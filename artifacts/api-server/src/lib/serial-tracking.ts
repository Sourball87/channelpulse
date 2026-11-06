import type { ScanbackImport } from "@workspace/api-zod";
import type { PoolClient } from "@workspace/db";
import { serialKey } from "./scanback-engine";

export interface ReportedSale {
  serial: string; reportId: string; reportName: string; rowIndex: number;
  accountId: number | null; sellDate: string; committedAt: string;
}

/** Immutable report facts are the SOLD ledger. Commit order, never a
 * backdated sale date or an earlier staged upload, decides the first source. */
export function reportedSales(reports: ScanbackImport[]): ReportedSale[] {
  return reports.filter(r => r.kind === "claim" && r.state === "committed")
    .sort((a, b) => (a.committedAt ?? a.createdAt).localeCompare(b.committedAt ?? b.createdAt) || a.id.localeCompare(b.id))
    .flatMap(r => [...r.rows].sort((a, b) => a.rowIndex - b.rowIndex).map(row => ({
      serial: serialKey(row.serial), reportId: r.id, reportName: r.name, rowIndex: row.rowIndex,
      accountId: row.accountId ?? r.accountId, sellDate: row.date, committedAt: r.committedAt ?? r.createdAt,
    })));
}
export function firstReportedSales(sales: ReportedSale[]): Map<string, ReportedSale> {
  const first = new Map<string, ReportedSale>();
  for (const sale of sales) if (!first.has(sale.serial)) first.set(sale.serial, sale);
  return first;
}
export function earlierReportReason(first: ReportedSale | undefined, reportId: string, rowIndex: number): string {
  if (!first || (first.reportId === reportId && first.rowIndex === rowIndex)) return "";
  return `Already reported sold in ${first.reportName} [${first.reportId}], row ${first.rowIndex + 2}` +
    (first.sellDate ? `, sell date ${first.sellDate}` : "") +
    (first.accountId != null ? `, reseller ID ${first.accountId}` : "");
}
export async function loadReportedSales(c: PoolClient): Promise<ReportedSale[]> {
  const rows = await c.query("SELECT payload FROM scanback_imports WHERE payload->>'kind'='claim' AND payload->>'state'='committed'");
  return reportedSales(rows.rows.map(r => r.payload as ScanbackImport));
}
