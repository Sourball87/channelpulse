import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { getOrCreateSettings } from "./insights-settings";
import { parseFilterParams, buildConditions } from "../lib/filter-params";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const r = await db.select({ week: inventorySnapshots.weekIso }).from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(1);
  return r[0]?.week ?? null;
}

router.get("/insights/stockout-risk", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, projected_stockouts: [], active_stockouts: [], lost_sales_headline: { units: 0, value: 0 }, insufficient_data: true });

    // Get last 4 weeks for trailing avg
    const prev4Rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} < ${weekIso}`)
      .orderBy(desc(inventorySnapshots.weekIso)).limit(4);
    const prev4Weeks = prev4Rows.map(r => r.week!);
    const dataWeeks = prev4Weeks.length;
    const insufficient_data = dataWeeks < 2;

    const filters = parseFilterParams(req.query as Record<string, unknown>);

    // ── Trailing 4-week avg ST per reseller×part ──────────────────────────────
    let trailingRows: { part_id: number; reseller_id: number; avg_st: number; avg_cost: number | null }[] = [];
    if (prev4Weeks.length > 0) {
      const tRows = await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        avg_st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
        avg_cost: sql<number>`avg(${inventorySnapshots.avgCost}::numeric)::numeric`,
      }).from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([
          inArray(inventorySnapshots.weekIso, prev4Weeks),
          category && category !== "All" ? eq(parts.category, category) : undefined,
        ], filters))
        .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);
      trailingRows = tRows.map(r => ({
        part_id: r.part_id!,
        reseller_id: r.reseller_id!,
        avg_st: Number(r.avg_st),
        avg_cost: r.avg_cost != null ? Number(r.avg_cost) : null,
      }));
    }
    const trailingMap = new Map(trailingRows.map(r => [`${r.part_id}:${r.reseller_id}`, r]));

    // ── Current week snapshots ────────────────────────────────────────────────
    const curFilter = buildConditions([
      eq(inventorySnapshots.weekIso, weekIso),
      category && category !== "All" ? eq(parts.category, category) : undefined,
    ], filters);

    const curRows = await db.select({
      part_id: inventorySnapshots.partId,
      reseller_id: inventorySnapshots.resellerId,
      part_no: parts.partNo,
      display_name: parts.displayName,
      category: parts.category,
      reseller_name: resellers.name,
      soh: inventorySnapshots.soh,
      st: inventorySnapshots.sellThrough7d,
      avg_cost: inventorySnapshots.avgCost,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(curFilter);

    // ── Projected stockouts: SOH/avg_st < horizon and SOH > 0 ────────────────
    const projectedStockouts: unknown[] = [];
    const activeStockouts: unknown[] = [];

    for (const r of curRows) {
      const key = `${r.part_id}:${r.reseller_id}`;
      const trailing = trailingMap.get(key);
      const trailingAvgSt = trailing?.avg_st ?? 0;
      const avgCost = trailing?.avg_cost ?? (r.avg_cost ? Number(r.avg_cost) : null);
      const soh = r.soh ?? 0;
      const curSt = r.st ?? 0;

      if (soh > 0 && trailingAvgSt > 0) {
        const weeksToZero = soh / trailingAvgSt;
        if (weeksToZero < settings.stockoutHorizonWeeks) {
          projectedStockouts.push({
            part_id: r.part_id,
            part_no: r.part_no,
            display_name: r.display_name,
            category: r.category,
            reseller_id: r.reseller_id,
            reseller_name: r.reseller_name,
            soh,
            st: curSt,
            trailing_avg_st: trailingAvgSt,
            weeks_to_zero: weeksToZero,
            est_lost_value_per_week: avgCost != null ? trailingAvgSt * avgCost : null,
            confidence: dataWeeks >= 4 ? "high" : `low (${dataWeeks} weeks of data)`,
            action: "Sell-in opportunity",
            explorer_link: `/explorer?part_id=${r.part_id}&reseller_id=${r.reseller_id}`,
          });
        }
      } else if (soh === 0 && trailingAvgSt > 0) {
        // Active stockout — had prior ST
        activeStockouts.push({
          part_id: r.part_id,
          part_no: r.part_no,
          display_name: r.display_name,
          category: r.category,
          reseller_id: r.reseller_id,
          reseller_name: r.reseller_name,
          soh: 0,
          trailing_avg_st: trailingAvgSt,
          est_lost_units_per_week: trailingAvgSt,
          est_lost_value_per_week: avgCost != null ? trailingAvgSt * avgCost : null,
          confidence: dataWeeks >= 4 ? "high" : `low (${dataWeeks} weeks of data)`,
          action: "Urgent replenish",
          explorer_link: `/explorer?part_id=${r.part_id}&reseller_id=${r.reseller_id}`,
        });
      }
    }

    // ── Vanished SKU detection ────────────────────────────────────────────────
    // Resellers that reported this week (have at least one snapshot)
    const reportingResellers = new Set(curRows.map(r => r.reseller_id!));
    // Keys already covered by current-week rows
    const coveredKeys = new Set(curRows.map(r => `${r.part_id}:${r.reseller_id}`));

    if (prev4Weeks.length > 0) {
      // Get display info for parts/resellers in trailing data
      const trailingWithInfo = await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        part_no: parts.partNo,
        display_name: parts.displayName,
        category: parts.category,
        reseller_name: resellers.name,
        avg_st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
        avg_cost: sql<number>`avg(${inventorySnapshots.avgCost}::numeric)::numeric`,
      }).from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
        .where(
          category && category !== "All"
            ? and(inArray(inventorySnapshots.weekIso, prev4Weeks), eq(parts.category, category))
            : inArray(inventorySnapshots.weekIso, prev4Weeks)
        )
        .groupBy(
          inventorySnapshots.partId, inventorySnapshots.resellerId,
          parts.partNo, parts.displayName, parts.category, resellers.name
        );

      for (const r of trailingWithInfo) {
        if (!reportingResellers.has(r.reseller_id!)) continue; // reseller didn't report
        const key = `${r.part_id}:${r.reseller_id}`;
        if (coveredKeys.has(key)) continue; // already in current-week rows
        const avgSt = Number(r.avg_st ?? 0);
        if (avgSt <= 0) continue;
        const avgCost = r.avg_cost != null ? Number(r.avg_cost) : null;
        activeStockouts.push({
          part_id: r.part_id,
          part_no: r.part_no,
          display_name: r.display_name,
          category: r.category,
          reseller_id: r.reseller_id,
          reseller_name: r.reseller_name,
          soh: 0,
          trailing_avg_st: avgSt,
          est_lost_units_per_week: avgSt,
          est_lost_value_per_week: avgCost != null ? avgSt * avgCost : null,
          confidence: dataWeeks >= 4 ? "high" : `low (${dataWeeks} weeks of data)`,
          note: "SKU missing from reseller file — likely out of stock",
          action: "Urgent replenish",
          explorer_link: `/explorer?part_id=${r.part_id}&reseller_id=${r.reseller_id}`,
        });
      }
    }

    // Sort: projected by weekly ST (biggest run-rate risk first), active by lost units
    (projectedStockouts as Array<{ trailing_avg_st: number }>)
      .sort((a, b) => b.trailing_avg_st - a.trailing_avg_st);
    (activeStockouts as Array<{ est_lost_units_per_week: number }>)
      .sort((a, b) => b.est_lost_units_per_week - a.est_lost_units_per_week);

    // Lost sales headline
    const lostUnits = (activeStockouts as Array<{ est_lost_units_per_week: number }>)
      .reduce((acc, s) => acc + s.est_lost_units_per_week, 0);
    const lostValue = (activeStockouts as Array<{ est_lost_value_per_week: number | null }>)
      .reduce((acc, s) => acc + (s.est_lost_value_per_week ?? 0), 0);

    res.json({
      week_iso: weekIso,
      insufficient_data,
      data_weeks_available: dataWeeks + 1,
      projected_stockouts: projectedStockouts.slice(0, 7),
      projected_stockouts_total: projectedStockouts.length,
      active_stockouts: activeStockouts.slice(0, 7),
      active_stockouts_total: activeStockouts.length,
      lost_sales_headline: {
        units: Math.round(lostUnits),
        value: Math.round(lostValue),
      },
      thresholds: {
        stockout_horizon_weeks: settings.stockoutHorizonWeeks,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute stockout insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
