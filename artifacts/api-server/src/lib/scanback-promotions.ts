import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import type {
  ScanbackImport, ScanbackProgram, ScanbackPromotionLine, ScanbackPromotionPartner,
  ScanbackPromotionTally, ScanbackPromotionTotals, ScanbackReconciliationInput,
  ScanbackCloseInput, ScanbackBatch,
} from "@workspace/api-zod";
import {
  get, hash, loadVerificationContext, recordApprovedSerials, requireThat, total,
  verifyWithContext, type Client, type ScanbackVerificationData, type StoredScanbackBatch,
} from "./scanback-store";
import { resolveMissingClaimSkus, splitResolvedClaimRowsByPromotion } from "./scanback-auto-drafts";
import { dateStringToWeekIso, sydneyDateString, weekDates } from "./dates";
import { serialKey } from "./scanback-engine";
import { maskCustomerText } from "./customer-display";
import { invalidateScanbackClaimsByWeekCache } from "./scanback-weekly";

type PromotionBatch = StoredScanbackBatch & {
  promotionClosed?: boolean;
  partnerSnapshot?: ScanbackPromotionPartner;
};
type Reconciliation = {
  id: string; programId: string; accountId: number; token: string;
  input: ScanbackReconciliationInput;
};
const emptyTotals = (): ScanbackPromotionTotals => ({ reported: 0, qualifying: 0, notQualifying: 0, claimCents: 0 });
const reconciliationId = (programId: string, accountId: number) => `promotion-close:${programId}:${accountId}`;
export const isPayableLine = (line: ScanbackPromotionLine) => line.include && line.status === "eligible";
function totals(lines: ScanbackPromotionLine[]): ScanbackPromotionTotals {
  const qualifying = lines.filter(isPayableLine);
  return { reported: lines.length, qualifying: qualifying.length, notQualifying: lines.length - qualifying.length,
    claimCents: qualifying.reduce((sum, line) => sum + line.amountCents, 0) };
}
function partnerBatches(context: ScanbackVerificationData, program: ScanbackProgram, accountId: number): PromotionBatch[] {
  return context.batches.filter(batch => {
    const programId = batch.settings?.programId ?? batch.programSnapshot?.id;
    const matches = programId ? programId === program.id : batch.programName.toUpperCase() === program.name.toUpperCase();
    return matches && (batch.settings?.accountId === accountId ||
      (!batch.settings?.accountId && batch.accountCode === context.accountCodesById.get(accountId)));
  });
}
export function requireReconciliationAllowed(program: ScanbackProgram, input: ScanbackReconciliationInput, today = sydneyDateString()) {
  requireThat(!program.archived, "This promotion is archived.");
  requireThat(today >= program.start, "The promotion has not started.");
  requireThat(today > program.end || !!input.earlyNote?.trim(),
    "Reconciliation is blocked until after the promotion end date. Use Reconcile early with an override note.", 409);
}

/** A single virtual report per partner lets the unchanged engine apply its
 * duplicate and customer/SKU cap rules across the ENTIRE promotion, not per file.
 * It is never persisted as a new source import. */
