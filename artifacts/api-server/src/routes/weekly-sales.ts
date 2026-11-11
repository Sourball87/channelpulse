import { Router } from "express";
import { GetDashboardWeeklySalesQueryParams } from "@workspace/api-zod";
import { parseFilterParams } from "../lib/filter-params";
import { isValidWeekIso } from "../lib/dates";
import { calendarWeeksBetween, weeklySalesData } from "../lib/weekly-sales";
import { loadSalesReconciliation } from "../lib/load-sales-reconciliation";
import { reconciledWeeklyCells } from "../lib/sales-reconciliation";

const router = Router();

router.get(["/dashboard/weekly-sales", "/dashboard/serial-reconciliation"], async (req, res) => {
  const query = GetDashboardWeeklySalesQueryParams.safeParse(req.query);
  if (!query.success || (query.data.week_iso && !isValidWeekIso(query.data.week_iso))) {
    res.status(400).json({ error: "Select a valid reporting week and account/stock filters." });
    return;
  }
  try {
    const filters = parseFilterParams(query.data);
    const hasPeriodBoundary = !!filters.weekFrom || !!filters.weekTo;
    const periodWeeks = hasPeriodBoundary && filters.weekFrom && filters.weekTo &&
      isValidWeekIso(filters.weekFrom) && isValidWeekIso(filters.weekTo)
      ? calendarWeeksBetween(filters.weekFrom, filters.weekTo)
      : undefined;
    if (hasPeriodBoundary && !periodWeeks?.length) {
      res.status(400).json({ error: "Select a valid inclusive ISO week range." });
      return;
    }
    const requestedWeek = filters.weekTo ?? query.data.week_iso;
    const data = await loadSalesReconciliation(requestedWeek, {
      partIds: filters.partIds,
      resellerIds: filters.resellerIds,
      category: query.data.category,
      weeks: periodWeeks,
    });
    return res.json(req.path.endsWith("serial-reconciliation") ? data :
      weeklySalesData(data.week_iso, reconciledWeeklyCells(data.rows), periodWeeks));
  } catch (err) {
    req.log.error({ err }, "Failed to get weekly sales");
    return res.status(500).json({ error: "Unable to load weekly sell-through." });
  }
});

export default router;
