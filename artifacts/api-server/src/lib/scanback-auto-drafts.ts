import type { ScanbackImportRow, ScanbackProgram } from "@workspace/api-zod";
import { isValidDateString } from "./dates";
import { serialKey } from "./scanback-engine";

export interface PromotionClaimRows {
  program: ScanbackProgram;
  accountId: number;
  rowIndices: number[];
}

export interface UnmatchedClaimRow {
  rowIndex: number;
  reason: "missing_customer_or_sale_date" | "no_matching_promotion" | "overlapping_promotions";
}

export type InvoiceSkuIndex = Map<string, Set<string>>;
type InvoiceSkuRow = Pick<ScanbackImportRow, "serial" | "sku" | "accountId">;

export function buildInvoiceSkuIndex(invoiceRows: InvoiceSkuRow[]): InvoiceSkuIndex {
  const invoiceSkus: InvoiceSkuIndex = new Map();
  for (const invoice of invoiceRows) {
    if (invoice.accountId == null) continue;
    const serial = serialKey(invoice.serial);
    const sku = String(invoice.sku ?? "").trim().toUpperCase();
    if (!serial || !sku) continue;
    const key = `${invoice.accountId}|${serial}`;
    const skus = invoiceSkus.get(key) ?? new Set<string>();
    skus.add(sku);
    invoiceSkus.set(key, skus);
  }
  return invoiceSkus;
}

export function resolveMissingClaimSkus(
  rows: ScanbackImportRow[],
  reportAccountId: number | null,
  invoiceRowsOrIndex: InvoiceSkuRow[] | InvoiceSkuIndex,
): ScanbackImportRow[] {
  const invoiceSkus = invoiceRowsOrIndex instanceof Map
    ? invoiceRowsOrIndex
    : buildInvoiceSkuIndex(invoiceRowsOrIndex);

  return rows.map(row => {
    if (String(row.sku ?? "").trim()) return row;
    const accountId = row.accountId ?? reportAccountId;
    const serial = serialKey(row.serial);
    if (accountId == null || !serial) return row;
    const skus = invoiceSkus.get(`${accountId}|${serial}`);
    return skus?.size === 1 ? { ...row, sku: [...skus][0] } : row;
  });
}

export function splitClaimRowsByPromotion(
  rows: ScanbackImportRow[],
  reportAccountId: number | null,
  programs: ScanbackProgram[],
  invoiceRowsOrIndex: InvoiceSkuRow[] | InvoiceSkuIndex = [],
): { groups: PromotionClaimRows[]; unmatched: UnmatchedClaimRow[] } {
  const resolvedRows = resolveMissingClaimSkus(rows, reportAccountId, invoiceRowsOrIndex);
  return splitResolvedClaimRowsByPromotion(resolvedRows, reportAccountId, programs);
}

export function splitResolvedClaimRowsByPromotion(
  resolvedRows: ScanbackImportRow[],
  reportAccountId: number | null,
  programs: ScanbackProgram[],
): { groups: PromotionClaimRows[]; unmatched: UnmatchedClaimRow[] } {
  const grouped = new Map<string, PromotionClaimRows>();
  const unmatched: UnmatchedClaimRow[] = [];

  for (const row of resolvedRows) {
    const accountId = row.accountId ?? reportAccountId;
    if (accountId == null || !isValidDateString(row.date)) {
      unmatched.push({ rowIndex: row.rowIndex, reason: "missing_customer_or_sale_date" });
      continue;
    }

    const matches = programs.filter(program =>
      !program.archived && program.customerIds.includes(accountId) &&
      row.date >= program.start && row.date <= program.end &&
      program.lines.some(line =>
        String(line.sku ?? "").trim().toUpperCase() === row.sku.trim().toUpperCase(),
      ),
    );
    if (matches.length !== 1) {
      unmatched.push({
        rowIndex: row.rowIndex,
        reason: matches.length ? "overlapping_promotions" : "no_matching_promotion",
      });
      continue;
    }

    const program = matches[0];
    const key = `${program.id}|${accountId}`;
    const group = grouped.get(key) ?? { program, accountId, rowIndices: [] };
    group.rowIndices.push(row.rowIndex);
    grouped.set(key, group);
  }

  return { groups: [...grouped.values()], unmatched };
}
