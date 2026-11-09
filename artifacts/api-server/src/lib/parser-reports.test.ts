import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  detectWeekFromFilename, isValidWeekIso, isAutoCommitEligible,
  applyMappingsToRows, mapHeaders, type ResellerProfile,
} from "./parser";
import { parseFile } from "./file-parser";

const profiles: ResellerProfile[] = [
  [1, "CA", "Computer Alliance"], [2, "centrecom", "Centrecom"],
  [3, "scorptec", "Scorptec"], [4, "ple", "PLE Computers"],
  [5, "pccg", "PCCG"], [6, "umart", "Umart"],
  [7, "ks", "KS Computer Tech"], [8, "jw", "JW Computers"], [9, "digi", "DigiDirect"],
].map(([id, code, name]) => ({
  id: Number(id), code: String(code), name: String(name), aliases: [], filenamePatterns: [],
}));

function workbook(headers: (string | null)[], row: unknown[], sheet = "Sheet1", legacy = false) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, row]), sheet);
  return XLSX.write(book, { type: "buffer", bookType: legacy ? "biff8" : "xlsx" }) as Buffer;
}

const shared = ["Model", "Stock On Hand", "Stock On order", "Sold Last 7 Days", "Sold MTD", "Average Cost (Ex GST)", null];
const umart = ["SapCode", "Sku", "TotalOnHand", "OtherOnHand", "DaysToSale", "OnOrderQty", "SoldQty", "SapPrice", "Cost",
  "TotalOnHandAllWHRevenue", "Revenue", "Ageing90", "Ageing90Cost", "Ageing120", "Ageing120Cost"];
const fixtures = [
  { filename: "Samsung HDD Weekly.xlsx", code: "jw", week: null, sheet: "Sheet1",
    headers: ["Model Code", "SOH", "Sold Last 7 Days", "Sold MTD", "Qty On PO", "Avg Cost"],
    row: ["MZ-V9P1T0BW", 12, 3, 7, 2, 99], soh: 12, sold: 3 },
  { filename: "Samsung Monitor + SSD SOH 29.06.2026.xls", code: "pccg", week: "2026-W27", sheet: "Forecast",
    headers: ["Product Name", "Product Model", "30 D", "14 D", "7 D", "Stock", "Avg Stock Value"],
    row: ["Samsung monitor", "LS24F320GAEXXY", 20, 10, 5, 8, 99], soh: 8, sold: 5 },
  { filename: "ReportingProcurementCustom--Samsung-SSD.csv", code: "ple", week: null, sheet: "CSV",
    headers: ["InventoryItemId", "ManufacturerModel", "QuantityOnHand", "QuantityOnOrder", "InvoicedQuantity", "AverageCostExTax"],
    row: [644779, "MZ-77E1T0BW", 3, 4, 2, 400], soh: 3, sold: 2 },
  { filename: "Scorptec_stock_on_hand_175_20260705060455.csv", code: "scorptec", week: "2026-W27", sheet: "CSV",
    headers: ["#", "Category", "Model", "On Hand", "Sold Last 7 Days", "Item Average Cost (Ex GST)", "Item Average Cost (Inc GST)", "Qty On Order"],
    row: [1, "SSD", "MZ-77E1T0BW", 9, 2, 100, 110, 3], soh: 9, sold: 2 },
  { filename: "V. Report - Samsung.xlsx", code: null, week: null, sheet: "Sheet1",
    headers: ["Part Number", "SOH", "Sold last 7 days", "Sold MTD", "AVG Cost"],
    row: ["MZ-77E1T0BW", 4, 1, 2, 100], soh: 4, sold: 1 },
  { filename: "samsung_soh_report_(1).xlsx", code: "ca", week: null, sheet: "ComputerAlliance",
    headers: shared, row: ["MZ-77E1T0BW", 10, 0, 2, 4, 100, null], soh: 10, sold: 2 },
  { filename: "Samsung_ssd_sell_thru_and_soh_Report_2026-06-29_2026-07-05.xlsx", code: "centrecom", week: "2026-W27", sheet: "ItemForcastReport",
    headers: umart, row: [1234, "MZ-77E1T0BW", 12, 1, 30, 4, 3, 150, 100, 1200, 300, 2, 200, 1, 100], soh: 12, sold: 3 },
  ...[
    ["SSD", "MZ-V9P1T0BW"], ["Mobility", "SM-S918BZKASTS"], ["Monitor", "LS24F320GAEXXY"],
  ].map(([category, part]) => ({
    filename: `2026 WK 27 Samsung ${category} SOH reports - KS.xlsx`, code: "ks", week: "2026-W27",
    sheet: "Samsung SOH report", headers: shared, row: [part, 10, 0, 2, 4, 100, null], soh: 10, sold: 2,
  })),
];

