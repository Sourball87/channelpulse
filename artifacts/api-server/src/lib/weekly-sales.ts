import { previousWeekIso } from "./dates";
import { isValidWeekIso } from "./dates";

/** Calendar weeks, including weeks without any reports; never skip gaps. */
export function weeklySalesWeeks(endWeek: string, count = 12): string[] {
  const weeks = [endWeek];
  while (weeks.length < count) weeks.unshift(previousWeekIso(weeks[0]));
  return weeks;
}

/** Build every calendar week in a selected inclusive ISO-week range. */
export function calendarWeeksBetween(startWeek: string, endWeek: string): string[] {
  if (!isValidWeekIso(startWeek) || !isValidWeekIso(endWeek) || startWeek > endWeek) return [];
  const weeks = [endWeek];
  while (weeks[0] > startWeek && weeks.length < 261) {
    weeks.unshift(previousWeekIso(weeks[0]));
  }
  return weeks[0] === startWeek ? weeks : [];
}

export interface WeeklySalesCell {
  part_id: number | null;
  part_no: string;
  week_iso: string;
  units_sold: number;
  reported_accounts: number;
  serials_backed?: boolean;
  serials_reported?: number;
}

export function weeklySalesData(endWeek: string | null, cells: WeeklySalesCell[]) {
  const weeks = endWeek ? weeklySalesWeeks(endWeek) : [];
  const window = new Set(weeks);
  const reportedCells = cells.filter(cell => window.has(cell.week_iso));
  return {
    end_week: endWeek,
    weeks,
    parts: [...new Set(reportedCells.map(cell => cell.part_no))].sort(),
    // Do not fabricate zero cells for unreported weeks/SKUs.
    cells: reportedCells,
  };
}
