import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWeekLabel, formatWeekRange, formatWeekSpan, isoWeekDates } from "./week-display.ts";

test("shows the agreed reporting week and its Monday–Sunday dates", () => {
  assert.equal(formatWeekLabel("2026-W27"), "Week 27, 2026 · 29 Jun–5 Jul 2026");
  assert.equal(formatWeekRange("2026-W28"), "6–12 Jul 2026");
});
test("handles ISO year boundaries, leap years, and valid week 53", () => {
  assert.equal(formatWeekRange("2020-W53"), "28 Dec 2020–3 Jan 2021");
  assert.equal(formatWeekRange("2026-W01"), "29 Dec 2025–4 Jan 2026");
  assert.equal(formatWeekRange("2024-W09"), "26 Feb–3 Mar 2024");
  assert.equal(formatWeekRange("2026-W53"), "28 Dec 2026–3 Jan 2027");
});
test("does not invent dates for invalid or missing weeks", () => {
  for (const value of ["2025-W53", "2026-W00", "2026-W54", "n/a", ""]) {
    assert.equal(isoWeekDates(value), undefined);
    assert.equal(formatWeekRange(value), "");
  }
  assert.equal(formatWeekLabel(null), "Latest week");
});
test("formats multi-week periods without changing identifiers", () => {
  assert.equal(formatWeekSpan("2026-W26", "2026-W27"), "2026-W26 – 2026-W27 · 22 Jun–5 Jul 2026");
  assert.equal(isoWeekDates("2026-W27")?.start.toISOString(), "2026-06-29T00:00:00.000Z");
});
