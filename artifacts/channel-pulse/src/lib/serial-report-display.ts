/** Expectations configure missing-report warnings; they must never hide a
 * count supplied by a report that was actually received. */
export function serialReportDisplay(row: {
  serials_reported: number | null;
  serial_report_received: boolean;
  serials_expected: boolean;
}): { kind: "count"; count: number } | { kind: "not-expected" | "missing" } {
  if (row.serials_reported != null) return { kind: "count", count: row.serials_reported };
  if (!row.serials_expected && !row.serial_report_received) return { kind: "not-expected" };
  return { kind: "missing" };
}

export function selectReconciliationWeek<T extends { week_iso: string }>(rows: T[], week: string | null | undefined): T[] {
  return rows.filter(row => row.week_iso === week);
}
