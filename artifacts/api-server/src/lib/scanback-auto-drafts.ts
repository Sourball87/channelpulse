import type { ScanbackImportRow, ScanbackProgram } from "@workspace/api-zod";
import { isValidDateString } from "./dates";

export interface PromotionClaimRows {
  program: ScanbackProgram;
  accountId: number;
  rowIndices: number[];
}

export interface UnmatchedClaimRow {
  rowIndex: number;
  reason: "missing_customer_or_sale_date" | "no_matching_promotion" | "overlapping_promotions";
}

export function splitClaimRowsByPromotion(
  rows: ScanbackImportRow[],
  reportAccountId: number | null,
  programs: ScanbackProgram[],
): { groups: PromotionClaimRows[]; unmatched: UnmatchedClaimRow[] } {
  const grouped = new Map<string, PromotionClaimRows>();
  const unmatched: UnmatchedClaimRow[] = [];

  for (const row of rows) {
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
