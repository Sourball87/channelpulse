import { Router } from "express";
import { db, inventorySnapshots, parts } from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { GetDashboardWeeklySalesQueryParams } from "@workspace/api-zod";
import { buildConditions, parseFilterParams } from "../lib/filter-params";
import { isValidWeekIso } from "../lib/parser";
import { weeklySalesData, weeklySalesWeeks } from "../lib/weekly-sales";

const router = Router();

router.get("/dashboard/weekly-sales", async (req, res) => {
  const query = GetDashboardWeeklySalesQueryParams.safeParse(req.query);
  if (!query.success || (query.data.week_iso && !isValidWeekIso(query.data.week_iso))) {
    return res.status(400).json({ error: "Select a valid reporting week and account/stock filters." });
  }
  try {
    let endWeek = query.data.week_iso;
    if (!endWeek) {
      const [latest] = await db.select({ week: inventorySnapshots.weekIso })
        .from(inventorySnapshots).orderBy(desc(inventorySnapshots.weekIso)).limit(1);
      endWeek = latest?.week;
    }
    if (!endWeek) return res.json(weeklySalesData(null, []));

    const weeks = weeklySalesWeeks(endWeek);
    const filters = parseFilterParams(query.data);
    const category = query.data.category;
    const rows = await db.select({
      part_id: inventorySnapshots.partId,
      part_no: parts.partNo,
      week_iso: inventorySnapshots.weekIso,
      units_sold: sql<number>`sum(${inventorySnapshots.sellThrough7d})::int`,
      reported_accounts: sql<number>`count(distinct ${inventorySnapshots.resellerId})::int`,
    }).from(inventorySnapshots)
      .innerJoin(parts, eq(parts.id, inventorySnapshots.partId))
      .where(buildConditions([
        inArray(inventorySnapshots.weekIso, weeks),
        category && category !== "All" ? eq(parts.category, category) : undefined,
      ], filters))
      .groupBy(inventorySnapshots.partId, parts.partNo, inventorySnapshots.weekIso)
      .orderBy(parts.partNo, inventorySnapshots.weekIso);
    return res.json(weeklySalesData(endWeek, rows.map(row => ({
      ...row,
      units_sold: Number(row.units_sold),
      reported_accounts: Number(row.reported_accounts),
    }))));
  } catch (err) {
    req.log.error({ err }, "Failed to get weekly sales");
    return res.status(500).json({ error: "Unable to load weekly sell-through." });
  }
});

export default router;
