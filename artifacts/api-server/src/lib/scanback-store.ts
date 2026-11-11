import { pool, type PoolClient } from "@workspace/db";
import { createHash, randomUUID } from "node:crypto";
import type {
  ScanbackProgram, ScanbackImport, ScanbackDraft, ScanbackVerificationInput,
  ScanbackResult, ScanbackBatch, ScanbackImportRow,
} from "@workspace/api-zod";
import {
  buildEvidenceSerialIndex, verifyClaim, evidenceKey, cents,
  type EvidenceRow, type ApprovedSerial, type CatalogPart,
} from "./scanback-engine";
import {
  buildInvoiceSkuIndex, resolveMissingClaimSkus, splitResolvedClaimRowsByPromotion,
  type InvoiceSkuIndex,
} from "./scanback-auto-drafts";
import { mapImport, parseDate, prontoRangeCovers, type Sheets, type Account } from "./scanback-import";
import { indexProntoSource, pendingProntoCredits, prontoCreditIdentity, type ProntoCreditReport } from "./scanback-pronto";
import { maskCustomerText } from "./customer-display";
import {
  loadReportedSales, reportedSales as getReportedSales, firstReportedSales, earlierReportReason,
  isSameCustomerReportRepeat, type ReportedSale,
} from "./serial-tracking";

export type Client = PoolClient;
export class ScanbackError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new ScanbackError(message, status);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
// PostgreSQL jsonb reorders object keys. A verification fingerprint must survive
// the round trip without mistaking that reordering for a financial change.
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export async function transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // All financial writers, including imports and changes to program terms,
    // use this lock. Unique serial/draft constraints are the second defence.
    await client.query("SELECT pg_advisory_xact_lock(73482819)");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}
