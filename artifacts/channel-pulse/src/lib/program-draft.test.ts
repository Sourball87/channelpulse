import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInput, cappedQty, discPct, draftFromPreview, emptyDraft, fingerprint,
  programStatus, staFromDraft, withPriceRefs, type ProgramTablePreview,
} from "./program-draft.ts";

test("reference calculations stay null-safe and use integer cents", () => {
  assert.equal(discPct(11000, 9900), "10.0%");
  assert.equal(discPct(null, 9900), "");
  assert.equal(discPct(0, 9900), "");
  const line = { ...emptyDraft().lines[0], t1: "85.25", gtmBuy: "70.20" };
  assert.equal(staFromDraft(line), 1505);
  assert.equal(staFromDraft({ ...line, t1: "" }), null);
  assert.equal(cappedQty({ 1: "5", 2: "0", 3: "", 4: "2" }, [1, 2, 3, 4]), 7);
});
test("source-only draft retains blank references, unlimited caps and explicit zero", () => {
  const preview: ProgramTablePreview = {
    headers: [], mapping: { fields: {}, customers: {}, ignored: [] }, issues: [], aiNote: null,
    sourceName: "program.csv", customerIds: [1, 2],
    rows: [{ sourceRow: 2, sku: "CUSTOM", rrpIncCents: null, gtmIncCents: 9900, ddCostExCents: null,
      t1ExCents: null, gtmBuyCents: 7000, caps: [{ resellerId: 1, quantity: null }, { resellerId: 2, quantity: 0 }] }],
  };
  const d = draftFromPreview(preview);
  assert.equal(d.id, undefined);
  assert.equal(d.lines[0].rrp, "");
  assert.equal(d.lines[0].gtmInc, "99.00");
  assert.equal(d.lines[0].caps[1], "");
  assert.equal(d.lines[0].caps[2], "0");
  const input = buildInput({ ...d, start: "2026-11-01", end: "2026-11-30" }, []);
  assert.ok(typeof input !== "string");
  assert.equal(input.lines[0].rrpIncCents, null);
  assert.equal(input.lines[0].partId, null);
  assert.equal(input.lines[0].caps[0].quantity, null);
  assert.equal(input.lines[0].caps[1].quantity, 0);
});
test("unknown SKU never retains previous price-list references", () => {
  const line = { ...emptyDraft().lines[0], sku: "UNKNOWN", rrp: "110.00", dd: "60.00", t1: "85.00", gtmBuy: "70.00" };
  assert.deepEqual(
    (({ rrp, dd, t1, gtmBuy }) => ({ rrp, dd, t1, gtmBuy }))(withPriceRefs(line, [])),
    { rrp: "", dd: "", t1: "", gtmBuy: "70.00" },
  );
});
test("status follows inclusive calendar dates", () => {
  assert.equal(programStatus("2026-11-10", "2026-11-30", new Date(2026, 10, 6)).kind, "upcoming");
  assert.deepEqual(programStatus("2026-11-01", "2026-11-06", new Date(2026, 10, 6)), { kind: "live", label: "Live · 1d left" });
  assert.equal(programStatus("2026-11-01", "2026-11-05", new Date(2026, 10, 6)).kind, "ended");
});
test("dirty fingerprint ignores random keys but retains customer and financial edits", () => {
  const d = emptyDraft();
  assert.equal(fingerprint(d), fingerprint({ ...d, lines: [{ ...d.lines[0], key: "another-key" }] }));
  assert.notEqual(fingerprint(d), fingerprint({ ...d, lines: [{ ...d.lines[0], gtmBuy: "70" }] }));
  assert.notEqual(fingerprint(d), fingerprint({ ...d, customerIds: [1] }));
});
