import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import type { ScanbackImport } from "@workspace/api-zod";
import { parseSheets, mapImport, suggestMapping, type Sheets } from "./scanback-import";
import { isPronto, prontoMapping } from "./scanback-pronto";
import { verifyClaim } from "./scanback-engine";

const accounts = [{ id: 1, code: "CA", name: "Computer Alliance" }, { id: 2, code: "umart", name: "Umart" }, { id: 3, code: "other", name: "Not in the existing nine" }];
const invoice = (extra: Record<string, unknown> = {}) => ({
  "Invoice No": "TEST-INVOICE", "Invoice Date": "2026-09-01", "Account Code": "123",
  "Reseller Name": "COMPUTER ALLIANCE PTY LTD", "Stock Code": "SKU", "Ship Qty": 2,
  "Serial Number": "SN001|SN002", "Item Price": 100, "Line Price Ex": 200, ...extra,
});
const base: ScanbackImport = {
  id: "test", kind: "evidence", name: "test.xlsx", state: "preview", createdAt: "", sheets: ["Sheet1"],
  sheet: "Sheet1", headers: [], mapping: prontoMapping, dateFormat: "dmy", accountId: null,
  rows: [], errors: [], warnings: [], duplicate: false, recordCount: 0,
};
const map = (rows = [invoice()], prontoAccounts: Record<string, number | null> = { "123": 1 }) =>
  mapImport(base, { Sheet1: rows }, { ...base, prontoAccounts }, accounts, new Set(["SKU"]));