type Table = "scanback_programs" | "scanback_imports" | "scanback_drafts" | "scanback_batches";
export async function all<T>(c: Client, table: Table): Promise<T[]> {
  return (await c.query(`SELECT payload FROM ${table} ORDER BY created_at DESC, id`)).rows.map(r => r.payload as T);
}
export async function get<T>(c: Client, table: Table, id: string): Promise<T> {
  const result = await c.query(`SELECT payload FROM ${table} WHERE id=$1`, [id]);
  if (!result.rowCount) throw new ScanbackError("Record not found", 404);
  return result.rows[0].payload as T;
}
export async function put(c: Client, table: Table, id: string, value: unknown) {
  await c.query(`UPDATE ${table} SET payload=$2::jsonb WHERE id=$1`, [id, JSON.stringify(value)]);
}
export async function catalog(c: Client): Promise<{ accounts: Account[]; parts: CatalogPart[] }> {
  const accounts = (await c.query("SELECT id,code,name,aliases,active FROM resellers ORDER BY code")).rows as Account[];
  const parts = (await c.query("SELECT id, part_no AS code FROM parts ORDER BY part_no")).rows as CatalogPart[];
  return { accounts, parts };
}
export async function ledger(c: Client): Promise<ApprovedSerial[]> {
  return (await c.query(`SELECT s.serial,s.batch_id AS "batchId",s.program_id AS "programId",
    s.account_id AS "accountId",s.part_id AS "partId",COALESCE(s.sku,p.part_no) AS sku,
    b.payload->>'programName' AS "programName",b.payload->>'reference' AS "batchReference"
    FROM scanback_approved_serials s LEFT JOIN parts p ON p.id=s.part_id
    JOIN scanback_batches b ON b.id=s.batch_id ORDER BY s.serial`)).rows;
}
export function publicImport(value: ScanbackImport, withRows = false): ScanbackImport {
  const publicValue = { ...value } as ScanbackImport & Record<string, unknown>;
  delete publicValue.prontoCreditRows;
  delete publicValue.prontoRestrictedSerials;
  return { ...publicValue, rows: withRows ? value.rows.slice(0, 200) : [], errors: value.errors.slice(0, 200) };
}
export async function rebuildImport(c: Client, base: ScanbackImport, raw: Sheets, opts: Parameters<typeof mapImport>[2]) {
  const cat = await catalog(c);
  const value = mapImport(base, raw, opts, cat.accounts, new Set(cat.parts.map(p => p.code.toUpperCase())));
  if (base.kind === "evidence") {
    const old = (await all<ScanbackImport>(c, "scanback_imports")).filter(i =>
      i.id !== base.id && i.kind === "evidence" && ["committed", "superseded"].includes(i.state));
    const seen = new Set(old.flatMap(i => i.rows.map(evidenceKey)));
    let ignored = 0;
    value.rows = value.rows.filter(row => {
      const key = evidenceKey(row);
      if (seen.has(key)) { ignored++; return false; }
      seen.add(key); return true;
    });
    // Different content for the same financial event is a conflict, not an
    // update. The old evidence remains immutable.
    const financial = new Map(old.flatMap(i => i.rows.map(r => [
      JSON.stringify([r.serial, r.accountId, r.sku, r.date, r.invoice, Math.sign(r.quantity)]), r.unitPriceCents,
    ] as const)));
    for (const row of value.rows) {
      const key = JSON.stringify([row.serial, row.accountId, row.sku, row.date, row.invoice, Math.sign(row.quantity)]);
      if (financial.has(key) && financial.get(key) !== row.unitPriceCents)
        value.errors.push({ row: row.rowIndex + 2, message: "Conflicting unit price for an already imported invoice event. Review the original evidence; it will not be overwritten." });
    }
    value.recordCount = value.rows.length;
    if (ignored) value.warnings.push(`${ignored} identical invoice/credit events already present were ignored; ${value.rows.length} new serial events remain.`);
  }
  if (base.kind === "history") {
    const used = new Set((await ledger(c)).map(l => l.serial));
    const seen = new Set<string>();
    for (const row of value.rows) {
      if (seen.has(row.serial) || used.has(row.serial))
        value.errors.push({ row: row.rowIndex + 2, message: "This serial is duplicated or already exists in approved history." });
      seen.add(row.serial);
    }
  }
  if (base.kind === "claim") {
    const first = firstReportedSales(await loadReportedSales(c));
    const approved = new Map((await ledger(c)).map(row => [row.serial, row]));
    const seen = new Map<string, number>();
    let blockedRepeats = 0, sameCustomerRepeats = 0;
    value.rows = value.rows.map(row => {
      const sourceRow = row.sourceRow ?? row.rowIndex + 2;
      const firstSourceRow = seen.get(row.serial);
      if (firstSourceRow == null) seen.set(row.serial, sourceRow);
      const claimed = approved.get(row.serial);
      const approvedReason = claimed
        ? `Already approved in batch ${claimed.batchId}${claimed.programName ? `, promotion ${claimed.programName}` : ""}`
        : "";
      const reportReason = earlierReportReason(first.get(row.serial), base.id, row.rowIndex, row.accountId ?? base.accountId);
      const localRepeat = firstSourceRow == null ? "" :
        `Duplicate serial in this upload (${base.name}): source row ${sourceRow} repeats its first occurrence on source row ${firstSourceRow}.`;
      const reason = [localRepeat, approvedReason, reportReason].filter(Boolean).join(" ");
      if (reason) {
        if (isSameCustomerReportRepeat(reason)) sameCustomerRepeats++;
        else blockedRepeats++;
        if (blockedRepeats + sameCustomerRepeats <= 20) value.warnings.push(`${row.serial} at source row ${sourceRow}: ${reason}`);
      }
      return { ...row, reuseReason: reason };
    });
    if (blockedRepeats) value.warnings.push(`${blockedRepeats} serial row(s) are red because they were already approved, sold by another customer, or duplicated in this report.`);
    if (sameCustomerRepeats) value.warnings.push(`${sameCustomerRepeats} serial row(s) also appear in an earlier report for this customer. They are amber and can still be verified unless approved.`);
  }
  return value;
}
export async function currentClaimReport(c: Client, report: ScanbackImport): Promise<ScanbackImport> {
  if (report.kind !== "claim" || report.state !== "committed") return report;
  const first = firstReportedSales(await loadReportedSales(c));
  const approved = new Map((await ledger(c)).map(row => [row.serial, row]));
  return { ...report, rows: report.rows.map(row => {
    const claimed = approved.get(row.serial);
    const reuseReason = claimed ? `Already approved in batch ${claimed.batchId}${claimed.programName ? `, promotion ${claimed.programName}` : ""}` :
      earlierReportReason(first.get(row.serial), report.id, row.rowIndex, row.accountId ?? report.accountId);
    return { ...row, reuseReason };
  }) };
}
type IndexedImport = ScanbackImport & {
  prontoCreditRows?: Record<string, unknown>[];
  prontoRestrictedSerials?: string[];
};
type VerificationTokenImport = {
  id: string;
  state: string;
  events: string[];
  prontoCreditResolutions?: unknown[];
};
type UnmatchedProntoCredit = { accountSkuKey: string; invoice: string; date: string };
export type StoredScanbackBatch = ScanbackBatch & {
  settings?: { programId?: string; accountId?: number; claimImportId?: string };
  programSnapshot?: ScanbackProgram;
};

