import { describe, expect, it } from "vitest";
import { analyzeReportData, type ResellerProfile } from "./parser";
import { diagnoseUpload, reanalyzeStoredUpload, selectReportingWeek, withMappings, type Recognition } from "./upload-review";

const profiles: ResellerProfile[] = [
  { id: 1, code: "umart", name: "Umart", aliases: [], filenamePatterns: [] },
  { id: 2, code: "ca", name: "Computer Alliance", aliases: [], filenamePatterns: [] },
  { id: 3, code: "ks", name: "KS Computer Tech", aliases: [], filenamePatterns: [] },
];
const headers = ["SapCode", "Sku", "TotalOnHand", "OtherOnHand", "DaysToSale", "OnOrderQty", "SoldQty"];
const cells = { SapCode: 1, Sku: "MZ-V9P1T0BW", TotalOnHand: 12, OtherOnHand: 0, DaysToSale: 6, OnOrderQty: 2, SoldQty: 3 };
function report(filename = "Umart_2026-07-05.xlsx") {
  return analyzeReportData({ filename, headers, rawRows: [cells], sheetName: "ItemForcastReport", fileHash: "test", parserUsed: "stored" }, profiles);
}
const metadata = (): Recognition => ({ version: 1, sheetName: "ItemForcastReport", weekSource: "filename" });

describe("actionable review reasons", () => {
  it("marks a clean known report ready and auto-eligible", () => {
    expect(diagnoseUpload(report(), false, metadata())).toEqual({ reasons: [], ready: true, autoEligible: true });
  });
  it("shows missing week, conflict and legacy reasons independently", () => {
    const r = report("Umart.xlsx");
    expect(diagnoseUpload(r, true, null).reasons.map(r => r.code)).toEqual(expect.arrayContaining(["missing_week", "snapshot_conflict", "legacy_recheck"]));
    expect(diagnoseUpload(r, true, null).autoEligible).toBe(false);
  });
  it("reports duplicated canonical fields, duplicated source columns and unsupported fields", () => {
    for (const mappings of [
      [...report().mappings, { source_col: "OtherOnHand", canonical_field: "soh", confidence: 1, sample_values: [] }],
      [...report().mappings, report().mappings[0]],
      report().mappings.map(m => m.source_col === "Sku" ? { ...m, canonical_field: "unknown" } : m),
    ]) {
      const d = diagnoseUpload(withMappings(report(), mappings), false, metadata());
      expect(d.reasons.some(r => r.code === "invalid_mapping")).toBe(true);
      expect(d.autoEligible).toBe(false);
    }
  });
  it("counts flags using the final mappings and detects duplicate SKUs", () => {
    const r = report();
    r.rawRows = [{ ...cells, TotalOnHand: -2 }, cells];
    const mapped = withMappings(r, r.mappings);
    expect(mapped.rowsFlagged).toBe(1);
    expect(diagnoseUpload(mapped, false, metadata()).reasons.map(r => r.code)).toEqual(expect.arrayContaining(["flagged_rows", "duplicate_sku"]));
  });
  it("blocks invalid numeric cells rather than silently committing a zero", () => {
    const r = report();
    const mapped = withMappings({ ...r, rawRows: [{ ...cells, SoldQty: "bad" }] }, r.mappings);
    expect(diagnoseUpload(mapped, false, metadata()).reasons.map(r => r.code)).toContain("invalid_numbers");
    expect(diagnoseUpload(mapped, false, metadata()).autoEligible).toBe(false);
  });
  it("explains ambiguous reseller and filename/header disagreement", () => {
    const r = { ...report(), detectedResellerId: null, detectionReasoning: "Filename and report format/sheet identify different resellers." };
    expect(diagnoseUpload(r, false, metadata()).reasons.map(r => r.code)).toEqual(expect.arrayContaining(["ambiguous_reseller", "detection_conflict"]));
  });
  it("never auto-commits AI suggestions, including a seemingly clean result", () => {
    const m = metadata();
    m.ai = { status: "suggested", message: "Review evidence" };
    expect(diagnoseUpload(report(), false, m).autoEligible).toBe(false);
    expect(diagnoseUpload(report(), false, m).reasons.map(r => r.code)).toContain("ai_suggestion");
  });
  it("keeps automatic-commit failures actionable across reloads", () => {
    const m = { ...metadata(), commitDeferred: true };
    const review = diagnoseUpload(report(), false, m);
    expect(review.ready).toBe(false);
    expect(review.reasons.map(r => r.code)).toContain("automatic_commit_deferred");
  });
});

