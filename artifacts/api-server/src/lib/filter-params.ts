import { db, inventorySnapshots } from "@workspace/db";
import { sql, and, inArray, desc } from "drizzle-orm";

export interface FilterParams {
  partIds: number[];
  resellerIds: number[];
  weekIso?: string;
  weekFrom?: string;
  weekTo?: string;
}

export interface ResolvedRange {
  weekList: string[];     // newest-first, all data weeks in range
  latestWeek: string;     // for SOH point-in-time queries
  prevWeekList: string[]; // prior period (same length) for deltas
  isPeriod: boolean;
  weeksWithData: number;
}

export function parseFilterParams(query: Record<string, unknown>): FilterParams {
  return {
    partIds: query.part_ids
      ? String(query.part_ids).split(",").map(Number).filter(n => !isNaN(n) && n > 0)
      : [],
    resellerIds: query.reseller_ids
      ? String(query.reseller_ids).split(",").map(Number).filter(n => !isNaN(n) && n > 0)
      : [],
    weekIso: query.week_iso as string | undefined,
    weekFrom: query.week_from as string | undefined,
    weekTo: query.week_to as string | undefined,
  };
}

export async function resolveRange(
  params: FilterParams,
  latestFallback: string,
): Promise<ResolvedRange> {
  if (params.weekFrom && params.weekTo) {
    const rangeRows = await db
      .selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(
        sql`${inventorySnapshots.weekIso} >= ${params.weekFrom} AND ${inventorySnapshots.weekIso} <= ${params.weekTo}`,
      )
      .orderBy(desc(inventorySnapshots.weekIso));
    const weekList = rangeRows.map(r => r.week!);

    const n = Math.max(weekList.length, 1);
    const priorRows = await db
      .selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} < ${params.weekFrom}`)
      .orderBy(desc(inventorySnapshots.weekIso))
      .limit(n);
    const prevWeekList = priorRows.map(r => r.week!);

    const effective = weekList.length > 0 ? weekList : [latestFallback];
    return {
      weekList: effective,
      latestWeek: effective[0],
      prevWeekList,
      isPeriod: true,
      weeksWithData: weekList.length,
    };
  }
  const week = params.weekIso ?? latestFallback;
  return {
    weekList: [week],
    latestWeek: week,
    prevWeekList: [],
    isPeriod: false,
    weeksWithData: 1,
  };
}

/**
 * Build a combined WHERE condition from a list of base conditions plus
 * optional part_ids / reseller_ids filters from the global filter params.
 * Undefined / null / false entries in `bases` are ignored.
 */
export function buildConditions(
  bases: unknown[],
  filters: Pick<FilterParams, "partIds" | "resellerIds">,
): any {
  const all: unknown[] = bases.filter(Boolean);
  if (filters.partIds.length > 0) all.push(inArray(inventorySnapshots.partId, filters.partIds));
  if (filters.resellerIds.length > 0) all.push(inArray(inventorySnapshots.resellerId, filters.resellerIds));
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return and(...(all as any[]));
}