export interface ScanbackVerificationData {
  programs: ScanbackProgram[];
  programsById: Map<string, ScanbackProgram>;
  imports: ScanbackImport[];
  importsById: Map<string, ScanbackImport>;
  claimImports: ScanbackImport[];
  evidenceImports: ScanbackImport[];
  batches: StoredScanbackBatch[];
  autoDrafts: (ScanbackDraft & { autoKey?: string })[];
  draftsByAutoKey: Map<string, (ScanbackDraft & { autoKey?: string })>;
  approvedDraftIds: Set<string>;
  invoiceRows: ScanbackImportRow[];
  invoiceSkuIndex: InvoiceSkuIndex;
  evidence: EvidenceRow[];
  evidenceBySerial: Map<string, EvidenceRow[]>;
  approved: ApprovedSerial[];
  approvedBySerial: Map<string, ApprovedSerial>;
  parts: CatalogPart[];
  accounts: Account[];
  accountCodesById: Map<number, string>;
  restrictedSerials: Set<string>;
  unmatchedProntoCredits: UnmatchedProntoCredit[];
  unmatchedProntoCreditsByAccountSku: Map<string, UnmatchedProntoCredit>;
  reportedSales: ReportedSale[];
  reportedSalesBySerial: Map<string, ReportedSale>;
  ddRangeSkus: Set<string>;
  tokenImports: VerificationTokenImport[];
}

