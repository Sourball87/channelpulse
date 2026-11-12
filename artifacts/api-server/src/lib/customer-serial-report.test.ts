import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { createCustomerSerialWorkbook, resolveCustomerSerialSaleDate } from "./customer-serial-report";

describe("customer serial report workbook", () => {
  it("recovers an unmapped source date using its stored date order", () => {
    expect(resolveCustomerSerialSaleDate("", "20261026", "dmy")).toBe("2026-10-26");
    expect(resolveCustomerSerialSaleDate("2026-10-20", "20261026", "dmy")).toBe("2026-10-20");
  });

  it("shows a per-customer summary before the full lookup sheet", () => {
    const workbook = XLSX.read(createCustomerSerialWorkbook([
      {
        customerCode: "ks",
        customerName: "KS Computer Technology",
        serial: "000123456789",
        sku: "MODEL-1",
        saleDate: "2026-10-14",
        reportName: "KS October serial report.xlsx",
        sourceRow: "18",
      },
      {
        customerCode: "ple",
        customerName: "PLE Computers",
        serial: "SERIAL-2",
        sku: "MODEL-2",
        saleDate: "2026-10-20",
        reportName: "PLE October serial report.xlsx",
        sourceRow: "25",
      },
      {
        customerCode: "umart",
        customerName: "Umart",
        serial: "SERIAL-3",
        sku: "MODEL-3",
        saleDate: "2026-10-21",
        reportName: "Umart October serial report.xlsx",
        sourceRow: "31",
      },
      {
        customerCode: "ks",
        customerName: "KS Computer Technology",
        serial: "000123456789",
        sku: "MODEL-1",
        saleDate: "2026-10-16",
        reportName: "KS October serial report.xlsx",
        sourceRow: "22",
      },
    ]), { type: "buffer" });

    expect(workbook.SheetNames).toEqual(["Customer Summary", "Customer Serials"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Summary"], { header: 1 })).toEqual([
      ["Customer", "Serial Rows", "Unique Serials", "First Sale Date", "Last Sale Date"],
      ["KS", 2, 1, "2026-10-14", "2026-10-16"],
      ["PL", 1, 1, "2026-10-20", "2026-10-20"],
      ["UM", 1, 1, "2026-10-21", "2026-10-21"],
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Serials"], { header: 1 })).toEqual([
      ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
      ["KS", "000123456789", "MODEL-1", "2026-10-14", "KS October serial report.xlsx", "18"],
      ["PL", "SERIAL-2", "MODEL-2", "2026-10-20", "PL October serial report.xlsx", "25"],
      ["UM", "SERIAL-3", "MODEL-3", "2026-10-21", "UM October serial report.xlsx", "31"],
      ["KS", "000123456789", "MODEL-1", "2026-10-16", "KS October serial report.xlsx", "22"],
    ]);
  });

  it("still creates a header-only workbook when there are no matching sales", () => {
    const workbook = XLSX.read(createCustomerSerialWorkbook([]), { type: "buffer" });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Summary"], { header: 1 })).toEqual([
      ["Customer", "Serial Rows", "Unique Serials", "First Sale Date", "Last Sale Date"],
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Customer Serials"], { header: 1 })).toEqual([
      ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
    ]);
  });
});
