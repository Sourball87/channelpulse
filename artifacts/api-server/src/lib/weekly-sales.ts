import { previousWeekIso } from "./parser";

/** Calendar weeks, including weeks without any reports; never skip gaps. */
export function weeklySalesWeeks(endWeek: string): string[] {
  const weeks = [endWeek];
  while (weeks.length < 12) weeks.unshift(previousWeekIso(weeks[0]));
  return weeks;
}

export interface WeeklySalesCell {
  part_id: number;
  part_no: string;
  week_iso: string;
  units_sold: number;
  reported_accounts: number;
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
