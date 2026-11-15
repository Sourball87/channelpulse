import { test } from "node:test";
import assert from "node:assert/strict";
import { displayDate, displayDateTime } from "./date-display.ts";

test("uses the chosen date format without local timezone shifts", () => {
  assert.equal(displayDate("2026-11-08"), "08 Nov 2026");
  assert.equal(displayDate("2026-09-01"), "01 Sep 2026");
  assert.equal(displayDate("2024-02-29"), "29 Feb 2024");
  assert.equal(displayDate("2026-02-29"), "2026-02-29");
  assert.equal(displayDate(null), "");
});

test("shows Sydney dates and times consistently across daylight saving", () => {
  assert.equal(displayDate("2026-11-07T14:00:00Z"), "08 Nov 2026");
  assert.equal(displayDateTime("2026-11-07T14:00:00Z"), "08 Nov 2026, 01:00 am Sydney");
  assert.equal(displayDateTime("2026-07-01T00:00:00Z"), "01 Jul 2026, 10:00 am Sydney");
});
