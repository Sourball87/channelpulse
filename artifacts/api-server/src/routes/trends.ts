import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, inArray, desc } from "drizzle-orm";
import { parseFilterParams, resolveRange, buildConditions } from "../lib/filter-params";

const router: IRouter = Router();

router.get("/trends", async (req, res) => {
  try {
    const filters = parseFilterParams(req.query as Record<string, unknown>);
    const partIds = filters.partIds;
    const resellerIds = filters.resellerIds;

    const weeksParam = req.query.weeks ? parseInt(String(req.query.weeks), 10) : 12;
    const safeWeeks = isNaN(weeksParam) ? 12 : Math.min(Math.max(weeksParam, 1), 52);

    // Determine week list
    let weekList: string[];

    if (filters.weekFrom && filters.weekTo) {
      // Period mode: use the specified range
      const rangeRows = await db
        .selectDistinct({ week: inventorySnapshots.weekIso })
        .from(inventorySnapshots)
        .where(
          sql`${inventorySnapshots.weekIso} >= ${filters.weekFrom} AND ${inventorySnapshots.weekIso} <= ${filters.weekTo}`,
        )
        .orderBy(desc(inventorySnapshots.weekIso));
      weekList = rangeRows.map(r => r.week!);
    } else {
      // Single-week or default: last N weeks ending at weekIso (or latest)
      const endWeek = filters.weekIso;
      const cond = endWeek
        ? sql`${inventorySnapshots.weekIso} <= ${endWeek}`
        : sql`1=1`;
      const weekRows = await db
        .selectDistinct({ week: inventorySnapshots.weekIso })
        .from(inventorySnapshots)
        .where(cond)
        .orderBy(desc(inventorySnapshots.weekIso))
        .limit(safeWeeks);
      weekList = weekRows.map(r => r.week!).filter(Boolean);
    }

    if (weekList.length === 0) return res.json([]);

    const conditions: any[] = [inArray(inventorySnapshots.weekIso, weekList)];
    if (partIds.length > 0) conditions.push(inArray(inventorySnapshots.partId, partIds));
    if (resellerIds.length > 0) conditions.push(inArray(inventorySnapshots.resellerId, resellerIds));

    const chronological = [...weekList].sort(); // oldest-first for chart

    if (partIds.length > 0 && resellerIds.length > 0) {
      // One series per part×reseller
      const rawRows = await db
        .select({
          week_iso: inventorySnapshots.weekIso,
          part_id: inventorySnapshots.partId,
          reseller_id: inventorySnapshots.resellerId,
          part_no: parts.partNo,
          reseller_code: resellers.code,
          soh: inventorySnapshots.soh,
          st: inventorySnapshots.sellThrough7d,
          sold_mtd: inventorySnapshots.soldMtd,
          on_order: inventorySnapshots.onOrder,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
        .where(and(...conditions))
        .orderBy(inventorySnapshots.weekIso);

      const seriesMap = new Map<string, {
        key: string; label: string; part_no: string; reseller_code: string;
        points: Map<string, { soh: number; st: number; sold_mtd: number; on_order: number }>;
      }>();

      for (const r of rawRows) {
        const key = `${r.part_id}:${r.reseller_id}`;
        if (!seriesMap.has(key)) {
          seriesMap.set(key, {
            key, label: `${r.part_no} @ ${r.reseller_code}`,
            part_no: r.part_no ?? "", reseller_code: r.reseller_code ?? "",
            points: new Map(),
          });
        }
        const s = seriesMap.get(key)!;
        const ex = s.points.get(r.week_iso!) ?? { soh: 0, st: 0, sold_mtd: 0, on_order: 0 };
        s.points.set(r.week_iso!, {
          soh: ex.soh + (r.soh ?? 0), st: ex.st + (r.st ?? 0),
          sold_mtd: ex.sold_mtd + (r.sold_mtd ?? 0), on_order: ex.on_order + (r.on_order ?? 0),
        });
      }

      return res.json([...seriesMap.values()].map(s => ({
        key: s.key, label: s.label, part_no: s.part_no, reseller_code: s.reseller_code,
        points: chronological.map(w => {
          const p = s.points.get(w) ?? { soh: 0, st: 0, sold_mtd: 0, on_order: 0 };
          return { week_iso: w, soh: p.soh, st: p.st, woi: p.st > 0 ? p.soh / p.st : null, sold_mtd: p.sold_mtd, on_order: p.on_order };
        }),
      })));
    }

    if (partIds.length > 0) {
      // One series per part (aggregated across all resellers)
      const allParts = await db.select().from(parts).where(inArray(parts.id, partIds));
      const series = await Promise.all(allParts.map(async pt => {
        const rows = await db
          .select({
            week_iso: inventorySnapshots.weekIso,
            soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
            st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
            sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
            on_order: sql<number>`coalesce(sum(${inventorySnapshots.onOrder}), 0)::int`,
          })
          .from(inventorySnapshots)
          .where(and(inArray(inventorySnapshots.weekIso, weekList), eq(inventorySnapshots.partId, pt.id)))
          .groupBy(inventorySnapshots.weekIso);
        const pm = new Map(rows.map(r => [r.week_iso, r]));
        return {
          key: `part:${pt.id}`, label: pt.displayName ?? pt.partNo, part_no: pt.partNo, reseller_code: null,
          points: chronological.map(w => {
            const r = pm.get(w);
            const soh = Number(r?.soh ?? 0), st = Number(r?.st ?? 0);
            return { week_iso: w, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r?.sold_mtd ?? 0), on_order: Number(r?.on_order ?? 0) };
          }),
        };
      }));
      return res.json(series);
    }

    if (resellerIds.length > 0) {
      // One series per reseller
      const allResellers = await db.select().from(resellers).where(inArray(resellers.id, resellerIds));
      const series = await Promise.all(allResellers.map(async re => {
        const rows = await db
          .select({
            week_iso: inventorySnapshots.weekIso,
            soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
            st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
            sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
            on_order: sql<number>`coalesce(sum(${inventorySnapshots.onOrder}), 0)::int`,
          })
          .from(inventorySnapshots)
          .where(and(inArray(inventorySnapshots.weekIso, weekList), eq(inventorySnapshots.resellerId, re.id)))
          .groupBy(inventorySnapshots.weekIso);
        const pm = new Map(rows.map(r => [r.week_iso, r]));
        return {
          key: `reseller:${re.id}`, label: re.name, part_no: null, reseller_code: re.code,
          points: chronological.map(w => {
            const r = pm.get(w);
            const soh = Number(r?.soh ?? 0), st = Number(r?.st ?? 0);
            return { week_iso: w, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r?.sold_mtd ?? 0), on_order: Number(r?.on_order ?? 0) };
          }),
        };
      }));
      return res.json(series);
    }

    // No filter: single aggregate series
    const rows = await db
      .select({
        week_iso: inventorySnapshots.weekIso,
        soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
        st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
        on_order: sql<number>`coalesce(sum(${inventorySnapshots.onOrder}), 0)::int`,
      })
      .from(inventorySnapshots)
      .where(inArray(inventorySnapshots.weekIso, weekList))
      .groupBy(inventorySnapshots.weekIso);

    const pm = new Map(rows.map(r => [r.week_iso, r]));
    res.json([{
      key: "all", label: "Total Channel", part_no: null, reseller_code: null,
      points: chronological.map(w => {
        const r = pm.get(w);
        const soh = Number(r?.soh ?? 0), st = Number(r?.st ?? 0);
        return { week_iso: w, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r?.sold_mtd ?? 0), on_order: Number(r?.on_order ?? 0) };
      }),
    }]);
  } catch (err) {
    req.log.error({ err }, "Failed to get trends");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
