import type { ScanbackImport, SerialReconciliation, SerialReconciliationRow } from "@workspace/api-zod";
import { dateStringToWeekIso, isValidWeekIso } from "./parser";
import { evidenceKey, ownerFor, serialKey, validDate, type EvidenceRow } from "./scanback-engine";
import { firstReportedSales, reportedSales } from "./serial-tracking";
import { weeklySalesWeeks, type WeeklySalesCell } from "./weekly-sales";

export interface SalesAccount { id: number; code: string; sendsSerialReports: boolean }
export interface SalesPart { id: number; code: string; category: string }
export interface SalesSnapshot { resellerId: number; sku: string; week: string; soh: number; sold: number; soldColumn: boolean | null }
export interface SalesUpload { resellerId: number; week: string; soldColumn: boolean | null }
export interface ReportMeta { sourceId: string; accountId: number | null; weekIso: string | null }
export interface SalesInputs {
  accounts: SalesAccount[]; parts: SalesPart[]; snapshots: SalesSnapshot[];
  uploads: SalesUpload[]; imports: ScanbackImport[]; reports: ReportMeta[];
}
export interface SalesScope { partIds?: number[]; resellerIds?: number[]; category?: string }
const key = (account: number, sku: string, week = "") => JSON.stringify([account, sku, week]);
const skuKey = (sku: string) => sku.trim().toUpperCase();

/** Stored zero is not proof of a sold column: old imports default missing sales
 * to zero. Only authoritative mapping metadata establishes an absent column. */
export function mappedSoldColumn(mappings: unknown, sold?: number): boolean | null {
  if (Array.isArray(mappings) && mappings.some(m => m?.canonical_field === "part_no") &&
      mappings.some(m => m?.canonical_field === "soh"))
    return mappings.some(m => m?.canonical_field === "sell_through_7d");
  return sold != null && sold > 0 ? true : null;
}
export function weekBounds(week: string): { start: string; end: string } {
  const year = Number(week.slice(0, 4)), n = Number(week.slice(6));
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (n - 1) * 7 * 86_400_000;
  return { start: new Date(monday).toISOString().slice(0, 10), end: new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10) };
}
export function reconcileSales(input: {
  sold: number | null; soldColumn: boolean | null; serials: number | null;
  expected: boolean; reportReceived: boolean;
}) {
  const { sold, soldColumn, serials, expected, reportReceived } = input;
  const alerts: SerialReconciliationRow["alerts"] = [];
  const comparable = soldColumn === true && sold != null && sold >= 0;
  const pct = comparable && sold > 0 && serials != null ? Math.round(serials / sold * 10_000) / 100 : null;
  if (comparable && serials != null && serials > sold)
    alerts.push({ severity: "high", message: "More serials than sold — check before paying claims" });
  else if (comparable && sold > 0 && (expected || reportReceived) && (serials == null || serials < sold))
    alerts.push({ severity: "low", message: "Sold not serial-reported" });
  const fallback = soldColumn === false;
  const sellThrough = fallback ? serials : sold;
  return { pct, alerts, sellThrough, source: sellThrough == null ? "missing" as const : fallback ? "serials" as const : "soh" as const };
}

