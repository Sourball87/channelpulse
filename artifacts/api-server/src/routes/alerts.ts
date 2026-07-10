import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers, uploads } from "@workspace/db";
import { sql, eq, and, lt, gt, desc, inArray } from "drizzle-orm";
import { previousWeekIso, currentWeekIso } from "../lib/parser";
import { GetAlertsQueryParams } from "@workspace/api-zod";

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

    let weekIso = q.success && q.data.week_iso ? q.data.week_iso : null;
    if (!weekIso) weekIso = await getLatestWeek();
    if (!weekIso) return res.json([]);

    const prevWeek = previousWeekIso(weekIso);

    const alerts: unknown[] = [];

    // ── 1. Overstocked: WOI > 15 with SOH > 20 ────────────────────────────────
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
        .where(eq(inventorySnapshots.weekIso, weekIso));

      for (const r of rows) {
        const soh = r.soh ?? 0;
        const st = r.st ?? 0;
        if (soh > 20 && st > 0) {
          const woiVal = soh / st;
          if (woiVal > 15) {
            alerts.push({
              id: `overstocked:${r.part_id}:${r.reseller_id}:${weekIso}`,
              type: "overstocked",
              severity: woiVal > 30 ? "critical" : "warning",
              week_iso: weekIso,
              message: `${r.part_no} at ${r.reseller_name}: ${woiVal.toFixed(1)} WOI (${soh} units, ${st} sold)`,
              part_no: r.part_no,
              part_id: r.part_id,
              reseller_name: r.reseller_name,
              reseller_id: r.reseller_id,
              soh,
              st,
              woi: woiVal,
              trailing_avg_st: null,
            });
          }
        }
      }
    }

    // ── 2. Stockout risk: SOH = 0 but ST > 0 previous week ──────────────────
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
        .where(and(eq(inventorySnapshots.weekIso, weekIso), eq(inventorySnapshots.soh, 0)));

      if (curZeroSoh.length > 0) {
        const partResellerPairs = curZeroSoh.map((r) => `${r.part_id}:${r.reseller_id}`);
        const prevSales = await db
          .select({
            part_id: inventorySnapshots.partId,
            reseller_id: inventorySnapshots.resellerId,
            st: inventorySnapshots.sellThrough7d,
          })
          .from(inventorySnapshots)
          .where(and(eq(inventorySnapshots.weekIso, prevWeek), gt(inventorySnapshots.sellThrough7d, 0)));

        const prevSaleSet = new Set(prevSales.map((p) => `${p.part_id}:${p.reseller_id}`));
        const prevSaleMap = new Map(prevSales.map((p) => [`${p.part_id}:${p.reseller_id}`, p.st]));

        for (const r of curZeroSoh) {
          const key = `${r.part_id}:${r.reseller_id}`;
          if (prevSaleSet.has(key)) {
            alerts.push({
              id: `stockout_risk:${r.part_id}:${r.reseller_id}:${weekIso}`,
              type: "stockout_risk",
              severity: "warning",
              week_iso: weekIso,
              message: `${r.part_no} at ${r.reseller_name}: SOH dropped to 0 (sold ${prevSaleMap.get(key) ?? 0} last week)`,
              part_no: r.part_no,
              part_id: r.part_id,
              reseller_name: r.reseller_name,
              reseller_id: r.reseller_id,
              soh: 0,
              st: 0,
              woi: null,
              trailing_avg_st: null,
            });
          }
        }
      }
    }

    // ── 3. ST spike: > 3x trailing 4-week avg ─────────────────────────────────
    if (!typeFilter || typeFilter === "st_spike") {
      const curRows = await db
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
        .where(and(eq(inventorySnapshots.weekIso, weekIso), gt(inventorySnapshots.sellThrough7d, 0)));

      if (curRows.length > 0) {
        // Get 4 previous weeks
        const prev4Weeks = await db
          .selectDistinct({ week: inventorySnapshots.weekIso })
          .from(inventorySnapshots)
          .where(lt(inventorySnapshots.weekIso, weekIso))
          .orderBy(desc(inventorySnapshots.weekIso))
          .limit(4);

        const prev4WeekList = prev4Weeks.map((w) => w.week).filter(Boolean) as string[];

        if (prev4WeekList.length > 0) {
          const trailingRows = await db
            .select({
              part_id: inventorySnapshots.partId,
              reseller_id: inventorySnapshots.resellerId,
              st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
            })
            .from(inventorySnapshots)
            .where(inArray(inventorySnapshots.weekIso, prev4WeekList))
            .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);

          const trailingMap = new Map(
            trailingRows.map((r) => [`${r.part_id}:${r.reseller_id}`, Number(r.st)]),
          );

          for (const r of curRows) {
            const key = `${r.part_id}:${r.reseller_id}`;
            const trailingAvg = trailingMap.get(key) ?? 0;
            const st = r.st ?? 0;
            if (trailingAvg > 0 && st > trailingAvg * 3) {
              alerts.push({
                id: `st_spike:${r.part_id}:${r.reseller_id}:${weekIso}`,
                type: "st_spike",
                severity: "warning",
                week_iso: weekIso,
                message: `${r.part_no} at ${r.reseller_name}: ${st} sold this week vs ${trailingAvg.toFixed(1)} avg — possible bulk/commercial deal`,
                part_no: r.part_no,
                part_id: r.part_id,
                reseller_name: r.reseller_name,
                reseller_id: r.reseller_id,
                soh: r.soh,
                st,
                woi: r.soh && st > 0 ? (r.soh ?? 0) / st : null,
                trailing_avg_st: trailingAvg,
              });
            }
          }
        }
      }
    }

    // ── 4. Missing upload ──────────────────────────────────────────────────────
    if (!typeFilter || typeFilter === "missing_upload") {
      const allResellers = await db.select().from(resellers).where(eq(resellers.active, true));
      const reportedResellers = await db
        .selectDistinct({ resellerId: uploads.resellerId })
        .from(uploads)
        .where(and(eq(uploads.weekIso, weekIso), eq(uploads.status, "committed")));
      const reportedIds = new Set(reportedResellers.map((r) => r.resellerId));

      for (const r of allResellers) {
        if (!reportedIds.has(r.id)) {
          alerts.push({
            id: `missing_upload:${r.id}:${weekIso}`,
            type: "missing_upload",
            severity: "info",
            week_iso: weekIso,
            message: `${r.name} has not uploaded data for ${weekIso}`,
            part_no: null,
            part_id: null,
            reseller_name: r.name,
            reseller_id: r.id,
            soh: null,
            st: null,
            woi: null,
            trailing_avg_st: null,
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
        .where(and(eq(inventorySnapshots.weekIso, weekIso), lt(inventorySnapshots.soh, 0)));

      for (const r of negRows) {
        alerts.push({
          id: `negative_soh:${r.part_id}:${r.reseller_id}:${weekIso}`,
          type: "negative_soh",
          severity: "warning",
          week_iso: weekIso,
          message: `${r.part_no} at ${r.reseller_name}: negative SOH (${r.soh})`,
          part_no: r.part_no,
          part_id: r.part_id,
          reseller_name: r.reseller_name,
          reseller_id: r.reseller_id,
          soh: r.soh,
          st: null,
          woi: null,
          trailing_avg_st: null,
        });
      }
    }

    // Sort by severity: critical first
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
