import * as XLSX from "xlsx";
import type {
  ScanbackClaimsByWeek,
  ScanbackClaimsByWeekCustomer,
  ScanbackClaimsByWeekLine,
  ScanbackClaimsByWeekTotals,
  ScanbackImport,
  ScanbackProgram,
  ScanbackResult,
} from "@workspace/api-zod";
import {
  loadVerificationContext,
  requireThat,
  ScanbackError,
  verifyWithContext,
  type Client,
  type ScanbackVerificationData,
  type StoredScanbackBatch,
} from "./scanback-store";
import { dateStringToWeekIso, previousCompletedWeekIso, weekDates, weekEndingShortLabel, isValidWeekIso } from "./dates";
import { resolveMissingClaimSkus, splitResolvedClaimRowsByPromotion } from "./scanback-auto-drafts";
import { serialKey } from "./scanback-engine";
import { maskCustomerText } from "./customer-display";

export interface ScanbackClaimsByWeekFilters {
  programId: string;
  week?: string;
  customerId?: number;
  status?: "all" | "approved" | "awaiting_approval" | "not_qualifying";
}

type CandidateLine = ScanbackClaimsByWeekLine & { _rowIndex: number };
type Status = ScanbackClaimsByWeekLine["status"];
const WEEKLY_CACHE_TTL_MS = 30_000;
type WeeklyCacheEntry = {
  programId: string;
  expiresAt: number;
  programCustomerIds: number[];
  coveredCustomerIds: Set<number>;
  report: ScanbackClaimsByWeek;
};
const weeklyReportCache = new Map<string, WeeklyCacheEntry>();

export function invalidateScanbackClaimsByWeekCache(programId?: string) {
  if (!programId) {
    weeklyReportCache.clear();
    return;
  }
  for (const [key, entry] of weeklyReportCache) {
    if (entry.programId === programId) weeklyReportCache.delete(key);
  }
}

const emptyTotals = (): ScanbackClaimsByWeekTotals => ({
  reportedCount: 0,
  qualifyingCount: 0,
  notQualifyingCount: 0,
  qualifyingCents: 0,
  approvedCents: 0,
  awaitingApprovalCents: 0,
});

function addTotals(target: ScanbackClaimsByWeekTotals, source: ScanbackClaimsByWeekCustomer) {
  target.reportedCount += source.reportedCount;
  target.qualifyingCount += source.qualifyingCount;
  target.notQualifyingCount += source.notQualifyingCount;
  target.qualifyingCents += source.qualifyingCents;
  target.approvedCents += source.approvedCents;
  target.awaitingApprovalCents += source.awaitingApprovalCents;
}

