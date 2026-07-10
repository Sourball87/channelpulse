import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const r = await db.select({ week: inventorySnapshots.weekIso }).from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(1);
  return r[0]?.week ?? null;
}

router.get("/insights/whitespace", async (req, res) => {
  try {
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, range_gaps: [], breadth_scores: [], new_line_adoption: [], insufficient_data: true });

    // Last 8 weeks for new line adoption
    const prev8Rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} <= ${weekIso}`)
      .orderBy(desc(inventorySnapshots.weekIso)).limit(8);
    const allWeeks = prev8Rows.map(r => r.week!);
    const dataWeeks = allWeeks.length;

    const catFilter = category && category !== "All"
      ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
      : eq(inventorySnapshots.weekIso, weekIso);

    // ── Channel-wide ST per SKU (current week) ────────────────────────────────
    const channelSt = await db.select({
      part_id: inventorySnapshots.partId,
      part_no: parts.partNo,
      display_name: parts.displayName,
      category: parts.category,
      total_st: sql<number>`sum(${inventorySnapshots.sellThrough7d})::int`,
      reseller_count: sql<number>`count(distinct ${inventorySnapshots.resellerId})::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(catFilter)
      .groupBy(inventorySnapshots.partId, parts.partNo, parts.displayName, parts.category);

    // Top quartile SKUs by ST
    const sorted = [...channelSt].sort((a, b) => Number(b.total_st) - Number(a.total_st));
    const quartileCutoff = sorted.length > 0
      ? Number(sorted[Math.floor(sorted.length * 0.25)].total_st) : 0;
    const topQuartileParts = sorted.filter(p => Number(p.total_st) >= quartileCutoff && Number(p.total_st) > 0);

    // All active resellers
    const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
    const allResellerIds = allResellers.map(r => r.id);

    // Which resellers have SOH or ST for each top quartile part in current week?
    const topPartIds = topQuartileParts.map(p => p.part_id!).filter(Boolean);

    // Only count a reseller as "ranged" if they actually have SOH or ST > 0
    const rangedRows = topPartIds.length > 0
      ? await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
      }).from(inventorySnapshots)
        .where(and(
          eq(inventorySnapshots.weekIso, weekIso),
          inArray(inventorySnapshots.partId, topPartIds),
          sql`(${inventorySnapshots.soh} > 0 OR ${inventorySnapshots.sellThrough7d} > 0)`,
        ))
      : [];

    const rangedByPart = new Map<number, Set<number>>();
    for (const r of rangedRows) {
      if (!rangedByPart.has(r.part_id!)) rangedByPart.set(r.part_id!, new Set());
      rangedByPart.get(r.part_id!)!.add(r.reseller_id!);
    }

    // Channel avg ST (to estimate opportunity)
    const channelStMap = new Map(channelSt.map(r => [r.part_id!, {
      total_st: Number(r.total_st),
      reseller_count: Number(r.reseller_count),
      part_no: r.part_no,
      display_name: r.display_name,
      category: r.category,
    }]));

    // Build range gaps
    const rangeGaps: unknown[] = [];
    for (const partEntry of topQuartileParts) {
      const pid = partEntry.part_id!;
      const rangedResellers = rangedByPart.get(pid) ?? new Set();
      const notRangedResellers = allResellers.filter(r => !rangedResellers.has(r.id));
      if (notRangedResellers.length === 0) continue;

      const channelData = channelStMap.get(pid);
      const avgStPerReseller = channelData && channelData.reseller_count > 0
        ? channelData.total_st / channelData.reseller_count : 0;

      for (const r of notRangedResellers) {
        rangeGaps.push({
          part_id: pid,
          part_no: channelData?.part_no,
          display_name: channelData?.display_name,
          category: channelData?.category,
          reseller_id: r.id,
          reseller_name: r.name,
          channel_total_st: channelData?.total_st ?? 0,
          ranged_reseller_count: rangedResellers.size,
          est_opportunity_units_per_week: Math.round(avgStPerReseller),
          action: "Range extension opportunity",
          explorer_link: `/explorer?part_id=${pid}&reseller_id=${r.id}`,
        });
      }
    }

    // Sort by estimated opportunity
    (rangeGaps as Array<{ est_opportunity_units_per_week: number }>)
      .sort((a, b) => b.est_opportunity_units_per_week - a.est_opportunity_units_per_week);

    // ── Range breadth score per reseller ──────────────────────────────────────
    const allActiveParts = await db.select({ id: parts.id }).from(parts).where(eq(parts.active, true));
    const totalParts = allActiveParts.length;

    const resellerRangeRows = await db.select({
      reseller_id: inventorySnapshots.resellerId,
      ranged: sql<number>`count(distinct ${inventorySnapshots.partId})::int`,
    }).from(inventorySnapshots)
      .where(eq(inventorySnapshots.weekIso, weekIso))
      .groupBy(inventorySnapshots.resellerId);

    const breadthScores = allResellers.map(r => {
      const ranged = resellerRangeRows.find(x => x.reseller_id === r.id);
      const rangedCount = ranged ? Number(ranged.ranged) : 0;
      return {
        reseller_id: r.id,
        reseller_name: r.name,
        reseller_code: r.code,
        ranged_skus: rangedCount,
        total_skus: totalParts,
        breadth_pct: totalParts > 0 ? (rangedCount / totalParts) * 100 : 0,
      };
    }).sort((a, b) => b.breadth_pct - a.breadth_pct);

    // ── New line adoption (first seen in last 8 weeks) ─────────────────────────
    const newLineAdoption: unknown[] = [];
    if (allWeeks.length >= 2) {
      // Find parts first seen in the last 8 weeks but not before
      const firstSeenRows = await db.select({
        part_id: inventorySnapshots.partId,
        part_no: parts.partNo,
        display_name: parts.displayName,
        first_week: sql<string>`min(${inventorySnapshots.weekIso})`,
      }).from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .groupBy(inventorySnapshots.partId, parts.partNo, parts.displayName);

      const oldestWeek = allWeeks[allWeeks.length - 1];
      const newParts = firstSeenRows.filter(r => r.first_week && r.first_week >= oldestWeek);

      for (const np of newParts.slice(0, 5)) {
        const weeklyRows = await db.select({
          week_iso: inventorySnapshots.weekIso,
          st: sql<number>`sum(${inventorySnapshots.sellThrough7d})::int`,
          resellers: sql<number>`count(distinct ${inventorySnapshots.resellerId})::int`,
        }).from(inventorySnapshots)
          .where(and(
            eq(inventorySnapshots.partId, np.part_id!),
            inArray(inventorySnapshots.weekIso, allWeeks),
          ))
          .groupBy(inventorySnapshots.weekIso)
          .orderBy(inventorySnapshots.weekIso);

        const rampPoints = weeklyRows.map(r => ({ week_iso: r.week_iso!, st: Number(r.st), resellers: Number(r.resellers) }));
        const latestResellers = rampPoints[rampPoints.length - 1]?.resellers ?? 0;
        const slowRamp = latestResellers < Math.ceil(allResellers.length * 0.3);

        newLineAdoption.push({
          part_id: np.part_id,
          part_no: np.part_no,
          display_name: np.display_name,
          first_week: np.first_week,
          resellers_ranged: latestResellers,
          total_resellers: allResellers.length,
          ramp: rampPoints,
          slow_ramp: slowRamp,
          flag: slowRamp ? "Slow ramp — consider sell-in push" : null,
        });
      }
    }

    res.json({
      week_iso: weekIso,
      insufficient_data: dataWeeks < 2,
      data_weeks_available: dataWeeks,
      range_gaps: rangeGaps.slice(0, 7),
      range_gaps_total: rangeGaps.length,
      breadth_scores: breadthScores,
      new_line_adoption: newLineAdoption,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute whitespace insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
