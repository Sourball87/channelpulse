import * as XLSX from "xlsx";
import { maskCustomerCode, maskCustomerText } from "./customer-display";

export interface CustomerSerialReportRow {
  customerCode: string | null;
  customerName: string | null;
  serial: string;
  sku: string;
  saleDate: string;
  reportName: string;
  sourceRow: string | null;
}

export function createCustomerSerialWorkbook(rows: CustomerSerialReportRow[]): Buffer {
  const sheetRows: string[][] = [
    ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
    ...rows.map(row => [
      row.customerCode
        ? maskCustomerCode(row.customerCode)
        : maskCustomerText(row.customerName || "Unknown"),
      row.serial,
      row.sku,
      row.saleDate,
      maskCustomerText(row.reportName),
      row.sourceRow ?? "",
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), "Customer Serials");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