export async function loadVerificationContext(c: Client): Promise<ScanbackVerificationData> {
  const [programs, imports, storedDrafts, approved, batches, cat, legacySourceRows, approvedDraftRows] = await Promise.all([
    all<ScanbackProgram>(c, "scanback_programs"),
    c.query(`SELECT payload FROM scanback_imports
      WHERE payload->>'kind' IN ('claim','evidence')
        AND payload->>'state' IN ('committed','superseded')
      ORDER BY created_at DESC,id`),
    c.query("SELECT payload FROM scanback_drafts WHERE payload->>'autoGenerated'='true' ORDER BY created_at DESC"),
    ledger(c),
    all<StoredScanbackBatch>(c, "scanback_batches"),
    catalog(c),
    c.query(`SELECT id,raw_sheets FROM scanback_imports
      WHERE payload->>'kind'='evidence' AND payload->>'state' IN ('committed','superseded')
        AND payload ? 'pronto'
        AND NOT (payload ? 'prontoCreditRows' AND payload ? 'prontoRestrictedSerials')`),
    c.query("SELECT draft_id FROM scanback_batches WHERE draft_id IS NOT NULL"),
  ]);
  const committedImports = imports.rows.map(row => row.payload as ScanbackImport);
  const evidenceImports = committedImports.filter(item =>
    item.kind === "evidence" && ["committed", "superseded"].includes(item.state) && item.rows.length > 0,
  );
  const prontoImports = committedImports.filter(item =>
    item.kind === "evidence" && ["committed", "superseded"].includes(item.state) && Object.hasOwn(item, "pronto"),
  );
  const claimImports = committedImports.filter(item => item.kind === "claim" && item.state === "committed");
  const importsById = new Map(committedImports.map(item => [item.id, item]));
  const programsById = new Map(programs.map(program => [program.id, program]));
  const autoDrafts = storedDrafts.rows.map(row => row.payload as ScanbackDraft & { autoKey?: string });
  const draftsByAutoKey = new Map<string, ScanbackDraft & { autoKey?: string }>();
  for (const draft of autoDrafts) {
    if (draft.autoKey && !draftsByAutoKey.has(draft.autoKey)) draftsByAutoKey.set(draft.autoKey, draft);
  }
  const approvedDraftIds = new Set<string>(approvedDraftRows.rows.map(row => String(row.draft_id)));
  const invoiceRows = prontoImports.flatMap(item => item.rows);
  const invoiceSkuIndex = buildInvoiceSkuIndex(invoiceRows);
  const evidence: EvidenceRow[] = evidenceImports.flatMap(item =>
    item.rows.map(row => ({
      ...row,
      source: `${item.name} [${item.id}], ${item.sheet}, row ${row.sourceRow ?? row.rowIndex + 2}`,
    })),
  );
  const approvedBySerial = new Map(approved.map(item => [item.serial, item]));
  const accountCodesById = new Map(cat.accounts.map(account => [account.id, account.code]));
  const ddRangeSkus = new Set([
    ...evidenceImports.flatMap(item => item.rows.map(row => row.sku.trim().toUpperCase()).filter(Boolean)),
    ...programs.flatMap(program => program.lines.map(line =>
      (line.sku ?? cat.parts.find(part => part.id === line.partId)?.code ?? "").trim().toUpperCase(),
    ).filter(Boolean)),
  ]);
  const legacyIndexes = new Map<string, ReturnType<typeof indexProntoSource>>();
  for (const source of legacySourceRows.rows) {
    const imp = importsById.get(String(source.id)) as IndexedImport | undefined;
    if (!imp) continue;
    legacyIndexes.set(imp.id, indexProntoSource(
      (source.raw_sheets as Sheets)?.[imp.sheet] ?? [], imp.prontoAccounts ?? {},
    ));
  }
  const restrictedSerials = new Set<string>();
  const prontoReports: ProntoCreditReport[] = prontoImports.map(item => {
    const imp = item as IndexedImport;
    const legacy = legacyIndexes.get(item.id);
    for (const serial of imp.prontoRestrictedSerials ?? legacy?.restrictedSerials ?? []) restrictedSerials.add(serial);
    return {
      id: imp.id, createdAt: imp.createdAt, committedAt: imp.committedAt,
      prontoAccounts: imp.prontoAccounts, prontoCreditResolutions: imp.prontoCreditResolutions,
      dateFormat: imp.dateFormat, rows: imp.prontoCreditRows ?? legacy?.creditRows ?? [],
    };
  });
  const unmatchedProntoCredits = pendingProntoCredits(prontoReports).map(credit => ({
    ...credit, date: parseDate(credit.date, "dmy") || credit.date,
  }));
  const unmatchedProntoCreditsByAccountSku = new Map<string, UnmatchedProntoCredit>();
  for (const credit of unmatchedProntoCredits) {
    if (!unmatchedProntoCreditsByAccountSku.has(credit.accountSkuKey))
      unmatchedProntoCreditsByAccountSku.set(credit.accountSkuKey, credit);
  }
  const appliedResolutionKeys = new Set<string>();
  for (const report of prontoReports) {
    const imp = importsById.get(report.id) as IndexedImport | undefined;
    if (!imp) continue;
    const indexedRows = new Map(report.rows.map(row => [Number(row.sourceRow), row]));
    for (const resolution of imp.prontoCreditResolutions ?? []) {
      if (resolution.mode !== "serials") continue;
      const row = indexedRows.get(resolution.sourceRow) ?? report.rows[resolution.sourceRow - 2];
      if (!row) continue;
      const creditKey = resolution.creditKey ?? prontoCreditIdentity(
        row["Account Code"], row["Stock Code"], row["Invoice No"], row["Ship Qty"], row["Invoice Date"], imp.dateFormat,
      );
      if (appliedResolutionKeys.has(creditKey)) continue;
      appliedResolutionKeys.add(creditKey);
      const accountCode = String(row["Account Code"] ?? "").trim();
      const accountId = imp.prontoAccounts?.[accountCode];
      if (accountId == null) continue;
      const sku = String(row["Stock Code"] ?? "").trim().toUpperCase();
      const date = parseDate(row["Invoice Date"], imp.dateFormat ?? "dmy");
      const invoice = String(row["Invoice No"] ?? "").trim();
      const price = cents(row["Item Price"]);
      for (const serial of resolution.serials) {
        const resolvedEvidence: EvidenceRow = {
          rowIndex: resolution.sourceRow - 2, serial, sku, date, accountId, quantity: -1,
          invoice, unitPriceCents: price == null ? null : Math.abs(price), costCents: null,
          amountCents: null, program: "", reference: "",
          source: `Resolved Pronto credit ${invoice} [${imp.id}], row ${resolution.sourceRow}`,
        };
        evidence.push(resolvedEvidence);
      }
    }
  }
  const evidenceBySerial = buildEvidenceSerialIndex(evidence);
  const reportedSales = getReportedSales(claimImports);
  const reportedSalesBySerial = firstReportedSales(reportedSales);
  const tokenImports: VerificationTokenImport[] = evidenceImports
    .map(item => ({ id: item.id, state: item.state, events: item.rows.map(evidenceKey) }))
    .concat(prontoImports.map(item => ({
      id: item.id, state: item.state, events: [],
      prontoCreditResolutions: (item as IndexedImport).prontoCreditResolutions ?? [],
    })))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    programs, programsById, imports: committedImports, importsById, claimImports, evidenceImports, batches,
    autoDrafts, draftsByAutoKey, approvedDraftIds, invoiceRows, invoiceSkuIndex, evidence, evidenceBySerial,
    approved, approvedBySerial, parts: cat.parts, accounts: cat.accounts, accountCodesById,
    restrictedSerials, unmatchedProntoCredits, unmatchedProntoCreditsByAccountSku,
    reportedSales, reportedSalesBySerial, ddRangeSkus, tokenImports,
  };
}