describe("native Pronto POS evidence", () => {
  it("detects only the full Pronto contract and selects Invoice Date / Item Price", () => {
    expect(isPronto(Object.keys(invoice({ "Order Date": "2020-01-01", "Item Cost": 70 })))).toBe(true);
    expect(isPronto(["Serial Number", "Item Price"])).toBe(false);
    expect(suggestMapping(Object.keys(invoice({ "Order Date": "2020-01-01", "Item Cost": 70 })))).toEqual(prontoMapping);
  });
  it("does not automatically use even a clear company-name suggestion", () => {
    const result = map(undefined, {});
    expect(result.recordCount).toBe(0);
    expect(result.pronto?.accounts[0]).toMatchObject({ suggestedAccountId: 1, accountId: null });
    expect(result.errors.some(e => e.message.includes("Map at least one"))).toBe(true);
  });
  it("expands pipe-separated serial lists into signed unit events at the invoiced unit price", () => {
    const r = map([invoice(), invoice({ "Invoice No": "CREDIT", "Serial Number": "SN001", "Ship Qty": -1, "Line Price Ex": -100, "Invoice Date": "2026-09-02" })]);
    expect(r.errors).toEqual([]);
    expect(r.rows.map(row => [row.serial, row.quantity, row.unitPriceCents, row.sourceRow])).toEqual([
      ["SN001", 1, 10000, 2], ["SN002", 1, 10000, 2], ["SN001", -1, 10000, 3],
    ]);
  });
  it("counts excluded accounts, unknown SKUs and nonserial lines without inventing evidence", () => {
    const r = map([invoice(), invoice({ "Account Code": "999", "Reseller Name": "Outside scope" }),
      invoice({ "Stock Code": "UNKNOWN" }), invoice({ "Serial Number": "" })]);
    expect(r.recordCount).toBe(2); expect(r.pronto?.excludedSourceRows).toBe(3);
    expect(Object.keys(r.pronto!.excludedCounts)).toHaveLength(3);
    expect(r.rows.every(row => row.accountId === 1)).toBe(true);
  });
  it("rejects mappings outside the nine resellers and non-existent source account codes", () => {
    expect(map(undefined, { "123": 3 }).errors.some(e => e.message.includes("existing nine"))).toBe(true);
    expect(map(undefined, { "123": 1, "not-in-file": 1 }).errors.some(e => e.message.includes("not present"))).toBe(true);
  });
  it("blocks missing-serial credits for selected accounts and known SKUs", () => {
    expect(map([invoice({ "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "" })]).errors.some(e => e.message.includes("Credit") && e.message.includes("no serials"))).toBe(true);
    expect(map([invoice({ "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "", "Account Code": "999" })]).errors.some(e => e.message.includes("Credit"))).toBe(false);
  });
  it("does not allow changing Item Price to cost or replacing the multi-account map with a fallback", () => {
    expect(() => mapImport(base, { Sheet1: [invoice()] }, { ...base, mapping: { ...prontoMapping, unitPrice: "Line Price Ex" } }, accounts, new Set(["SKU"]))).toThrow("fixed invoice/price");
    expect(() => mapImport(base, { Sheet1: [invoice()] }, { ...base, accountId: 1 }, accounts, new Set(["SKU"]))).toThrow("fallback account");
  });
  it("validates exact extended prices, quantity/serial counts and foreign currency", () => {
    expect(map([invoice({ "Line Price Ex": 199.99 })]).errors.some(e => e.message.includes("exact cents"))).toBe(true);
    expect(map([invoice({ "Ship Qty": 3, "Line Price Ex": 300 })]).errors.some(e => e.message.includes("match the number"))).toBe(true);
    expect(map([invoice({ Currency: "USD" })]).errors.some(e => e.message.includes("Foreign-currency"))).toBe(true);
    expect(map([invoice({ Currency: "AUD" })]).errors).toEqual([]);
    expect(map([invoice({ "Item Price": 0, "Line Price Ex": 0 })]).errors).toEqual([]);
  });
  it("rejects using a Pronto POS extract as a customer claim file", () => {
    expect(() => mapImport({ ...base, kind: "claim" }, { Sheet1: [invoice()] }, base, accounts, new Set(["SKU"]))).toThrow("Choose Invoice / credit evidence");
  });
  it("retains only evidence/account/currency columns, not addresses, user IDs, RRP or purchase costs", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([invoice({
      "Reseller Address": "Not needed", "EU Email": "not-needed@example.invalid", "User ID Code": "operator",
      "Item Cost": 70, "Line Cost Ex": 140, RRP: 200, Currency: "AUD",
    })]), "Sheet1");
    const raw = parseSheets(XLSX.write(wb, { type: "buffer" }));
    expect(Object.keys(raw.Sheet1[0])).not.toEqual(expect.arrayContaining(["EU Email"]));
    expect(Object.keys(raw.Sheet1[0]).sort()).toEqual([...Object.keys(invoice()), "Currency"].sort());
  });
  it("holds a serial for review when excluded source evidence could hide an owner or return", () => {
    const evidence = map().rows.map(row => ({ ...row, source: "test source" }));
    const result = verifyClaim({
      program: { id: "p", name: "p", start: "2026-09-01", end: "2026-09-30", version: 1, archived: false, notes: "", createdAt: "",
        customerIds: [1], lines: [{ partId: 1, gtmBuyCents: 7000, caps: [] }] },
      settings: { programId: "p", accountId: 1, claimImportId: "c", basis: "invoice", from: "2026-09-01", to: "2026-09-30" },
      claims: [evidence[0]], evidence, approved: [], parts: [{ id: 1, code: "SKU" }], restrictedSerials: new Set(["SN001"]),
    });
    expect(result[0]).toMatchObject({ status: "review", include: false });
    expect(result[0].reason).toContain("excluded Pronto");
  });
});

describe.skipIf(!process.env.PRONTO_SAMPLE)("local uploaded Pronto sample — read-only dry run", () => {
  it("parses and scopes the real workbook without saving imports or financial data", async () => {
    const raw: Sheets = parseSheets(readFileSync(process.env.PRONTO_SAMPLE!));
    const cat = await (await fetch("http://localhost:80/api/resellers")).json() as { id: number; code: string; name: string }[];
    const parts = await (await fetch("http://localhost:80/api/parts")).json() as { part_no: string }[];
    const skuCodes = new Set(parts.map(p => p.part_no.toUpperCase()));
    const opts = { ...base, mapping: suggestMapping(Object.keys(raw.Sheet1[0])) };
    const initial = mapImport(base, raw, opts, cat, skuCodes);
    expect(initial.pronto).toMatchObject({ sourceRows: 2160, sourceSerialEvents: 90208, includedSourceRows: 0 });
    const prontoAccounts = Object.fromEntries(initial.pronto!.accounts.filter(a => a.suggestedAccountId != null).map(a => [a.code, a.suggestedAccountId]));
    const scoped = mapImport(base, raw, { ...opts, prontoAccounts }, cat, skuCodes);
    console.log("Read-only Pronto dry-run counts:", JSON.stringify({
      mappedSourceAccounts: Object.keys(prontoAccounts).length, serialEvents: scoped.recordCount,
      includedSourceRows: scoped.pronto!.includedSourceRows, excludedRows: scoped.pronto!.excludedSourceRows,
      exclusions: scoped.pronto!.excludedCounts, errors: scoped.errors.slice(0, 10), errorCount: scoped.errors.length,
    }));
    expect(scoped.recordCount).toBeGreaterThan(0);
    expect(scoped.rows.every(row => cat.some(a => a.id === row.accountId))).toBe(true);
    expect(Object.keys(raw.Sheet1[0])).not.toContain("Reseller Address");
    expect(scoped.errors).toHaveLength(2);
    expect(scoped.errors).toEqual(expect.arrayContaining([
      { row: 131, message: "Serial has unsupported characters or length." },
      { row: 1320, message: "Credit for a selected reseller/known SKU has no serials. Resolve the return before committing evidence." },
    ]));
  }, 30_000);
});
