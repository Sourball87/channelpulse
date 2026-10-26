import { describe, expect, it } from "vitest";
import { weeklySalesData, weeklySalesWeeks } from "./weekly-sales";
import { dateStringToWeekIso, isValidWeekIso } from "./parser";

describe("12-week sales window", () => {
  it("includes every calendar week oldest-first", () => {
    const weeks = weeklySalesWeeks("2026-W27");
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toBe("2026-W16");
    expect(weeks[11]).toBe("2026-W27");
  });
  it("crosses a 53-week ISO year correctly", () => {
    const weeks = weeklySalesWeeks("2021-W02");
    expect(weeks).toHaveLength(12);
    expect(weeks.slice(-3)).toEqual(["2020-W53", "2021-W01", "2021-W02"]);
  });
  it("uses calendar ISO weeks when January 1 falls on a Friday", () => {
    expect(dateStringToWeekIso("2021-01-04")).toBe("2021-W01");
    expect(dateStringToWeekIso("2027-01-04")).toBe("2027-W01");
    expect(dateStringToWeekIso("2021-01-01")).toBe("2020-W53");
    expect(isValidWeekIso("2021-W01")).toBe(true);
    expect(isValidWeekIso("2020-W53")).toBe(true);
    expect(isValidWeekIso("2021-W53")).toBe(false);
    expect(new Set(weeklySalesWeeks("2027-W01")).size).toBe(12);
  });
  it("crosses a 52-week ISO year correctly", () => {
    expect(weeklySalesWeeks("2026-W02").slice(-3)).toEqual(["2025-W52", "2026-W01", "2026-W02"]);
  });
  it("keeps reported zeros, missing weeks and historical-only SKUs distinct", () => {
    const data = weeklySalesData("2026-W27", [
      { part_id: 1, part_no: "SKU-OLD", week_iso: "2026-W17", units_sold: 0, reported_accounts: 1 },
      { part_id: 2, part_no: "SKU-NEW", week_iso: "2026-W27", units_sold: 15, reported_accounts: 2 },
      { part_id: 3, part_no: "OUTSIDE", week_iso: "2026-W15", units_sold: 100, reported_accounts: 1 },
    ]);
    expect(data.parts).toEqual(["SKU-NEW", "SKU-OLD"]);
    expect(data.cells).toHaveLength(2);
    expect(data.cells[0].units_sold).toBe(0);
    expect(data.cells.some(cell => cell.week_iso === "2026-W18")).toBe(false);
    expect(data.weeks).toContain("2026-W18");
  });
  it("retains the window when the selection has no reports", () => {
    expect(weeklySalesData("2026-W27", []).weeks).toHaveLength(12);
    expect(weeklySalesData(null, [])).toEqual({ end_week: null, weeks: [], parts: [], cells: [] });
  });
});