export function verifyWithContext(
  context: ScanbackVerificationData,
  settings: ScanbackVerificationInput,
  scopeRowIndices?: number[],
) {
  const p = context.programsById.get(settings.programId);
  requireThat(p, "Record not found", 404);
  requireThat(!p.archived, "This promotion is archived.");
  requireThat(p.customerIds.includes(settings.accountId), "Choose an eligible Account Code.");
  const canonicalSettings: ScanbackVerificationInput = {
    ...settings, basis: "sell", from: p.start, to: p.end,
  };
  const claim = context.importsById.get(settings.claimImportId);
  requireThat(claim, "Record not found", 404);
  requireThat(claim.state === "committed" && claim.kind === "claim", "Choose a committed customer claim import.");
  const claimRows = resolveMissingClaimSkus(claim.rows, claim.accountId, context.invoiceSkuIndex);
  const scopedIndices = scopeRowIndices ? new Set(scopeRowIndices) : null;
  const scopedClaims = scopedIndices ? claimRows.filter(row => scopedIndices.has(row.rowIndex)) : claimRows;
  const results = verifyClaim({
    program: p, settings: canonicalSettings, claims: scopedClaims,
    evidence: context.evidence, evidenceBySerial: context.evidenceBySerial,
    approved: context.approved, approvedBySerial: context.approvedBySerial,
    parts: context.parts, restrictedSerials: context.restrictedSerials,
    unmatchedProntoCredits: context.unmatchedProntoCredits,
    unmatchedProntoCreditsByAccountSku: context.unmatchedProntoCreditsByAccountSku,
    reportedSales: context.reportedSales, reportedSalesBySerial: context.reportedSalesBySerial,
    accounts: context.accounts, accountCodesById: context.accountCodesById,
    ddRangeSkus: context.ddRangeSkus,
  });
  const token = hash({
    p, settings: canonicalSettings, scopeRowIndices,
    imports: context.tokenImports, approved: context.approved, results,
  });
  return { results, token, p, settings: canonicalSettings, accounts: context.accounts, parts: context.parts };
}

export async function calculateDraft(c: Client, settings: ScanbackVerificationInput, scopeRowIndices?: number[]) {
  const context = await loadVerificationContext(c);
  return verifyWithContext(context, settings, scopeRowIndices);
}

export async function generateAutomaticClaimDrafts(
  c: Client,
  report: ScanbackImport,
  loadedContext?: ScanbackVerificationData,
): Promise<ScanbackDraft[]> {
  if (report.kind !== "claim" || report.state !== "committed") return [];
  const context = loadedContext ?? await loadVerificationContext(c);
  const resolvedRows = resolveMissingClaimSkus(report.rows, report.accountId, context.invoiceSkuIndex);
  const { groups, unmatched } = splitResolvedClaimRowsByPromotion(resolvedRows, report.accountId, context.programs);

  report.warnings = (report.warnings ?? []).filter(warning => !warning.startsWith("Automatic promotion matching:"));
  if (unmatched.length) {
    report.warnings.push(
      `Automatic promotion matching: ${unmatched.length} row(s) could not be assigned to exactly one active customer promotion. Use Verify Claims override to review them.`,
    );
  }

  const drafts: ScanbackDraft[] = [];
  for (const group of groups) {
    const settings: ScanbackVerificationInput = {
      programId: group.program.id, accountId: group.accountId, claimImportId: report.id,
      basis: "sell", from: group.program.start, to: group.program.end,
      selectedRows: group.rowIndices,
    };
    const autoKey = `${report.id}|${group.program.id}|${group.accountId}`;
    const existing = context.draftsByAutoKey.get(autoKey);
    if (existing && context.approvedDraftIds.has(existing.id)) continue;

    const previousSelection = existing?.settings?.selectedRows;
    const selectedRows = Array.isArray(previousSelection)
      ? previousSelection.filter(index => group.rowIndices.includes(index))
      : group.rowIndices;
    const selectedCalculation = verifyWithContext(context, { ...settings, selectedRows }, group.rowIndices);
    const id = existing?.id ?? randomUUID();
    const draft: ScanbackDraft = {
      id, settings: selectedCalculation.settings, results: selectedCalculation.results, token: selectedCalculation.token,
      createdAt: new Date().toISOString(), totalCents: total(selectedCalculation.results),
      autoGenerated: true, scopeRowIndices: group.rowIndices,
    };
    const snapshot = {
      ...draft, autoKey, programName: group.program.name,
      accountCode: selectedCalculation.accounts.find(account => account.id === group.accountId)?.code,
    };
    await c.query(
      `INSERT INTO scanback_drafts(id,payload) VALUES($1,$2::jsonb)
       ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`,
      [id, JSON.stringify(snapshot)],
    );
    drafts.push(draft);
  }

  await put(c, "scanback_imports", report.id, report);
  return drafts;
}

