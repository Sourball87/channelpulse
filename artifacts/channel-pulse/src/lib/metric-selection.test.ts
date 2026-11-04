import { test } from "node:test";
import assert from "node:assert/strict";
import { addMetric, moveMetric, parseStoredMetrics, removeMetric, sanitizeMetrics } from "./metric-selection.ts";

test("adds metrics idempotently and at a position", () => {
  assert.deepEqual(addMetric([], "soh"), ["soh"]);
  assert.deepEqual(addMetric(["soh"], "soh"), ["soh"]);
  assert.deepEqual(addMetric(["soh"], "st", 0), ["st", "soh"]);
  assert.deepEqual(addMetric(["soh"], "st", 9), ["soh", "st"]);
});
test("removes and reorders", () => {
  assert.deepEqual(removeMetric(["st", "soh"], "st"), ["soh"]);
  assert.deepEqual(removeMetric([], "st"), []);
  assert.deepEqual(moveMetric(["st", "soh"], "st", 1), ["soh", "st"]);
  assert.deepEqual(moveMetric(["st", "soh"], "soh", 0), ["soh", "st"]);
  assert.deepEqual(moveMetric(["st"], "soh", 0), ["st"]);
});
test("sanitizes stored values", () => {
  assert.deepEqual(sanitizeMetrics(["soh", "x", "soh", "st", 3]), ["soh", "st"]);
  assert.equal(sanitizeMetrics("st"), null);
  assert.deepEqual(parseStoredMetrics(null), ["st", "soh"]);
  assert.deepEqual(parseStoredMetrics("{bad"), ["st", "soh"]);
  assert.deepEqual(parseStoredMetrics('{"a":1}'), ["st", "soh"]);
  assert.deepEqual(parseStoredMetrics("[]"), []);
  assert.deepEqual(parseStoredMetrics('["woi",123]'), ["st", "soh"]);
  assert.deepEqual(parseStoredMetrics('["soh","woi"]'), ["soh"]);
});
