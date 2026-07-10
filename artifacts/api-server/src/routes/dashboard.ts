import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, uploads } from "@workspace/db";
import { sql, eq, and, inArray, desc } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { GetDashboardKpisQueryParams, GetDashboardHeatmapQueryParams } from "@workspace/api-zod";

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

    let weekIso = q.success && q.data.week_iso ? q.data.week_iso : null;
    if (!weekIso) {
      weekIso = await getLatestWeek();
    }
    if (!weekIso) {
      return res.json({
        week_iso: "—",
        kpis: [
          { label: "Total SOH", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
          { label: "Total ST", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
          { label: "Blended WOI", value: null, formatted: "—", delta: null, delta_pct: null, delta_direction: null },
          { label: "Active SKUs", value: 0, formatted: "0", delta: null, delta_pct: null, delta_direction: null },
        ],
        reseller_statuses: [],
      });
    }

    const prevWeek = previousWeekIso(weekIso);

    // Build category filter condition
    const categoryFilter =
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, weekIso);

    const prevCategoryFilter =
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, prevWeek), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, prevWeek);

    // Current week aggregates
    const currentAgg = await db
      .select({
        totalSoh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
        totalSt: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        skuCount: sql<number>`count(distinct ${inventorySnapshots.partId})::int`,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(categoryFilter);

    // Previous week aggregates
    const prevAgg = await db
      .select({
        totalSoh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
        totalSt: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(prevCategoryFilter);

    const cur = currentAgg[0];
    const prev = prevAgg[0];

    const curSoh = Number(cur?.totalSoh ?? 0);
    const curSt = Number(cur?.totalSt ?? 0);
    const prevSoh = Number(prev?.totalSoh ?? 0);
    const prevSt = Number(prev?.totalSt ?? 0);
    const curWoi = curSt > 0 ? curSoh / curSt : null;
    const prevWoi = prevSt > 0 ? prevSoh / prevSt : null;

    const sohDelta = curSoh - prevSoh;
    const stDelta = curSt - prevSt;
    const woiDelta = curWoi !== null && prevWoi !== null ? curWoi - prevWoi : null;

    // Reseller reporting status
    const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
    const reportedResellers = await db
      .selectDistinct({ resellerId: uploads.resellerId })
      .from(uploads)
      .where(and(eq(uploads.weekIso, weekIso), eq(uploads.status, "committed")));

    const reportedIds = new Set(reportedResellers.map((r) => r.resellerId));
    const resellerStatuses = allResellers.map((r) => ({
      reseller_id: r.id,
      name: r.name,
      code: r.code,
      reported: reportedIds.has(r.id),
      upload_id: null as number | null,
    }));

    res.json({
      week_iso: weekIso,
      kpis: [
        {
          label: "Total Channel SOH",
          value: curSoh,
          formatted: curSoh.toLocaleString(),
          delta: sohDelta,
          delta_pct: prevSoh > 0 ? (sohDelta / prevSoh) * 100 : null,
          delta_direction: sohDelta > 0 ? "up" : sohDelta < 0 ? "down" : "flat",
        },
        {
          label: "Total Sell-Through",
          value: curSt,
          formatted: curSt.toLocaleString(),
          delta: stDelta,
          delta_pct: prevSt > 0 ? (stDelta / prevSt) * 100 : null,
          delta_direction: stDelta > 0 ? "up" : stDelta < 0 ? "down" : "flat",
        },
        {
          label: "Blended WOI",
          value: curWoi,
          formatted: curWoi !== null ? curWoi.toFixed(1) : "∞",
          delta: woiDelta,
          delta_pct: prevWoi != null && prevWoi > 0 ? ((woiDelta ?? 0) / prevWoi) * 100 : null,
          delta_direction:
            woiDelta !== null ? (woiDelta < 0 ? "up" : woiDelta > 0 ? "down" : "flat") : null,
        },
        {
          label: "Active SKUs",
          value: Number(cur?.skuCount ?? 0),
          formatted: String(cur?.skuCount ?? 0),
          delta: null,
          delta_pct: null,
          delta_direction: null,
        },
      ],
      reseller_statuses: resellerStatuses,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get dashboard KPIs");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/dashboard/heatmap", async (req, res) => {
  try {
    const q = GetDashboardHeatmapQueryParams.safeParse(req.query);
    const category = q.success ? q.data.category : undefined;

    let weekIso = q.success && q.data.week_iso ? q.data.week_iso : null;
    if (!weekIso) weekIso = await getLatestWeek();
    if (!weekIso) return res.json({ week_iso: "—", parts: [], resellers: [], cells: [] });

    const whereClause =
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, weekIso);

    const rows = await db
      .select({
        part_no: parts.partNo,
        display_name: parts.displayName,
        part_id: parts.id,
        reseller_code: resellers.code,
        reseller_id: resellers.id,
        soh: inventorySnapshots.soh,
        st: inventorySnapshots.sellThrough7d,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(whereClause)
      .orderBy(parts.category, parts.partNo, resellers.code);

    const partSet = [...new Set(rows.map((r) => r.part_no ?? ""))].filter(Boolean);
    const resellerSet = [...new Set(rows.map((r) => r.reseller_code ?? ""))].filter(Boolean);

    const cells = rows.map((r) => {
      const soh = r.soh ?? 0;
      const st = r.st ?? 0;
      const woi = st > 0 ? soh / st : null;
      return {
        part_no: r.part_no ?? "",
        display_name: r.display_name ?? null,
        reseller_code: r.reseller_code ?? "",
        reseller_id: r.reseller_id ?? 0,
        part_id: r.part_id ?? 0,
        woi,
        soh,
        st,
        color: woiColor(woi, soh, st),
      };
    });

    res.json({ week_iso: weekIso, parts: partSet, resellers: resellerSet, cells });
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

    res.json(rows.map((r) => ({
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
