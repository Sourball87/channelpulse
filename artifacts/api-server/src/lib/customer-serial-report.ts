import * as XLSX from "xlsx";
import { maskCustomerCode, maskCustomerText } from "./customer-display";
import { parseDateValue, type DateOrder } from "./dates";

export interface CustomerSerialReportRow {
  customerCode: string | null;
  customerName: string | null;
  serial: string;
  sku: string;
  saleDate: string;
  reportName: string;
  sourceRow: string | null;
}

export function resolveCustomerSerialSaleDate(
  parsedDate: string,
  sourceDate: unknown,
  dateOrder: DateOrder,
): string {
  return parsedDate || parseDateValue(sourceDate, dateOrder);
}

function displayCustomer(row: CustomerSerialReportRow): string {
  return row.customerCode
    ? maskCustomerCode(row.customerCode)
    : maskCustomerText(row.customerName || "Unknown");
}

export function createCustomerSerialWorkbook(rows: CustomerSerialReportRow[]): Buffer {
  const summaryByCustomer = new Map<string, {
    serials: Set<string>;
    rowCount: number;
    dates: string[];
  }>();
  for (const row of rows) {
    const customer = displayCustomer(row);
    const summary = summaryByCustomer.get(customer) ?? { serials: new Set<string>(), rowCount: 0, dates: [] };
    summary.serials.add(row.serial);
    summary.rowCount++;
    if (row.saleDate) summary.dates.push(row.saleDate);
    summaryByCustomer.set(customer, summary);
  }

  const summaryRows: (string | number)[][] = [
    ["Customer", "Serial Rows", "Unique Serials", "First Sale Date", "Last Sale Date"],
    ...[...summaryByCustomer.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([customer, summary]) => {
        const dates = summary.dates.sort();
        return [
          customer,
          summary.rowCount,
          summary.serials.size,
          dates[0] ?? "",
          dates.at(-1) ?? "",
        ];
      }),
  ];
  const detailRows: string[][] = [
    ["Customer", "Serial Number", "SKU", "Sale Date", "Source Report", "Source Row"],
    ...rows.map(row => [
      displayCustomer(row),
      row.serial,
      row.sku,
      row.saleDate,
      maskCustomerText(row.reportName),
      row.sourceRow ?? "",
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Customer Summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(detailRows), "Customer Serials");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