describe("supported real-report structures", () => {
  it("recognises the W26 Umart purchase-column variant without treating purchases as sales", async () => {
    const headers = [...umart, "PurchaseQty", "PurchaseValue"];
    const result = await parseFile(
      workbook(headers, [1234, "MZ-77E1T0BW", 12, 1, 30, 4, 3, 150, 100, 1200, 300, 2, 200, 1, 100, -4, -400]),
      "Samsung_ssd_sell_thru_and_soh_Report_2026-06-22_2026-06-28.xlsx",
      profiles,
    );
    expect(result.detectedFormatId).toBe("centrecom_forecast");
    expect(result.detectedWeekIso).toBe("2026-W26");
    expect(result.rows[0]).toMatchObject({ soh: 12, sell_through_7d: 3, avg_cost: 100, flagged: false });
    expect(result.mappings.filter(m => m.source_col.startsWith("Purchase")).every(m => m.canonical_field === null)).toBe(true);
    expect(isAutoCommitEligible(result)).toBe(true);
  });
  for (const fixture of fixtures) {
    it(`recognises and maps ${fixture.filename}`, async () => {
      const buf = fixture.filename.endsWith(".csv")
        ? Buffer.from([fixture.headers.join(","), fixture.row.join(",")].join("\r\n"))
        : workbook(fixture.headers, fixture.row, fixture.sheet, fixture.filename.endsWith(".xls"));
      const parsed = await parseFile(buf, fixture.filename, profiles);
      const code = profiles.find(p => p.id === parsed.detectedResellerId)?.code.toLowerCase() ?? null;
      expect(code).toBe(fixture.code);
      expect(parsed.detectedWeekIso).toBe(fixture.week);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].soh).toBe(fixture.soh);
      expect(parsed.rows[0].sell_through_7d).toBe(fixture.sold);
      expect(parsed.headers).not.toContain("__EMPTY");
      if (fixture.code === "centrecom" && fixture.sheet !== "ItemForcastReport") {
        expect(parsed.rows[0].sold_14d).toBe(10);
        expect(parsed.rows[0].sold_30d).toBe(20);
      }
      if (!fixture.week || !fixture.code) expect(isAutoCommitEligible(parsed)).toBe(false);
      if (fixture.code === null) {
        expect(parsed.detectedCandidates.map(p => p.code)).toEqual(["pccg", "digi"]);
      }
    });
  }
});

describe("week safety", () => {
  it("does not interpret workspace attachment suffixes as report dates", () => {
    expect(detectWeekFromFilename("Samsung_HDD_Weekly_1792967158351.xlsx").weekIso).toBeNull();
    expect(detectWeekFromFilename("Scorptec_stock_on_hand_175_20260705060455_1792967158460.csv").weekIso).toBe("2026-W27");
  });
  it("rejects invalid calendar dates and week numbers", () => {
    expect(detectWeekFromFilename("report_31.02.2026.xls").weekIso).toBeNull();
    expect(detectWeekFromFilename("2026 WK 99.xlsx").weekIso).toBeNull();
    expect(isValidWeekIso("2025-W53")).toBe(false);
    expect(isValidWeekIso("2026-W53")).toBe(true);
    expect(isValidWeekIso("2026-W00")).toBe(false);
    expect(isValidWeekIso("NaN-WNaN")).toBe(false);
  });
  it("uses the end of a date range and handles ISO year boundaries", () => {
    expect(detectWeekFromFilename("report_21-09-2026_-_27-09-2026.xlsx").weekIso).toBe("2026-W39");
    expect(detectWeekFromFilename("report_2025-12-29_2026-01-04.xlsx").weekIso).toBe("2026-W01");
  });
});

