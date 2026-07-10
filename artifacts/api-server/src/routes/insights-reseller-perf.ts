import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, insightAnnotations } from "@workspace/db";
import { sql, eq, and, desc, inArray, gt } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { getOrCreateSettings } from "./insights-settings";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const r = await db.select({ week: inventorySnapshots.weekIso }).from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(1);
  return r[0]?.week ?? null;
}

router.get("/insights/reseller-performance", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, leaderboard: [], concentration_risks: [], anomalies: [], insufficient_data: true });

    const prevWeek = previousWeekIso(weekIso);
    const prev4Rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} < ${weekIso}`)
      .orderBy(desc(inventorySnapshots.weekIso)).limit(4);
    const prev4Weeks = prev4Rows.map(r => r.week!);
    const dataWeeks = prev4Weeks.length;

    const catJoin = category && category !== "All"
      ? (week: string) => and(eq(inventorySnapshots.weekIso, week), eq(parts.category, category))
      : (week: string) => eq(inventorySnapshots.weekIso, week);

    // ── Current & prev week per-reseller aggregates ───────────────────────────
    const curAgg = await db.select({
      reseller_id: inventorySnapshots.resellerId,
      reseller_name: resellers.name,
      reseller_code: resellers.code,
      total_st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
      total_soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
      total_value: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d} * ${inventorySnapshots.avgCost}::numeric), 0)::numeric`,
      ranged_skus: sql<number>`count(distinct ${inventorySnapshots.partId})::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(catJoin(weekIso))
      .groupBy(inventorySnapshots.resellerId, resellers.name, resellers.code);

    const prevAgg = await db.select({
      reseller_id: inventorySnapshots.resellerId,
      total_st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(catJoin(prevWeek))
      .groupBy(inventorySnapshots.resellerId);

    const prevMap = new Map(prevAgg.map(r => [r.reseller_id!, Number(r.total_st)]));
    const channelTotalSt = curAgg.reduce((acc, r) => acc + Number(r.total_st), 0);
    const prevChannelTotalSt = prevAgg.reduce((acc, r) => acc + Number(r.total_st), 0);

    const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
    const totalSkus = await db.select({ id: parts.id }).from(parts).where(eq(parts.active, true));

    // Leaderboard
    const leaderboard = curAgg.map(r => {
      const curSt = Number(r.total_st), curSoh = Number(r.total_soh);
      const prevSt = prevMap.get(r.reseller_id!) ?? 0;
      const stShare = channelTotalSt > 0 ? (curSt / channelTotalSt) * 100 : 0;
      const prevShare = prevMap.get(r.reseller_id!) != null && prevChannelTotalSt > 0
        ? (prevSt / prevChannelTotalSt) * 100 : null;
      const avgWoi = curSt > 0 ? curSoh / curSt : null;
      const breadthPct = totalSkus.length > 0 ? (Number(r.ranged_skus) / totalSkus.length) * 100 : 0;
      return {
        reseller_id: r.reseller_id,
        reseller_name: r.reseller_name,
        reseller_code: r.reseller_code,
        total_st: curSt,
        total_st_delta: curSt - prevSt,
        throughput_value: Number(r.total_value),
        st_share_pct: stShare,
        st_share_delta: prevShare != null ? stShare - prevShare : null,
        avg_woi: avgWoi,
        breadth_pct: breadthPct,
        ranged_skus: Number(r.ranged_skus),
        total_skus: totalSkus.length,
      };
    }).sort((a, b) => b.total_st - a.total_st);

    // ── Concentration risk ────────────────────────────────────────────────────
    const top1Share = leaderboard[0]?.st_share_pct ?? 0;
    const top3Share = leaderboard.slice(0, 3).reduce((acc, r) => acc + r.st_share_pct, 0);

    // SKUs where one reseller > 60% of ST
    const skuConc = await db.select({
      part_id: inventorySnapshots.partId,
      reseller_id: inventorySnapshots.resellerId,
      part_no: parts.partNo,
      reseller_name: resellers.name,
      st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(catJoin(weekIso))
      .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId, parts.partNo, resellers.name);

    const skuTotals = new Map<number, number>();
    for (const r of skuConc) { skuTotals.set(r.part_id!, (skuTotals.get(r.part_id!) ?? 0) + Number(r.st)); }
    const concentrationRisks = skuConc
      .filter(r => {
        const total = skuTotals.get(r.part_id!) ?? 0;
        // Minimum 10 units channel ST to be a meaningful signal
        return total >= 10 && Number(r.st) / total > 0.6;
      })
      .map(r => ({
        part_id: r.part_id,
        part_no: r.part_no,
        reseller_id: r.reseller_id,
        reseller_name: r.reseller_name,
        st: Number(r.st),
        total_channel_st: skuTotals.get(r.part_id!) ?? 0,
        share_pct: ((Number(r.st) / (skuTotals.get(r.part_id!) ?? 1)) * 100),
      }))
      .sort((a, b) => b.share_pct - a.share_pct);

    // ── Anomalies (ST spikes + negative SOH) ─────────────────────────────────
    const anomalies: unknown[] = [];

    // Get existing annotations to mark as dismissed
    const annotations = await db.select().from(insightAnnotations)
      .where(and(eq(insightAnnotations.weekIso, weekIso), eq(insightAnnotations.dismissed, false)));
    const annotatedKeys = new Set(annotations.map(a => `${a.partId}:${a.resellerId}:${a.weekIso}`));

    const perfCurRows = await db.select({
      part_id: inventorySnapshots.partId,
      reseller_id: inventorySnapshots.resellerId,
      part_no: parts.partNo,
      reseller_name: resellers.name,
      soh: inventorySnapshots.soh,
      st: inventorySnapshots.sellThrough7d,
      avg_cost: inventorySnapshots.avgCost,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(catJoin(weekIso));

    let trailingMap = new Map<string, number>();
    if (prev4Weeks.length > 0) {
      const trailingRows = await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        avg_st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
      }).from(inventorySnapshots)
        .where(inArray(inventorySnapshots.weekIso, prev4Weeks))
        .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);
      trailingMap = new Map(trailingRows.map(r => [`${r.part_id}:${r.reseller_id}`, Number(r.avg_st)]));
    }

    for (const r of perfCurRows) {
      const key = `${r.part_id}:${r.reseller_id}`;
      const trailingAvg = trailingMap.get(key) ?? 0;
      const st = r.st ?? 0;
      const annoKey = `${r.part_id}:${r.reseller_id}:${weekIso}`;
      const isDismissed = annotatedKeys.has(annoKey);

      // ST spike anomaly (requires trailing history)
      if (prev4Weeks.length > 0 && trailingAvg > 0 && st > trailingAvg * Number(settings.spikeMultiplier)) {
        anomalies.push({
          type: "st_spike",
          part_id: r.part_id,
          part_no: r.part_no,
          reseller_id: r.reseller_id,
          reseller_name: r.reseller_name,
          week_iso: weekIso,
          st,
          trailing_avg_st: trailingAvg,
          spike_ratio: st / trailingAvg,
          soh: r.soh,
          note: `ST ${st} vs ${trailingAvg.toFixed(1)} avg — likely bulk/commercial deal`,
          dismissed: isDismissed,
          action: "Confirm bulk deal to exclude from run-rate",
        });
      }

      // Negative SOH — checked regardless of history availability
      if ((r.soh ?? 0) < 0) {
        anomalies.push({
          type: "negative_soh",
          part_id: r.part_id,
          part_no: r.part_no,
          reseller_id: r.reseller_id,
          reseller_name: r.reseller_name,
          week_iso: weekIso,
          st,
          trailing_avg_st: trailingAvg,
          soh: r.soh,
          note: `Negative SOH (${r.soh}) — data quality issue`,
          dismissed: isDismissed,
          action: "Investigate data with reseller",
        });
      }
    }

    res.json({
      week_iso: weekIso,
      insufficient_data: dataWeeks < 2,
      data_weeks_available: dataWeeks + 1,
      leaderboard,
      concentration: {
        top1_share_pct: top1Share,
        top3_share_pct: top3Share,
        top1_reseller: leaderboard[0]?.reseller_name ?? null,
        concentration_risks: concentrationRisks.slice(0, 7),
      },
      anomalies: anomalies.slice(0, 10),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute reseller performance insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
