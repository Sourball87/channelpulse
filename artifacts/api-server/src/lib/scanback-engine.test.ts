import { describe, expect, it } from "vitest";
import type { ScanbackProgram, ScanbackImportRow, ScanbackVerificationInput } from "@workspace/api-zod";
import { cents, validDate, verifyClaim, type EvidenceRow, type VerificationContext } from "./scanback-engine";
import { detectImportKind, mapImport, parseDate, parseSheets, suggestMapping, type Sheets } from "./scanback-import";
import * as XLSX from "xlsx";
import type { ScanbackImport } from "@workspace/api-zod";

const p: ScanbackProgram = {
  id: "promotion", name: "Program", version: 1, start: "2026-09-01", end: "2026-09-30",
  archived: false, notes: "", createdAt: "", customerIds: [1],
  lines: [{ partId: 2, gtmBuyCents: 7000, caps: [{ resellerId: 1, quantity: 2 }] }],
};
const settings: ScanbackVerificationInput = {
  programId: p.id, accountId: 1, claimImportId: "claim", basis: "sell", from: p.start, to: p.end,
};
const row = (serial: string, override: Partial<ScanbackImportRow> = {}): ScanbackImportRow => ({
  rowIndex: 0, serial, sku: "SKU", date: "2026-09-20", accountId: 1, quantity: 1,
  invoice: "INV1", unitPriceCents: 10000, amountCents: null, program: "", reference: "", ...override,
});
const ev = (serial: string, override: Partial<EvidenceRow> = {}): EvidenceRow => ({
  ...row(serial, { date: "2026-09-01" }), source: "test evidence", ...override,
});
const context = (override: Partial<VerificationContext> = {}): VerificationContext => ({
  program: p, settings, claims: [row("SER001")], evidence: [ev("SER001")], approved: [],
  parts: [{ id: 2, code: "SKU" }], ...override,
});
const first = (override: Partial<VerificationContext> = {}) => verifyClaim(context(override))[0];

