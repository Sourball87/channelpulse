import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, uploads } from "@workspace/db";
import { sql, eq, and, inArray, desc } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { GetDashboardKpisQueryParams, GetDashboardHeatmapQueryParams } from "@workspace/api-zod";
import { parseFilterParams, resolveRange, buildConditions } from "../lib/filter-params";

const router: IRouter = Router();

function woiColor(woi: number | null, soh: number, st: number): string {
  if (soh === 0) return "grey";
  if (st === 0) return "red";
  if (woi === null) return "grey";
  if (woi <= 8) return "green";
  if (woi <= 15) return "amber";
  return "red";
}

async function getLatestWeek(): Promise<string | null> {
  const result = await db
    .select({ week: inventorySnapshots.weekIso })
    .from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso))
    .limit(1);
  return result[0]?.week ?? null;
}

router.get("/dashboard/kpis", async (req, res) => {
  try {
    const q = GetDashboardKpisQueryParams.safeParse(req.query);
    const category = q.success ? q.data.category : undefined;
    const filters = parseFilterParams(req.query as Record<string, unknown>);

    let fallbackWeek = await getLatestWeek();
    if (!fallbackWeek) {
      return res.json({
        week_iso: "—", is_period: false, period_label: "—",
        kpis: [
          { label: "Total SOH", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
          { label: "Avg Weekly ST", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
          { label: "Blended WOI", value: null, formatted: "—", delta: null, delta_pct: null, delta_direction: null },
          { label: "Active SKUs", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
        ],
        reseller_statuses: [],
      });
    }

    // Override weekIso from query if not using period
    if (!filters.weekFrom && q.success && q.data.week_iso) {
      filters.weekIso = q.data.week_iso;
    }

    const range = await resolveRange(filters, fallbackWeek);
    const { weekList, latestWeek, prevWeekList, isPeriod } = range;

    const catCond = (week: string) =>
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, week), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, week);

    const catCondRange = (wList: string[]) =>
      category && category !== "All"
        ? and(inArray(inventorySnapshots.weekIso, wList), eq(parts.category, category))
        : inArray(inventorySnapshots.weekIso, wList);

    // ── Current SOH (latest week) ─────────────────────────────────────────────
    const [curSohAgg] = await db
      .select({
        totalSoh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
        skuCount: sql<number>`count(distinct ${inventorySnapshots.partId})::int`,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([catCond(latestWeek)], filters));

    // ── Current ST (sum across all weeks in range) ────────────────────────────
    const [curStAgg] = await db
      .select({
        totalSt: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([catCondRange(weekList)], filters));

    const curSoh = Number(curSohAgg.totalSoh);
    const sumSt = Number(curStAgg.totalSt);
    const avgWeeklySt = weekList.length > 0 ? sumSt / weekList.length : 0;
    const curWoi = avgWeeklySt > 0 ? curSoh / avgWeeklySt : null;

    // ── Previous period ───────────────────────────────────────────────────────
    let prevSoh = 0, prevAvgWeeklySt = 0, prevWoi: number | null = null;

    if (isPeriod && prevWeekList.length > 0) {
      const [pSohAgg] = await db
        .select({ totalSoh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int` })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([catCond(prevWeekList[0])], filters));

      const [pStAgg] = await db
        .select({ totalSt: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int` })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([catCondRange(prevWeekList)], filters));

      prevSoh = Number(pSohAgg.totalSoh);
      prevAvgWeeklySt = prevWeekList.length > 0 ? Number(pStAgg.totalSt) / prevWeekList.length : 0;
      prevWoi = prevAvgWeeklySt > 0 ? prevSoh / prevAvgWeeklySt : null;
    } else {
      // Single-week: use previousWeekIso for delta
      const prevWeek = previousWeekIso(latestWeek);
      const [prevAgg] = await db
        .select({
          totalSoh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
          totalSt: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([catCond(prevWeek)], filters));

      prevSoh = Number(prevAgg.totalSoh);
      prevAvgWeeklySt = Number(prevAgg.totalSt);
      prevWoi = prevAvgWeeklySt > 0 ? prevSoh / prevAvgWeeklySt : null;
    }

    const deltaLabel = isPeriod ? `vs prior ${weekList.length} wks` : "vs last week";

    function makeDelta(cur: number, prev: number) {
      const delta = cur - prev;
      const pct = prev !== 0 ? (delta / prev) * 100 : null;
      const direction: "up" | "down" | "flat" = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      return { delta, delta_pct: pct !== null ? Math.round(pct * 10) / 10 : null, delta_direction: direction };
    }

    const sohDelta = makeDelta(curSoh, prevSoh);
    const stDelta = makeDelta(Math.round(avgWeeklySt), Math.round(prevAvgWeeklySt));
    const displaySt = Math.round(avgWeeklySt);

    const woiDelta = curWoi !== null && prevWoi !== null ? curWoi - prevWoi : null;
    const woiPct = prevWoi !== null && prevWoi > 0 && woiDelta !== null ? (woiDelta / prevWoi) * 100 : null;

    // ── Reseller reporting status ─────────────────────────────────────────────
    const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
    const filterResellers = filters.resellerIds.length > 0
      ? allResellers.filter(r => filters.resellerIds.includes(r.id))
      : allResellers;

    const reportedThisWeek = await db
      .selectDistinct({ resellerId: uploads.resellerId })
      .from(uploads)
      .where(and(eq(uploads.weekIso, latestWeek), eq(uploads.status, "committed")));
    const reportedSet = new Set(reportedThisWeek.map(r => r.resellerId));

    const resellerStatuses = filterResellers.map(r => ({
      reseller_id: r.id,
      reseller_name: r.name,
      reseller_code: r.code,
      reported: reportedSet.has(r.id),
      expected_files: r.expectedWeeklyFiles,
    }));

    const weeksData = isPeriod ? weekList.length : undefined;

    res.json({
      week_iso: latestWeek,
      is_period: isPeriod,
      period_label: isPeriod
        ? (filters.weekFrom && filters.weekTo
          ? `${filters.weekFrom} – ${filters.weekTo}`
          : `Last ${weekList.length} weeks`)
        : latestWeek,
      weeks_in_range: isPeriod ? weekList.length : undefined,
      delta_label: deltaLabel,
      kpis: [
        {
          label: "Total SOH",
          value: curSoh,
          formatted: curSoh.toLocaleString(),
          ...sohDelta,
        },
        {
          label: isPeriod ? "Avg Weekly ST" : "Total ST",
          value: displaySt,
          formatted: displaySt.toLocaleString(),
          ...stDelta,
        },
        {
          label: "Blended WOI",
          value: curWoi,
          formatted: curWoi !== null ? String(Math.round(curWoi)) : "—",
          delta: woiDelta,
          delta_pct: woiPct !== null ? Math.round(woiPct * 10) / 10 : null,
          delta_direction: woiDelta === null ? null : woiDelta > 0 ? "up" : woiDelta < 0 ? "down" : "flat",
        },
        {
          label: "Active SKUs",
          value: Number(curSohAgg.skuCount),
          formatted: String(curSohAgg.skuCount),
          delta: null, delta_pct: null, delta_direction: null,
        },
      ],
      reseller_statuses: resellerStatuses,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get KPIs");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/dashboard/heatmap", async (req, res) => {
  try {
    const q = GetDashboardHeatmapQueryParams.safeParse(req.query);
    const category = q.success ? q.data.category : undefined;
    const filters = parseFilterParams(req.query as Record<string, unknown>);

    let fallbackWeek = await getLatestWeek();
    if (!fallbackWeek) return res.json({ week_iso: null, parts: [], resellers: [], cells: [] });

    if (!filters.weekFrom && q.success && q.data.week_iso) {
      filters.weekIso = q.data.week_iso;
    }

    const range = await resolveRange(filters, fallbackWeek);
    const { weekList, latestWeek, isPeriod } = range;

    const catParts = category && category !== "All";

    // ── SOH from latest week ──────────────────────────────────────────────────
    const sohRows = await db
      .select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        part_no: parts.partNo,
        display_name: parts.displayName,
        reseller_code: resellers.code,
        soh: inventorySnapshots.soh,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(buildConditions([
        eq(inventorySnapshots.weekIso, latestWeek),
        catParts ? eq(parts.category, category!) : undefined,
      ], filters));

    // ── Avg weekly ST across weekList ─────────────────────────────────────────
    const stRows = await db
      .select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        total_st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        weeks_count: sql<number>`count(distinct ${inventorySnapshots.weekIso})::int`,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([
        inArray(inventorySnapshots.weekIso, weekList),
        catParts ? eq(parts.category, category!) : undefined,
      ], filters))
      .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);

    // Build ST map
    const stMap = new Map<string, { totalSt: number; weeksCount: number }>();
    for (const r of stRows) {
      stMap.set(`${r.part_id}:${r.reseller_id}`, {
        totalSt: Number(r.total_st),
        weeksCount: Number(r.weeks_count),
      });
    }

    const partSet = [...new Set(sohRows.map(r => r.part_no ?? ""))].filter(Boolean);
    const resellerSet = [...new Set(sohRows.map(r => r.reseller_code ?? ""))].filter(Boolean);

    const cells = sohRows.map(r => {
      const soh = r.soh ?? 0;
      const stData = stMap.get(`${r.part_id}:${r.reseller_id}`);
      const avgSt = stData && stData.weeksCount > 0
        ? stData.totalSt / stData.weeksCount
        : 0;
      const woi = avgSt > 0 ? soh / avgSt : null;
      return {
        part_no: r.part_no ?? "",
        display_name: r.display_name ?? null,
        reseller_code: r.reseller_code ?? "",
        reseller_id: r.reseller_id ?? 0,
        part_id: r.part_id ?? 0,
        woi,
        soh,
        st: Math.round(avgSt),
        color: woiColor(woi, soh, Math.round(avgSt)),
      };
    });

    res.json({
      week_iso: latestWeek,
      is_period: isPeriod,
      parts: partSet,
      resellers: resellerSet,
      cells,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get heatmap");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/dashboard/weeks", async (req, res) => {
  try {
    const rows = await db
      .select({
        week_iso: inventorySnapshots.weekIso,
        reseller_count: sql<number>`count(distinct ${inventorySnapshots.resellerId})::int`,
        snapshot_count: sql<number>`count(*)::int`,
      })
      .from(inventorySnapshots)
      .groupBy(inventorySnapshots.weekIso)
      .orderBy(desc(inventorySnapshots.weekIso));

    res.json(rows.map(r => ({
      week_iso: r.week_iso,
      reseller_count: Number(r.reseller_count),
      snapshot_count: Number(r.snapshot_count),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get available weeks");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