export function salesReconciliation(endWeek: string | null, data: SalesInputs, scope: SalesScope = {}): SerialReconciliation {
  if (!endWeek) return { week_iso: null, weeks: [], rows: [], pronto_through: null, pronto_note: "No committed Pronto serial data.", unmatched_serials: 0 };
  const weeks = weeklySalesWeeks(endWeek), window = new Set(weeks);
  const accounts = new Map(data.accounts.map(a => [a.id, a]));
  const parts = new Map(data.parts.map(p => [skuKey(p.code), p]));
  const include = (account: number, sku: string) => {
    const p = parts.get(sku);
    return accounts.has(account) && (!scope.resellerIds?.length || scope.resellerIds.includes(account)) &&
      (!scope.partIds?.length || (p != null && scope.partIds.includes(p.id))) &&
      (!scope.category || scope.category === "All" || p?.category === scope.category);
  };
  const pairs = new Map<string, { account: number; sku: string }>();
  const addPair = (account: number, sku: string, week: string) => {
    if (sku && window.has(week) && include(account, sku)) pairs.set(key(account, sku), { account, sku });
  };
  const snapshots = new Map<string, SalesSnapshot>();
  for (const s of data.snapshots) {
    const sku = skuKey(s.sku);
    if (!window.has(s.week)) continue;
    snapshots.set(key(s.resellerId, sku, s.week), s);
    addPair(s.resellerId, sku, s.week);
  }
  const seenEvidence = new Set<string>(), ddCoverage: { start: string; end: string }[] = [];
  const invoiceBySerial = new Map<string, EvidenceRow[]>();
  const sellIn = new Map<string, number>();
  const ddDates: string[] = [];
  for (const imp of data.imports.filter(i => i.kind === "evidence" && i.state === "committed")) {
    const dates = imp.rows.map(r => r.date).filter(validDate).sort();
    if (dates.length) ddCoverage.push({ start: dates[0], end: dates.at(-1)! });
    for (const row of imp.rows) {
      const eventKey = evidenceKey(row);
      if (seenEvidence.has(eventKey)) continue;
      seenEvidence.add(eventKey);
      if (!validDate(row.date)) continue;
      ddDates.push(row.date);
      const event = { ...row, source: imp.id };
      invoiceBySerial.set(serialKey(row.serial), [...(invoiceBySerial.get(serialKey(row.serial)) ?? []), event]);
      if (row.accountId == null) continue;
      const week = dateStringToWeekIso(row.date), sku = skuKey(row.sku);
      addPair(row.accountId, sku, week);
      const k = key(row.accountId, sku, week);
      sellIn.set(k, (sellIn.get(k) ?? 0) + row.quantity);
    }
  }
  const ddEnd = ddDates.sort().at(-1) ?? null;
  const metadata = new Map(data.reports.map(r => [r.sourceId, r]));
  const first = firstReportedSales(reportedSales(data.imports));
  const reportReceived = new Set<string>(), serialCounts = new Map<string, number>();
  let unmatched = 0;
  for (const imp of data.imports.filter(i => i.kind === "claim" && i.state === "committed")) {
    const meta = metadata.get(imp.id);
    const fixedWeek = meta?.weekIso && isValidWeekIso(meta.weekIso) ? meta.weekIso : null;
    const fixedAccount = imp.accountId ?? meta?.accountId ?? null;
    if (fixedWeek && fixedAccount != null) reportReceived.add(key(fixedAccount, "", fixedWeek));
    for (const row of imp.rows) {
      const week = fixedWeek ?? (validDate(row.date) ? dateStringToWeekIso(row.date) : null);
      if (!week || !window.has(week)) continue;
      const cutoff = validDate(row.date) ? row.date : weekBounds(week).end;
      const events = (invoiceBySerial.get(serialKey(row.serial)) ?? []).filter(e => e.date <= cutoff);
      const owner = ownerFor(events).owner;
      const account = row.accountId ?? fixedAccount;
      if (account != null) reportReceived.add(key(account, "", week));
      const original = first.get(serialKey(row.serial));
      if (original?.reportId !== imp.id || original?.rowIndex !== row.rowIndex) continue;
      const sku = skuKey(row.sku || (owner?.accountId === account ? owner.sku : ""));
      if (account == null || !sku) {
        if (!scope.resellerIds?.length || (account != null && scope.resellerIds.includes(account))) unmatched++;
        continue;
      }
      addPair(account, sku, week);
      const k = key(account, sku, week);
      serialCounts.set(k, (serialCounts.get(k) ?? 0) + 1);
    }
  }
  const rows: SerialReconciliationRow[] = [];
  for (const pair of pairs.values()) for (const week of weeks) {
    const { account, sku } = pair, a = accounts.get(account)!, k = key(account, sku, week);
    const snapshot = snapshots.get(k);
    const profile = data.uploads.filter(u => u.resellerId === account && u.week <= week)
      .sort((a, b) => b.week.localeCompare(a.week))[0];
    const soldColumn = snapshot ? snapshot.soldColumn : profile?.soldColumn ?? null;
    const sohSold = snapshot ? soldColumn === false ? null : snapshot.sold : null;
    const received = reportReceived.has(key(account, "", week));
    const serials = received ? serialCounts.get(k) ?? 0 : null;
    const result = reconcileSales({ sold: sohSold, soldColumn, serials, expected: a.sendsSerialReports, reportReceived: received });
    const bounds = weekBounds(week);
    const ddAvailable = ddCoverage.some(c => c.start <= bounds.end && c.end >= bounds.start);
    rows.push({
      reseller_id: account, code: a.code, part_id: parts.get(sku)?.id ?? null, part_no: sku, week_iso: week,
      soh: snapshot?.soh ?? null, soh_reported: !!snapshot || data.uploads.some(u => u.resellerId === account && u.week === week),
      soh_sold: sohSold, sold_column_present: soldColumn,
      serials_reported: serials, serial_report_received: received, serials_expected: a.sendsSerialReports,
      serial_match_pct: result.pct, sell_through: result.sellThrough, sell_through_source: result.source,
      dd_sell_in_week: ddAvailable ? sellIn.get(k) ?? 0 : null, alerts: result.alerts,
    });
  }
  const selected = weekBounds(endWeek);
  const note = !ddEnd ? "No committed Pronto serial data." : ddEnd < selected.start ?
    `Pronto data ends ${ddEnd}, before the selected week (${selected.start} to ${selected.end}). DD sell-in is unavailable for later weeks.` :
    ddEnd < selected.end ? `Pronto data ends ${ddEnd}; the selected week ends ${selected.end}. DD sell-in is partial for this week.` : null;
  return { week_iso: endWeek, weeks, rows: rows.sort((a, b) => b.week_iso.localeCompare(a.week_iso) || a.code.localeCompare(b.code) || a.part_no.localeCompare(b.part_no)),
    pronto_through: ddEnd, pronto_note: note, unmatched_serials: unmatched };
}

/** Same reconciled figures feed the existing heatmap, never a parallel set of
 * sales totals. Missing observations stay absent; true zero remains a cell. */
export function reconciledWeeklyCells(rows: SerialReconciliationRow[]): WeeklySalesCell[] {
  const cells = new Map<string, WeeklySalesCell>();
  for (const r of rows) {
    if (r.sell_through == null) continue;
    const k = JSON.stringify([r.part_no, r.week_iso]);
    const c = cells.get(k) ?? { part_id: r.part_id, part_no: r.part_no, week_iso: r.week_iso, units_sold: 0, reported_accounts: 0, serials_backed: false, serials_reported: 0 };
    c.units_sold += r.sell_through; c.reported_accounts++;
    c.serials_backed ||= r.sell_through_source === "serials";
    c.serials_reported = (c.serials_reported ?? 0) + (r.serials_reported ?? 0);
    cells.set(k, c);
  }
  return [...cells.values()];
}
