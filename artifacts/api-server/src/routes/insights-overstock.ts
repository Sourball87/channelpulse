import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { getOrCreateSettings } from "./insights-settings";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const r = await db.select({ week: inventorySnapshots.weekIso }).from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(1);
  return r[0]?.week ?? null;
}

router.get("/insights/overstock", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, overstocked: [], dead_stock: [], channel_overhang: [], insufficient_data: true });

    // Get last 4 weeks for trailing history
    const prev4Rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} < ${weekIso}`)
      .orderBy(desc(inventorySnapshots.weekIso)).limit(4);
    const prev4Weeks = prev4Rows.map(r => r.week!);
    const dataWeeks = prev4Weeks.length;

    const catFilter = category && category !== "All"
      ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
      : eq(inventorySnapshots.weekIso, weekIso);

    // ── Current week snapshots ────────────────────────────────────────────────
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
      .where(catFilter);

    // ── Trailing 4-week ST per reseller×part ──────────────────────────────────
    let trailingRows: { part_id: number; reseller_id: number; weeks_data: { week_iso: string; st: number }[] }[] = [];
    if (prev4Weeks.length > 0) {
      const tRows = await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        week_iso: inventorySnapshots.weekIso,
        st: inventorySnapshots.sellThrough7d,
      }).from(inventorySnapshots)
        .where(inArray(inventorySnapshots.weekIso, prev4Weeks))
        .orderBy(inventorySnapshots.weekIso);

      // Group by part+reseller
      const grouped = new Map<string, { part_id: number; reseller_id: number; weeks_data: { week_iso: string; st: number }[] }>();
      for (const r of tRows) {
        const key = `${r.part_id}:${r.reseller_id}`;
        if (!grouped.has(key)) grouped.set(key, { part_id: r.part_id!, reseller_id: r.reseller_id!, weeks_data: [] });
        grouped.get(key)!.weeks_data.push({ week_iso: r.week_iso!, st: r.st ?? 0 });
      }
      trailingRows = [...grouped.values()];
    }

    const trailingMap = new Map(trailingRows.map(r => [`${r.part_id}:${r.reseller_id}`, r]));

    // ── Overstocked positions ─────────────────────────────────────────────────
    const overstocked: unknown[] = [];
    const deadStock: unknown[] = [];

    for (const r of curRows) {
      const soh = r.soh ?? 0;
      const curSt = r.st ?? 0;
      const avgCostNum = r.avg_cost ? Number(r.avg_cost) : null;
      const invValue = avgCostNum != null ? soh * avgCostNum : null;
      const key = `${r.part_id}:${r.reseller_id}`;
      const trailing = trailingMap.get(key);
      const trailingSts = trailing?.weeks_data.map(w => w.st) ?? [];
      const avgTrailingSt = trailingSts.length > 0
        ? trailingSts.reduce((a, b) => a + b, 0) / trailingSts.length : 0;
      const woi = curSt > 0 ? soh / curSt : (avgTrailingSt > 0 ? soh / avgTrailingSt : null);

      if (soh >= settings.overstockMinSoh && woi !== null && woi > settings.overstockWoiThreshold) {
        overstocked.push({
          part_id: r.part_id,
          part_no: r.part_no,
          display_name: r.display_name,
          category: r.category,
          reseller_id: r.reseller_id,
          reseller_name: r.reseller_name,
          soh,
          st: curSt,
          woi,
          avg_cost: avgCostNum,
          inv_value: invValue,
          trailing_st_by_week: trailingSts,
          trailing_avg_st: avgTrailingSt,
          action: woi > 30 ? "Run promo" : woi > 20 ? "Rebalance" : "Review pricing",
          explorer_link: `/explorer?part_id=${r.part_id}&reseller_id=${r.reseller_id}`,
        });
      }

      // Dead stock: SOH > 0, zero ST in all trailing weeks (and now)
      if (soh > 0 && curSt === 0 && trailingSts.length >= settings.deadStockWeeks) {
        const allZero = trailingSts.slice(0, settings.deadStockWeeks).every(s => s === 0);
        if (allZero) {
          deadStock.push({
            part_id: r.part_id,
            part_no: r.part_no,
            display_name: r.display_name,
            category: r.category,
            reseller_id: r.reseller_id,
            reseller_name: r.reseller_name,
            soh,
            inv_value: invValue,
            weeks_no_movement: trailingSts.filter(s => s === 0).length + 1,
            explorer_link: `/explorer?part_id=${r.part_id}&reseller_id=${r.reseller_id}`,
          });
        }
      }
    }

    // Sort overstocked by inv value desc
    (overstocked as Array<{ inv_value: number | null }>)
      .sort((a, b) => (b.inv_value ?? 0) - (a.inv_value ?? 0));

    const deadStockTotal = (deadStock as Array<{ inv_value: number | null }>)
      .reduce((acc, s) => acc + (s.inv_value ?? 0), 0);

    // ── Channel-level overhang: total channel WOI > 20 per SKU ───────────────
    const channelAgg = await db.select({
      part_id: inventorySnapshots.partId,
      part_no: parts.partNo,
      display_name: parts.displayName,
      category: parts.category,
      total_soh: sql<number>`sum(${inventorySnapshots.soh})::int`,
      total_st: sql<number>`sum(${inventorySnapshots.sellThrough7d})::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(catFilter)
      .groupBy(inventorySnapshots.partId, parts.partNo, parts.displayName, parts.category);

    const channelOverhang = channelAgg
      .map(r => ({
        part_id: r.part_id,
        part_no: r.part_no,
        display_name: r.display_name,
        category: r.category,
        total_soh: Number(r.total_soh),
        total_st: Number(r.total_st),
        channel_woi: Number(r.total_st) > 0 ? Number(r.total_soh) / Number(r.total_st) : null,
      }))
      .filter(r => r.channel_woi !== null && r.channel_woi > 20)
      .sort((a, b) => (b.channel_woi ?? 0) - (a.channel_woi ?? 0));

    res.json({
      week_iso: weekIso,
      insufficient_data: dataWeeks < 2,
      data_weeks_available: dataWeeks + 1,
      overstocked: overstocked.slice(0, 7),
      overstocked_total: overstocked.length,
      dead_stock: deadStock.slice(0, 7),
      dead_stock_total: deadStock.length,
      dead_stock_value: Math.round(deadStockTotal),
      channel_overhang: channelOverhang.slice(0, 7),
      channel_overhang_total: channelOverhang.length,
      thresholds: {
        woi_threshold: settings.overstockWoiThreshold,
        min_soh: settings.overstockMinSoh,
        dead_stock_weeks: settings.deadStockWeeks,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute overstock insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