export async function refreshAutomaticClaimDrafts(c: Client) {
  const context = await loadVerificationContext(c);
  const importIds = new Set(context.autoDrafts.map(draft => draft.settings.claimImportId));
  const claims = [...importIds]
    .map(id => context.importsById.get(id))
    .filter((report): report is ScanbackImport => !!report && report.kind === "claim" && report.state === "committed");
  for (const claim of claims) await generateAutomaticClaimDrafts(c, claim, context);
}
export function total(results: ScanbackResult[]) {
  const sum = results.filter(r => r.include && r.status === "eligible").reduce((sum, r) => sum + r.amountCents, 0);
  requireThat(Number.isSafeInteger(sum) && sum <= 2_000_000_000, "Batch total exceeds the supported limit; split the claim.");
  return sum;
}
export async function recordApprovedSerials(
  c: Client, batch: ScanbackBatch, accountId: number, parts: CatalogPart[], programId: string | null,
) {
  for (const row of batch.rows.filter(r => r.include)) {
    const part = parts.find(p => p.code.toUpperCase() === row.sku);
    requireThat(row.sku.trim().length > 0, "Stock Code is missing; re-verify.");
    await c.query(`INSERT INTO scanback_approved_serials(serial,batch_id,program_id,account_id,part_id,sku,amount_cents)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.serial, batch.id, programId, accountId, part?.id ?? null, row.sku, row.amountCents]);
  }
}
export function statementRows(batch: ScanbackBatch | ScanbackDraft): (string | number)[][] {
  const isBatch = "reference" in batch;
  const metadata = batch as typeof batch & { programName?: string; accountCode?: string };
  const title = isBatch ? "APPROVED CLAIM — NOT A PAYMENT CONFIRMATION" : "DRAFT — NOT APPROVED";
  const results = isBatch ? batch.rows : batch.results;
  return [
    [title], ["Reference", isBatch ? batch.reference : batch.id],
    ["Promotion", isBatch ? batch.programName : metadata.programName ?? batch.settings.programId],
    ["Account", isBatch ? batch.accountCode : metadata.accountCode ?? batch.settings.accountId],
    ["Eligibility basis", isBatch ? batch.basis : batch.settings.basis],
    ["From", isBatch ? batch.from : batch.settings.from],
    ["To", isBatch ? batch.to : batch.settings.to],
    ["Saved at", batch.createdAt],
    ["Claim total (ex GST)", batch.totalCents / 100],
    [],
    ["Serial", "Stock Code", "Sell date", "Invoice", "Invoice date", "Invoiced unit price (ex GST)", "GTM Buy Ex", "Claim (ex GST)", "Status", "Reason", "Included", "Source evidence"],
    ...results.map(r => [r.serial, r.sku, r.date, r.invoice, r.invoiceDate, r.unitPriceCents == null ? "" : r.unitPriceCents / 100,
      r.gtmBuyCents == null ? "" : r.gtmBuyCents / 100, r.include ? r.amountCents / 100 : 0, r.status, r.reason, r.include ? "Yes" : "No", r.source]),
  ].map((row, index) => row.map((value, column) =>
    typeof value === "string" && (index < 11 || (column !== 0 && column !== 1))
      ? maskCustomerText(value) : value));
}
