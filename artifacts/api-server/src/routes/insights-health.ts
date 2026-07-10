import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, uploads } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { getOrCreateSettings } from "./insights-settings";
import { parseFilterParams, buildConditions } from "../lib/filter-params";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const r = await db.select({ week: inventorySnapshots.weekIso }).from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(1);
  return r[0]?.week ?? null;
}

async function getPrevNWeeks(current: string, n: number): Promise<string[]> {
  const rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
    .from(inventorySnapshots)
    .where(sql`${inventorySnapshots.weekIso} < ${current}`)
    .orderBy(desc(inventorySnapshots.weekIso)).limit(n);
  return rows.map(r => r.week!);
}

router.get("/insights/health", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, health_score: 0, sections: [], insufficient_data: true });

    const prevWeek = previousWeekIso(weekIso);
    const prev4Weeks = await getPrevNWeeks(weekIso, 4);
    const historyWeeks = [weekIso, ...prev4Weeks];

    const filters = parseFilterParams(req.query as Record<string, unknown>);
    const catFilter = (week: string) => buildConditions([
      eq(inventorySnapshots.weekIso, week),
      category && category !== "All" ? eq(parts.category, category) : undefined,
    ], filters);

    // ── Current & prev week aggregates ───────────────────────────────────────
    const [curAgg] = await db.select({
      soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
      st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
      value: sql<number>`coalesce(sum(${inventorySnapshots.soh} * ${inventorySnapshots.avgCost}::numeric), 0)::numeric`,
      skus: sql<number>`count(distinct ${inventorySnapshots.partId})::int`,
      cells: sql<number>`count(*)::int`,
      green_cells: sql<number>`count(*) filter (
        where ${inventorySnapshots.soh} > 0
        and ${inventorySnapshots.sellThrough7d} > 0
        and (${inventorySnapshots.soh}::float / nullif(${inventorySnapshots.sellThrough7d}, 0)) <= ${settings.woiAmberMax}
      )::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(catFilter(weekIso));

    const [prevAgg] = await db.select({
      soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
      st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(catFilter(prevWeek));

    const curSoh = Number(curAgg.soh), curSt = Number(curAgg.st);
    const prevSoh = Number(prevAgg.soh), prevSt = Number(prevAgg.st);
    const blendedWoi = curSt > 0 ? curSoh / curSt : null;

    // ── 4-week ST trend by category ──────────────────────────────────────────
    const trendRows = await db.select({
      week_iso: inventorySnapshots.weekIso,
      category: parts.category,
      st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([inArray(inventorySnapshots.weekIso, historyWeeks.slice(0, 5))], filters))
      .groupBy(inventorySnapshots.weekIso, parts.category)
      .orderBy(parts.category, inventorySnapshots.weekIso);

    const catTrend: Record<string, { week_iso: string; st: number }[]> = {};
    for (const r of trendRows) {
      const cat = r.category ?? "Unknown";
      catTrend[cat] = catTrend[cat] ?? [];
      catTrend[cat].push({ week_iso: r.week_iso!, st: Number(r.st) });
    }
    const categoryTrends = Object.entries(catTrend).map(([cat, points]) => {
      const sorted = [...points].sort((a, b) => a.week_iso.localeCompare(b.week_iso));
      const stValues = sorted.map(p => p.st);
      const first = stValues[0] ?? 0, last = stValues[stValues.length - 1] ?? 0;
      const pctChange = first > 0 ? ((last - first) / first) * 100 : 0;
      const momentum = pctChange > 5 ? "accelerating" : pctChange < -5 ? "declining" : "stable";
      return { category: cat, points: sorted, momentum, pct_change: pctChange };
    });

    // ── Channel coverage (category-scoped) ────────────────────────────────────
    const totalSkusWhere = category && category !== "All"
      ? and(eq(parts.active, true), eq(parts.category, category))
      : eq(parts.active, true);
    const [totalSkus] = await db.select({ cnt: sql<number>`count(*)::int` }).from(parts)
      .where(totalSkusWhere);
    const coveredSkusWhere = category && category !== "All"
      ? and(eq(inventorySnapshots.weekIso, weekIso), sql`${inventorySnapshots.soh} > 0`, eq(parts.category, category))
      : and(eq(inventorySnapshots.weekIso, weekIso), sql`${inventorySnapshots.soh} > 0`);
    const [coveredSkus] = await db.select({ cnt: sql<number>`count(distinct ${inventorySnapshots.partId})::int` })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(coveredSkusWhere);
    const totalSkuCount = Number(totalSkus.cnt), coveredSkuCount = Number(coveredSkus.cnt);
    const coveragePct = totalSkuCount > 0 ? (coveredSkuCount / totalSkuCount) * 100 : 0;

    const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
    const reportedResellers = await db.selectDistinct({ rid: uploads.resellerId })
      .from(uploads).where(and(eq(uploads.weekIso, weekIso), eq(uploads.status, "committed")));
    const reportedCount = reportedResellers.length;
    const compliancePct = allResellers.length > 0 ? (reportedCount / allResellers.length) * 100 : 0;

    // ── Health score (0–100) ─────────────────────────────────────────────────
    // WOI band: target 6–12, score 40 if in band, proportionally less outside
    let woiScore = 0;
    if (blendedWoi !== null) {
      const target = (settings.woiGreenMax + settings.woiAmberMax) / 2; // midpoint
      const deviation = Math.abs(blendedWoi - target) / target;
      woiScore = Math.max(0, 40 * (1 - deviation));
    }
    // % green cells: 30 pts
    const greenCellPct = Number(curAgg.cells) > 0 ? (Number(curAgg.green_cells) / Number(curAgg.cells)) : 0;
    const greenScore = greenCellPct * 30;
    // ST momentum: 20 pts (stable = 20, accelerating = 20, declining proportionally less)
    const overallStMomentum = prevSt > 0 ? ((curSt - prevSt) / prevSt) * 100 : 0;
    const momentumScore = overallStMomentum >= -5 ? 20 : Math.max(0, 20 + overallStMomentum);
    // Reporting compliance: 10 pts
    const complianceScore = (compliancePct / 100) * 10;

    const healthScore = Math.round(woiScore + greenScore + momentumScore + complianceScore);

    // ── Sparkline data (last 5 weeks SOH + ST) ───────────────────────────────
    const sparkRows = await db.select({
      week_iso: inventorySnapshots.weekIso,
      soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
      st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
    }).from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([inArray(inventorySnapshots.weekIso, historyWeeks.slice(0, 5))], filters))
      .groupBy(inventorySnapshots.weekIso)
      .orderBy(inventorySnapshots.weekIso);

    res.json({
      week_iso: weekIso,
      health_score: healthScore,
      health_score_formula: "WOI band fit (40pts) + % green cells (30pts) + ST momentum (20pts) + reporting compliance (10pts)",
      insufficient_data: prev4Weeks.length < 2,
      data_weeks_available: historyWeeks.length,
      kpis: {
        total_soh: curSoh,
        total_soh_delta: curSoh - prevSoh,
        estimated_value: Number(curAgg.value),
        total_st: curSt,
        total_st_delta: curSt - prevSt,
        blended_woi: blendedWoi,
        blended_woi_delta: blendedWoi !== null && prevSt > 0 ? blendedWoi - prevSoh / prevSt : null,
      },
      sparklines: sparkRows.map(r => ({ week_iso: r.week_iso!, soh: Number(r.soh), st: Number(r.st) })),
      category_trends: categoryTrends,
      coverage: {
        total_skus: totalSkuCount,
        covered_skus: coveredSkuCount,
        coverage_pct: coveragePct,
        resellers_expected: allResellers.length,
        resellers_reported: reportedCount,
        compliance_pct: compliancePct,
      },
      score_breakdown: {
        woi_score: woiScore,
        green_cell_score: greenScore,
        momentum_score: momentumScore,
        compliance_score: complianceScore,
        green_cell_pct: greenCellPct * 100,
        st_momentum_pct: overallStMomentum,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute health insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
