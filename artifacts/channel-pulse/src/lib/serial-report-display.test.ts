import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serialReportDisplay, selectReconciliationWeek } from "./serial-report-display";

describe("serial report display", () => {
  it("shows only the selected week, retaining both accounts and missing-report rows", () => {
    const rows = [{ week_iso: "2051-W10", account: 1 }, { week_iso: "2051-W09", account: 1 }, { week_iso: "2051-W10", account: 2 }];
    assert.deepEqual(selectReconciliationWeek(rows, "2051-W10"), [rows[0], rows[2]]);
  });
  it("shows received counts even when the account is not configured to send reports", () => {
    for (const count of [0, 2, 3]) assert.deepEqual(serialReportDisplay({
      serials_reported: count, serial_report_received: true, serials_expected: false,
    }), { kind: "count", count });
  });
  it("shows expected report counts without treating zero as missing", () => {
    assert.deepEqual(serialReportDisplay({ serials_reported: 0, serial_report_received: true, serials_expected: true }),
      { kind: "count", count: 0 });
  });
  it("distinguishes missing expected reports from reports that are not expected", () => {
    assert.deepEqual(serialReportDisplay({ serials_reported: null, serial_report_received: false, serials_expected: true }),
      { kind: "missing" });
    assert.deepEqual(serialReportDisplay({ serials_reported: null, serial_report_received: false, serials_expected: false }),
      { kind: "not-expected" });
  });
  it("does not label a received but uncounted report as not expected", () => {
    assert.deepEqual(serialReportDisplay({ serials_reported: null, serial_report_received: true, serials_expected: false }),
      { kind: "missing" });
  });
});