describe("no silent data corruption", () => {
  it("trusts a unique filename customer over a conflicting format/sheet hint", async () => {
    const result = await parseFile(workbook(shared, ["MZ-V9P1T0BW", 10, 0, 2, 4, 100, null], "ComputerAlliance"),
      "2026 WK 27 report KS.xlsx", profiles);
    expect(result.detectedResellerId).toBe(7);
    expect(result.detectedCandidates.map(candidate => candidate.code)).toEqual(["ks"]);
    expect(result.detectionReasoning).not.toContain("different resellers");
  });
  it("blocks auto-commit for flags, overwrite, learned results or duplicate SKUs", async () => {
    const result = await parseFile(workbook(umart, [1, "MZ-V9P1T0BW", 10, 0, 10, 0, 2, 10, 10]),
      "Centrecom_2026-07-05.xlsx", profiles);
    expect(isAutoCommitEligible(result)).toBe(true);
    expect(isAutoCommitEligible(result, result.mappings, true)).toBe(false);
    expect(isAutoCommitEligible({ ...result, headerResolutionSource: "learned" })).toBe(false);
    expect(isAutoCommitEligible({ ...result, rawRows: [...result.rawRows, ...result.rawRows] })).toBe(false);
    expect(isAutoCommitEligible({ ...result, rawRows: [{ ...result.rawRows[0], TotalOnHand: -1 }] })).toBe(false);
    expect(isAutoCommitEligible({ ...result, rawRows: [{ ...result.rawRows[0], TotalOnHand: "bad value" }] })).toBe(false);
  });
  it("never auto-commits V-Report, even with a filename tie-break", async () => {
    const result = await parseFile(workbook(["Part Number", "SOH", "Sold last 7 days", "Sold MTD", "AVG Cost"],
      ["MZ-V9P1T0BW", 4, 1, 2, 100]), "PCCG_2026-07-05.xlsx", profiles);
    expect(isAutoCommitEligible(result)).toBe(false);
  });
  it("ignores blank/total rows, normalises SKU case and preserves negative stock as flagged", () => {
    const rows = [
      { Model: "mz-v9p1t0bw", SOH: "-2", "Sold Last 7 Days": "3" },
      { Model: "Grand Total", SOH: "20", "Sold Last 7 Days": "30" },
      { Model: "", SOH: "20", "Sold Last 7 Days": "30" },
    ];
    const parsed = applyMappingsToRows(rows, mapHeaders(Object.keys(rows[0]), rows));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ part_no: "MZ-V9P1T0BW", soh: -2, flagged: true });
  });
  it("keeps valid Samsung business monitor prefixes", () => {
    const rows = [{ Model: "LC34G55TWWEXXY", SOH: "12", "Sold Last 7 Days": "3" }];
    expect(applyMappingsToRows(rows, mapHeaders(Object.keys(rows[0]), rows))[0].flagged).toBe(false);
  });
  it("preserves formatted currency costs rather than silently returning null", () => {
    const rows = [{ Model: "MZ-V9P1T0BW", SOH: "1,234", "Sold Last 7 Days": "3", "AVG Cost": "$1,203.32" }];
    const parsed = applyMappingsToRows(rows, mapHeaders(Object.keys(rows[0]), rows));
    expect(parsed[0]).toMatchObject({ soh: 1234, avg_cost: 1203.32, flagged: false });
  });
});
