import { pool, type PoolClient } from "@workspace/db";
import { createHash, randomUUID } from "node:crypto";
import type {
  ScanbackProgram, ScanbackImport, ScanbackDraft, ScanbackVerificationInput,
  ScanbackResult, ScanbackBatch,
} from "@workspace/api-zod";
import { verifyClaim, evidenceKey, cents, type EvidenceRow, type ApprovedSerial, type CatalogPart } from "./scanback-engine";
import { resolveMissingClaimSkus, splitClaimRowsByPromotion } from "./scanback-auto-drafts";
import { mapImport, parseDate, prontoRangeCovers, type Sheets, type Account } from "./scanback-import";
import { indexProntoSource, pendingProntoCredits, prontoCreditIdentity, type ProntoCreditReport } from "./scanback-pronto";
import { maskCustomerText } from "./customer-display";
import { loadReportedSales, firstReportedSales, earlierReportReason, isSameCustomerReportRepeat } from "./serial-tracking";

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
    const seen = new Set<string>();
    let blockedRepeats = 0, sameCustomerRepeats = 0;
    value.rows = value.rows.map(row => {
      const claimed = approved.get(row.serial);
      const reason = claimed ? `Already approved in batch ${claimed.batchId}${claimed.programName ? `, promotion ${claimed.programName}` : ""}` :
        (seen.has(row.serial) ? "Duplicate serial in this customer report" :
          earlierReportReason(first.get(row.serial), base.id, row.rowIndex, row.accountId ?? base.accountId));
      seen.add(row.serial);
      if (reason) {
        if (isSameCustomerReportRepeat(reason)) sameCustomerRepeats++;
        else blockedRepeats++;
        if (blockedRepeats + sameCustomerRepeats <= 20) value.warnings.push(`${row.serial}: ${reason}`);
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
export async function calculateDraft(c: Client, settings: ScanbackVerificationInput, scopeRowIndices?: number[]) {
  const p = await get<ScanbackProgram>(c, "scanback_programs", settings.programId);
  requireThat(!p.archived, "This promotion is archived.");
  requireThat(p.customerIds.includes(settings.accountId), "Choose an eligible Account Code.");
  const canonicalSettings: ScanbackVerificationInput = {
    ...settings, basis: "sell", from: p.start, to: p.end,
  };
  const claim = await get<ScanbackImport>(c, "scanback_imports", settings.claimImportId);
  requireThat(claim.state === "committed" && claim.kind === "claim", "Choose a committed customer claim import.");
  type IndexedImport = ScanbackImport & {
    prontoCreditRows?: Record<string, unknown>[];
    prontoRestrictedSerials?: string[];
  };
  const imports = (await c.query(`SELECT payload FROM scanback_imports
    WHERE payload->>'kind'='evidence' AND payload->>'state' IN ('committed','superseded')
      AND jsonb_array_length(COALESCE(payload->'rows','[]'::jsonb)) > 0`))
    .rows.map(r => r.payload as ScanbackImport);
  const evidence: EvidenceRow[] = imports.flatMap(i =>
    i.rows.map(r => ({ ...r, source: `${i.name} [${i.id}], ${i.sheet}, row ${r.sourceRow ?? r.rowIndex + 2}` })));
  const claimRows = resolveMissingClaimSkus(claim.rows, claim.accountId,
    imports.filter(i => !!i.pronto).flatMap(i => i.rows));
  const approved = await ledger(c);
  const cat = await catalog(c);
  const programs = await all<ScanbackProgram>(c, "scanback_programs");
  const ddRangeSkus = new Set([
    ...imports.flatMap(i => i.rows.map(row => row.sku.trim().toUpperCase()).filter(Boolean)),
    ...programs.flatMap(program => program.lines.map(line => (line.sku ?? cat.parts.find(part => part.id === line.partId)?.code ?? "").trim().toUpperCase()).filter(Boolean)),
  ]);
  // Excluded accounts/SKUs never become payable evidence. Their overlapping
  // serials still block automatic approval: scoping must not hide a subsequent
  // transfer/return, including when it arrived in a different committed extract.
  const restrictedSerials = new Set<string>();
  const prontoReports: ProntoCreditReport[] = [];
  const sourceRows = await c.query(`SELECT id,
      CASE WHEN payload ? 'prontoCreditRows' THEN payload - 'rows' ELSE payload END AS payload,
      CASE WHEN payload ? 'prontoCreditRows' AND payload ? 'prontoRestrictedSerials' THEN NULL ELSE raw_sheets END AS raw_sheets
    FROM scanback_imports
    WHERE payload->>'kind'='evidence' AND payload->>'state' IN ('committed','superseded') AND payload ? 'pronto'`);
  if (sourceRows.rowCount) {
    const legacyIndexes = new Map<string, { creditRows: Record<string, unknown>[]; restrictedSerials: string[] }>();
    const legacyIds = sourceRows.rows.filter(source => !(source.payload as IndexedImport).prontoCreditRows ||
      !(source.payload as IndexedImport).prontoRestrictedSerials).map(source => source.id);
    for (const source of sourceRows.rows) {
      if (!legacyIds.includes(source.id)) continue;
      const imp = source.payload as ScanbackImport;
      const raw = source.raw_sheets as Sheets;
      legacyIndexes.set(source.id, indexProntoSource(raw?.[imp.sheet] ?? [], imp.prontoAccounts ?? {}));
    }
    for (const source of sourceRows.rows) {
      const imp = source.payload as IndexedImport;
      const index = legacyIndexes.get(source.id);
      const rows = imp.prontoCreditRows ?? index?.creditRows ?? [];
      prontoReports.push({ id: imp.id, createdAt: imp.createdAt, committedAt: imp.committedAt,
        prontoAccounts: imp.prontoAccounts, prontoCreditResolutions: imp.prontoCreditResolutions,
        dateFormat: imp.dateFormat, rows });
      for (const serial of imp.prontoRestrictedSerials ?? index?.restrictedSerials ?? []) restrictedSerials.add(serial);
    }
  }
  const unmatchedProntoCredits = pendingProntoCredits(prontoReports).map(credit => ({
    ...credit, date: parseDate(credit.date, "dmy") || credit.date,
  }));
  const appliedResolutionKeys = new Set<string>();
  for (const report of prontoReports) {
    const imp = sourceRows.rows.find(item => item.id === report.id)?.payload as IndexedImport | undefined;
    if (!imp) continue;
    for (const resolution of imp.prontoCreditResolutions ?? []) {
      if (resolution.mode !== "serials") continue;
      const row = report.rows.find(item => Number(item.sourceRow) === resolution.sourceRow) ??
        report.rows[resolution.sourceRow - 2];
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
      for (const serial of resolution.serials) evidence.push({
        rowIndex: resolution.sourceRow - 2, serial, sku, date, accountId, quantity: -1,
        invoice, unitPriceCents: price == null ? null : Math.abs(price), costCents: null,
        amountCents: null, program: "", reference: "", source: `Resolved Pronto credit ${invoice} [${imp.id}], row ${resolution.sourceRow}`,
      });
    }
  }
  const reportedSales = await loadReportedSales(c);
  const scopedIndices = scopeRowIndices ? new Set(scopeRowIndices) : null;
  const scopedClaims = scopedIndices ? claimRows.filter(row => scopedIndices.has(row.rowIndex)) : claimRows;
  const results = verifyClaim({ program: p, settings: canonicalSettings, claims: scopedClaims, evidence, approved, parts: cat.parts,
    restrictedSerials, unmatchedProntoCredits, reportedSales, accounts: cat.accounts, ddRangeSkus });
  const token = hash({
    p, settings: canonicalSettings, scopeRowIndices,
    imports: imports.map(i => ({ id: i.id, state: i.state, events: i.rows.map(evidenceKey) }))
      .concat(sourceRows.rows.map(source => {
        const imp = source.payload as IndexedImport;
        return { id: imp.id, state: imp.state, events: [], prontoCreditResolutions: imp.prontoCreditResolutions ?? [] };
      })).sort((a, b) => a.id.localeCompare(b.id)),
    approved, results,
  });
  return { results, token, p, settings: canonicalSettings, accounts: cat.accounts, parts: cat.parts };
}

export async function generateAutomaticClaimDrafts(c: Client, report: ScanbackImport): Promise<ScanbackDraft[]> {
  if (report.kind !== "claim" || report.state !== "committed") return [];
  const programs = await all<ScanbackProgram>(c, "scanback_programs");
  const prontoImports = (await c.query(`SELECT payload FROM scanback_imports
    WHERE payload->>'kind'='evidence' AND payload->>'state' IN ('committed','superseded')
      AND payload ? 'pronto'
      AND jsonb_array_length(COALESCE(payload->'rows','[]'::jsonb)) > 0`))
    .rows.map(row => row.payload as ScanbackImport);
  const prontoInvoiceRows = prontoImports.flatMap(invoice => invoice.rows);
  const { groups, unmatched } = splitClaimRowsByPromotion(report.rows, report.accountId, programs, prontoInvoiceRows);

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
    const existing = (await c.query(
      "SELECT id,payload FROM scanback_drafts WHERE payload->>'autoKey'=$1 LIMIT 1", [autoKey],
    )).rows[0];
    if (existing && (await c.query("SELECT 1 FROM scanback_batches WHERE draft_id=$1", [existing.id])).rowCount) continue;

    const previousSelection = (existing?.payload as ScanbackDraft | undefined)?.settings?.selectedRows;
    const selectedRows = Array.isArray(previousSelection)
      ? previousSelection.filter(index => group.rowIndices.includes(index))
      : group.rowIndices;
    const selectedCalculation = await calculateDraft(c, { ...settings, selectedRows }, group.rowIndices);
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
  const existing = await c.query(
    "SELECT DISTINCT payload->'settings'->>'claimImportId' AS import_id FROM scanback_drafts WHERE payload->>'autoGenerated'='true'",
  );
  const importIds = new Set(existing.rows.map(row => String(row.import_id ?? "")));
  const claims = (await all<ScanbackImport>(c, "scanback_imports"))
    .filter(report => importIds.has(report.id) && report.kind === "claim" && report.state === "committed");
  for (const claim of claims) await generateAutomaticClaimDrafts(c, claim);
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