describe("scanback currency and dates", () => {
  it("uses integer cents, including $ and thousands separators", () => {
    expect(cents("$1,234.56")).toBe(123456); expect(cents("0.10")).toBe(10);
    expect(cents("30")).toBe(3000); expect(cents("-1.01")).toBe(-101);
  });
  it("rejects missing, nonfinite and fractional cents instead of assuming zero", () => {
    for (const value of ["", undefined, null, NaN, "1.001", "1e3", "Infinity"]) expect(cents(value)).toBe(null);
  });
  it("validates actual calendar days and explicit DMY / MDY", () => {
    expect(validDate("2026-02-29")).toBe(false); expect(validDate("2024-02-29")).toBe(true);
    expect(parseDate("03/04/26", "dmy")).toBe("2026-04-03");
    expect(parseDate("03/04/26", "mdy")).toBe("2026-03-04");
    expect(parseDate("31/02/2026", "dmy")).toBe("");
    expect(parseDate("20260921", "dmy")).toBe("2026-09-21");
    expect(parseDate(20260921, "mdy")).toBe("2026-09-21");
    expect(parseDate("20260230", "dmy")).toBe("");
  });
});
describe("scanback deterministic verification", () => {
  const sold = {
    serial: "SER001", reportId: "claim", reportName: "First customer report", rowIndex: 0,
    accountId: 1, sellDate: "2026-09-20", committedAt: "2026-09-21T00:00:00.000Z",
  };
  it("allows the first SOLD source to verify without blocking itself and marks payable green", () => {
    expect(first({ reportedSales: [sold] })).toMatchObject({ trackingColor: "green", include: true, amountCents: 3000 });
  });
  it("blocks later report reuse across customers and promotions in red with original source details", () => {
    const result = first({ settings: { ...settings, claimImportId: "later", accountId: 9 }, reportedSales: [sold] });
    expect(result).toMatchObject({ trackingColor: "red", status: "rejected", include: false, selectable: false });
    expect(result.reason).toContain("First customer report [claim]");
    expect(result.reason).toContain("2026-09-20");
  });
  it("keeps unapproved same-customer report repeats amber and verifiable", () => {
    const result = first({ settings: { ...settings, claimImportId: "resend" }, reportedSales: [sold] });
    expect(result).toMatchObject({ trackingColor: "amber", status: "eligible", include: true, amountCents: 3000 });
    expect(result.reason).toContain("Also in earlier report First customer report [claim]");
  });
  it("reviews the reseller/SKU while a Pronto credit has no matching serial", () => {
    const result = first({ unmatchedProntoCredits: [{
      accountSkuKey: "1|SKU", invoice: "CR-7539088", date: "2026-09-01",
    }] });
    expect(result).toMatchObject({ trackingColor: "amber", status: "review", include: false });
    expect(result.reason).toContain("unmatched Pronto credit");
    expect(result.reason).toContain("CR-7539088");
    expect(result.reason).toContain("2026-09-01");
  });
  it("retains invoice and claim-basis details for claimed red rows", () => {
    const result = first({ accounts: [{ id: 1, code: "ca" }], approved: [{
      serial: "SER001", batchId: "batch-old", programId: "old", programName: "Past promotion",
      batchReference: "REF1", accountId: 1, partId: 2,
    }] });
    expect(result).toMatchObject({ trackingColor: "red", include: false, invoicedTo: "ca", invoice: "INV1", invoiceDate: "2026-09-01", unitPriceCents: 10000, gtmBuyCents: 7000 });
    expect(result.reason).toContain("Past promotion"); expect(result.reason).toContain("REF1");
  });
  it("always uses the customer sold date even if a legacy request asks for invoice basis", () => {
    const result = first({ settings: { ...settings, basis: "invoice" }, claims: [row("SER001", { date: "2026-10-01" })] });
    expect(result).toMatchObject({ trackingColor: "orange", include: false, status: "rejected" });
    expect(result.reason).toContain("Outside promotion dates");
  });
  it("keeps other blockers neutral and never lets reference cost change the payout", () => {
    expect(first({ evidence: [] }).trackingColor).toBe("neutral");
    expect(first({ evidence: [ev("SER001", { costCents: 999999 })] }))
      .toMatchObject({ trackingColor: "green", amountCents: 3000, costCents: 999999 });
  });
  it("calculates claim as DD invoiced price ex GST minus GTM Buy Ex", () => {
    const result = first({
      evidence: [ev("SER001", { unitPriceCents: 11725, costCents: 99999 })],
      program: { ...p, lines: [{ ...p.lines[0], gtmBuyCents: 8450, rrpIncCents: 99999, t1ExCents: 50000 }] },
    });
    expect(result).toMatchObject({ status: "eligible", unitPriceCents: 11725, gtmBuyCents: 8450, amountCents: 3275, include: true });
  });
  it("never uses program reference prices or GTM Inc as the claim basis", () => {
    const references = { ...p, lines: p.lines.map(line => ({
      ...line, rrpIncCents: 99999, gtmIncCents: 1, ddCostExCents: 500, t1ExCents: 20000,
    })) };
    expect(first({ program: references })).toMatchObject({ status: "eligible", amountCents: 3000, include: true });
  });
  it("blocks serial reuse across other promotions", () => {
    expect(first({ approved: [{ serial: "SER001", batchId: "old", programId: "different", accountId: 9, partId: 2 }] }).reason).toContain("Already approved");
  });
  it("blocks duplicates inside a claim", () => {
    const rows = verifyClaim(context({ claims: [row("SER001"), row("SER001", { rowIndex: 1 })] }));
    expect(rows[1]).toMatchObject({ trackingColor: "red", include: false });
    expect(rows[1].reason).toContain("first occurrence is on source row 2");
  });
  it("blocks missing invoice evidence", () => { expect(first({ evidence: [] }).reason).toContain("not found"); });
  it("marks only SKUs absent from all DD invoices and promotions as outside DD range", () => {
    const known = first({ ddRangeSkus: new Set(["SKU", "KNOWN-PROMO"]) });
    const unknown = first({ claims: [row("SER001", { sku: "MONITOR" })], ddRangeSkus: new Set(["SKU"]) });
    const blank = first({ claims: [row("SER001", { sku: "" })], ddRangeSkus: new Set(["SKU"]) });
    expect(known.notDdRange).toBe(false);
    expect(unknown.notDdRange).toBe(true);
    expect(blank.notDdRange).toBe(false);
  });
  it("blocks returned serials and handles a later reinvoice", () => {
    const credit = ev("SER001", { quantity: -1, invoice: "CR1", date: "2026-09-02" });
    expect(first({ evidence: [ev("SER001"), credit] }).reason).toContain("Credited");
    expect(first({ evidence: [ev("SER001"), credit, ev("SER001", { date: "2026-09-03", invoice: "INV2", unitPriceCents: 9000 })] }))
      .toMatchObject({ invoice: "INV2", amountCents: 2000, include: true });
  });
  it("does not guess between multiple active invoice owners", () => {
    expect(first({ evidence: [ev("SER001"), ev("SER001", { invoice: "INV2", date: "2026-09-02" })] }).status).toBe("review");
  });
  it("deduplicates identical evidence without inventing ambiguity", () => {
    expect(first({ evidence: [ev("SER001"), ev("SER001")] }).status).toBe("eligible");
  });
  it("rejects another customer or a claimed SKU mismatch", () => {
    expect(first({ evidence: [ev("SER001", { accountId: 5 })] }).reason).toContain("different customer");
    expect(first({ claims: [row("SER001", { sku: "WRONG" })] }).reason).toContain("SKU mismatch");
  });
  it("requires the customer sold date and never substitutes the DD invoice date", () => {
    expect(first({ claims: [row("SER001", { date: "" })] }).status).toBe("review");
    expect(first({ settings: { ...settings, basis: "invoice" }, claims: [row("SER001", { date: "" })] }).include).toBe(false);
  });
  it("rejects sales before invoice, outside dates and invalid program SKUs", () => {
    expect(first({ claims: [row("SER001", { date: "2026-08-31" })] }).reason).toContain("precedes");
    expect(first({ claims: [row("SER001", { date: "2026-10-01" })] }).reason).toContain("Outside");
    expect(first({ program: { ...p, lines: [] } }).reason).toContain("not in this promotion");
  });
  it("accepts inclusive date boundaries", () => {
    expect(first({ claims: [row("SER001", { date: p.start })] }).include).toBe(true);
    expect(first({ claims: [row("SER001", { date: p.end })] }).include).toBe(true);
  });
  it("rejects missing and nonpositive rebates", () => {
    expect(first({ evidence: [ev("SER001", { unitPriceCents: null })] }).status).toBe("review");
    expect(first({ evidence: [ev("SER001", { unitPriceCents: 7000 })] }).include).toBe(false);
    expect(first({ evidence: [ev("SER001", { unitPriceCents: 6000 })] }).include).toBe(false);
  });
  it("requires review for multiple units attached to one serial", () => {
    expect(first({ claims: [row("SER001", { quantity: 3 })] })).toMatchObject({ status: "review", include: false });
  });
  it("enforces caps against prior approvals and current selection", () => {
    const cap1 = { ...p, lines: [{ ...p.lines[0], caps: [{ resellerId: 1, quantity: 1 }] }] };
    const ctx = context({ program: cap1, claims: [row("SER001"), row("SER002", { rowIndex: 1 })], evidence: [ev("SER001"), ev("SER002")] });
    expect(verifyClaim(ctx).map(r => r.include)).toEqual([true, false]);
    expect(verifyClaim({ ...ctx, settings: { ...settings, selectedRows: [1] } }).map(r => r.include)).toEqual([false, true]);
    expect(first({ program: cap1, approved: [{ serial: "OLD", batchId: "old", programId: p.id, accountId: 1, partId: 2 }] }).reason).toContain("cap reached");
  });
  it("distinguishes zero caps from unlimited caps", () => {
    expect(first({ program: { ...p, lines: [{ ...p.lines[0], caps: [{ resellerId: 1, quantity: 0 }] }] } }).include).toBe(false);
    expect(first({ program: { ...p, lines: [{ ...p.lines[0], caps: [{ resellerId: 1, quantity: null }] }] } }).include).toBe(true);
  });
  it("matches typed catalogue-independent SKU codes and tracks their promotion caps", () => {
    const custom = { ...p, lines: [{ sku: "CUSTOM-SKU", partId: null, gtmBuyCents: 5000, caps: [{ resellerId: 1, quantity: 1 }] }] };
    const claims = [row("CUSTOM1", { sku: "CUSTOM-SKU" }), row("CUSTOM2", { sku: "CUSTOM-SKU", rowIndex: 1 })];
    const evidence = [ev("CUSTOM1", { sku: "CUSTOM-SKU" }), ev("CUSTOM2", { sku: "CUSTOM-SKU" })];
    expect(verifyClaim(context({ program: custom, claims, evidence })).map(r => [r.status, r.amountCents, r.reason]))
      .toEqual([["eligible", 5000, "Eligible"], ["rejected", 0, "Customer/SKU cap reached (1 units)"]]);
    const approved = [{ serial: "OLD-CUSTOM", batchId: "old", programId: p.id, accountId: 1, partId: null, sku: "CUSTOM-SKU" }];
    expect(verifyClaim(context({ program: custom, claims: [claims[0]], evidence: [evidence[0]], approved }))[0].reason)
      .toContain("cap reached");
  });
  it("permits deselecting every row without allocating caps", () => {
    expect(first({ settings: { ...settings, selectedRows: [] } }).include).toBe(false);
  });
});
describe("scanback imports", () => {
  const raw: Sheets = { Sheet1: [{ Serial: " sn-001 ", SKU: "SKU", Date: "20/09/26", Account: "CA", Quantity: 1, Invoice: "INV1", "Unit Price": "100.00" }] };
  const base = {
    id: "i", kind: "evidence", name: "source.csv", state: "preview", createdAt: "", sheets: ["Sheet1"],
    sheet: "Sheet1", mapping: {}, dateFormat: "dmy", accountId: null, rows: [], errors: [], warnings: [], duplicate: false, headers: [], recordCount: 0,
  } as ScanbackImport;
  const mapClaimSheet = (r: Sheets, sheet: string) => mapImport(
    { ...base, kind: "claim" }, r, { sheet, dateFormat: "dmy", mapping: suggestMapping(Object.keys(r[sheet][0])) },
    [{ id: 1, code: "CA", name: "Computer Alliance" }], new Set(["SKU"]),
  );
  const map = (r = raw, kind: ScanbackImport["kind"] = "evidence", override = {}) =>
    mapImport({ ...base, kind }, r, { sheet: "Sheet1", dateFormat: "dmy", mapping: suggestMapping(Object.keys(r.Sheet1[0])), ...override }, [{ id: 1, code: "CA", name: "Computer Alliance" }], new Set(["SKU"]));
  it("normalizes account, serial, money and AU date", () => {
    const result = map(); expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ serial: "SN-001", accountId: 1, date: "2026-09-20", unitPriceCents: 10000 });
  });
  it("keeps blank serials as hard errors for invoice evidence", () => {
    const result = map({ Sheet1: [{ ...raw.Sheet1[0], Serial: "" }] });
    expect(result.errors.some(issue => issue.message === "Serial is required; remove totals/non-serial rows.")).toBe(true);
  });
  it("does not map purchase cost as invoiced price", () => {
    expect(suggestMapping(["Serial", "Cost"]).unitPrice).toBe("");
    const withCost = { Sheet1: [{ ...raw.Sheet1[0], Cost: "70.00" }] };
    expect(map(withCost, "evidence", { mapping: { ...suggestMapping(Object.keys(withCost.Sheet1[0])), unitPrice: "Cost" } }).errors
      .some(e => e.message.includes("UNIT PRICE EX GST"))).toBe(true);
  });
  it("requires review of ambiguous date or price headings", () => {
    expect(suggestMapping(["Date", "Invoice Date", "Serial"]).date).toBe("");
    expect(suggestMapping(["Price", "Unit Price", "Serial"]).unitPrice).toBe("");
  });
  it("requires a sale-date column to make a customer report usable", () => {
    expect(map({ Sheet1: [{ Serial: "SER001" }] }, "claim").errors)
      .toContainEqual({ row: 0, message: "Map the date column." });
  });
  it("excludes row-level claim issues as warnings instead of blocking the report", () => {
    const result = map({ Sheet1: [
      { Serial: "SER001", Date: "20/09/2026" },
      { Serial: "SER002; SER003", Date: "20/09/2026", Quantity: 1 },
      { Serial: "SER004", Date: "not a date" },
    ] }, "claim");
    expect(result.errors).toEqual([]);
    expect(result.rows.map(row => row.serial)).toEqual(["SER001"]);
    expect(result.warnings).toContain("Row 3: Use exactly one serial per customer claim row; split serial lists into separate rows. — skipped.");
    expect(result.warnings).toContain("Row 4: Invalid date for the selected date format. — skipped.");
  });
  it("accepts custom SKU codes in invoice evidence without cataloguing them", () => {
    const result = map({ Sheet1: [{ ...raw.Sheet1[0], Account: "CA", SKU: "Custom-Model", Invoice: "CUSTOM-INV" }] });
    expect(result.errors).toEqual([]);
    expect(result.rows[0].sku).toBe("CUSTOM-MODEL");
    expect(result.warnings.some(w => w.includes("CUSTOM-MODEL") && w.includes("No product SKUs were created"))).toBe(true);
  });
  it("expands signed serial lists without multiplying payments", () => {
    const r = map({ Sheet1: [{ ...raw.Sheet1[0], Serial: "SN1; SN2", Quantity: -2 }] });
    expect(r.errors).toEqual([]); expect(r.rows.map(x => x.quantity)).toEqual([-1, -1]);
  });
  it("rejects a mismatch between serialized invoice units and serial count", () => {
    expect(map({ Sheet1: [{ ...raw.Sheet1[0], Quantity: 4 }] }).errors.some(e => /match the number/.test(e.message))).toBe(true);
  });
  it("reads CSV and XLSX using the same structured import", () => {
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(raw.Sheet1), "Sheet1");
    expect(parseSheets(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).Sheet1).toHaveLength(1);
    expect(parseSheets(Buffer.from("Serial,SKU\nSER001,SKU")).Sheet1).toHaveLength(1);
  });
  it("detects Umart's combined IMEI/serial heading and Model Number SKU", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["IMEI Code/Serial No", "Model Number", "Sale Date"],
      ["UMART-SERIAL-001", "UMART-MODEL", "21/09/2026"],
    ]), "Umart Sales");
    const parsed = parseSheets(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    const headers = Object.keys(parsed["Umart Sales"][0]);
    expect(detectImportKind(headers)).toBe("claim");
    expect(suggestMapping(headers)).toMatchObject({ serial: "IMEI Code/Serial No", sku: "Model Number" });
    const mapped = mapClaimSheet(parsed, "Umart Sales");
    expect(mapped.errors).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({ serial: "UMART-SERIAL-001", sku: "UMART-MODEL" });
  });
  it("parses Scorptec's compact yyyymmdd text and numeric date cells", () => {
    const csv = parseSheets(Buffer.from("Serial Number,Model Number,Sale Date\nSCORP-CSV-001,MODEL-A,20260921"));
    expect(csv.Sheet1[0]["Sale Date"]).toBe("20260921");
    expect(mapClaimSheet(csv, "Sheet1").rows[0].date).toBe("2026-09-21");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Serial Number", "Model Number", "Sale Date"], ["SCORP-XLS-001", "MODEL-B", 20260921],
    ]), "Scorptec");
    const xlsx = parseSheets(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    expect(xlsx.Scorptec[0]["Sale Date"]).toBe(20260921);
    expect(mapClaimSheet(xlsx, "Scorptec").rows[0].date).toBe("2026-09-21");
  });
  it("preserves leading zero CSV serials and rejects numeric spreadsheet serial cells", () => {
    expect(parseSheets(Buffer.from("Serial,SKU\n000123,SKU")).Sheet1[0].Serial).toBe("000123");
    expect(map({ Sheet1: [{ ...raw.Sheet1[0], Serial: 123 }] }).errors.some(e => e.message.includes("as text"))).toBe(true);
  });
  it("does not let CSV reader pre-interpret slash dates before the chosen date format", () => {
    const sheets = parseSheets(Buffer.from("Serial,SKU,Date\nSER001,SKU,01/09/2026\nSER002,SKU,02/09/2026"));
    expect(sheets.Sheet1[0].Date).toBe("01/09/2026");
    const dmy = map(sheets, "claim");
    expect(dmy.rows.map(r => r.date)).toEqual(["2026-09-01", "2026-09-02"]);
    const mdy = map(sheets, "claim", { dateFormat: "mdy" });
    expect(mdy.rows.map(r => r.date)).toEqual(["2026-01-09", "2026-02-09"]);
  });
});
