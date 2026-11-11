import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekOf, lastCompletedSunday, serialShortfallChaseLine, shiftSunday } from "./upload-center.ts";

test("weekly intake defaults to the last fully completed Monday–Sunday week", () => {
  assert.equal(lastCompletedSunday(new Date(2026, 10, 6)).toISOString().slice(0, 10), "2026-11-01");
  assert.equal(lastCompletedSunday(new Date(2026, 10, 1)).toISOString().slice(0, 10), "2026-10-25");
  assert.equal(lastCompletedSunday(new Date(2026, 10, 2)).toISOString().slice(0, 10), "2026-11-01");
});
test("week navigation stays consecutive across ISO-year boundaries", () => {
  const end = new Date("2021-01-03T00:00:00Z");
  assert.equal(isoWeekOf(end), "2020-W53");
  assert.equal(isoWeekOf(shiftSunday(end, -1)), "2020-W52");
  assert.equal(isoWeekOf(shiftSunday(end, 1)), "2021-W01");
});
test("serial-report chase lines call out sold units missing serials", () => {
  assert.equal(serialShortfallChaseLine("KS", 6, "KS-report.xlsx"), "KS - 6 sold without serial (KS-report.xlsx)");
});
