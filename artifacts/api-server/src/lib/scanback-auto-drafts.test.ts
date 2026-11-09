import { describe, expect, it } from "vitest";
import type { ScanbackImportRow, ScanbackProgram } from "@workspace/api-zod";
import { splitClaimRowsByPromotion } from "./scanback-auto-drafts";

const promotion = (id: string, start: string, end: string, customerIds = [7], skus = ["SKU"]): ScanbackProgram => ({
  id, name: id, version: 1, start, end, archived: false, notes: "", createdAt: "",
  customerIds, lines: skus.map(sku => ({ sku, gtmBuyCents: 0, caps: [] })),
});
const row = (rowIndex: number, date: string, accountId: number | null = 7, sku = "SKU"): ScanbackImportRow => ({
  rowIndex, serial: `SERIAL${rowIndex}`, sku, date, accountId, quantity: 1,
  invoice: "", unitPriceCents: null, amountCents: null, program: "", reference: "",
});

describe("automatic promotion assignment", () => {
  it("splits one serial report across promotions using customer sold dates", () => {
    const result = splitClaimRowsByPromotion([
      row(0, "2026-09-30"), row(1, "2026-10-01"),
    ], 7, [
      promotion("sept", "2026-09-01", "2026-09-30"),
      promotion("oct", "2026-10-01", "2026-10-31"),
    ]);

    expect(result.groups.map(group => [group.program.id, group.accountId, group.rowIndices]))
      .toEqual([["sept", 7, [0]], ["oct", 7, [1]]]);
    expect(result.unmatched).toEqual([]);
  });

  it("does not guess when a sale has no unique customer promotion", () => {
    const result = splitClaimRowsByPromotion([
      row(0, "2026-09-15"), row(1, "2026-11-15"),
    ], 7, [
      promotion("sept-a", "2026-09-01", "2026-09-30"),
      promotion("sept-b", "2026-09-10", "2026-09-20"),
      promotion("oct", "2026-10-01", "2026-10-31", [8]),
    ]);

    expect(result.groups).toEqual([]);
    expect(result.unmatched).toEqual([
      { rowIndex: 0, reason: "overlapping_promotions" },
      { rowIndex: 1, reason: "no_matching_promotion" },
    ]);
  });

  it("resolves date-overlapping promotions by customer and SKU", () => {
    const result = splitClaimRowsByPromotion([
      row(0, "2026-09-15", 7, "SKU-A"),
      row(1, "2026-09-15", 7, "SKU-B"),
    ], 7, [
      promotion("promotion-a", "2026-09-01", "2026-09-30", [7], ["SKU-A"]),
      promotion("promotion-b", "2026-09-10", "2026-09-20", [7], ["SKU-B"]),
    ]);

    expect(result.groups.map(group => [group.program.id, group.rowIndices]))
      .toEqual([["promotion-a", [0]], ["promotion-b", [1]]]);
    expect(result.unmatched).toEqual([]);
  });
});