function weekOptions(program: ScanbackProgram, defaultWeek: string) {
  const weeks = new Set<string>();
  const firstWeek = dateStringToWeekIso(program.start);
  let cursor = firstWeek ? weekDates(firstWeek)?.start : undefined;
  while (cursor && cursor <= program.end) {
    const weekIso = dateStringToWeekIso(cursor);
    if (weekIso) weeks.add(weekIso);
    const next = new Date(`${cursor}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    cursor = next.toISOString().slice(0, 10);
  }
  weeks.add(defaultWeek);
  return [...weeks].sort((a, b) => b.localeCompare(a)).map((weekIso) => {
    const dates = weekDates(weekIso)!;
    return {
      weekIso,
      label: `w/e Sun ${weekEndingShortLabel(weekIso)}`,
      start: dates.start,
      end: dates.end,
    };
  });
}

function statusResult(result: ScanbackResult, batchReference: string | null = null): ScanbackClaimsByWeekLine {
  const claimCents = result.unitPriceCents != null && result.gtmBuyCents != null
    ? result.unitPriceCents - result.gtmBuyCents
    : null;
  const status: Status = result.status === "eligible" ? "awaiting_approval" : "not_qualifying";
  return {
    serial: result.serial,
    sku: result.sku,
    soldDate: result.date,
    invoiceNo: result.invoice,
    invoiceDate: result.invoiceDate,
    invoicedPriceCents: result.unitPriceCents,
    gtmBuyExCents: result.gtmBuyCents,
    claimCents,
    status,
    reason: result.status === "eligible" ? "Qualifies under the current verification." : result.reason,
    trackingColor: result.trackingColor ?? (result.status === "eligible" ? "green" : "neutral"),
    batchReference,
  };
}

function notQualifyingResult(
  row: ScanbackImport["rows"][number],
  reason: string,
  result?: ScanbackResult,
): ScanbackClaimsByWeekLine {
  const calculated = result ? statusResult(result) : null;
  return {
    serial: row.serial,
    sku: result?.sku ?? row.sku,
    soldDate: row.date,
    invoiceNo: result?.invoice ?? "",
    invoiceDate: result?.invoiceDate ?? "",
    invoicedPriceCents: result?.unitPriceCents ?? null,
    gtmBuyExCents: result?.gtmBuyCents ?? null,
    claimCents: calculated?.claimCents ?? null,
    status: "not_qualifying",
    reason,
    trackingColor: result?.trackingColor ?? "neutral",
    batchReference: null,
  };
}

function approvedLine(
  result: ScanbackResult,
  batchReference: string,
): ScanbackClaimsByWeekLine {
  const line = statusResult(result, batchReference);
  return {
    ...line,
    status: "approved",
    reason: `Approved in batch ${batchReference}`,
    trackingColor: "green",
  };
}

function lineStatusText(line: ScanbackClaimsByWeekLine) {
  if (line.status === "approved") return `Approved [${line.batchReference ?? "approved batch"}]`;
  if (line.status === "awaiting_approval") return "Qualifies – awaiting approval";
  return `Not qualifying – ${line.reason}`;
}

export function buildScanbackClaimsByWeekFromContext(
  context: ScanbackVerificationData,
  programId: string,
  selectedWeek: string | null,
  defaultWeek: string,
  customerIdsToBuild?: number[],
): ScanbackClaimsByWeek {
  const program = context.programsById.get(programId);
  requireThat(program, "Record not found", 404);
  const requestedCustomers = customerIdsToBuild ? new Set(customerIdsToBuild) : null;
  const programAccounts = context.accounts.filter(account =>
    program.customerIds.includes(account.id) && (!requestedCustomers || requestedCustomers.has(account.id)),
  );
  const batchesById = new Map<string, StoredScanbackBatch>(context.batches.map(batch => [batch.id, batch]));
  const approvedBySource = new Map<string, { row: ScanbackResult; reference: string }>();
  for (const approved of context.approved) {
    const batch = batchesById.get(approved.batchId);
    if (!batch) continue;
    const approvedProgramId = batch.settings?.programId ?? batch.programSnapshot?.id ?? approved.programId;
    const programName = batch.programSnapshot?.name ?? batch.programName;
    if (approvedProgramId ? approvedProgramId !== program.id : programName.toUpperCase() !== program.name.toUpperCase()) continue;
    const accountId = batch.settings?.accountId ?? approved.accountId;
    if (!program.customerIds.includes(accountId)) continue;
    const reportId = batch.settings?.claimImportId;
    for (const row of batch.rows) {
      if (!row.include || serialKey(row.serial) !== serialKey(approved.serial)) continue;
      const promotionRow = row as ScanbackResult & { importId?: string; lineId?: string };
      const sourceId = reportId ?? promotionRow.importId;
      if (!sourceId) continue;
      const rowIndex = promotionRow.lineId ? Number(promotionRow.lineId.split(":").at(-1)) : row.rowIndex;
      const key = `${sourceId}|${accountId}|${rowIndex}|${serialKey(row.serial)}`;
      approvedBySource.set(key, { row, reference: batch.reference });
    }
  }

  const reportsByCustomer = new Map<number, ScanbackImport[]>();
  for (const report of context.claimImports) {
    const accountId = report.accountId ?? report.rows.find(row => row.accountId != null)?.accountId ?? null;
    if (accountId == null || !program.customerIds.includes(accountId)) continue;
    const hasRowsInPeriod = report.rows.some(row =>
      (row.accountId ?? accountId) === accountId &&
      (selectedWeek
        ? dateStringToWeekIso(row.date) === selectedWeek
        : row.date >= program.start && row.date <= program.end),
    );
    if (!hasRowsInPeriod) continue;
    const current = reportsByCustomer.get(accountId) ?? [];
    current.push(report);
    reportsByCustomer.set(accountId, current);
  }

  const customers: ScanbackClaimsByWeekCustomer[] = [];
  for (const account of programAccounts) {
    const lines: CandidateLine[] = [];
    for (const report of reportsByCustomer.get(account.id) ?? []) {
      const reportAccountId = report.accountId ?? report.rows.find(row => row.accountId != null)?.accountId ?? null;
      if (reportAccountId !== account.id) continue;
      const resolvedRows = resolveMissingClaimSkus(report.rows, reportAccountId, context.invoiceSkuIndex);
      const matching = splitResolvedClaimRowsByPromotion(resolvedRows, reportAccountId, context.programs);
      const groupByRow = new Map<number, (typeof matching.groups)[number]>();
      for (const group of matching.groups) for (const rowIndex of group.rowIndices) groupByRow.set(rowIndex, group);
      const unmatchedByRow = new Map(matching.unmatched.map(row => [row.rowIndex, row.reason]));
      const selectedGroup = matching.groups.find(group =>
        group.program.id === program.id && group.accountId === account.id,
      );

      let selectedRows: number[] | undefined;
      if (selectedGroup) {
        const autoKey = `${report.id}|${program.id}|${account.id}`;
        const savedSelection = context.draftsByAutoKey.get(autoKey)?.settings.selectedRows;
        selectedRows = Array.isArray(savedSelection)
          ? savedSelection.filter(index => selectedGroup.rowIndices.includes(index))
          : selectedGroup.rowIndices;
      }
      const verification = program.archived ? null : verifyWithContext(context, {
        programId: program.id,
        accountId: account.id,
        claimImportId: report.id,
        basis: "sell",
        from: program.start,
        to: program.end,
        ...(selectedRows ? { selectedRows } : {}),
      });
      const resultByRow = new Map((verification?.results ?? []).map(result => [result.rowIndex, result]));

      for (const row of resolvedRows) {
        if ((row.accountId ?? reportAccountId) !== account.id) continue;
        const saleWeek = dateStringToWeekIso(row.date);
        if (!saleWeek) continue;
        if (selectedWeek ? saleWeek !== selectedWeek : row.date < program.start || row.date > program.end) continue;

        const group = groupByRow.get(row.rowIndex);
        const approved = approvedBySource.get(`${report.id}|${account.id}|${row.rowIndex}|${serialKey(row.serial)}`);
        let line: ScanbackClaimsByWeekLine;
        if (approved) {
          line = approvedLine(approved.row, approved.reference);
        } else if (program.archived) {
          line = notQualifyingResult(row, "Promotion is archived.");
        } else if (group?.program.id === program.id) {
          const result = resultByRow.get(row.rowIndex);
          line = result
            ? statusResult(result)
            : notQualifyingResult(row, "Current verification result is unavailable.");
        } else if (group) {
          line = notQualifyingResult(row, `Matched to promotion ${maskCustomerText(group.program.name)} instead.`);
        } else {
          const reason = unmatchedByRow.get(row.rowIndex);
          const explanation = reason === "overlapping_promotions"
            ? "Overlapping active promotions; choose the promotion in Verify."
            : reason === "missing_customer_or_sale_date"
              ? "Customer or sold date is missing."
              : "No unique active promotion matched this customer, sold date and SKU.";
          line = notQualifyingResult(row, explanation, resultByRow.get(row.rowIndex));
        }
        lines.push({ ...line, _rowIndex: row.rowIndex });
      }
    }

    lines.sort((a, b) => a.soldDate.localeCompare(b.soldDate) ||
      a.serial.localeCompare(b.serial) || a._rowIndex - b._rowIndex);
    const approvedCents = lines.filter(line => line.status === "approved")
      .reduce((sum, line) => sum + (line.claimCents ?? 0), 0);
    const awaitingApprovalCents = lines.filter(line => line.status === "awaiting_approval")
      .reduce((sum, line) => sum + (line.claimCents ?? 0), 0);
    const qualifyingCount = lines.filter(line => line.status !== "not_qualifying").length;
    const notQualifyingCount = lines.length - qualifyingCount;
    customers.push({
      accountId: account.id,
      accountCode: account.code,
      hasSerialReport: lines.length > 0,
      reportedCount: lines.length,
      qualifyingCount,
      notQualifyingCount,
      qualifyingCents: approvedCents + awaitingApprovalCents,
      approvedCents,
      awaitingApprovalCents,
      lines: lines.map(({ _rowIndex: _unused, ...line }) => line),
    });
  }

  const totals = emptyTotals();
  for (const customer of customers) addTotals(totals, customer);
  return {
    programId: program.id,
    programName: program.name,
    programStart: program.start,
    programEnd: program.end,
    selectedWeek,
    defaultWeek,
    weekLabel: selectedWeek ? `w/e Sun ${weekEndingShortLabel(selectedWeek)}` : "All weeks in promotion",
    weekOptions: weekOptions(program, defaultWeek),
    customers,
    totals,
  };
}

function filteredReport(report: ScanbackClaimsByWeek, filters: ScanbackClaimsByWeekFilters, defaultWeek: string) {
  const status = filters.status ?? "all";
  const customers = report.customers.flatMap(customer => {
    if (filters.customerId != null && filters.customerId !== customer.accountId) return [];
    const lines = customer.lines.filter(line => status === "all" || line.status === status);
    if (status !== "all" && lines.length === 0) return [];
    const approvedCents = lines.filter(line => line.status === "approved")
      .reduce((sum, line) => sum + (line.claimCents ?? 0), 0);
    const awaitingApprovalCents = lines.filter(line => line.status === "awaiting_approval")
      .reduce((sum, line) => sum + (line.claimCents ?? 0), 0);
    const qualifyingCount = lines.filter(line => line.status !== "not_qualifying").length;
    return [{
      ...customer,
      reportedCount: lines.length,
      qualifyingCount,
      notQualifyingCount: lines.length - qualifyingCount,
      qualifyingCents: approvedCents + awaitingApprovalCents,
      approvedCents,
      awaitingApprovalCents,
      lines,
    }];
  });
  const totals = emptyTotals();
  for (const customer of customers) addTotals(totals, customer);
  return {
    ...report,
    defaultWeek,
    weekOptions: weekOptions({ start: report.programStart, end: report.programEnd } as ScanbackProgram, defaultWeek),
    customers,
    totals,
  };
}

export async function buildScanbackClaimsByWeek(
  c: Client,
  filters: ScanbackClaimsByWeekFilters,
): Promise<ScanbackClaimsByWeek> {
  const defaultWeek = previousCompletedWeekIso();
  const selectedWeek = filters.week === "all" ? null : filters.week ?? defaultWeek;
  if (selectedWeek && !isValidWeekIso(selectedWeek)) throw new ScanbackError("Choose a valid Monday–Sunday week.");
  const key = JSON.stringify([filters.programId, selectedWeek ?? "all"]);
  let entry = weeklyReportCache.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    weeklyReportCache.delete(key);
    entry = undefined;
  }

  let context: ScanbackVerificationData | undefined;
  if (!entry) {
    context = await loadVerificationContext(c);
    const program = context.programsById.get(filters.programId);
    requireThat(program, "Record not found", 404);
    entry = {
      programId: program.id,
      expiresAt: Date.now() + WEEKLY_CACHE_TTL_MS,
      programCustomerIds: [...program.customerIds],
      coveredCustomerIds: new Set(),
      report: {
        programId: program.id,
        programName: program.name,
        programStart: program.start,
        programEnd: program.end,
        selectedWeek,
        defaultWeek,
        weekLabel: selectedWeek ? `w/e Sun ${weekEndingShortLabel(selectedWeek)}` : "All weeks in promotion",
        weekOptions: weekOptions(program, defaultWeek),
        customers: [],
        totals: emptyTotals(),
      },
    };
    weeklyReportCache.set(key, entry);
  }

  if (filters.customerId != null && !entry.programCustomerIds.includes(filters.customerId))
    throw new ScanbackError("Choose a customer included in this promotion.");
  const customerIdsToBuild = filters.customerId == null ? entry.programCustomerIds : [filters.customerId];
  const missingCustomerIds = customerIdsToBuild.filter(id => !entry.coveredCustomerIds.has(id));
  if (missingCustomerIds.length) {
    context ??= await loadVerificationContext(c);
    const segment = buildScanbackClaimsByWeekFromContext(
      context, filters.programId, selectedWeek, defaultWeek, missingCustomerIds,
    );
    const customersById = new Map(entry.report.customers.map(customer => [customer.accountId, customer]));
    for (const customer of segment.customers) customersById.set(customer.accountId, customer);
    const mergedCustomers = [...customersById.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const totals = emptyTotals();
    for (const customer of mergedCustomers) addTotals(totals, customer);
    entry.report = { ...entry.report, customers: mergedCustomers, totals };
    for (const id of missingCustomerIds) entry.coveredCustomerIds.add(id);
  }
  entry.expiresAt = Date.now() + WEEKLY_CACHE_TTL_MS;
  return filteredReport(entry.report, filters, defaultWeek);
}

function safeCell(value: unknown): string | number {
  if (typeof value === "number") return value;
  const text = String(value ?? "");
  return /^[=+@\-]/.test(text) ? `'${text}` : text;
}

function detailRows(report: ScanbackClaimsByWeek, customers = report.customers) {
  const columns = [
    "Serial", "SKU", "Sold date", "DD invoice no.", "Invoice date",
    "Invoiced price ex GST", "GTM Buy Ex", "Claim $", "Status",
  ];
  return [
    ["Promotion", maskCustomerText(report.programName)],
    ["Promotion dates", `${report.programStart} to ${report.programEnd}`],
    ["Week", report.weekLabel],
    [],
    columns,
    ...customers.flatMap((customer) => customer.lines.map((line) => [
      line.serial,
      line.sku,
      line.soldDate,
      line.invoiceNo,
      line.invoiceDate,
      line.invoicedPriceCents == null ? "" : line.invoicedPriceCents / 100,
      line.gtmBuyExCents == null ? "" : line.gtmBuyExCents / 100,
      line.claimCents == null ? "" : line.claimCents / 100,
      `${lineStatusText(line)}${line.status === "not_qualifying" ? ` · ${line.reason}` : ""}`,
    ])),
  ].map((row) => row.map(safeCell));
}

export async function buildScanbackClaimsByWeekWorkbook(
  c: Client,
  filters: ScanbackClaimsByWeekFilters,
): Promise<Buffer> {
  const report = await buildScanbackClaimsByWeek(c, filters);
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ["Promotion", maskCustomerText(report.programName)],
    ["Promotion dates", `${report.programStart} to ${report.programEnd}`],
    ["Week", report.weekLabel],
    [],
    ["Customer", "Serials reported", "Qualifying", "Not qualifying", "Claim $ qualifying", "Approved $", "Awaiting approval $"],
    ...report.customers.map((customer) => [
      maskCustomerText(customer.accountCode),
      customer.reportedCount,
      customer.qualifyingCount,
      customer.notQualifyingCount,
      customer.qualifyingCents / 100,
      customer.approvedCents / 100,
      customer.awaitingApprovalCents / 100,
    ]),
    ["Total", report.totals.reportedCount, report.totals.qualifyingCount, report.totals.notQualifyingCount,
      report.totals.qualifyingCents / 100, report.totals.approvedCents / 100, report.totals.awaitingApprovalCents / 100],
  ].map((row) => row.map(safeCell));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Customer summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(detailRows(report)), "Serial details");

  const usedNames = new Set(["customer summary", "serial details"]);
  for (const customer of report.customers) {
    const baseName = maskCustomerText(customer.accountCode).replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Customer ${customer.accountId}`;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      const tail = ` ${suffix++}`;
      name = `${baseName.slice(0, 31 - tail.length)}${tail}`;
    }
    usedNames.add(name.toLowerCase());
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(detailRows(report, [customer])), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
