/**
 * Unit tests for parser reseller detection functions.
 * Run with: pnpm --filter @workspace/api-server test
 */
import { describe, it, expect } from "vitest";
import {
  detectResellerFromFilename,
  detectResellerFromHeaders,
  tokenizeFilename,
  collapseStr,
  stableCollapsedFilename,
} from "./parser";
import type { ResellerProfile } from "./parser";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeReseller(id: number, code: string, name: string, patterns: string[] = [], aliases: string[] = []): ResellerProfile {
  return { id, code, name, filenamePatterns: patterns, aliases };
}

const RESELLERS: ResellerProfile[] = [
  makeReseller(1,  "ca",        "Computer Alliance"),
  makeReseller(2,  "ks",        "Kogan/Shopping"),
  makeReseller(3,  "scorptec",  "Scorptec"),
  makeReseller(4,  "umart",     "Umart"),
  makeReseller(5,  "ple",       "PLE Computers"),
  makeReseller(6,  "centrecom", "Centrecom"),
  makeReseller(7,  "pccg",      "PCCG"),
  makeReseller(8,  "jw",        "JW"),
  makeReseller(9,  "digi",      "DigiDirect"),
];

// ─── tokenizeFilename ─────────────────────────────────────────────────────────

describe("tokenizeFilename", () => {
  it("handles spaces and dashes", () => {
    expect(tokenizeFilename("2026 WK 28 Samsung SSD SOH reports - KS.xlsx"))
      .toEqual(["2026", "wk", "28", "samsung", "ssd", "soh", "reports", "ks"]);
  });

  it("handles underscores", () => {
    expect(tokenizeFilename("2026_WK_28_Samsung_Monitor_SOH_reports_-_KS.xlsx"))
      .toEqual(["2026", "wk", "28", "samsung", "monitor", "soh", "reports", "ks"]);
  });

  it("handles mixed separators", () => {
    // underscore and dash are delimiters; camelCase within a run is kept as-is
    expect(tokenizeFilename("SellThruAndSOH_2026-07-05.csv"))
      .toEqual(["sellthruandsoh", "2026", "07", "05"]);
  });
});

describe("stableCollapsedFilename", () => {
  it("removes numbers and week tokens", () => {
    const result = stableCollapsedFilename("2026 WK 28 Samsung SSD SOH reports - KS.xlsx");
    expect(result).toBe("samsungssdsohreportsks");
  });

  it("removes numbers and wk for underscore variant", () => {
    const result = stableCollapsedFilename("2026_WK_28_Samsung_Monitor_SOH_reports_-_KS.xlsx");
    expect(result).toBe("samsungmonitorsohreportsks");
  });
});

// ─── detectResellerFromFilename ───────────────────────────────────────────────

