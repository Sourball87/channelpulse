import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { GetExplorerDataQueryParams, GetExplorerTrendQueryParams } from "@workspace/api-zod";
import { parseFilterParams, resolveRange, buildConditions } from "../lib/filter-params";

const router: IRouter = Router();

function woi(soh: number, st: number): number | null {
  return st > 0 ? soh / st : null;
}

async function getLatestWeek(): Promise<string | null> {
  const result = await db
    .select({ week: inventorySnapshots.weekIso })
    .from(inventorySnapshots)
    .orderBy(desc(inventorySnapshots.weekIso))
    .limit(1);
  return result[0]?.week ?? null;
}

router.get("/explorer", async (req, res) => {
  try {
    const q = GetExplorerDataQueryParams.safeParse(req.query);
    const category = q.success ? q.data.category : undefined;
    const pivot = (q.success ? q.data.pivot : undefined) ?? "category_model_reseller";
    const filters = parseFilterParams(req.query as Record<string, unknown>);

    let fallbackWeek = await getLatestWeek();
    if (!fallbackWeek) return res.json([]);

    if (!filters.weekFrom && q.success && q.data.week_iso) {
      filters.weekIso = q.data.week_iso;
    }

    const range = await resolveRange(filters, fallbackWeek);
    const { weekList, latestWeek, isPeriod } = range;

    const catParts = category && category !== "All";
    const prevWeek = previousWeekIso(latestWeek);

    // ── Current week: SOH from latestWeek ────────────────────────────────────
    const curRows = await db
      .select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        part_no: parts.partNo,
        display_name: parts.displayName,
        category: parts.category,
        reseller_code: resellers.code,
        reseller_name: resellers.name,
        soh: inventorySnapshots.soh,
        st: inventorySnapshots.sellThrough7d,
        sold_mtd: inventorySnapshots.soldMtd,
        on_order: inventorySnapshots.onOrder,
        avg_cost: inventorySnapshots.avgCost,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .leftJoin(resellers, eq(inventorySnapshots.resellerId, resellers.id))
      .where(buildConditions([
        eq(inventorySnapshots.weekIso, latestWeek),
        catParts ? eq(parts.category, category!) : undefined,
      ], filters));

    // ── Period ST sums (if period mode) ──────────────────────────────────────
    let periodStMap = new Map<string, { sumSt: number; weeksCount: number; sumSoldMtd: number }>();
    if (isPeriod && weekList.length > 1) {
      const stRows = await db
        .select({
          part_id: inventorySnapshots.partId,
          reseller_id: inventorySnapshots.resellerId,
          sum_st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
          sum_sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
          weeks_count: sql<number>`count(distinct ${inventorySnapshots.weekIso})::int`,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([
          inArray(inventorySnapshots.weekIso, weekList),
          catParts ? eq(parts.category, category!) : undefined,
        ], filters))
        .groupBy(inventorySnapshots.partId, inventorySnapshots.resellerId);

      for (const r of stRows) {
        periodStMap.set(`${r.part_id}:${r.reseller_id}`, {
          sumSt: Number(r.sum_st),
          weeksCount: Number(r.weeks_count),
          sumSoldMtd: Number(r.sum_sold_mtd),
        });
      }
    }

    const getEffectiveSt = (partId: number, resellerId: number, rawSt: number) => {
      if (!isPeriod) return rawSt;
      const pd = periodStMap.get(`${partId}:${resellerId}`);
      return pd && pd.weeksCount > 0 ? pd.sumSt / pd.weeksCount : rawSt;
    };
    const getEffectiveSoldMtd = (partId: number, resellerId: number, rawMtd: number) => {
      if (!isPeriod) return rawMtd;
      const pd = periodStMap.get(`${partId}:${resellerId}`);
      return pd ? pd.sumSoldMtd : rawMtd;
    };

    // ── Previous week (for deltas) ────────────────────────────────────────────
    const prevRows = await db
      .select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        soh: inventorySnapshots.soh,
        st: inventorySnapshots.sellThrough7d,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(buildConditions([
        eq(inventorySnapshots.weekIso, prevWeek),
        catParts ? eq(parts.category, category!) : undefined,
      ], filters));

    const prevMap = new Map<string, { soh: number; st: number }>();
    for (const r of prevRows) {
      prevMap.set(`${r.part_id}:${r.reseller_id}`, { soh: r.soh ?? 0, st: r.st ?? 0 });
    }

    const result: unknown[] = [];

    // ── model_week pivot (only in period mode) ────────────────────────────────
    if (pivot === "model_week" && isPeriod) {
      // Fetch all weeks in range with per-model ST for a weekly progression table
      const weeklyRows = await db
        .select({
          part_id: inventorySnapshots.partId,
          part_no: parts.partNo,
          display_name: parts.displayName,
          category: parts.category,
          week_iso: inventorySnapshots.weekIso,
          soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
          st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        })
        .from(inventorySnapshots)
        .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
        .where(buildConditions([
          inArray(inventorySnapshots.weekIso, weekList),
          catParts ? eq(parts.category, category!) : undefined,
        ], filters))
        .groupBy(inventorySnapshots.partId, parts.partNo, parts.displayName, parts.category, inventorySnapshots.weekIso);

      const modelMap = new Map<string, {
        part_id: number; part_no: string; display_name: string | null; category: string;
        weeks: Map<string, { soh: number; st: number }>;
      }>();

      for (const r of weeklyRows) {
        const key = String(r.part_id);
        if (!modelMap.has(key)) {
          modelMap.set(key, { part_id: r.part_id!, part_no: r.part_no!, display_name: r.display_name, category: r.category!, weeks: new Map() });
        }
        modelMap.get(key)!.weeks.set(r.week_iso!, { soh: Number(r.soh), st: Number(r.st) });
      }

      const weeksChron = [...weekList].sort();
      for (const [_, m] of modelMap) {
        const totalSoh = m.weeks.get(latestWeek)?.soh ?? 0;
        const totalSt = [...m.weeks.values()].reduce((s, v) => s + v.st, 0);
        const avgSt = weekList.length > 0 ? totalSt / weekList.length : 0;
        const modelId = `model:${m.part_id}`;
        result.push({
          id: modelId, parent_id: null, level: "model",
          label: m.display_name ?? m.part_no,
          part_id: m.part_id, part_no: m.part_no, category: m.category,
          soh: totalSoh, st: Math.round(avgSt),
          soh_delta: null, st_delta: null,
          sold_mtd: null, on_order: null, avg_cost: null,
          woi: woi(totalSoh, Math.round(avgSt)),
        });
        for (const w of weeksChron) {
          const wd = m.weeks.get(w) ?? { soh: 0, st: 0 };
          result.push({
            id: `${modelId}:${w}`, parent_id: modelId, level: "week",
            label: w,
            part_id: m.part_id, part_no: m.part_no, category: m.category,
            soh: wd.soh, st: wd.st,
            soh_delta: null, st_delta: null,
            sold_mtd: null, on_order: null, avg_cost: null,
            woi: woi(wd.soh, wd.st),
          });
        }
      }
      return res.json(result);
    }

    if (pivot === "reseller_model") {
      // Group: reseller → model
      const resellerMap = new Map<string, {
        reseller_id: number; reseller_code: string; reseller_name: string;
        soh: number; st: number; sold_mtd: number; on_order: number;
        models: Map<string, {
          part_id: number; part_no: string; display_name: string | null; category: string;
          soh: number; st: number; sold_mtd: number; on_order: number; avg_cost: number | null;
        }>;
      }>();

      for (const r of curRows) {
        const rKey = String(r.reseller_id);
        if (!resellerMap.has(rKey)) {
          resellerMap.set(rKey, {
            reseller_id: r.reseller_id ?? 0, reseller_code: r.reseller_code ?? "",
            reseller_name: r.reseller_name ?? "", soh: 0, st: 0, sold_mtd: 0, on_order: 0,
            models: new Map(),
          });
        }
        const re = resellerMap.get(rKey)!;
        const effSt = Math.round(getEffectiveSt(r.part_id!, r.reseller_id!, r.st ?? 0));
        const effMtd = getEffectiveSoldMtd(r.part_id!, r.reseller_id!, r.sold_mtd ?? 0);
        re.soh += r.soh ?? 0;
        re.st += effSt;
        re.sold_mtd += effMtd;
        re.on_order += r.on_order ?? 0;
        re.models.set(String(r.part_id), {
          part_id: r.part_id ?? 0, part_no: r.part_no ?? "",
          display_name: r.display_name, category: r.category ?? "",
          soh: r.soh ?? 0, st: effSt, sold_mtd: effMtd,
          on_order: r.on_order ?? 0, avg_cost: r.avg_cost != null ? Number(r.avg_cost) : null,
        });
      }

      for (const [_, re] of resellerMap) {
        const rId = `reseller:${re.reseller_id}`;
        const prevResellerSoh = [...re.models.keys()].reduce((s, pid) => {
          return s + (prevMap.get(`${pid}:${re.reseller_id}`)?.soh ?? 0);
        }, 0);
        const prevResellerSt = [...re.models.keys()].reduce((s, pid) => {
          return s + (prevMap.get(`${pid}:${re.reseller_id}`)?.st ?? 0);
        }, 0);
        result.push({
          id: rId, parent_id: null, level: "reseller",
          label: re.reseller_name || re.reseller_code,
          reseller_id: re.reseller_id, reseller_code: re.reseller_code,
          soh: re.soh, st: re.st, sold_mtd: re.sold_mtd, on_order: re.on_order,
          soh_delta: re.soh - prevResellerSoh, st_delta: re.st - prevResellerSt,
          woi: woi(re.soh, re.st),
        });
        for (const [_, m] of re.models) {
          const prev = prevMap.get(`${m.part_id}:${re.reseller_id}`) ?? { soh: 0, st: 0 };
          result.push({
            id: `${rId}:model:${m.part_id}`, parent_id: rId, level: "model",
            label: m.display_name ?? m.part_no,
            part_id: m.part_id, part_no: m.part_no, category: m.category,
            reseller_id: re.reseller_id, reseller_code: re.reseller_code,
            soh: m.soh, st: m.st, sold_mtd: m.sold_mtd, on_order: m.on_order, avg_cost: m.avg_cost,
            soh_delta: m.soh - prev.soh, st_delta: m.st - prev.st,
            woi: woi(m.soh, m.st),
          });
        }
      }
      return res.json(result);
    }

    // ── Default: category → model → reseller ─────────────────────────────────
    const categoryMap = new Map<string, {
      soh: number; st: number; sold_mtd: number; on_order: number;
      models: Map<string, {
        part_id: number; part_no: string; display_name: string | null;
        soh: number; st: number; sold_mtd: number; on_order: number;
        resellers: Map<string, {
          reseller_id: number; reseller_code: string; reseller_name: string;
          soh: number; st: number; sold_mtd: number; on_order: number; avg_cost: number | null;
        }>;
      }>;
    }>();

    for (const r of curRows) {
      const cat = r.category ?? "Unknown";
      if (!categoryMap.has(cat)) categoryMap.set(cat, { soh: 0, st: 0, sold_mtd: 0, on_order: 0, models: new Map() });
      const catEntry = categoryMap.get(cat)!;
      const modelKey = String(r.part_id);
      if (!catEntry.models.has(modelKey)) {
        catEntry.models.set(modelKey, {
          part_id: r.part_id ?? 0, part_no: r.part_no ?? "",
          display_name: r.display_name, soh: 0, st: 0, sold_mtd: 0, on_order: 0,
          resellers: new Map(),
        });
      }
      const modelEntry = catEntry.models.get(modelKey)!;
      const effSt = Math.round(getEffectiveSt(r.part_id!, r.reseller_id!, r.st ?? 0));
      const effMtd = getEffectiveSoldMtd(r.part_id!, r.reseller_id!, r.sold_mtd ?? 0);
      const prev = prevMap.get(`${r.part_id}:${r.reseller_id}`) ?? { soh: 0, st: 0 };
      modelEntry.resellers.set(String(r.reseller_id), {
        reseller_id: r.reseller_id ?? 0, reseller_code: r.reseller_code ?? "",
        reseller_name: r.reseller_name ?? "", soh: r.soh ?? 0, st: effSt,
        sold_mtd: effMtd, on_order: r.on_order ?? 0,
        avg_cost: r.avg_cost != null ? Number(r.avg_cost) : null,
      });
      modelEntry.soh += r.soh ?? 0;
      modelEntry.st += effSt;
      modelEntry.sold_mtd += effMtd;
      modelEntry.on_order += r.on_order ?? 0;
      catEntry.soh += r.soh ?? 0;
      catEntry.st += effSt;
      catEntry.sold_mtd += effMtd;
      catEntry.on_order += r.on_order ?? 0;
    }

    for (const [cat, catEntry] of categoryMap) {
      const catId = `cat:${cat}`;
      result.push({
        id: catId, parent_id: null, level: "category", label: cat,
        soh: catEntry.soh, st: catEntry.st, sold_mtd: catEntry.sold_mtd, on_order: catEntry.on_order,
        soh_delta: null, st_delta: null, woi: woi(catEntry.soh, catEntry.st),
      });
      for (const [_, m] of catEntry.models) {
        const prevModelSoh = [...m.resellers.values()].reduce((s, re) => s + (prevMap.get(`${m.part_id}:${re.reseller_id}`)?.soh ?? 0), 0);
        const prevModelSt = [...m.resellers.values()].reduce((s, re) => s + (prevMap.get(`${m.part_id}:${re.reseller_id}`)?.st ?? 0), 0);
        const mId = `${catId}:model:${m.part_id}`;
        result.push({
          id: mId, parent_id: catId, level: "model",
          label: m.display_name ?? m.part_no,
          part_id: m.part_id, part_no: m.part_no,
          soh: m.soh, st: m.st, sold_mtd: m.sold_mtd, on_order: m.on_order,
          soh_delta: m.soh - prevModelSoh, st_delta: m.st - prevModelSt,
          woi: woi(m.soh, m.st),
        });
        for (const [_, re] of m.resellers) {
          const prev = prevMap.get(`${m.part_id}:${re.reseller_id}`) ?? { soh: 0, st: 0 };
          result.push({
            id: `${mId}:re:${re.reseller_id}`, parent_id: mId, level: "reseller",
            label: re.reseller_name || re.reseller_code,
            part_id: m.part_id, part_no: m.part_no,
            reseller_id: re.reseller_id, reseller_code: re.reseller_code,
            soh: re.soh, st: re.st, sold_mtd: re.sold_mtd, on_order: re.on_order, avg_cost: re.avg_cost,
            soh_delta: re.soh - prev.soh, st_delta: re.st - prev.st,
            woi: woi(re.soh, re.st),
          });
        }
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get explorer data");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/explorer/trend", async (req, res) => {
  try {
    const q = GetExplorerTrendQueryParams.safeParse(req.query);
    const partId = q.success && q.data.part_id ? q.data.part_id : undefined;
    const resellerId = q.success && q.data.reseller_id ? q.data.reseller_id : undefined;
    const weeks = q.success && q.data.weeks ? q.data.weeks : 12;

    const weekRows = await db
      .selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .orderBy(desc(inventorySnapshots.weekIso))
      .limit(weeks);

    const weekList = weekRows.map(w => w.week).filter(Boolean) as string[];
    if (weekList.length === 0) return res.json([]);

    const conditions: any[] = [inArray(inventorySnapshots.weekIso, weekList)];
    if (partId) conditions.push(eq(inventorySnapshots.partId, partId));
    if (resellerId) conditions.push(eq(inventorySnapshots.resellerId, resellerId));

    const rows = await db
      .select({
        week_iso: inventorySnapshots.weekIso,
        soh: sql<number>`coalesce(sum(${inventorySnapshots.soh}), 0)::int`,
        st: sql<number>`coalesce(sum(${inventorySnapshots.sellThrough7d}), 0)::int`,
        sold_mtd: sql<number>`coalesce(sum(${inventorySnapshots.soldMtd}), 0)::int`,
        on_order: sql<number>`coalesce(sum(${inventorySnapshots.onOrder}), 0)::int`,
      })
      .from(inventorySnapshots)
      .where(and(...conditions))
      .groupBy(inventorySnapshots.weekIso)
      .orderBy(inventorySnapshots.weekIso);

    res.json(rows.map(r => {
      const soh = Number(r.soh), st = Number(r.st);
      return { week_iso: r.week_iso, soh, st, woi: st > 0 ? soh / st : null, sold_mtd: Number(r.sold_mtd), on_order: Number(r.on_order) };
    }));
  } catch (err) {
    req.log.error({ err }, "Failed to get explorer trend");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
