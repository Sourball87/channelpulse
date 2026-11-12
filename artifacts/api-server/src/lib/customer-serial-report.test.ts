import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createCustomerSerialWorkbook } from "./customer-serial-report";

describe("customer serial report workbook", () => {
  it("creates an Excel lookup sheet with masked customer codes and source references", () => {
    const workbook = XLSX.read(createCustomerSerialWorkbook([{
      customerCode: "ca",
      customerName: "Computer Alliance",
      serial: "000123456789",
      sku: "MODEL-1",
      saleDate: "2026-10-14",
      reportName: "Computer Alliance October serial report.xlsx",
      sourceRow: "18",
    }]), { type: "buffer" });

    expect(workbook.SheetNames).toEqual(["Customer Serials"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Serials"], { header: 1 })).toEqual([
      ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
      ["CA", "000123456789", "MODEL-1", "2026-10-14", "CA October serial report.xlsx", "18"],
    ]);
  });

  it("still creates a header-only workbook when there are no matching sales", () => {
    const workbook = XLSX.read(createCustomerSerialWorkbook([]), { type: "buffer" });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Serials"], { header: 1 })).toEqual([
      ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
    ]);
  });
});