describe("detectResellerFromFilename", () => {
  it("KS: spaces + dash separators", () => {
    const r = detectResellerFromFilename("2026 WK 28 Samsung SSD SOH reports - KS.xlsx", RESELLERS);
    expect(r.resellerId).toBe(2);
    expect(r.resellerName).toBe("Kogan/Shopping");
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("KS: underscore separators", () => {
    const r = detectResellerFromFilename("2026_WK_28_Samsung_Monitor_SOH_reports_-_KS.xlsx", RESELLERS);
    expect(r.resellerId).toBe(2);
  });

  it("KS: mobility variant", () => {
    const r = detectResellerFromFilename("2026 WK 27 Samsung Mobility SOH Reports - KS.xlsx", RESELLERS);
    expect(r.resellerId).toBe(2);
  });

  it("'weeks' does NOT match KS", () => {
    const r = detectResellerFromFilename("inventory_weeks_report.xlsx", RESELLERS);
    expect(r.resellerId).not.toBe(2);
    expect(r.candidates.map(c => c.code)).not.toContain("ks");
  });

  it("'stocks' does NOT match KS", () => {
    const r = detectResellerFromFilename("stocks_2026.xlsx", RESELLERS);
    expect(r.resellerId).not.toBe(2);
    expect(r.candidates.map(c => c.code)).not.toContain("ks");
  });

  it("CA: resolved via 'computeralliance' in filename", () => {
    const r = detectResellerFromFilename("ComputerAlliance_SOH_2026-07-05.xlsx", RESELLERS);
    expect(r.resellerId).toBe(1);
  });

  it("CA: 'cable' does NOT match CA (token 'ca' not present)", () => {
    const r = detectResellerFromFilename("cable_report.xlsx", RESELLERS);
    expect(r.candidates.map(c => c.code)).not.toContain("ca");
  });

  it("Scorptec: resolved", () => {
    const r = detectResellerFromFilename("Scorptec_inventory_2026-07-05.csv", RESELLERS);
    expect(r.resellerId).toBe(3);
  });

  it("Umart: resolved via 'umart'", () => {
    const r = detectResellerFromFilename("Umart_2026-07-05.csv", RESELLERS);
    expect(r.resellerId).toBe(4);
  });

  it("PLE: resolved via 'ple' token", () => {
    const r = detectResellerFromFilename("ReportingProcurementCustom_2026.xlsx", RESELLERS);
    expect(r.resellerId).toBe(5);
  });

  it("JW: resolved via 'jw' token", () => {
    const r = detectResellerFromFilename("JW_weekly_2026_W27.xlsx", RESELLERS);
    expect(r.resellerId).toBe(8);
  });

  it("PCCG: resolved", () => {
    const r = detectResellerFromFilename("PCCG_inventory_report_2026.xlsx", RESELLERS);
    expect(r.resellerId).toBe(7);
  });

  it("DigiDirect: resolved via 'digidirect'", () => {
    const r = detectResellerFromFilename("DigiDirect_weekly_2026.xlsx", RESELLERS);
    expect(r.resellerId).toBe(9);
  });

  it("generic file: returns no match", () => {
    const r = detectResellerFromFilename("report_2026-W27.xlsx", RESELLERS);
    expect(r.resellerId).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it("ambiguous file: returns null with candidates listed", () => {
    // A hypothetical file that mentions both 'ca' and 'ks'
    const r = detectResellerFromFilename("ca_ks_combined_report.xlsx", RESELLERS);
    expect(r.resellerId).toBeNull();
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("DB filename pattern match (learned): exact token for short pattern", () => {
    const ksWithPattern = makeReseller(2, "ks", "Kogan/Shopping", ["samsungssdsohreportsks"]);
    const resellersWithLearned = [makeReseller(1, "ca", "Computer Alliance"), ksWithPattern];
    const r = detectResellerFromFilename("2026 WK 28 Samsung SSD SOH reports - KS.xlsx", resellersWithLearned);
    expect(r.resellerId).toBe(2);
  });
});

// ─── detectResellerFromHeaders ────────────────────────────────────────────────

const CA_KS_HEADERS = ["Model", "StockOnHand", "StockOnOrder", "SoldLast7Days", "SoldMTD", "AverageCostExGST"];
const SCORPTEC_HEADERS = ["Category", "Model", "OnHand", "SoldLast7Days", "ItemAverageCostExGST", "ItemAverageCostIncGST", "QtyOnOrder"];
const PLE_HEADERS = ["InventoryItemID", "ManufacturerModel", "QuantityOnHand", "QuantityOnOrder", "InvoicedQuantity", "AverageCostExTax"];
const UMART_HEADERS = ["SAPCode", "SKU", "TotalOnHand", "OtherOnHand", "DaysToSale", "OnOrderQty", "SoldQty"];
const JW_HEADERS = ["ModelCode", "SOH", "SoldLast7Days", "SoldMTD", "QtyOnPO", "AvgCost"];
const CENTRECOM_HEADERS = ["ProductName", "ProductModel", "30D", "14D", "7D", "Stock", "AvgStockValue"];
const V_REPORT_HEADERS = ["PartNumber", "SOH", "SoldLast7Days", "SoldMTD", "AvgCost"];

describe("detectResellerFromHeaders", () => {
  it("CA/KS format: sheet 'ComputerAlliance' → CA", () => {
    const r = detectResellerFromHeaders(CA_KS_HEADERS, "ComputerAlliance", RESELLERS);
    expect(r.resellerId).toBe(1);
    expect(r.formatId).toBe("ca_ks_weekly");
    expect(r.resolutionSource).toBe("sheet_name");
  });

  it("CA/KS format: sheet 'Samsung SOH report' → KS", () => {
    const r = detectResellerFromHeaders(CA_KS_HEADERS, "Samsung SOH report", RESELLERS);
    expect(r.resellerId).toBe(2);
    expect(r.formatId).toBe("ca_ks_weekly");
    expect(r.resolutionSource).toBe("sheet_name");
  });

  it("CA/KS format: sheet 'Sheet1' → ambiguous, candidates [CA, KS]", () => {
    const r = detectResellerFromHeaders(CA_KS_HEADERS, "Sheet1", RESELLERS);
    expect(r.resellerId).toBeNull();
    expect(r.formatId).toBe("ca_ks_weekly");
    expect(r.candidates.map(c => c.code).sort()).toEqual(["ca", "ks"]);
    expect(r.resolutionSource).toBeNull();
  });

  it("CA/KS format: filename token result for KS breaks the tie", () => {
    const filenameResult = { resellerId: 2, resellerName: "KS", confidence: 0.9, candidates: [RESELLERS[1]] };
    const r = detectResellerFromHeaders(CA_KS_HEADERS, null, RESELLERS, filenameResult);
    expect(r.resellerId).toBe(2);
    expect(r.resolutionSource).toBe("filename_token");
  });

  it("Scorptec: unique format → resolved without sheet name", () => {
    const r = detectResellerFromHeaders(SCORPTEC_HEADERS, null, RESELLERS);
    expect(r.resellerId).toBe(3);
    expect(r.formatId).toBe("scorptec_csv");
    expect(r.resolutionSource).toBe("format_unique");
  });

  it("PLE: unique format → resolved", () => {
    const r = detectResellerFromHeaders(PLE_HEADERS, null, RESELLERS);
    expect(r.resellerId).toBe(5);
    expect(r.formatId).toBe("ple_weekly");
    expect(r.resolutionSource).toBe("format_unique");
  });

  it("Centrecom ItemForcastReport: unique format → resolved", () => {
    const r = detectResellerFromHeaders(UMART_HEADERS, "ItemForcastReport", RESELLERS);
    expect(r.resellerId).toBe(6);
    expect(r.formatId).toBe("centrecom_forecast");
  });

  it("JW: unique format → resolved", () => {
    const r = detectResellerFromHeaders(JW_HEADERS, null, RESELLERS);
    expect(r.resellerId).toBe(8);
    expect(r.formatId).toBe("jw_weekly");
    expect(r.resolutionSource).toBe("format_unique");
  });

  it("Centrecom: unique format → resolved", () => {
    const r = detectResellerFromHeaders(CENTRECOM_HEADERS, null, RESELLERS);
    expect(r.resellerId).toBe(6);
    expect(r.formatId).toBe("centrecom_legacy");
    expect(r.resolutionSource).toBe("format_unique");
  });

  it("V-Report: unhelpful filename → resellerId null, candidates listed, confidence 0", () => {
    const r = detectResellerFromHeaders(V_REPORT_HEADERS, null, RESELLERS);
    expect(r.resellerId).toBeNull();
    expect(r.formatId).toBe("v_report");
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.confidence).toBe(0);
    expect(r.resolutionSource).toBeNull();
  });

  it("V-Report: learned fingerprint breaks the tie", async () => {
    const { computeHeaderFingerprint } = await import("./parser");
    const fingerprint = computeHeaderFingerprint(V_REPORT_HEADERS);
    const learned = new Map([[fingerprint, 7]]); // 7 = PCCG
    const r = detectResellerFromHeaders(V_REPORT_HEADERS, null, RESELLERS, undefined, learned);
    expect(r.resellerId).toBe(7);
    expect(r.resolutionSource).toBe("learned");
  });

  it("no matching format → resellerId null, formatId null", () => {
    const r = detectResellerFromHeaders(["foo", "bar", "baz"], null, RESELLERS);
    expect(r.resellerId).toBeNull();
    expect(r.formatId).toBeNull();
  });
});
