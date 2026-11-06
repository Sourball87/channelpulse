import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import type { ScanbackImport } from "@workspace/api-zod";
import { parseSheets, mapImport, suggestMapping, prontoRangeCovers, type Sheets } from "./scanback-import";
import { indexProntoSource, isPronto, parseProntoSerials, pendingProntoCredits, prontoCreditIdentity, prontoMapping, unmatchedCreditKey, unmatchedCreditReason } from "./scanback-pronto";
import { verifyClaim } from "./scanback-engine";

const accounts = [{ id: 1, code: "CA", name: "Computer Alliance" }, { id: 2, code: "umart", name: "Umart" }, { id: 3, code: "other", name: "Not in the existing nine" }];
const invoice = (extra: Record<string, unknown> = {}) => ({
  "Invoice No": "TEST-INVOICE", "Invoice Date": "2026-09-01", "Account Code": "123",
  "Reseller Name": "COMPUTER ALLIANCE PTY LTD", "Stock Code": "SKU", "Ship Qty": 2,
  "Serial Number": "SN0001|SN0002", "Item Price": 100, "Line Price Ex": 200, ...extra,
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
    expect(suggestMapping(Object.keys(invoice({ "Order Date": "2020-01-01", "Item Cost": 70 })))).toEqual({ ...prontoMapping, cost: "Item Cost" });
  });
  it("does not automatically use even a clear company-name suggestion", () => {
    const result = map(undefined, {});
    expect(result.recordCount).toBe(0);
    expect(result.pronto?.accounts[0]).toMatchObject({ suggestedAccountId: 1, accountId: null });
    expect(result.errors.some(e => e.message.includes("Map at least one"))).toBe(true);
  });
  it("expands pipe-separated serial lists into signed unit events at the invoiced unit price", () => {
    const r = map([invoice(), invoice({ "Invoice No": "CREDIT", "Serial Number": "SN0001", "Ship Qty": -1, "Line Price Ex": -100, "Invoice Date": "2026-09-02" })]);
    expect(r.errors).toEqual([]);
    expect(r.rows.map(row => [row.serial, row.quantity, row.unitPriceCents, row.sourceRow])).toEqual([
      ["SN0001", 1, 10000, 2], ["SN0002", 1, 10000, 2], ["SN0001", -1, 10000, 3],
    ]);
  });
  it("drops Pronto placeholders, lists them in warnings and retains real serials", () => {
    const row = invoice({
      "Invoice No": "7539088AC", "Ship Qty": 2, "Line Price Ex": 200,
      "Serial Number": "-+08|000000000000|ABCDEF|12345678|S7MLNS0YC02190|ABCDEF12",
    });
    const parsed = parseProntoSerials(row["Serial Number"]);
    expect(parsed.serials).toEqual(["S7MLNS0YC02190", "ABCDEF12"]);
    expect(parsed.placeholders).toEqual(["-+08", "000000000000", "ABCDEF", "12345678"]);
    const result = map([row]);
    expect(result.errors).toEqual([]);
    expect(result.rows.map(record => record.serial)).toEqual(["S7MLNS0YC02190", "ABCDEF12"]);
    expect(result.warnings.some(w => w.includes("-+08") && w.includes("000000000000"))).toBe(true);
  });
  it("keeps valid serials on short rows and warns with expected versus found counts", () => {
    const good = invoice({ "Invoice No": "GOOD", "Serial Number": "GOOD1234|GOOD5678" });
    const mismatch = invoice({
      "Invoice No": "BAD", "Ship Qty": 2, "Line Price Ex": 200, "Serial Number": "ONLY1234",
    });
    const result = map([good, mismatch]);
    expect(result.errors).toEqual([]);
    expect(result.rows.map(record => record.serial)).toEqual(["GOOD1234", "GOOD5678", "ONLY1234"]);
    expect(result.pronto?.includedSourceRows).toBe(2);
    expect(result.pronto?.excludedCounts["More serials than Ship Qty"]).toBeUndefined();
    expect(result.warnings.some(w => w.includes("Row 3") && w.includes("expected 2, found 1"))).toBe(true);
  });
  it("excludes only rows with more valid serials than Ship Qty", () => {
    const good = invoice({ "Invoice No": "GOOD", "Serial Number": "GOOD1234|GOOD5678" });
    const excess = invoice({
      "Invoice No": "EXCESS", "Ship Qty": 1, "Line Price Ex": 100, "Serial Number": "EXTRA123|EXTRA456",
    });
    const result = map([good, excess]);
    expect(result.errors).toEqual([]);
    expect(result.rows.map(record => record.serial)).toEqual(["GOOD1234", "GOOD5678"]);
    expect(result.pronto?.excludedCounts["More serials than Ship Qty"]).toBe(1);
    expect(result.warnings.some(w => w.includes("Row 3") && w.includes("found 2") && w.includes("Ship Qty 1"))).toBe(true);
  });
  it("quietly counts positive-quantity rows without serials", () => {
    const result = map([
      invoice({ "Invoice No": "NO-SERIAL-1", "Serial Number": "" }),
      invoice({ "Invoice No": "NO-SERIAL-2", "Serial Number": "" }),
    ]);
    expect(result.pronto?.excludedCounts["No serial number — not serial-level evidence"]).toBe(2);
    expect(result.warnings.some(w => /Row (2|3).*No serial number/i.test(w))).toBe(false);
    expect(result.pronto?.excludedSamples.filter(sample => sample.reason === "No serial number — not serial-level evidence"))
      .toHaveLength(2);
  });
  it("retains uncatalogued SKUs as evidence while excluding unmapped accounts and nonserial lines", () => {
    const r = map([invoice(), invoice({ "Account Code": "999", "Reseller Name": "Outside scope" }),
      invoice({ "Stock Code": "UNKNOWN" }), invoice({ "Serial Number": "" })]);
    expect(r.recordCount).toBe(4); expect(r.pronto?.includedSourceRows).toBe(2); expect(r.pronto?.excludedSourceRows).toBe(2);
    expect(Object.keys(r.pronto!.excludedCounts)).toHaveLength(2);
    expect(r.rows.every(row => row.accountId === 1)).toBe(true);
    expect(r.warnings.some(w => w.includes("UNKNOWN"))).toBe(true);
  });
  it("allows any active reseller but rejects inactive resellers and unknown source account codes", () => {
    expect(map(undefined, { "123": 3 }).errors).toEqual([]);
    const inactive = mapImport(base, { Sheet1: [invoice()] }, { ...base, prontoAccounts: { "123": 4 } },
      [{ id: 4, code: "new", name: "New Reseller", active: false }], new Set(["SKU"]));
    expect(inactive.errors.some(e => e.message.includes("active ChannelPulse reseller"))).toBe(true);
    expect(map(undefined, { "123": 1, "not-in-file": 1 }).errors.some(e => e.message.includes("not present"))).toBe(true);
  });
  it("commits serialless selected credits as listed warnings, including credit-only files", () => {
    const result = map([invoice({ "Invoice No": "CREDIT-1", "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "" })]);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.warnings.some(w => w.includes("1 selected Pronto credit") && w.includes("until resolved"))).toBe(true);
    expect(result.pronto?.excludedCounts[unmatchedCreditReason]).toBe(1);
    expect(result.pronto?.excludedSamples[0]).toMatchObject({
      row: 2, sku: "SKU", quantity: -1, serialCount: 0, reason: unmatchedCreditReason,
    });
    expect(map([invoice({ "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "", "Account Code": "999" })]).errors.some(e => e.message.includes("Credit"))).toBe(false);
  });
  it("keeps unmatched credits visible until a later matching credit or an audited resolution", () => {
    const missing = invoice({ "Invoice No": "CREDIT-1", "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "" });
    const resolved = invoice({ "Invoice No": "CREDIT-1", "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "RETURNED1" });
    const original = {
      id: "old", committedAt: "2026-09-01T00:00:00Z", prontoAccounts: { "123": 1 }, rows: [missing],
    };
    expect(pendingProntoCredits([original])).toMatchObject([{
      id: "old:2", accountSkuKey: unmatchedCreditKey(1, "SKU"), invoice: "CREDIT-1", date: "2026-09-01",
    }]);
    expect(pendingProntoCredits([
      original, { id: "later", committedAt: "2026-09-02T00:00:00Z", prontoAccounts: { "123": 1 }, rows: [resolved] },
    ])).toEqual([]);
    expect(pendingProntoCredits([
      original, { id: "wrong-ref", committedAt: "2026-09-02T00:00:00Z", prontoAccounts: { "123": 1 },
        rows: [invoice({ "Invoice No": "OTHER-CREDIT", "Ship Qty": -1, "Line Price Ex": -100, "Serial Number": "RETURNED1" })] },
    ])).toHaveLength(1);
    expect(pendingProntoCredits([{
      ...original,
      prontoCreditResolutions: [{
        sourceRow: 2, mode: "reviewed", serials: [], note: "Checked return record.",
        resolvedAt: "2026-09-03T00:00:00.000Z", resolvedBy: "admin",
      }],
    }])).toEqual([]);
  });
  it("deduplicates overlapping Pronto extracts and carries resolutions across files", () => {
    const credit = invoice({
      "Invoice No": "CREDIT-OVERLAP", "Ship Qty": -1, "Line Price Ex": -100,
      "Serial Number": "", "Invoice Date": "2026-09-04",
    });
    const key = prontoCreditIdentity("123", "SKU", "CREDIT-OVERLAP", -1, "2026-09-04");
    const first = {
      id: "first-file", committedAt: "2026-09-05T00:00:00Z", prontoAccounts: { "123": 1 }, rows: [credit],
      prontoCreditResolutions: [{
        sourceRow: 2, creditKey: key, mode: "reviewed" as const, serials: [], note: "Reviewed return.",
        resolvedAt: "2026-09-06T00:00:00Z", resolvedBy: "admin",
      }],
    };
    const overlap = {
      id: "overlap-file", committedAt: "2026-09-07T00:00:00Z", prontoAccounts: { "123": 1 }, rows: [credit],
    };
    expect(pendingProntoCredits([first, overlap])).toEqual([]);
    expect(pendingProntoCredits([
      { ...first, prontoCreditResolutions: [] }, overlap,
    ])).toMatchObject([{ id: "overlap-file:2", invoice: "CREDIT-OVERLAP" }]);
    expect(pendingProntoCredits([
      { ...first, prontoCreditResolutions: [] },
      { ...overlap, rows: [{ ...credit, "Serial Number": "RETURNED1" }] },
    ])).toEqual([]);
    expect(pendingProntoCredits([
      { ...first, rows: [{ ...credit, "Serial Number": "RETURNED1" }], prontoCreditResolutions: [] },
      overlap,
    ])).toEqual([]);
  });
  it("identifies Pronto source rows and detects date-range coverage", () => {
    const indexed = indexProntoSource([
      invoice({ "Invoice No": "CREDIT", "Ship Qty": -1, "Serial Number": "" }),
      invoice({ "Account Code": "999", "Serial Number": "OTHER123" }),
    ], { "123": 1 });
    expect(indexed.creditRows).toMatchObject([{ sourceRow: 2, "Invoice No": "CREDIT" }]);
    expect(indexed.restrictedSerials).toEqual(["OTHER123"]);
    expect(prontoRangeCovers(
      [{ "Invoice Date": "2026-09-01" }, { "Invoice Date": "2026-09-30" }], "dmy",
      [{ "Invoice Date": "2026-09-04" }, { "Invoice Date": "2026-09-25" }], "dmy",
    )).toBe(true);
    expect(prontoRangeCovers(
      [{ "Invoice Date": "2026-09-04" }, { "Invoice Date": "2026-09-25" }], "dmy",
      [{ "Invoice Date": "2026-09-01" }, { "Invoice Date": "2026-09-30" }], "dmy",
    )).toBe(false);
    expect(prontoCreditIdentity("123", "sku", "cr-1", -1, "04/03/2026", "dmy"))
      .not.toBe(prontoCreditIdentity("123", "sku", "cr-1", -1, "04/03/2026", "mdy"));
  });
  it("does not allow changing Item Price to cost or replacing the multi-account map with a fallback", () => {
    expect(() => mapImport(base, { Sheet1: [invoice()] }, { ...base, mapping: { ...prontoMapping, unitPrice: "Line Price Ex" } }, accounts, new Set(["SKU"]))).toThrow("fixed invoice/price");
    expect(() => mapImport(base, { Sheet1: [invoice()] }, { ...base, accountId: 1 }, accounts, new Set(["SKU"]))).toThrow("fallback account");
  });
  it("validates exact extended prices, quantity/serial counts and foreign currency", () => {
    expect(map([invoice({ "Line Price Ex": 199.99 })]).errors.some(e => e.message.includes("exact cents"))).toBe(true);
    const mismatch = map([invoice({ "Ship Qty": 3, "Line Price Ex": 300 })]);
    expect(mismatch.pronto?.includedSourceRows).toBe(1);
    expect(mismatch.rows).toHaveLength(2);
    expect(mismatch.warnings.some(w => w.includes("expected 3, found 2"))).toBe(true);
    expect(map([invoice({ Currency: "USD" })]).errors.some(e => e.message.includes("Foreign-currency"))).toBe(true);
    expect(map([invoice({ Currency: "AUD" })]).errors).toEqual([]);
    expect(map([invoice({ "Item Price": 0, "Line Price Ex": 0 })]).errors).toEqual([]);
  });
  it("rejects using a Pronto POS extract as a customer claim file", () => {
    expect(() => mapImport({ ...base, kind: "claim" }, { Sheet1: [invoice()] }, base, accounts, new Set(["SKU"]))).toThrow("Choose Invoice / credit evidence");
  });
  it("retains evidence/account/currency and reference cost, not addresses, user IDs or RRP", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([invoice({
      "Reseller Address": "Not needed", "EU Email": "not-needed@example.invalid", "User ID Code": "operator",
      "Item Cost": 70, "Line Cost Ex": 140, RRP: 200, Currency: "AUD",
    })]), "Sheet1");
    const raw = parseSheets(XLSX.write(wb, { type: "buffer" }));
    expect(Object.keys(raw.Sheet1[0])).not.toEqual(expect.arrayContaining(["EU Email"]));
    expect(Object.keys(raw.Sheet1[0]).sort()).toEqual([...Object.keys(invoice()), "Currency", "Item Cost"].sort());
  });
  it("holds a serial for review when excluded source evidence could hide an owner or return", () => {
    const evidence = map().rows.map(row => ({ ...row, source: "test source" }));
    const result = verifyClaim({
      program: { id: "p", name: "p", start: "2026-09-01", end: "2026-09-30", version: 1, archived: false, notes: "", createdAt: "",
        customerIds: [1], lines: [{ partId: 1, gtmBuyCents: 7000, caps: [] }] },
      settings: { programId: "p", accountId: 1, claimImportId: "c", basis: "invoice", from: "2026-09-01", to: "2026-09-30" },
      claims: [evidence[0]], evidence, approved: [], parts: [{ id: 1, code: "SKU" }], restrictedSerials: new Set(["SN0001"]),
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
    expect(initial.pronto).toMatchObject({ sourceRows: 2160, includedSourceRows: 0 });
    expect(initial.pronto!.sourceSerialEvents).toBeLessThan(90208);
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
    expect(scoped.errors).toHaveLength(0);
    expect(scoped.warnings.some(w => w.includes("Row 131") && w.includes("ignored placeholder serial token"))).toBe(true);
    expect(scoped.pronto?.excludedCounts[unmatchedCreditReason]).toBe(3);
  }, 30_000);
});
