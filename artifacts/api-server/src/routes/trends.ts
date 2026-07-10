import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, inArray, desc } from "drizzle-orm";
import { GetTrendsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/trends", async (req, res) => {
  try {
    const q = GetTrendsQueryParams.safeParse(req.query);
    const weeks = q.success && q.data.weeks ? q.data.weeks : 12;

    const partIdStrs = q.success && q.data.part_ids ? q.data.part_ids.split(",").filter(Boolean) : [];
    const resellerIdStrs = q.success && q.data.reseller_ids ? q.data.reseller_ids.split(",").filter(Boolean) : [];
    const partIds = partIdStrs.map(Number).filter((n) => !isNaN(n));
    const resellerIds = resellerIdStrs.map(Number).filter((n) => !isNaN(n));

    // Get last N weeks
    const weekRows = await db
      .selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .orderBy(desc(inventorySnapshots.weekIso))
      .limit(weeks);

    const weekList = weekRows.map((w) => w.week).filter(Boolean) as string[];
    if (weekList.length === 0) return res.json([]);

    // Build conditions
    const conditions = [inArray(inventorySnapshots.weekIso, weekList)];
    if (partIds.length > 0) conditions.push(inArray(inventorySnapshots.partId, partIds));
    if (resellerIds.length > 0) conditions.push(inArray(inventorySnapshots.resellerId, resellerIds));

    const groupKeys: string[] = [];
    if (partIds.length > 0 && resellerIds.length > 0) {
      // One series per part+reseller combination
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

      // Group into series
      const seriesMap = new Map<string, { key: string; label: string; part_no: string; reseller_code: string; points: Map<string, { soh: number; st: number; sold_mtd: number; on_order: number }> }>();

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
        const existing = s.points.get(r.week_iso!) ?? { soh: 0, st: 0, sold_mtd: 0, on_order: 0 };
        s.points.set(r.week_iso!, {
          soh: existing.soh + (r.soh ?? 0),
          st: existing.st + (r.st ?? 0),
          sold_mtd: existing.sold_mtd + (r.sold_mtd ?? 0),
          on_order: existing.on_order + (r.on_order ?? 0),
        });
      }

      const series = [...seriesMap.values()].map((s) => ({
        key: s.key, label: s.label, part_no: s.part_no, reseller_code: s.reseller_code,
        points: weekList.slice().reverse().map((w) => {
          const p = s.points.get(w) ?? { soh: 0, st: 0, sold_mtd: 0, on_order: 0 };
          return { week_iso: w, soh: p.soh, st: p.st, woi: p.st > 0 ? p.soh / p.st : null, sold_mtd: p.sold_mtd, on_order: p.on_order };
        }),
      }));

      return res.json(series);
    }

    // Simple: one series per part or per reseller
    if (partIds.length > 0) {
      const partsData = await db.select().from(parts).where(inArray(parts.id, partIds));
      const series = await Promise.all(
        partsData.map(async (p) => {
          const rows = await db
            .select({
              week_iso: inventorySnapshots.weekIso,
              soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
              st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
              sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
              on_order: sql<number>`coalesce(sum(${inventorySnapshots.onOrder}), 0)::int`,
            })
            .from(inventorySnapshots)
            .where(and(inArray(inventorySnapshots.weekIso, weekList), eq(inventorySnapshots.partId, p.id)))
            .groupBy(inventorySnapshots.weekIso)
            .orderBy(inventorySnapshots.weekIso);

          const pointMap = new Map(rows.map((r) => [r.week_iso, r]));
          return {
            key: `part:${p.id}`, label: p.displayName || p.partNo,
            part_no: p.partNo, reseller_code: null,
            points: weekList.slice().reverse().map((w) => {
              const r = pointMap.get(w);
              const soh = Number(r?.soh ?? 0), st = Number(r?.st ?? 0);
              return { week_iso: w, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r?.sold_mtd ?? 0), on_order: Number(r?.on_order ?? 0) };
            }),
          };
        }),
      );
      return res.json(series);
    }

    if (resellerIds.length > 0) {
      const resellersData = await db.select().from(resellers).where(inArray(resellers.id, resellerIds));
      const series = await Promise.all(
        resellersData.map(async (re) => {
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
            .groupBy(inventorySnapshots.weekIso)
            .orderBy(inventorySnapshots.weekIso);

          const pointMap = new Map(rows.map((r) => [r.week_iso, r]));
          return {
            key: `reseller:${re.id}`, label: re.name, part_no: null, reseller_code: re.code,
            points: weekList.slice().reverse().map((w) => {
              const r = pointMap.get(w);
              const soh = Number(r?.soh ?? 0), st = Number(r?.st ?? 0);
              return { week_iso: w, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r?.sold_mtd ?? 0), on_order: Number(r?.on_order ?? 0) };
            }),
          };
        }),
      );
      return res.json(series);
    }

    // No filter: aggregate across everything
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
      .groupBy(inventorySnapshots.weekIso)
      .orderBy(inventorySnapshots.weekIso);

    const pointMap = new Map(rows.map((r) => [r.week_iso, r]));
    res.json([{
      key: "all", label: "Total Channel", part_no: null, reseller_code: null,
      points: weekList.slice().reverse().map((w) => {
        const r = pointMap.get(w);
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
