import { Router, type IRouter } from "express";
import { db, inventorySnapshots, parts, resellers } from "@workspace/db";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { previousWeekIso } from "../lib/parser";
import { GetExplorerDataQueryParams, GetExplorerTrendQueryParams } from "@workspace/api-zod";

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

    let weekIso = q.success && q.data.week_iso ? q.data.week_iso : null;
    if (!weekIso) weekIso = await getLatestWeek();
    if (!weekIso) return res.json([]);

    const prevWeek = previousWeekIso(weekIso);

    const weekFilter =
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, weekIso), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, weekIso);

    const prevWeekFilter =
      category && category !== "All"
        ? and(eq(inventorySnapshots.weekIso, prevWeek), eq(parts.category, category))
        : eq(inventorySnapshots.weekIso, prevWeek);

    // Fetch current week data
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
      .where(weekFilter);

    // Fetch prev week data
    const prevRows = await db
      .select({
        part_id: inventorySnapshots.partId,
        reseller_id: inventorySnapshots.resellerId,
        soh: inventorySnapshots.soh,
        st: inventorySnapshots.sellThrough7d,
      })
      .from(inventorySnapshots)
      .leftJoin(parts, eq(inventorySnapshots.partId, parts.id))
      .where(prevWeekFilter);

    const prevMap = new Map<string, { soh: number; st: number }>();
    for (const r of prevRows) {
      prevMap.set(`${r.part_id}:${r.reseller_id}`, {
        soh: r.soh ?? 0,
        st: r.st ?? 0,
      });
    }

    const result: unknown[] = [];

    if (pivot === "reseller_model") {
      // Group: reseller → model
      const resellerMap = new Map<string, {
        reseller_id: number; reseller_code: string; reseller_name: string;
        soh: number; st: number; sold_mtd: number; on_order: number;
        models: Map<string, { part_id: number; part_no: string; display_name: string | null; category: string;
          soh: number; st: number; sold_mtd: number; on_order: number; avg_cost: number | null;
        }>;
      }>();

      for (const r of curRows) {
        const rKey = String(r.reseller_id);
        if (!resellerMap.has(rKey)) {
          resellerMap.set(rKey, {
            reseller_id: r.reseller_id ?? 0,
            reseller_code: r.reseller_code ?? "",
            reseller_name: r.reseller_name ?? "",
            soh: 0, st: 0, sold_mtd: 0, on_order: 0,
            models: new Map(),
          });
        }
        const rEntry = resellerMap.get(rKey)!;
        rEntry.soh += r.soh ?? 0;
        rEntry.st += r.st ?? 0;
        rEntry.sold_mtd += r.sold_mtd ?? 0;
        rEntry.on_order += r.on_order ?? 0;

        const mKey = String(r.part_id);
        if (!rEntry.models.has(mKey)) {
          rEntry.models.set(mKey, {
            part_id: r.part_id ?? 0, part_no: r.part_no ?? "", display_name: r.display_name ?? null,
            category: r.category ?? "", soh: 0, st: 0, sold_mtd: 0, on_order: 0, avg_cost: null,
          });
        }
        const mEntry = rEntry.models.get(mKey)!;
        mEntry.soh += r.soh ?? 0;
        mEntry.st += r.st ?? 0;
        mEntry.sold_mtd += r.sold_mtd ?? 0;
        mEntry.on_order += r.on_order ?? 0;
        mEntry.avg_cost = r.avg_cost ? Number(r.avg_cost) : mEntry.avg_cost;
      }

      for (const [, re] of resellerMap) {
        const rId = `r:${re.reseller_id}`;
        const prevRe = Array.from(prevMap.entries())
          .filter(([k]) => k.endsWith(`:${re.reseller_id}`))
          .reduce((acc, [, v]) => ({ soh: acc.soh + v.soh, st: acc.st + v.st }), { soh: 0, st: 0 });

        result.push({
          id: rId, parent_id: null, label: re.reseller_name || re.reseller_code,
          level: "reseller", category: null, part_no: null, part_id: null,
          reseller_id: re.reseller_id, reseller_code: re.reseller_code,
          st: re.st, st_delta: re.st - prevRe.st,
          soh: re.soh, soh_delta: re.soh - prevRe.soh,
          woi: woi(re.soh, re.st), sold_mtd: re.sold_mtd, on_order: re.on_order, avg_cost: null,
        });

        for (const [, mo] of re.models) {
          const prevMo = prevMap.get(`${mo.part_id}:${re.reseller_id}`) ?? { soh: 0, st: 0 };
          result.push({
            id: `r:${re.reseller_id}:m:${mo.part_id}`, parent_id: rId,
            label: mo.display_name || mo.part_no, level: "model",
            category: mo.category, part_no: mo.part_no, part_id: mo.part_id,
            reseller_id: re.reseller_id, reseller_code: re.reseller_code,
            st: mo.st, st_delta: mo.st - prevMo.st,
            soh: mo.soh, soh_delta: mo.soh - prevMo.soh,
            woi: woi(mo.soh, mo.st), sold_mtd: mo.sold_mtd, on_order: mo.on_order, avg_cost: mo.avg_cost,
          });
        }
      }
    } else {
      // Default: category → model → reseller
      const catMap = new Map<string, { soh: number; st: number; sold_mtd: number; on_order: number;
        models: Map<string, { part_id: number; part_no: string; display_name: string | null;
          soh: number; st: number; sold_mtd: number; on_order: number;
          resellers: typeof curRows;
        }>;
      }>();

      for (const r of curRows) {
        const cat = r.category ?? "Uncategorized";
        if (!catMap.has(cat)) {
          catMap.set(cat, { soh: 0, st: 0, sold_mtd: 0, on_order: 0, models: new Map() });
        }
        const catEntry = catMap.get(cat)!;
        catEntry.soh += r.soh ?? 0;
        catEntry.st += r.st ?? 0;
        catEntry.sold_mtd += r.sold_mtd ?? 0;
        catEntry.on_order += r.on_order ?? 0;

        const mKey = String(r.part_id);
        if (!catEntry.models.has(mKey)) {
          catEntry.models.set(mKey, {
            part_id: r.part_id ?? 0, part_no: r.part_no ?? "", display_name: r.display_name ?? null,
            soh: 0, st: 0, sold_mtd: 0, on_order: 0, resellers: [],
          });
        }
        const mEntry = catEntry.models.get(mKey)!;
        mEntry.soh += r.soh ?? 0;
        mEntry.st += r.st ?? 0;
        mEntry.sold_mtd += r.sold_mtd ?? 0;
        mEntry.on_order += r.on_order ?? 0;
        mEntry.resellers.push(r);
      }

      // Build a per-category prev-week aggregate from prevRows (category-scoped, not global)
      const prevCatMap = new Map<string, { soh: number; st: number }>();
      for (const pr of prevRows) {
        // prevRows includes parts join so we can access category via the parts table—but prevRows
        // only has part_id, reseller_id, soh, st. We derive category from catMap membership.
      }
      // Simpler: for each category, sum prevRows where part_id belongs to that category
      const catPartIds = new Map<string, Set<number>>();
      for (const [cat, catData] of catMap) {
        const ids = new Set<number>();
        for (const [, mo] of catData.models) ids.add(mo.part_id);
        catPartIds.set(cat, ids);
      }

      for (const [cat, catData] of catMap) {
        const catId = `cat:${cat}`;
        const partIds = catPartIds.get(cat) ?? new Set();
        const prevCat = prevRows
          .filter((r) => r.part_id !== null && partIds.has(r.part_id!))
          .reduce((acc, r) => ({ soh: acc.soh + (r.soh ?? 0), st: acc.st + (r.st ?? 0) }), { soh: 0, st: 0 });

        result.push({
          id: catId, parent_id: null, label: cat, level: "category",
          category: cat, part_no: null, part_id: null, reseller_id: null, reseller_code: null,
          st: catData.st, st_delta: catData.st - prevCat.st,
          soh: catData.soh, soh_delta: catData.soh - prevCat.soh,
          woi: woi(catData.soh, catData.st), sold_mtd: catData.sold_mtd, on_order: catData.on_order, avg_cost: null,
        });

        for (const [, mo] of catData.models) {
          const mId = `cat:${cat}:m:${mo.part_id}`;
          const prevMoAll = prevRows
            .filter((p) => p.part_id === mo.part_id)
            .reduce((acc, r) => ({ soh: acc.soh + (r.soh ?? 0), st: acc.st + (r.st ?? 0) }), { soh: 0, st: 0 });

          result.push({
            id: mId, parent_id: catId, label: mo.display_name || mo.part_no, level: "model",
            category: cat, part_no: mo.part_no, part_id: mo.part_id, reseller_id: null, reseller_code: null,
            st: mo.st, st_delta: mo.st - prevMoAll.st,
            soh: mo.soh, soh_delta: mo.soh - prevMoAll.soh,
            woi: woi(mo.soh, mo.st), sold_mtd: mo.sold_mtd, on_order: mo.on_order, avg_cost: null,
          });

          for (const r of mo.resellers) {
            const prevR = prevMap.get(`${mo.part_id}:${r.reseller_id}`) ?? { soh: 0, st: 0 };
            result.push({
              id: `${mId}:r:${r.reseller_id}`, parent_id: mId,
              label: r.reseller_name || r.reseller_code || "",
              level: "reseller", category: cat, part_no: mo.part_no, part_id: mo.part_id,
              reseller_id: r.reseller_id, reseller_code: r.reseller_code,
              st: r.st ?? 0, st_delta: (r.st ?? 0) - prevR.st,
              soh: r.soh ?? 0, soh_delta: (r.soh ?? 0) - prevR.soh,
              woi: woi(r.soh ?? 0, r.st ?? 0),
              sold_mtd: r.sold_mtd ?? 0, on_order: r.on_order ?? 0,
              avg_cost: r.avg_cost ? Number(r.avg_cost) : null,
            });
          }
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
    const partId = q.success && q.data.part_id ? q.data.part_id : null;
    const resellerId = q.success && q.data.reseller_id ? q.data.reseller_id : null;
    const weeks = q.success && q.data.weeks ? q.data.weeks : 12;

    // Get last N weeks
    const weekRows = await db
      .selectDistinct({ week: inventorySnapshots.weekIso })
      .from(inventorySnapshots)
      .orderBy(desc(inventorySnapshots.weekIso))
      .limit(weeks);

    const weekList = weekRows.map((w) => w.week).filter(Boolean) as string[];
    if (weekList.length === 0) return res.json([]);

    // Constrain to the selected week range + optional filters
    const conditions: ReturnType<typeof eq>[] = [inArray(inventorySnapshots.weekIso, weekList)];
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

    res.json(
      rows.map((r) => {
        const soh = Number(r.soh);
        const st = Number(r.st);
        const woiVal = st > 0 ? soh / st : null;
        return {
          week_iso: r.week_iso,
          soh,
          st,
          woi: woiVal,
          sold_mtd: Number(r.sold_mtd),
          on_order: Number(r.on_order),
        };
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get explorer trend");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