describe("reporting week provenance", () => {
  it("uses a batch week only for an undated report", () => {
    const m = metadata();
    const r = selectReportingWeek(report("Umart_(2).xlsx"), m, "2026-W26");
    expect(r.detectedWeekIso).toBe("2026-W26");
    expect(m.weekSource).toBe("batch");
    expect(m.confirmedWeek).toBe("2026-W26");
    const dated = metadata();
    expect(selectReportingWeek(report(), dated, "2026-W26").detectedWeekIso).toBe("2026-W27");
    expect(dated.weekSource).toBe("filename");
  });
  it("preserves explicitly confirmed per-file and batch weeks across rechecks", () => {
    for (const weekSource of ["manual", "batch"] as const) {
      const m = { ...metadata(), weekSource, confirmedWeek: "2026-W26" };
      expect(selectReportingWeek(report(), m, "2026-W25").detectedWeekIso).toBe("2026-W26");
      expect(m.weekSource).toBe(weekSource);
    }
  });
  it("rejects invalid batch weeks and does not promote an AI suggestion to confirmation", () => {
    const m: Recognition = { ...metadata(), weekSource: "ai_suggested", confirmedWeek: "2026-W28" };
    expect(selectReportingWeek(report("Umart.xlsx"), m, "2025-W53").detectedWeekIso).toBeNull();
    expect(m.weekSource).toBeNull();
  });
});

describe("legacy rechecks", () => {
  it("uses persisted raw cells, not legacy guessed week, flags or attribution", () => {
    const source = { filename: "Umart.xlsx", rawHeaders: headers, rawRows: [cells], fileHash: "test",
      parserUsed: "sheetjs", recognition: null, weekIso: "2026-W28", rowsFlagged: 8, resellerId: 99 };
    const before = JSON.stringify(source);
    const { result, recognition, metadataMissing } = reanalyzeStoredUpload(source, profiles);
    expect(result.detectedWeekIso).toBeNull();
    expect(result.rowsFlagged).toBe(0);
    expect(result.detectedResellerId).toBe(1);
    expect(metadataMissing).toBe(true);
    expect(recognition.sheetName).toBeNull();
    expect(JSON.stringify(source)).toBe(before);
  });
  it("does not invent lost ComputerAlliance sheet metadata", () => {
    const raw = { Model: "MZ-V9P1T0BW", "Stock On Hand": 12, "Stock On order": 2, "Sold Last 7 Days": 3, "Sold MTD": 6, "Average Cost (Ex GST)": 100 };
    const source = { filename: "samsung_soh_report.xlsx", rawHeaders: Object.keys(raw), rawRows: [raw],
      fileHash: "test", parserUsed: "sheetjs", recognition: null };
    const legacy = reanalyzeStoredUpload(source, profiles);
    expect(legacy.result.detectedResellerId).toBeNull();
    const evidenced = reanalyzeStoredUpload({ ...source, recognition: { ...metadata(), sheetName: "ComputerAlliance" } }, profiles);
    expect(evidenced.result.detectedResellerId).toBe(2);
    const second = reanalyzeStoredUpload({ ...source, recognition: legacy.recognition }, profiles);
    expect(second.metadataMissing).toBe(true);
  });
  it("returns empty diagnostics with a re-upload instruction if raw data is missing", () => {
    const { result } = reanalyzeStoredUpload({ filename: "Umart.xlsx", rawHeaders: null, rawRows: null,
      fileHash: "test", parserUsed: null, recognition: null }, profiles);
    expect(result.rowsParsed).toBe(0);
    expect(diagnoseUpload(result, false, null).reasons.map(r => r.code)).toContain("empty_rows");
  });
});