export function buildPromotionPartner(
  context: ScanbackVerificationData, programId: string, accountId: number,
  input: ScanbackReconciliationInput = {}, today = sydneyDateString(),
): ScanbackPromotionPartner {
  const program = context.programsById.get(programId);
  requireThat(program, "Promotion not found.", 404);
  requireThat(program.customerIds.includes(accountId), "Choose a partner in this promotion.");
  const batches = partnerBatches(context, program, accountId);
  const closedBatch = batches.find(batch => batch.promotionClosed);
  if (closedBatch?.partnerSnapshot) return { ...closedBatch.partnerSnapshot, closed: true, batches };
  const virtualId = `promotion:${programId}:${accountId}`;
  const candidates: { row: ScanbackImport["rows"][number]; importId: string; lineId: string; matches: boolean }[] = [];
  const reportedWeeks = new Set<string>();
  const reports = [...context.claimImports].sort((a, b) =>
    (a.committedAt ?? a.createdAt).localeCompare(b.committedAt ?? b.createdAt) || a.id.localeCompare(b.id));
  for (const report of reports) {
    const rows = resolveMissingClaimSkus(report.rows, report.accountId, context.invoiceSkuIndex);
    const matching = splitResolvedClaimRowsByPromotion(rows, report.accountId, context.programs);
    const matched = new Set(matching.groups.filter(group => group.program.id === program.id && group.accountId === accountId)
      .flatMap(group => group.rowIndices));
    for (const row of rows) {
      if ((row.accountId ?? report.accountId) !== accountId || row.date < program.start || row.date > program.end) continue;
      reportedWeeks.add(dateStringToWeekIso(row.date));
      candidates.push({ row, importId: report.id, lineId: `${report.id}:${row.rowIndex}`, matches: matched.has(row.rowIndex) });
    }
    // Explicit upload metadata also records a submitted zero-sales week.
    if (report.accountId === accountId) {
      const week = context.reportWeeksByImportId?.get(report.id);
      if (week) reportedWeeks.add(week);
    }
  }
  const exclusions = new Map((input.exclusions ?? []).map(item => [item.lineId, item.note.trim()]));
  requireThat(exclusions.size === (input.exclusions ?? []).length, "A serial can only be excluded once.");
  for (const [id, note] of exclusions) {
    requireThat(note.length > 0, "Every excluded serial requires a note.");
    requireThat(candidates.some(candidate => candidate.lineId === id), "An excluded serial is no longer in this promotion. Recheck.");
  }
  const syntheticRows = candidates.map((candidate, index) => ({ ...candidate.row, rowIndex: index }));
  const virtualReport: ScanbackImport = {
    id: virtualId, kind: "claim", name: program.name, state: "committed", createdAt: "",
    headers: [], sheets: [], mapping: {}, dateFormat: "dmy", sheet: "", accountId,
    rows: syntheticRows, errors: [], warnings: [], duplicate: false, recordCount: syntheticRows.length,
  };
  const firstSales = new Map(context.reportedSalesBySerial);
  candidates.forEach((candidate, index) => {
    const key = serialKey(candidate.row.serial);
    const first = firstSales.get(key);
    if (first?.reportId === candidate.importId && first.rowIndex === candidate.row.rowIndex)
      firstSales.set(key, { ...first, reportId: virtualId, rowIndex: index });
  });
  const selectedRows = candidates.flatMap((candidate, index) =>
    candidate.matches && !exclusions.has(candidate.lineId) ? [index] : []);
  const syntheticContext: ScanbackVerificationData = {
    ...context,
    // Archived promotions remain readable; reconciliation is separately blocked.
    programsById: new Map(context.programsById).set(program.id, { ...program, archived: false }),
    importsById: new Map(context.importsById).set(virtualId, virtualReport),
    reportedSalesBySerial: firstSales,
  };
  const verified = verifyWithContext(syntheticContext, {
    programId, accountId, claimImportId: virtualId, basis: "sell",
    from: program.start, to: program.end, selectedRows,
  });
  const approvals = new Map<string, { row: ScanbackBatch["rows"][number]; batch: PromotionBatch }>();
  for (const batch of batches) for (const row of batch.rows) {
    if (row.include) approvals.set(serialKey(row.serial), { row, batch });
  }
  const shownApprovals = new Set<string>();
  const lines: ScanbackPromotionLine[] = verified.results.map((result, index) => {
    const candidate = candidates[index];
    const line = { ...result, lineId: candidate.lineId, importId: candidate.importId };
    const key = serialKey(line.serial);
    const approved = approvals.get(key);
    // Old approvals keep their immutable prices and count against the engine's
    // remaining cap. Display each approved serial once, never once per report.
    if (approved && !shownApprovals.has(key)) {
      shownApprovals.add(key);
      return { ...line, ...approved.row, rowIndex: index, include: true, status: "eligible",
        trackingColor: "green", reason: `Previously approved — ${approved.batch.reference}` };
    }
    if (exclusions.has(candidate.lineId)) return { ...line, include: false, status: "rejected",
      trackingColor: "orange", reason: `Excluded: ${exclusions.get(candidate.lineId)}` };
    if (!candidate.matches) return { ...line, include: false, status: "review", trackingColor: "orange",
      reason: "No unique active promotion matched this partner, sold date and SKU. Review promotion terms." };
    return { ...line, trackingColor: line.status === "eligible" ? "green" : line.status === "review" ? "orange" : "red" };
  });
  for (const [key, approved] of approvals) {
    if (shownApprovals.has(key)) continue;
    lines.push({ ...approved.row, rowIndex: lines.length, lineId: `approved:${approved.batch.id}:${key}`,
      importId: approved.batch.settings?.claimImportId ?? "", include: true, status: "eligible",
      trackingColor: "green", reason: `Previously approved — ${approved.batch.reference}` });
  }
  const weeks: ScanbackPromotionPartner["weeks"] = [];
  let cursor = weekDates(dateStringToWeekIso(program.start))!.start;
  while (cursor <= program.end) {
    const weekIso = dateStringToWeekIso(cursor);
    const dates = weekDates(weekIso)!;
    const weekLines = lines.filter(line => dateStringToWeekIso(line.date) === weekIso);
    const reportedWeek = reportedWeeks.has(weekIso) || weekLines.length > 0;
    weeks.push({ weekIso, weekEnd: dates.end, reportedWeek,
      missing: !reportedWeek && (dates.end < today || program.end < today), ...totals(weekLines) });
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    cursor = next.toISOString().slice(0, 10);
  }
  // Keep even incomplete legacy statement dates accountable in weekly totals.
  const unassigned = lines.filter(line => !weeks.some(week => dateStringToWeekIso(line.date) === week.weekIso));
  if (unassigned.length) weeks.push({ weekIso: "undated", weekEnd: "", reportedWeek: true, missing: false, ...totals(unassigned) });
  const capUsed = program.lines.map(line => {
    const sku = line.sku ?? context.parts.find(part => part.id === line.partId)?.code ?? "";
    const used = lines.filter(row => isPayableLine(row) && row.sku === sku).length;
    const cap = line.caps.find(item => item.resellerId === accountId)?.quantity;
    return `${sku}: ${used} / ${cap == null ? "uncapped" : cap}`;
  }).join("; ");
  return {
    accountId, accountCode: context.accountCodesById.get(accountId) ?? String(accountId),
    closed: !!closedBatch, weeksReported: weeks.filter(week => week.reportedWeek && week.weekIso !== "undated").length,
    weeksExpected: weeks.filter(week => week.weekIso !== "undated").length,
    missingWeeks: weeks.filter(week => week.missing).map(week => week.weekEnd), weeks, lines, capUsed, batches,
    ...totals(lines),
  };
}
export function buildPromotionTally(context: ScanbackVerificationData, programId: string, today = sydneyDateString()): ScanbackPromotionTally {
  const program = context.programsById.get(programId);
  requireThat(program, "Promotion not found.", 404);
  const partners = program.customerIds.map(accountId => buildPromotionPartner(context, programId, accountId, {}, today));
  const combined = emptyTotals();
  for (const partner of partners) for (const key of Object.keys(combined) as (keyof ScanbackPromotionTotals)[]) combined[key] += partner[key];
  const daysLeft = Math.max(0, Math.ceil((Date.parse(program.end) - Date.parse(today)) / 86_400_000));
  return { program, today, partners, totals: combined, daysLeft,
    status: partners.length && partners.every(partner => partner.closed) ? "reconciled" :
      today < program.start ? "scheduled" : today <= program.end ? "live" : "ended" };
}
function reconciliationToken(context: ScanbackVerificationData, partner: ScanbackPromotionPartner, programId: string, input: ScanbackReconciliationInput) {
  return hash({ program: context.programsById.get(programId), partner, input,
    imports: context.tokenImports, reports: context.claimImports, approved: context.approved,
    credits: context.unmatchedProntoCredits, restricted: [...context.restrictedSerials].sort() });
}
export async function reconcilePromotionPartner(c: Client, programId: string, accountId: number, input: ScanbackReconciliationInput) {
  const context = await loadVerificationContext(c);
  const program = context.programsById.get(programId);
  requireThat(program, "Promotion not found.", 404);
  requireReconciliationAllowed(program, input);
  const partner = buildPromotionPartner(context, programId, accountId, input);
  requireThat(!partner.closed, "This partner is already closed.", 409);
  const token = reconciliationToken(context, partner, programId, input);
  const draft: Reconciliation = { id: reconciliationId(programId, accountId), programId, accountId, input, token };
  await c.query(`INSERT INTO scanback_drafts(id,payload) VALUES($1,$2::jsonb)
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [draft.id, JSON.stringify(draft)]);
  return { ...partner, token };
}
export async function closePromotionPartner(c: Client, programId: string, accountId: number, input: ScanbackCloseInput) {
  const context = await loadVerificationContext(c);
  const program = context.programsById.get(programId);
  requireThat(program, "Promotion not found.", 404);
  const existing = partnerBatches(context, program, accountId).find(batch => batch.promotionClosed);
  // Retries and simultaneous closes return the same batch under the financial
  // advisory transaction lock, including zero-payable closures.
  if (existing) return existing;
  const draft = await get<Reconciliation>(c, "scanback_drafts", reconciliationId(programId, accountId));
  requireThat(draft.token === input.token, "Reconciliation changed. Run the final check again.", 409);
  requireReconciliationAllowed(program, draft.input);
  const partner = buildPromotionPartner(context, programId, accountId, draft.input);
  requireThat(reconciliationToken(context, partner, programId, draft.input) === input.token,
    "Reports, Dicker evidence, promotion terms or approvals changed. Reconcile again before closing.", 409);
  requireThat(input.reference.trim() && input.reference.length <= 200, "Enter a claim reference.");
  // Existing approved serials are displayed in the tally but never repaid.
  const rows = partner.lines.map(line => ({ ...line,
    include: isPayableLine(line) && !context.approvedBySerial.has(serialKey(line.serial)) }));
  const batch: ScanbackBatch = {
    id: randomUUID(), reference: input.reference.trim(), programName: program.name, accountCode: partner.accountCode,
    createdAt: new Date().toISOString(), totalCents: total(rows), approvedCount: rows.filter(row => row.include).length,
    historical: false, basis: "sell", from: program.start, to: program.end, rows,
  };
  const snapshot: PromotionBatch = {
    ...batch, programSnapshot: program, settings: { programId, accountId }, promotionClosed: true,
    partnerSnapshot: { ...partner, closed: true, batches: [] },
  };
  const saved = { ...snapshot, reconciliation: draft, verificationToken: input.token };
  await c.query("INSERT INTO scanback_batches(id,draft_id,payload) VALUES($1,$2,$3::jsonb)",
    [batch.id, draft.id, JSON.stringify(saved)]);
  await recordApprovedSerials(c, batch, accountId, context.parts, programId);
  await c.query(`INSERT INTO scanback_audit_log(action,entity_id,entity_name,actor,details)
    VALUES('promotion_partner_closed',$1,$2,'admin',$3::jsonb)`,
  [programId, program.name, JSON.stringify({ accountId, batchId: batch.id, earlyNote: draft.input.earlyNote,
    exclusions: draft.input.exclusions, missingWeeks: partner.missingWeeks })]);
  invalidateScanbackClaimsByWeekCache();
  return batch;
}
export async function promotionWorkbook(c: Client, programId: string, accountId?: number): Promise<Buffer> {
  const report = buildPromotionTally(await loadVerificationContext(c), programId);
  const partners = report.partners.filter(partner => accountId == null || partner.accountId === accountId);
  requireThat(partners.length, "No matching promotion partner.", 404);
  const label = report.status === "reconciled" ? "RECONCILED" : "Running tally — not final";
  const safe = (value: unknown): string | number => {
    if (typeof value === "number") return value;
    const text = String(value ?? "");
    return /^[=+@\t\r-]/.test(text) ? `'${text}` : text;
  };
  const book = XLSX.utils.book_new();
  const append = (name: string, rows: unknown[][]) =>
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map(row => row.map(safe))), name);
  const sum = partners.reduce((acc, partner) => {
    for (const key of Object.keys(acc) as (keyof ScanbackPromotionTotals)[]) acc[key] += partner[key];
    return acc;
  }, emptyTotals());
  append("Partner summary", [[label], ["Promotion", maskCustomerText(report.program.name)], ["Dates", report.program.start, report.program.end],
    ["Partner", "Weeks reported", "Missing weeks", "Serials reported", "Qualifying", "Not qualifying", "Claim $", "Cap used", "Status"],
    ...partners.map(p => [maskCustomerText(p.accountCode), `${p.weeksReported} of ${p.weeksExpected}`, p.missingWeeks.join(", "), p.reported,
      p.qualifying, p.notQualifying, p.claimCents / 100, p.capUsed, p.closed ? "Closed" : report.status]),
    ["Total", "", "", sum.reported, sum.qualifying, sum.notQualifying, sum.claimCents / 100]]);
  append("Weekly breakdown", [[label], ["Partner", "Week ending", "Reported", "Missing", "Serials", "Qualifying", "Not qualifying", "Claim $"],
    ...partners.flatMap(p => p.weeks.map(w => [maskCustomerText(p.accountCode), w.weekEnd, w.reportedWeek ? "Yes" : "No", w.missing ? "Yes" : "No",
      w.reported, w.qualifying, w.notQualifying, w.claimCents / 100]))]);
  append("Serial details", [[label], ["Partner", "Serial", "SKU", "Sold date", "DD invoice", "Invoiced price ex GST", "GTM Buy Ex", "Claim $", "Status", "Reason", "Source report", "Source line"],
    ...partners.flatMap(p => p.lines.map(l => [maskCustomerText(p.accountCode), l.serial, l.sku, l.date, l.invoice,
      l.unitPriceCents == null ? "" : l.unitPriceCents / 100, l.gtmBuyCents == null ? "" : l.gtmBuyCents / 100,
      isPayableLine(l) ? l.amountCents / 100 : 0, l.status, maskCustomerText(l.reason), l.importId, l.lineId]))]);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
