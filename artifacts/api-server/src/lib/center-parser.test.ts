import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectCenterKind, readCenterSheets, readCenterWorkbook, referenceMapping, parseReference, sheetsBuffer } from "./center-parser";

describe("unified intake detection", () => {
  it.each([
    [["SKU", "SOH", "Sold Last 7 Days"], "soh"],
    [["Customer", "Model", "QTY", "Serial", "Date"], "claim"],
    [["Invoice", "Invoice Date", "Account", "SKU", "Quantity", "Serial", "Unit Price"], "evidence"],
    [["SKU", "Serial", "Date", "Claim Amount", "Promotion", "Reference"], "unknown"],
    [["SKU", "Description", "RRP Inc", "DD Cost Ex", "T1 Buy Ex"], "price"],
    [["SKU", "GTM Buy Ex", "CA", "CC"], "program"],
    [["mystery", "value"], "unknown"],
  ])("detects %s as %s", (headers, expected) => {
    expect(detectCenterKind(headers)).toBe(expected);
  });
  it("never decides a financial type from a filename alone", () => {
    expect(detectCenterKind(["Amount", "Other"], "", "Approved Pronto claim history.xlsx")).toBe("unknown");
  });
  it("preserves CSV serials and ambiguous date text across correction round trips", () => {
    const sheets = readCenterSheets(Buffer.from("Serial,Date,Model\n000012345,03/04/2026,MZ-TEST\n"));
    expect(Object.values(sheets)[0][0]).toEqual({ Serial: "000012345", Date: "03/04/2026", Model: "MZ-TEST" });
    expect(readCenterSheets(sheetsBuffer(sheets))).toEqual(sheets);
  });
  it("finds price-table headers below workbook titles", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Distributor price list"], [], ["SKU", "Description", "RRP Inc", "DD Cost Ex", "T1 Buy Ex"],
      ["TEST", "Example", 110, 65, 90],
    ]), "Price list");
    const sheets = readCenterSheets(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect(Object.values(sheets)[0][0].SKU).toBe("TEST");
  });
  it("reads the spreadsheet document creation date", () => {
    const wb = XLSX.utils.book_new();
    wb.Props = { CreatedDate: new Date("2026-10-18T02:00:00.000Z") };
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["SKU", "SOH"], ["TEST", 10]]), "SOH");
    const parsed = readCenterWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect(parsed.fileCreatedAt).toBeTruthy();
    expect(new Date(parsed.fileCreatedAt as Date | string).toISOString()).toBe("2026-10-18T02:00:00.000Z");
  });
});
describe("reference data validation", () => {
  const headers = ["SKU", "Description", "RRP Inc", "DD Cost Ex", "T1 Buy Ex"];
  const row = { SKU: "test-1", Description: "Test", "RRP Inc": "110.01", "DD Cost Ex": "65.27", "T1 Buy Ex": "90.99" };
  it("stores prices in exact cents with distinct reference amounts", () => {
    const parsed = parseReference("price", [row], referenceMapping(headers));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ sku: "TEST-1", description: "Test", rrpIncCents: 11001, ddCostExCents: 6527, t1BuyExCents: 9099 });
  });
  it("rejects missing, invalid and duplicate prices rather than inventing zeroes", () => {
    const parsed = parseReference("price", [row, { ...row, "DD Cost Ex": "not a price" }], referenceMapping(headers));
    expect(parsed.errors.some(e => e.includes("duplicate SKU"))).toBe(true);
    expect(parsed.errors.some(e => e.includes("valid ddCostExCents"))).toBe(true);
    expect(parseReference("price", [], {}).errors).toContain("This worksheet has no data rows.");
  });
  it("preserves caps and requires positive GTM Buy Ex", () => {
    const rows = [{ SKU: "TEST", "GTM Buy Ex": "70.25", CA: 0, CC: "" }];
    const parsed = parseReference("program", rows, referenceMapping(Object.keys(rows[0])));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ sku: "TEST", gtmBuyCents: 7025, CA: 0, CC: "" });
    expect(parseReference("program", [{ SKU: "TEST", "GTM Buy Ex": 0 }], referenceMapping(Object.keys(rows[0]))).errors.length).toBeGreaterThan(0);
  });
});
