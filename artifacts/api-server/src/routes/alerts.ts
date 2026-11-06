import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, uploads } from "@workspace/db";
import { sql, eq, and, lt, gt, desc, inArray } from "drizzle-orm";
import { previousWeekIso, currentWeekIso } from "../lib/parser";
import { GetAlertsQueryParams } from "@workspace/api-zod";
import { parseFilterParams, resolveRange, buildConditions } from "../lib/filter-params";
import { loadSalesReconciliation } from "../lib/load-sales-reconciliation";

const router: IRouter = Router();

async function getLatestWeek(): Promise<string | null> {
  const result = await db
    .select({ week: inventorySnapshots.weekIso })
    .from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso))
    .limit(1);
  return result[0]?.week ?? null;
}

router.get("/alerts", async (req, res) => {
  try {
    const q = GetAlertsQueryParams.safeParse(req.query);
    const typeFilter = q.success ? q.data.type : undefined;
    const filters = parseFilterParams(req.query as Record<string, unknown>);

    let weekIso = q.success && q.data.week_iso ? q.data.week_iso : null;
    if (!weekIso) weekIso = await getLatestWeek();
    if (!weekIso) return res.json([]);

    // In period mode, use the latest week of the range
    if (filters.weekFrom && filters.weekTo) {
      const range = await resolveRange(filters, weekIso);
      weekIso = range.latestWeek;
    }

    const prevWeek = previousWeekIso(weekIso);
    const alerts: unknown[] = [];

    const baseFilter = (w: string) => buildConditions([eq(inventorySnapshots.weekIso, w)], filters);

    // ── 1. Overstocked ────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "overstocked") {
      const rows = await db
        .select({
          part_id: inventorySnapshots.partId,
          reseller_id: inventorySnapshots.resellerId,
          part_no: parts.partNo,
          reseller_name: resellers.name,
          soh: inventorySnapshots.soh,
          st: inventorySnapshots.sellThrough7d,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
        .where(baseFilter(weekIso));

      for (const r of rows) {
        const soh = r.soh ?? 0, st = r.st ?? 0;
        if (soh > 20 && st > 0) {
          const woiVal = soh / st;
          if (woiVal > 15) {
            alerts.push({
              id: `overstocked:${r.part_id}:${r.reseller_id}:${weekIso}`,
              type: "overstocked",
              severity: woiVal > 30 ? "critical" : "warning",
              week_iso: weekIso,
              message: `${r.part_no} at ${r.reseller_name}: ${woiVal.toFixed(1)} WOI (${soh} units, ${st} sold)`,
              part_no: r.part_no, part_id: r.part_id, reseller_name: r.reseller_name, reseller_id: r.reseller_id,
              soh, st, woi: woiVal, trailing_avg_st: null,
            });
          }
        }
      }
    }

    // ── 2. Stockout risk ──────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "stockout_risk") {
      const curZeroSoh = await db
        .select({
          part_id: inventorySnapshots.partId,
          reseller_id: inventorySnapshots.resellerId,
          part_no: parts.partNo,
          reseller_name: resellers.name,
          soh: inventorySnapshots.soh,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
        .where(buildConditions([
          eq(inventorySnapshots.weekIso, weekIso),
          eq(inventorySnapshots.soh, 0),
        ], filters));

      if (curZeroSoh.length > 0) {
        const prevSales = await db
          .select({
            part_id: inventorySnapshots.partId,
            reseller_id: inventorySnapshots.resellerId,
            st: inventorySnapshots.sellThrough7d,
          })
          .from(inventorySnapshots)
          .where(buildConditions([
            eq(inventorySnapshots.weekIso, prevWeek),
            gt(inventorySnapshots.sellThrough7d, 0),
          ], filters));

        const prevSaleSet = new Set(prevSales.map(p => `${p.part_id}:${p.reseller_id}`));
        for (const r of curZeroSoh) {
          if (prevSaleSet.has(`${r.part_id}:${r.reseller_id}`)) {
            alerts.push({
              id: `stockout_risk:${r.part_id}:${r.reseller_id}:${weekIso}`,
              type: "stockout_risk",
              severity: "critical",
              week_iso: weekIso,
              message: `${r.part_no} at ${r.reseller_name}: zero SOH after active sales last week`,
              part_no: r.part_no, part_id: r.part_id, reseller_name: r.reseller_name, reseller_id: r.reseller_id,
              soh: 0, st: null, woi: 0, trailing_avg_st: null,
            });
          }
        }
      }
    }

    // ── 3. ST spike ───────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "st_spike") {
      const prev4Rows = await db
        .selectDistinct({ week: inventorySnapshots.weekIso })
        .from(inventorySnapshots)
        .where(sql`${inventorySnapshots.weekIso} < ${weekIso}`)
        .orderBy(desc(inventorySnapshots.weekIso))
        .limit(4);
      const prev4Weeks = prev4Rows.map(r => r.week!);

      if (prev4Weeks.length >= 2) {
        const curRows = await db
          .select({
            part_id: inventorySnapshots.partId,
            reseller_id: inventorySnapshots.resellerId,
            part_no: parts.partNo,
            reseller_name: resellers.name,
            st: inventorySnapshots.sellThrough7d,
          })
          .from(inventorySnapshots)
          .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
          .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
          .where(baseFilter(weekIso));

        const histRows = await db
          .select({
            part_id: inventorySnapshots.partId,
            reseller_id: inventorySnapshots.resellerId,
            avg_st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
          })
          .from(inventorySnapshots)
          .where(buildConditions([inArray(inventorySnapshots.weekIso, prev4Weeks)], filters))
          .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);

        const histMap = new Map(histRows.map(r => [`${r.part_id}:${r.reseller_id}`, Number(r.avg_st)]));
        for (const r of curRows) {
          const avgSt = histMap.get(`${r.part_id}:${r.reseller_id}`) ?? 0;
          const curSt = r.st ?? 0;
          if (avgSt > 0 && curSt >= avgSt * 3) {
            alerts.push({
              id: `st_spike:${r.part_id}:${r.reseller_id}:${weekIso}`,
              type: "st_spike",
              severity: "info",
              week_iso: weekIso,
              message: `${r.part_no} at ${r.reseller_name}: ST ${curSt} vs ${avgSt.toFixed(1)} avg (${(curSt / avgSt).toFixed(1)}×)`,
              part_no: r.part_no, part_id: r.part_id, reseller_name: r.reseller_name, reseller_id: r.reseller_id,
              soh: null, st: curSt, woi: null, trailing_avg_st: avgSt,
            });
          }
        }
      }
    }

    // ── 4. Missing upload ─────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "missing_upload") {
      const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
      const filtered = filters.resellerIds.length > 0
        ? allResellers.filter(r => filters.resellerIds.includes(r.id))
        : allResellers;

      const committed = await db
        .selectDistinct({ resellerId: uploads.resellerId })
        .from(uploads)
        .where(and(eq(uploads.weekIso, weekIso), eq(uploads.status, "committed")));
      const committedSet = new Set(committed.map(r => r.resellerId));

      for (const r of filtered) {
        if (!committedSet.has(r.id)) {
          alerts.push({
            id: `missing_upload:${r.id}:${weekIso}`,
            type: "missing_upload",
            severity: "warning",
            week_iso: weekIso,
            message: `${r.name} has not submitted data for ${weekIso}`,
            part_no: null, part_id: null, reseller_name: r.name, reseller_id: r.id,
            soh: null, st: null, woi: null, trailing_avg_st: null,
          });
        }
      }
    }

    // ── 5. Negative SOH ───────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "negative_soh") {
      const negRows = await db
        .select({
          part_id: inventorySnapshots.partId,
          reseller_id: inventorySnapshots.resellerId,
          part_no: parts.partNo,
          reseller_name: resellers.name,
          soh: inventorySnapshots.soh,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
        .where(buildConditions([
          eq(inventorySnapshots.weekIso, weekIso),
          lt(inventorySnapshots.soh, 0),
        ], filters));

      for (const r of negRows) {
        alerts.push({
          id: `negative_soh:${r.part_id}:${r.reseller_id}:${weekIso}`,
          type: "negative_soh", severity: "warning", week_iso: weekIso,
          message: `${r.part_no} at ${r.reseller_name}: negative SOH (${r.soh})`,
          part_no: r.part_no, part_id: r.part_id, reseller_name: r.reseller_name, reseller_id: r.reseller_id,
          soh: r.soh, st: null, woi: null, trailing_avg_st: null,
        });
      }
    }

    if (!typeFilter || typeFilter === "serials_exceed_sold" || typeFilter === "sold_not_serial_reported") {
      const data = await loadSalesReconciliation(weekIso, { partIds: filters.partIds, resellerIds: filters.resellerIds });
      for (const row of data.rows.filter(r => r.week_iso === weekIso)) for (const alert of row.alerts) {
        const type = alert.severity === "high" ? "serials_exceed_sold" : "sold_not_serial_reported";
        if (typeFilter && type !== typeFilter) continue;
        alerts.push({
          id: `${type}:${row.reseller_id}:${row.part_no}:${weekIso}`, type,
          severity: alert.severity === "high" ? "critical" : "info", week_iso: weekIso,
          message: `${row.part_no} at ${row.code}: ${alert.message}${row.serial_report_received ? "" : " (customer serial report missing)"}`,
          part_no: row.part_no, part_id: row.part_id, reseller_name: row.code, reseller_id: row.reseller_id,
          soh: row.soh, st: row.sell_through, woi: null, trailing_avg_st: null,
        });
      }
    }
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    (alerts as Array<{ severity: string }>).sort(
      (a, b) => (severityOrder[a.severity as keyof typeof severityOrder] ?? 3) - (severityOrder[b.severity as keyof typeof severityOrder] ?? 3),
    );

    res.json(alerts);
  } catch (err) {
    req.log.error({ err }, "Failed to get alerts");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
