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

router.get("/insights/rebalancing", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    const category = req.query.category as string | undefined;
    let weekIso = req.query.week_iso as string | undefined;
    if (!weekIso) weekIso = (await getLatestWeek()) ?? undefined;
    if (!weekIso) return res.json({ week_iso: null, opportunities: [], insufficient_data: true });

    // Trailing 4-week avg ST
    const prev4Rows = await db.selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .where(sql`${inventorySnapshots.weekIso} < ${weekIso}`)
      .orderBy(desc(inventorySnapshots.weekIso)).limit(4);
    const prev4Weeks = prev4Rows.map(r => r.week!);
    const dataWeeks = prev4Weeks.length;

    const catFilter = category && category !== "All"
      ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
      : eq(inventorySnapshots.weekIso, weekIso);

    // Current week snapshots
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

    // Trailing avg ST
    const trailingAvgMap = new Map<string, number>();
    if (prev4Weeks.length > 0) {
      const tRows = await db.select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        avg_st: sql<number>`avg(${inventorySnapshots.sellThrough7d})::numeric`,
      }).from(inventorySnapshots)
        .where(inArray(inventorySnapshots.weekIso, prev4Weeks))
        .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);
      for (const r of tRows) {
        trailingAvgMap.set(`${r.part_id}:${r.reseller_id}`, Number(r.avg_st));
      }
    }

    // Group by part_id → list of reseller positions
    type Position = {
      part_id: number; reseller_id: number; part_no: string; display_name: string | null;
      category: string; reseller_name: string; soh: number; st: number;
      avg_cost: number | null; woi: number | null; trailing_avg_st: number;
    };

    const byPart = new Map<number, Position[]>();
    for (const r of curRows) {
      const soh = r.soh ?? 0;
      const st = r.st ?? 0;
      const trailingSt = trailingAvgMap.get(`${r.part_id}:${r.reseller_id}`) ?? st;
      const woi = trailingSt > 0 ? soh / trailingSt : (st > 0 ? soh / st : null);
      const pos: Position = {
        part_id: r.part_id!, reseller_id: r.reseller_id!, part_no: r.part_no ?? "",
        display_name: r.display_name ?? null, category: r.category ?? "",
        reseller_name: r.reseller_name ?? "", soh, st,
        avg_cost: r.avg_cost ? Number(r.avg_cost) : null, woi,
        trailing_avg_st: trailingSt,
      };
      const arr = byPart.get(r.part_id!) ?? [];
      arr.push(pos);
      byPart.set(r.part_id!, arr);
    }

    // Find rebalancing pairs: starved (WOI < horizon or SOH=0) ↔ surplus (WOI > overstock_threshold)
    const opportunities: unknown[] = [];
    const starvedWoiLimit = settings.stockoutHorizonWeeks * 2; // e.g. < 6 WOI

    for (const [, positions] of byPart) {
      const starved = positions.filter(p =>
        p.soh === 0 || (p.woi !== null && p.woi < starvedWoiLimit));
      const surplus = positions.filter(p =>
        p.woi !== null && p.woi > settings.overstockWoiThreshold && p.soh >= settings.overstockMinSoh);

      for (const s of starved) {
        for (const d of surplus) {
          if (s.reseller_id === d.reseller_id) continue;

          // Target WOI for both: midpoint of green band
          const targetWoi = (settings.woiGreenMax + settings.woiAmberMax) / 2;
          // Units starved needs to reach target WOI: (targetWoi × avgSt) - SOH
          const starvedNeeds = s.trailing_avg_st > 0
            ? Math.ceil(targetWoi * s.trailing_avg_st - s.soh) : s.soh === 0 ? Math.ceil(targetWoi * (d.trailing_avg_st / 2)) : 0;
          // Units donor can spare: SOH - (targetWoi × donorAvgSt)
          const donorCan = d.trailing_avg_st > 0
            ? Math.floor(d.soh - targetWoi * d.trailing_avg_st) : 0;

          if (starvedNeeds <= 0 || donorCan <= 0) continue;

          const transferQty = Math.min(starvedNeeds, donorCan);
          if (transferQty <= 0) continue;

          opportunities.push({
            part_id: s.part_id,
            part_no: s.part_no,
            display_name: s.display_name,
            category: s.category,
            starved_reseller_id: s.reseller_id,
            starved_reseller_name: s.reseller_name,
            starved_soh: s.soh,
            starved_woi: s.woi,
            starved_trailing_st: s.trailing_avg_st,
            donor_reseller_id: d.reseller_id,
            donor_reseller_name: d.reseller_name,
            donor_soh: d.soh,
            donor_woi: d.woi,
            donor_trailing_st: d.trailing_avg_st,
            suggested_transfer_qty: transferQty,
            transfer_value: d.avg_cost != null ? transferQty * d.avg_cost : null,
            action: "Transfer stock",
            explorer_link: `/explorer?part_id=${s.part_id}`,
          });
        }
      }
    }

    // Sort by starved reseller's ST (biggest run-rate at risk first)
    (opportunities as Array<{ starved_trailing_st: number }>)
      .sort((a, b) => b.starved_trailing_st - a.starved_trailing_st);

    // Deduplicate: keep best opportunity per starved position
    const seen = new Set<string>();
    const deduped = (opportunities as Array<{ part_id: number; starved_reseller_id: number }>)
      .filter(o => {
        const key = `${o.part_id}:${o.starved_reseller_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    res.json({
      week_iso: weekIso,
      insufficient_data: dataWeeks < 1,
      data_weeks_available: dataWeeks + 1,
      opportunities: deduped.slice(0, 10),
      opportunities_total: deduped.length,
      thresholds: {
        starved_woi_limit: starvedWoiLimit,
        surplus_woi_limit: settings.overstockWoiThreshold,
        min_donor_soh: settings.overstockMinSoh,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute rebalancing insight");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
