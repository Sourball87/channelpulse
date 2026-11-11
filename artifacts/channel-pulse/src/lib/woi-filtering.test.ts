import { test } from "node:test";
import assert from "node:assert/strict";
import { filterWoiRows } from "./woi-filtering.ts";

test("hide-zero-SOH removes zero-stock SKUs without treating missing SOH as zero", () => {
  const rows = [
    { part_no: "OUT", channel_total: { soh: 0 } },
    { part_no: "UNKNOWN", channel_total: { soh: null } },
    { part_no: "IN", channel_total: { soh: 12 } },
  ];

  assert.deepEqual(filterWoiRows(rows, true).map((row) => row.part_no), ["UNKNOWN", "IN"]);
  const unchanged = filterWoiRows(rows, false);
  assert.deepEqual(unchanged, rows);
  assert.notEqual(unchanged, rows);
});
