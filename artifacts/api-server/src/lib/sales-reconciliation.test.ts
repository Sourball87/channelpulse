import { describe, expect, it } from "vitest";
import type { ScanbackImport, ScanbackImportRow } from "@workspace/api-zod";
import { mappedSoldColumn, reconcileSales, reconciledWeeklyCells, salesReconciliation, weekBounds, type SalesInputs } from "./sales-reconciliation";

const week = "2026-W38";
const row = (serial: string, overrides: Partial<ScanbackImportRow> = {}): ScanbackImportRow => ({
  rowIndex: 0, serial, sku: "SKU", accountId: 1, date: "2026-09-15", quantity: 1,
  invoice: "INV", unitPriceCents: 10000, amountCents: null, program: "", reference: "", ...overrides,
});
const imp = (id: string, kind: ScanbackImport["kind"], rows: ScanbackImportRow[], overrides: Partial<ScanbackImport> = {}): ScanbackImport => ({
  id, kind, rows, name: id, state: "committed", createdAt: "2026-09-21T00:00:00.000Z",
  committedAt: "2026-09-21T00:00:00.000Z", headers: [], sheets: ["Sheet1"], sheet: "Sheet1",
  mapping: {}, dateFormat: "dmy", accountId: 1, errors: [], warnings: [], duplicate: false, recordCount: rows.length, ...overrides,
});
const base = (): SalesInputs => ({
  accounts: [{ id: 1, code: "ca", sendsSerialReports: true }, { id: 2, code: "scorptec", sendsSerialReports: true }],
  parts: [{ id: 10, code: "SKU", category: "SSD" }, { id: 11, code: "OTHER", category: "Monitor" }],
  snapshots: [{ resellerId: 1, sku: "SKU", week, soh: 20, sold: 4, soldColumn: true }],
  uploads: [{ resellerId: 1, week, soldColumn: true }], reports: [], imports: [],
});
const current = (data: SalesInputs, account = 1) => salesReconciliation(week, data).rows.find(r => r.week_iso === week && r.reseller_id === account && r.part_no === "SKU")!;
describe("serial match calculations", () => {
  it("calculates the percentage without capping over-reporting at 100", () => {
    expect(reconcileSales({ sold: 4, soldColumn: true, serials: 3, expected: true, reportReceived: true }).pct).toBe(75);
    const over = reconcileSales({ sold: 2, soldColumn: true, serials: 3, expected: true, reportReceived: true });
    expect(over.pct).toBe(150);
    expect(over.alerts).toEqual([{ severity: "high", message: "More serials than sold — check before paying claims" }]);
  });
  it("flags serials against explicit zero but never divides by zero", () => {
    const result = reconcileSales({ sold: 0, soldColumn: true, serials: 1, expected: true, reportReceived: true });
    expect(result.pct).toBeNull(); expect(result.alerts[0].severity).toBe("high");
  });
  it("gives a low alert for partial or missing expected serial reporting", () => {
    for (const serials of [0, 2, null]) {
      const result = reconcileSales({ sold: 4, soldColumn: true, serials, expected: true, reportReceived: serials != null });
      expect(result.alerts).toEqual([{ severity: "low", message: "Sold not serial-reported" }]);
      expect(result.pct).toBe(serials == null ? null : serials / 4 * 100);
    }
  });
  it("does not invent missing-report alerts for non-expected reports or zero sales", () => {
    expect(reconcileSales({ sold: 4, soldColumn: true, serials: null, expected: false, reportReceived: false }).alerts).toEqual([]);
    expect(reconcileSales({ sold: 0, soldColumn: true, serials: null, expected: true, reportReceived: false }).alerts).toEqual([]);
  });
  it("fallback has no SOH denominator and missing serials stay missing", () => {
    const result = reconcileSales({ sold: null, soldColumn: false, serials: 3, expected: true, reportReceived: true });
    expect(result).toMatchObject({ pct: null, sellThrough: 3, source: "serials", alerts: [] });
    expect(reconcileSales({ sold: null, soldColumn: false, serials: null, expected: true, reportReceived: false }))
      .toMatchObject({ sellThrough: null, source: "missing" });
  });
  it("detects sold-column absence from mapping, never from a stored zero", () => {
    const fields = [{ canonical_field: "part_no" }, { canonical_field: "soh" }];
    expect(mappedSoldColumn(fields)).toBe(false);
    expect(mappedSoldColumn([...fields, { canonical_field: "sell_through_7d" }])).toBe(true);
    expect(mappedSoldColumn(null, 0)).toBeNull();
    expect(mappedSoldColumn([], 0)).toBeNull();
    expect(mappedSoldColumn(null, 5)).toBe(true);
  });
});
describe("weekly report reconciliation", () => {
  it("keeps missing files null, but a received file with no matching SKU is zero", () => {
    const data = base();
    expect(current(data)).toMatchObject({ serial_report_received: false, serials_reported: null, serial_match_pct: null });
    data.imports = [imp("report", "claim", [row("OTHER001", { sku: "OTHER" })])];
    expect(current(data)).toMatchObject({ serial_report_received: true, serials_reported: 0, serial_match_pct: 0 });
  });
  it("uses serial counts for missing sold columns, but preserves explicit SOH zero", () => {
    const data = base();
    data.imports = [imp("report", "claim", [row("SER001"), row("SER002", { rowIndex: 1 })])];
    data.snapshots[0].soldColumn = false; data.uploads[0].soldColumn = false; data.snapshots[0].sold = 0;
    expect(current(data)).toMatchObject({ sell_through: 2, sell_through_source: "serials", soh_sold: null, serial_match_pct: null });
    data.snapshots[0].soldColumn = true;
    expect(current(data)).toMatchObject({ sell_through: 0, sell_through_source: "soh", serial_match_pct: null });
    expect(current(data).alerts[0].severity).toBe("high");
  });
  it("does not count duplicate rows or later customer reports as additional sales", () => {
    const data = base();
    data.imports = [
      imp("first", "claim", [row("SER001"), row("SER001", { rowIndex: 1 })]),
      imp("later", "claim", [row("SER001")], { committedAt: "2026-09-22T00:00:00.000Z" }),
    ];
    expect(current(data).serials_reported).toBe(1);
  });
  it("respects the committed report's explicitly assigned week instead of upload week", () => {
    const data = base();
    data.imports = [imp("report", "claim", [row("SER001", { date: "2026-09-08" })])];
    data.reports = [{ sourceId: "report", accountId: 1, weekIso: week }];
    expect(current(data).serials_reported).toBe(1);
    expect(salesReconciliation(week, data).rows.find(r => r.week_iso === "2026-W37")?.serials_reported).toBeNull();
  });
  it("resolves serial-only SKU through invoice evidence, not an invented SKU or reporter", () => {
    const data = base();
    data.imports = [imp("dd", "evidence", [row("SER001", { date: "2026-09-14" })]), imp("report", "claim", [row("SER001", { sku: "" })])];
    expect(current(data).serials_reported).toBe(1);
    data.imports[1].accountId = null; data.imports[1].rows[0].accountId = null;
    expect(salesReconciliation(week, data).unmatched_serials).toBe(1);
    expect(current(data).serials_reported).toBeNull();
  });
  it("retains calendar gaps without fabricating SOH or sell-through zeroes", () => {
    const result = salesReconciliation(week, base());
    const gap = result.rows.find(r => r.week_iso === "2026-W37")!;
    expect(gap).toMatchObject({ soh: null, soh_reported: false, sell_through: null, serials_reported: null });
    expect(reconciledWeeklyCells(result.rows).some(c => c.week_iso === "2026-W37")).toBe(false);
  });
  it("keeps fallback provenance in existing heatmap totals and applies all filters", () => {
    const data = base();
    data.snapshots[0].soldColumn = false;
    data.imports = [imp("report", "claim", [row("SER001")])];
    const result = salesReconciliation(week, data, { resellerIds: [1], partIds: [10], category: "SSD" });
    expect(reconciledWeeklyCells(result.rows).find(c => c.week_iso === week))
      .toMatchObject({ units_sold: 1, serials_backed: true, reported_accounts: 1 });
    expect(salesReconciliation(week, data, { category: "Monitor" }).rows).toEqual([]);
    expect(salesReconciliation(week, data, { resellerIds: [2] }).rows).toEqual([]);
  });
  it("nets credits and deduplicates invoice events across DD sources", () => {
    const data = base();
    const invoice = row("SER001", { date: "2026-09-14" });
    data.imports = [imp("dd", "evidence", [invoice]), imp("repeat", "evidence", [invoice]),
      imp("credit", "evidence", [row("SER001", { date: "2026-09-15", invoice: "CREDIT", quantity: -1 })])];
    expect(current(data).dd_sell_in_week).toBe(0);
  });
  it("warns about outdated DD data and does not fill uncovered future weeks with zero", () => {
    const data = base();
    data.imports = [imp("dd", "evidence", [row("SER001", { date: "2026-09-08" })])];
    const result = salesReconciliation(week, data);
    expect(result.pronto_through).toBe("2026-09-08");
    expect(result.pronto_note).toContain("before the selected week");
    expect(current(data).dd_sell_in_week).toBeNull();
  });
  it("distinguishes a missing SKU from an entirely missing SOH report", () => {
    const data = base();
    data.snapshots = [];
    data.imports = [imp("report", "claim", [row("SER001")])];
    expect(current(data)).toMatchObject({ soh_reported: true, soh: null, soh_sold: null });
  });
  it("handles ISO year boundaries and true zero serial fallback", () => {
    expect(weekBounds("2020-W53")).toEqual({ start: "2020-12-28", end: "2021-01-03" });
    const data = base();
    data.snapshots[0].soldColumn = false;
    data.imports = [imp("report", "claim", [row("SER001", { sku: "OTHER" })])];
    expect(current(data)).toMatchObject({ sell_through: 0, sell_through_source: "serials", serials_reported: 0 });
  });
});
