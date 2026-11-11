import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { randomUUID, createHash } from "node:crypto";
import type { CenterUpload, ScanbackImport, CenterUploadCorrection } from "@workspace/api-zod";
import { CorrectCenterUploadBody } from "@workspace/api-zod";
import {
  hashBuffer, detectWeekFromFilename, detectResellerFromFilename,
  isValidWeekIso, dateStringToWeekIso, applyMappingsToRows, type MappingField,
} from "../lib/parser";
import { parseFile } from "../lib/file-parser";
import { parseDate, parseSheets, suggestMapping, type Sheets } from "../lib/scanback-import";
import { parseCsvSheets, filterFullHistorySerialRows } from "../lib/scanback-import";
import {
  isCompletedWeekAsOf, isWeekOutsideWindow, mostCommonWeek, previousCompletedWeekIso,
  resolveWeekFromFilename, resolveWeekFromReportDates, weekEndingShortLabel,
} from "../lib/dates";
import { serialKey } from "../lib/scanback-engine";
import { loadReportedSales, reportedSales, firstReportedSales, earlierReportReason, type ReportedSale } from "../lib/serial-tracking";
import { indexProntoSource, isPronto, pendingProntoCredits } from "../lib/scanback-pronto";
import { transaction, catalog, rebuildImport, requireThat, ScanbackError, type Client } from "../lib/scanback-store";
import { detectCenterKind, readCenterWorkbook, readCenterCsv, sheetsBuffer, referenceMapping, parseReference, type CenterKind } from "../lib/center-parser";
import { aiAssistEnabled, suggestFileType, suggestRecognition } from "../lib/upload-ai";
import type { AiNote } from "../lib/upload-review";
import { UploadCommitConflict, commitSohUpload } from "../lib/soh-upload-commit";
import { CommitCenterUploadBody } from "@workspace/api-zod";

const router = Router();
// The UI batches an arbitrary selection into requests. Bound each request's
// memory without imposing a total file-count limit on the user.
const intake = multer({ storage: multer.memoryStorage(), limits: { files: 20, fileSize: 50 * 1024 * 1024 } });
const emptySummary = (): CenterUpload["summary"] => ({
  skuCount: 0, soh: 0, unitsSold: 0, serialCount: 0, from: "", to: "", ddRangeCount: 0, invoicedCount: 0,
  nonSerialCount: 0, nonSerialIdentifiers: [], historyRowsSkipped: 0, missingSerialCount: 0,
});
const wrap = (fn: (c: Client, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { res.json(await transaction(c => fn(c, req))); }
  catch (e) {
    if (e instanceof UploadCommitConflict) res.status(409).json({
      error: "conflict",
      message: `This would overwrite ${e.existingCount} existing snapshots. Confirm to proceed.`,
      existing_count: e.existingCount,
      part_count: e.partCount,
    });
    else if (e instanceof ScanbackError) res.status(e.status).json({ error: e.message });
    else {
      req.log.error({ err: e }, "Upload Center operation failed");
      res.status(500).json({ error: "Could not complete the upload operation. Nothing was committed." });
    }
  }
};
async function profiles(c: Client) {
  return (await c.query("SELECT id,name,code,aliases,filename_patterns AS \"filenamePatterns\" FROM resellers ORDER BY code")).rows;
}
function unfinishedManualWeekMessage(weekIso: string, now = new Date()): string {
  const latest = previousCompletedWeekIso(now);
  return `Manual week ${weekIso} has not ended in Australia/Sydney. Choose a completed week (latest: ${latest}, w/e ${weekEndingShortLabel(latest)}).`;
}
async function validateMeta(c: Client, options: CenterUploadCorrection) {
  requireThat(options.weekIso == null || isValidWeekIso(options.weekIso), "Choose a valid reporting week.");
  requireThat(options.weekIso == null || isCompletedWeekAsOf(options.weekIso),
    options.weekIso ? unfinishedManualWeekMessage(options.weekIso) : "Choose a completed reporting week.");
  if (options.accountId != null)
    requireThat(Number.isSafeInteger(options.accountId) &&
      (await c.query("SELECT id FROM resellers WHERE id=$1", [options.accountId])).rowCount, "Choose an existing customer.");
}
async function createSource(c: Client, entry: CenterUpload, raw: Sheets, buffer?: Buffer, allowAi = false) {
  const data = buffer ?? sheetsBuffer(raw);
  const sourceRows = raw[Object.keys(raw)[0]] ?? [];
  entry.headers = Object.keys(sourceRows[0] ?? {});
  entry.preview = sourceRows.slice(0, 8);
  entry.rowCount = sourceRows.length;
  entry.errors = [];
  if (entry.kind === "soh") {
    const accounts = await profiles(c);
    let result = await parseFile(data, buffer ? entry.name : "review.xlsx", accounts);
    let ai: AiNote | undefined;
    const originalWeek = result.detectedWeekIso;
    // Explicit intake/card choices resolve metadata before considering AI.
    if (entry.weekIso) result = { ...result, detectedWeekIso: entry.weekIso };
    if (entry.accountId != null) result = { ...result, detectedResellerId: entry.accountId,
      detectedResellerName: accounts.find(a => a.id === entry.accountId)?.name ?? null };
    if (allowAi) {
      const suggestion = await suggestRecognition(result, entry.name, accounts);
      result = suggestion.result; ai = suggestion.note;
      if (result.detectedWeekIso && result.detectedWeekIso !== originalWeek) entry.weekSource = "ai_suggested";
    }
    const accountId = entry.accountId ?? result.detectedResellerId;
    const week = entry.weekIso ?? result.detectedWeekIso;
    const key = hashBuffer(data);
    const duplicate = await c.query("SELECT id FROM uploads WHERE file_hash=$1 AND status='committed'", [key]);
    requireThat(!duplicate.rowCount, "This SOH file is already committed. Open its existing history entry.", 409);
    const saved = accountId ? await c.query("SELECT mapping FROM column_mappings WHERE reseller_id=$1 AND fingerprint=$2",
      [accountId, result.headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, "")).sort().join("|")]) : null;
    const mappings = saved?.rows[0]?.mapping ?? result.mappings;
    const inserted = await c.query(`INSERT INTO uploads
      (reseller_id,filename,file_hash,report_date,week_iso,status,parser_used,confidence,rows_parsed,rows_flagged,raw_headers,raw_rows,detected_mappings,recognition)
      VALUES($1,$2,$3,$4,$5,'review',$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb) RETURNING id`, [
      accountId, entry.name, key, result.detectedReportDate, week, result.parserUsed,
      result.overallConfidence, result.rowsParsed, result.rowsFlagged, JSON.stringify(result.headers),
      JSON.stringify(result.rawRows), JSON.stringify(mappings),
      JSON.stringify({ version: 1, sheetName: result.sheetName,
        weekSource: entry.weekSource === "manual" ? "manual" : entry.weekSource === "ai_suggested" ? "ai_suggested" : result.detectedWeekIso ? "filename" : null,
        confirmedWeek: entry.weekSource === "manual" ? entry.weekIso : null,
        confirmedResellerId: entry.weekSource === "manual" ? entry.accountId : null, ai,
        candidates: result.detectedCandidates.map(candidate => ({ id: candidate.id, name: candidate.name, code: candidate.code })),
        detectedFormatId: result.detectedFormatId, detectionReasoning: result.detectionReasoning,
        ...(ai?.status === "suggested" && !originalWeek && !entry.weekIso ? { weekSource: "ai_suggested" } : {}) }),
    ]);
    entry.sourceId = String(inserted.rows[0].id);
    entry.accountId = accountId; entry.weekIso = week;
  } else if (["claim", "history", "evidence"].includes(entry.kind)) {
    // Reuse the strict existing financial parser (including Pronto redaction,
    // native account scoping, credits and original-price validation).
    requireThat(entry.kind !== "history", "Historical approved claims can no longer be uploaded. Existing history remains readable.", 400);
    let financial = /\.csv$/i.test(entry.name) ? await parseCsvSheets(data) : parseSheets(data);
    const sheet = Object.keys(financial)[0];
    let sourceRows = financial[sheet] ?? [];
    const headers = Object.keys(sourceRows[0] ?? {}).filter(h => h !== "__sourceRow");
    const mapping = suggestMapping(headers);
    if (entry.kind === "claim") {
      const known = (await loadReportedSales(c)).map(row => row.serial);
      const filenameWeek = detectWeekFromFilename(entry.name).weekIso;
      const targetWeek = entry.weekSource === "manual" ? entry.weekIso : entry.weekIso ?? filenameWeek;
      const filtered = filterFullHistorySerialRows(sourceRows, mapping, known, targetWeek);
      sourceRows = filtered.rows;
      financial[sheet] = sourceRows;
      if (entry.weekSource !== "manual" && filtered.weekIso) {
        entry.weekIso = filtered.weekIso;
        entry.weekSource = filtered.isFullHistory && filenameWeek ? "filename" : "file_dates";
      }
      entry.summary.historyRowsSkipped = filtered.historicalRowsSkipped;
      if (filtered.historicalRowsSkipped)
        entry.warnings = [...(entry.warnings ?? []), `${filtered.historicalRowsSkipped.toLocaleString()} historical rows skipped.`];
    }
    const key = createHash("sha256").update(entry.kind).update(data).digest("hex");
    const duplicate = await c.query("SELECT payload FROM scanback_imports WHERE content_key=$1", [key]);
    requireThat(!duplicate.rowCount, "This financial file is already in Upload Center. Open its existing history entry.", 409);
    const base: ScanbackImport = {
      id: randomUUID(), kind: entry.kind as ScanbackImport["kind"], name: entry.name, state: "preview",
      createdAt: entry.createdAt, sheets: Object.keys(financial), sheet, headers,
      mapping, dateFormat: "dmy", accountId: isPronto(headers) ? null : entry.accountId,
      rows: [], errors: [], warnings: [], duplicate: false, recordCount: 0,
    };
    const value = await rebuildImport(c, base, financial, base);
    await c.query("INSERT INTO scanback_imports(id,content_key,raw_sheets,payload) VALUES($1,$2,$3::jsonb,$4::jsonb)",
      [value.id, key, JSON.stringify(financial), JSON.stringify(value)]);
    entry.sourceId = value.id;
    // Never retain unrelated Pronto PII in the unified registry.
    raw = financial;
  } else if (entry.kind === "price" || entry.kind === "program") {
    entry.mapping = Object.keys(entry.mapping).length ? entry.mapping : referenceMapping(entry.headers);
    const parsed = parseReference(entry.kind, sourceRows, entry.mapping);
    entry.errors = parsed.errors;
    entry.summary.skuCount = new Set(parsed.rows.map(r => r.sku)).size;
  } else {
    entry.errors = ["Type could not be determined. Choose a spreadsheet type and confirm its metadata."];
    if (allowAi) entry.errors.push(await suggestFileType(entry.headers, Object.keys(raw)[0], entry.name));
  }
  return raw;
}
async function save(c: Client, entry: CenterUpload, raw: Sheets) {
  await c.query(`INSERT INTO center_uploads(id,payload,raw_sheets) VALUES($1,$2::jsonb,$3::jsonb)
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,raw_sheets=EXCLUDED.raw_sheets`,
  [entry.id, JSON.stringify(entry), JSON.stringify(raw)]);
}
type Source = { entry: CenterUpload; raw: Sheets; registered: boolean };
async function load(c: Client, id: string): Promise<Source> {
  const registry = await c.query("SELECT payload,raw_sheets FROM center_uploads WHERE id=$1 FOR UPDATE", [id]);
  if (registry.rowCount) {
    const entry = registry.rows[0].payload as CenterUpload;
    await hydrate(c, entry);
    return { entry, raw: registry.rows[0].raw_sheets, registered: true };
  }
  const entry = (await workspace(c)).uploads.find(e => e.id === id);
  requireThat(entry, "Upload not found.", 404);
  if (entry.kind === "soh") {
    const row = (await c.query("SELECT raw_rows,recognition FROM uploads WHERE id=$1 FOR UPDATE", [entry.sourceId])).rows[0];
    requireThat(row, "Source no longer exists.", 404);
    return { entry, raw: { [row.recognition?.sheetName ?? "Report"]: row.raw_rows ?? [] }, registered: false };
  }
  const row = (await c.query("SELECT raw_sheets FROM scanback_imports WHERE id=$1 FOR UPDATE", [entry.sourceId])).rows[0];
  requireThat(row, "Source no longer exists.", 404);
  return { entry, raw: row.raw_sheets, registered: false };
}
async function hydrate(c: Client, e: CenterUpload, cachedEvidence?: ScanbackImport[], cachedSales?: ReportedSale[]) {
  if (e.kind === "soh" && e.sourceId) {
    const r = (await c.query("SELECT * FROM uploads WHERE id=$1", [e.sourceId])).rows[0];
    if (!r) return;
    e.accountId = r.reseller_id; e.weekIso = r.week_iso;
    e.weekSource = e.weekSource ?? r.recognition?.weekSource ?? (r.week_iso ? "filename" : "unknown");
    e.state = r.status === "committed" ? "committed" : "preview";
    const rows = applyMappingsToRows(r.raw_rows ?? [], (r.detected_mappings ?? []) as MappingField[]);
    e.rowCount = r.rows_parsed ?? rows.length;
    e.summary = { ...emptySummary(), skuCount: new Set(rows.map(x => x.part_no).filter(Boolean)).size,
      soh: rows.reduce((s, x) => s + x.soh, 0), unitsSold: rows.reduce((s, x) => s + x.sell_through_7d, 0) };
    e.headers = r.raw_headers ?? [];
    e.preview = (r.raw_rows ?? []).slice(0, 8);
    const mappings = Array.isArray(r.detected_mappings) ? r.detected_mappings as MappingField[] : [];
    const readyToCommit = !!r.reseller_id && !!r.week_iso &&
      mappings.some(mapping => mapping.canonical_field === "part_no") &&
      mappings.some(mapping => mapping.canonical_field === "soh");
    e.sohReview = {
      upload_id: Number(r.id), filename: r.filename, status: r.status,
      detected_reseller_id: r.reseller_id, detected_reseller_name: null,
      detected_week_iso: r.week_iso, detected_report_date: r.report_date,
      confidence: Number(r.confidence ?? 0), rows_parsed: r.rows_parsed ?? rows.length,
      rows_flagged: r.rows_flagged ?? rows.filter(row => row.flagged).length,
      mappings, preview_rows: (r.raw_rows ?? []).slice(0, 8),
      raw_headers: r.raw_headers ?? [], week_not_detected: !r.week_iso,
      candidates: r.recognition?.candidates ?? [],
      detected_format_id: r.recognition?.detectedFormatId ?? null,
      detection_reasoning: r.recognition?.detectionReasoning ?? null,
      diagnostics: {
        review_reasons: [], ready_to_commit: readyToCommit, auto_eligible: false,
        week_source: e.weekSource ?? "unknown",
        metadata_missing: !r.reseller_id || !r.week_iso,
      },
    };
  } else if (e.sourceId && ["claim", "evidence", "history"].includes(e.kind)) {
    const r = (await c.query("SELECT payload FROM scanback_imports WHERE id=$1", [e.sourceId])).rows[0]?.payload as ScanbackImport | undefined;
    if (!r) return;
    e.state = r.state;
    e.rowCount = new Set(r.rows.map(row => row.sourceRow ?? row.rowIndex)).size;
    e.headers = r.headers;
    e.mapping = r.mapping; e.errors = r.errors.slice(0, 200).map(x => `Row ${x.row}: ${x.message}`);
    e.warnings = [...new Set([...(e.warnings ?? []), ...r.warnings])];
    // Original raw sample fields stay internal; mapped financial samples are
    // exposed through the existing redacted import preview endpoint.
    e.preview = r.rows.slice(0, 8).map(x => ({ serial: x.serial, sku: x.sku, date: x.date }));
    const accountIds = [...new Set(r.rows.map(x => x.accountId).filter(x => x != null))];
    e.accountId = r.accountId ?? (accountIds.length === 1 ? accountIds[0]! : e.accountId);
    const dates = r.rows.map(x => x.date).filter(Boolean).sort();
    if (e.kind === "claim" && e.weekSource !== "manual" && dates.length) {
      const detected = mostCommonWeek(dates);
      if (detected.weekIso) {
        const resolved = resolveWeekFromReportDates(detected.weekIso, detected.reportDate, new Date());
        e.weekIso = resolved.weekIso;
        e.weekSource = "file_dates";
        if (resolved.warning) e.warnings = [...(e.warnings ?? []), resolved.warning];
      }
    } else if (!e.weekIso && dates.length) {
      const detected = mostCommonWeek(dates);
      if (detected.weekIso) {
        const resolved = resolveWeekFromReportDates(detected.weekIso, detected.reportDate, new Date());
        e.weekIso = resolved.weekIso;
        e.weekSource = "file_dates";
        if (resolved.warning) e.warnings = [...(e.warnings ?? []), resolved.warning];
      }
    }
    e.summary = { ...emptySummary(), serialCount: new Set(r.rows.map(x => x.serial)).size,
      skuCount: new Set(r.rows.map(x => x.sku).filter(Boolean)).size, from: dates[0] ?? "", to: dates.at(-1) ?? "",
      nonSerialCount: Number(r.nonSerialCount ?? 0),
      nonSerialIdentifiers: Array.isArray(r.nonSerialIdentifiers) ? r.nonSerialIdentifiers : [],
      missingSerialCount: Number(r.missingSerialCount ?? 0),
      historyRowsSkipped: e.summary.historyRowsSkipped ?? 0 };
    if (e.kind === "claim") {
      const first = firstReportedSales(cachedSales ?? await loadReportedSales(c));
        const repeated = r.rows.filter(row =>
          earlierReportReason(first.get(row.serial), r.id, row.rowIndex, row.accountId ?? r.accountId));
      const reusedRows = new Set(repeated.map(row => row.rowIndex));
      e.summary.serialCount = new Set(r.rows.filter(row => !reusedRows.has(row.rowIndex)).map(row => row.serial)).size;
      const evidence = cachedEvidence ?? (await c.query("SELECT payload FROM scanback_imports WHERE payload->>'kind'='evidence' AND payload->>'state'='committed'")).rows.map(x => x.payload as ScanbackImport);
      const bySerial = new Map<string, ScanbackImport["rows"]>();
      for (const imp of evidence) for (const row of imp.rows)
        bySerial.set(row.serial, [...(bySerial.get(row.serial) ?? []), row]);
      for (const serial of new Set(r.rows.filter(row => !reusedRows.has(row.rowIndex)).map(x => serialKey(x.serial)))) {
        const events = bySerial.get(serial);
        if (!events) continue;
        e.summary.ddRangeCount++;
        const positives = events.filter(x => x.quantity > 0);
        if (positives.length && positives.every(x => x.accountId === e.accountId) &&
            !events.some(x => x.quantity < 0)) e.summary.invoicedCount++;
      }
    }
  }
  e.warnings = (e.warnings ?? []).filter(w =>
    !w.startsWith("Detected report week is more than 8 weeks") &&
    !w.startsWith("This upload is filed in an unfinished week") &&
    !w.startsWith("Manual week "),
  );
  if (e.weekIso && !isCompletedWeekAsOf(e.weekIso)) {
    e.warnings.push(e.weekSource === "manual"
      ? unfinishedManualWeekMessage(e.weekIso)
      : `This upload is filed in an unfinished week (${e.weekIso}). Review and correct it before committing.`);
  }
  if (e.weekIso && isWeekOutsideWindow(e.weekIso))
    e.warnings.push("Detected report week is more than 8 weeks from today. Confirm the reporting period before committing.");
  return e;
}
async function workspace(c: Client) {
  const entries: CenterUpload[] = (await c.query("SELECT payload FROM center_uploads ORDER BY created_at DESC")).rows.map(r => r.payload);
  const sources = new Set(entries.filter(e => e.sourceId).map(e => `${e.kind === "soh" ? "soh" : "scan"}:${e.sourceId}`));
  const oldSoh = (await c.query("SELECT id,filename,uploaded_at FROM uploads ORDER BY uploaded_at DESC")).rows;
  const oldScan = (await c.query("SELECT id,payload FROM scanback_imports ORDER BY created_at DESC")).rows;
  const base = (id: string, kind: CenterKind, name: string, sourceId: string, createdAt: string): CenterUpload => ({
    id, kind, name, sourceId, createdAt, accountId: null, weekIso: null, state: "preview", rowCount: 0,
    summary: emptySummary(), headers: [], mapping: {}, preview: [], errors: [],
  });
  for (const r of oldSoh) if (!sources.has(`soh:${r.id}`))
    entries.push(base(`soh:${r.id}`, "soh", r.filename, String(r.id), r.uploaded_at.toISOString()));
  for (const { id, payload: r } of oldScan) if (!sources.has(`scan:${id}`))
    entries.push(base(`scan:${id}`, r.kind, r.name, id, r.createdAt));
  const evidence = oldScan.map(x => x.payload as ScanbackImport).filter(x => x.kind === "evidence" && x.state === "committed");
  const sales = reportedSales(oldScan.map(x => x.payload as ScanbackImport));
  for (const e of entries) await hydrate(c, e, evidence, sales);
  const prontoSources = await c.query(`SELECT id,
      CASE WHEN payload ? 'prontoCreditRows' THEN payload - 'rows' ELSE payload END AS payload,
      CASE WHEN payload ? 'prontoCreditRows' THEN NULL ELSE raw_sheets END AS raw_sheets
    FROM scanback_imports
    WHERE payload->>'kind'='evidence' AND payload->>'state' IN ('committed','superseded') AND payload ? 'pronto'`);
  const unmatchedCredits = pendingProntoCredits(prontoSources.rows.map(source => {
    const imp = source.payload as ScanbackImport & { prontoCreditRows?: Record<string, unknown>[] };
    const raw = source.raw_sheets as Sheets | null;
    return {
      id: imp.id, createdAt: imp.createdAt, committedAt: imp.committedAt,
      prontoAccounts: imp.prontoAccounts, prontoCreditResolutions: imp.prontoCreditResolutions,
      dateFormat: imp.dateFormat,
      rows: imp.prontoCreditRows ?? indexProntoSource(raw?.[imp.sheet] ?? [], imp.prontoAccounts ?? {}).creditRows,
    };
  })).map(credit => ({
    id: credit.id, importId: credit.importId, sourceRow: credit.sourceRow,
    accountId: credit.accountId, accountCode: credit.accountCode, sku: credit.sku,
    invoice: credit.invoice, date: parseDate(credit.date, "dmy") || credit.date, quantity: credit.quantity,
  }));
  const prices = (await c.query(`SELECT sku,description,rrp_inc_cents AS "rrpIncCents",dd_cost_ex_cents AS "ddCostExCents",
    t1_buy_ex_cents AS "t1BuyExCents",updated_at AS "updatedAt" FROM price_list ORDER BY sku`)).rows;
  const latestProgram = entries.filter(e => e.kind === "program" && e.state === "committed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  let programRows: Record<string, unknown>[] = [];
  if (latestProgram) {
    const raw = (await c.query("SELECT raw_sheets FROM center_uploads WHERE id=$1", [latestProgram.id])).rows[0].raw_sheets as Sheets;
    programRows = parseReference("program", Object.values(raw)[0], latestProgram.mapping).rows;
  }
  return { uploads: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), prices, programRows, unmatchedCredits };
}
router.get("/upload-center", wrap(c => workspace(c)));
router.post("/upload-center/files", intake.array("files"), async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) return res.status(400).json({ error: "Choose CSV, XLS or XLSX files." });
  const data: CenterUploadCorrection = {
    ...(req.body.kind ? { kind: req.body.kind } : {}),
    ...(req.body.accountId ? { accountId: Number(req.body.accountId) } : {}),
    ...(req.body.weekIso ? { weekIso: req.body.weekIso } : {}),
  };
  const options = CorrectCenterUploadBody.safeParse(data);
  if (!options.success) return res.status(400).json({ error: "Invalid type, reseller or reporting week." });
  const staged: CenterUpload[] = [], errors: { name: string; error: string }[] = [];
  for (const file of files) {
    try {
      const result = await transaction(async c => {
        await validateMeta(c, options.data);
        requireThat(/\.(csv|xlsx|xls)$/i.test(file.originalname), "Use CSV, XLS or XLSX.");
        const uploadedAt = new Date();
        const workbook = /\.csv$/i.test(file.originalname)
          ? { sheets: await readCenterCsv(file.buffer), programSources: {}, fileCreatedAt: null }
          : readCenterWorkbook(file.buffer);
        let raw = workbook.sheets;
        const sheets = Object.keys(raw);
        const detected = sheets.map(sheet => ({ sheet, kind: detectCenterKind(Object.keys(raw[sheet][0] ?? {}), sheet, file.originalname) }));
        const selected = detected.find(d => d.kind !== "unknown") ?? detected[0];
        const kind = options.data.kind ?? selected.kind;
        requireThat(kind !== "history", "Historical approved claims can no longer be uploaded. Existing history remains readable.", 400);
        if (["claim", "evidence"].includes(kind))
          raw = /\.csv$/i.test(file.originalname) ? await parseCsvSheets(file.buffer) : parseSheets(file.buffer);
        else raw = { [selected.sheet]: raw[selected.sheet] };
        const filenameAccount = detectResellerFromFilename(file.originalname, await profiles(c)).resellerId;
        const filenameWeek = resolveWeekFromFilename(file.originalname, workbook.fileCreatedAt, uploadedAt);
        const weekSource = options.data.weekIso != null ? "manual" : filenameWeek.weekIso ? "filename" : "unknown";
        const entry: CenterUpload = {
          id: randomUUID(), name: file.originalname, kind, sourceId: null, state: "preview", createdAt: uploadedAt.toISOString(),
          accountId: options.data.accountId ?? (kind === "soh" ? null : filenameAccount),
          weekIso: options.data.weekIso ?? filenameWeek.weekIso,
          weekSource,
          summary: emptySummary(), headers: [], mapping: {}, errors: [],
          warnings: filenameWeek.warning ? [filenameWeek.warning] : [], preview: [], rowCount: 0,
          ...(kind === "program" && workbook.programSources[selected.sheet] ? { programSource: workbook.programSources[selected.sheet] } : {}),
        };
        raw = await createSource(c, entry, raw, file.buffer, aiAssistEnabled(req.body.ai_assist));
        await hydrate(c, entry);
        await save(c, entry, raw);
        return entry;
      });
      staged.push(result);
    } catch (e) {
      req.log.warn({ err: e }, "File preview rejected");
      errors.push({ name: file.originalname, error: e instanceof Error ? e.message : "Could not read file." });
    }
  }
  return res.json({ uploads: staged, errors });
});
async function removeSource(c: Client, e: CenterUpload) {
  if (e.kind === "soh" && e.sourceId) {
    const r = await c.query("DELETE FROM uploads WHERE id=$1 RETURNING id", [e.sourceId]);
    requireThat(r.rowCount, "This source no longer exists. Refresh before deleting.", 409);
  } else if (e.sourceId && ["claim", "evidence", "history"].includes(e.kind)) {
    if (e.kind === "claim") {
      // Unapproved drafts cannot be recalculated without their source report.
      // Preserve drafts already represented by an approved, immutable batch.
      await c.query(`DELETE FROM scanback_drafts d WHERE d.payload->'settings'->>'claimImportId'=$1
        AND NOT EXISTS (SELECT 1 FROM scanback_batches b WHERE b.draft_id=d.id)`, [e.sourceId]);
    }
    const r = await c.query("DELETE FROM scanback_imports WHERE id=$1 RETURNING id", [e.sourceId]);
    requireThat(r.rowCount, "This source no longer exists. Refresh before deleting.", 409);
  } else if (e.kind === "price") {
    // price_list.upload_id references this registry row without ON DELETE
    // CASCADE; remove only current price entries still owned by this upload.
    await c.query("DELETE FROM price_list WHERE upload_id=$1", [e.id]);
  }
}
async function correctCommittedSohWeek(c: Client, req: Request, entry: CenterUpload, raw: Sheets, weekIso: string) {
  requireThat(entry.kind === "soh" && entry.state === "committed" && entry.sourceId,
    "Only committed SOH uploads can use this correction path.", 409);
  const sourceId = Number(entry.sourceId);
  const source = (await c.query(
    "SELECT id,reseller_id,week_iso,status,recognition FROM uploads WHERE id=$1 FOR UPDATE", [sourceId],
  )).rows[0];
  requireThat(source?.status === "committed" && source.week_iso, "The committed SOH source is unavailable.", 409);
  const oldWeek = String(source.week_iso);
  requireThat(oldWeek !== weekIso, "Choose a different completed week.", 400);
  const resellerId = Number(source.reseller_id);
  requireThat(Number.isSafeInteger(resellerId) && resellerId > 0, "The SOH source has no reseller.", 409);

  await c.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [resellerId, weekIso]);
  const counts = (await c.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE week_iso IS DISTINCT FROM $2)::int AS mismatched
    FROM inventory_snapshots WHERE upload_id=$1`, [sourceId, oldWeek])).rows[0];
  const snapshotCount = Number(counts?.total ?? 0);
  requireThat(snapshotCount > 0, "This committed SOH upload has no inventory snapshots to correct.", 409);
  requireThat(Number(counts.mismatched) === 0, "Its snapshots do not all match the stored report week; no data was changed.", 409);

  const collisions = Number((await c.query(`SELECT count(*)::int AS count
    FROM inventory_snapshots target
    JOIN inventory_snapshots source_rows ON source_rows.part_id=target.part_id
      AND source_rows.reseller_id=target.reseller_id
    WHERE source_rows.upload_id=$1 AND target.upload_id<>$1
      AND target.reseller_id=$2 AND target.week_iso=$3`, [sourceId, resellerId, weekIso])).rows[0]?.count ?? 0);
  requireThat(collisions === 0,
    `Cannot move this report to ${weekIso}: ${collisions} matching SKU snapshots already exist for that week. No data was changed.`, 409);

  const moved = await c.query("UPDATE inventory_snapshots SET week_iso=$2 WHERE upload_id=$1 AND week_iso=$3",
    [sourceId, weekIso, oldWeek]);
  requireThat(Number(moved.rowCount ?? 0) === snapshotCount,
    "The snapshot set changed during correction; no data was changed.", 409);

  const recognition = source.recognition && typeof source.recognition === "object"
    ? source.recognition as Record<string, unknown> : {};
  const history = Array.isArray(recognition.weekCorrections) ? recognition.weekCorrections : [];
  recognition.weekSource = "manual";
  recognition.confirmedWeek = weekIso;
  recognition.weekCorrections = [...history, {
    from: oldWeek, to: weekIso, correctedAt: new Date().toISOString(), snapshotRows: snapshotCount,
  }];
  const updated = await c.query(`UPDATE uploads SET week_iso=$2,recognition=$3::jsonb
    WHERE id=$1 AND status='committed' AND week_iso=$4 RETURNING id`,
    [sourceId, weekIso, JSON.stringify(recognition), oldWeek]);
  requireThat(updated.rowCount, "The SOH source changed during correction; no data was changed.", 409);

  entry.weekIso = weekIso;
  entry.weekSource = "manual";
  req.log.info({ sourceId, oldWeek, weekIso, snapshotRows: snapshotCount }, "Corrected committed SOH reporting week");
  await save(c, entry, raw);
  return hydrate(c, entry);
}
router.delete("/upload-center", wrap(async (c, req) => {
  const ids = req.body?.ids;
  requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 5000 &&
    ids.every((id: unknown) => typeof id === "string" && id.trim().length > 0) &&
    new Set(ids).size === ids.length, "Choose between 1 and 5,000 unique uploads to delete.");
  const entries: CenterUpload[] = [];
  for (const id of ids as string[]) {
    const { entry } = await load(c, id);
    entries.push(entry);
  }
  // Resolve every entry before removing any source. The transaction rolls
  // back the whole selection if any linked source cannot be deleted.
  for (const entry of entries) {
    await removeSource(c, entry);
    await c.query("DELETE FROM center_uploads WHERE id=$1", [entry.id]);
  }
  return { success: true, deletedIds: entries.map(entry => entry.id) };
}));
router.patch("/upload-center/:id", wrap(async (c, req) => {
  const parsed = CorrectCenterUploadBody.safeParse(req.body);
  requireThat(parsed.success, "Invalid metadata correction.");
  const options = parsed.data!;
  await validateMeta(c, options);
  const { entry, raw } = await load(c, String(req.params.id));
  if (entry.state === "committed") {
    const onlyWeekCorrection = entry.kind === "soh" && options.weekIso != null &&
      Object.keys(options).every(field => field === "weekIso");
    requireThat(onlyWeekCorrection,
      "Committed financial evidence and reports are immutable except for a completed-week correction.", 409);
    return correctCommittedSohWeek(c, req, entry, raw, options.weekIso!);
  }
  const changedKind = options.kind !== undefined && options.kind !== entry.kind;
  // Same-kind metadata changes preserve financial column/account mappings.
  if (!changedKind && entry.sourceId && ["claim", "evidence", "history"].includes(entry.kind)) {
    const stored = (await c.query("SELECT payload,raw_sheets FROM scanback_imports WHERE id=$1 FOR UPDATE", [entry.sourceId])).rows[0];
    const base = stored.payload as ScanbackImport;
    requireThat(base.state !== "committed", "Committed evidence is immutable.", 409);
    const next = { ...base, accountId: options.accountId === undefined ? base.accountId : options.accountId,
      mapping: options.mapping ?? base.mapping };
    const value = await rebuildImport(c, base, stored.raw_sheets, next);
    await c.query("UPDATE scanback_imports SET payload=$2::jsonb WHERE id=$1", [base.id, JSON.stringify(value)]);
    Object.assign(entry, options);
    if (options.weekIso !== undefined) entry.weekSource = "manual";
    await save(c, entry, raw);
    return hydrate(c, entry);
  }
  if (!changedKind && entry.kind === "soh" && entry.sourceId) {
    const result = await c.query(`UPDATE uploads SET reseller_id=$2,week_iso=$3,
      recognition=COALESCE(recognition,'{}'::jsonb) || jsonb_build_object('confirmedResellerId',$2::int,'confirmedWeek',$3::text,'weekSource','manual')
      WHERE id=$1 AND status <> 'committed' RETURNING id`,
      [entry.sourceId, options.accountId === undefined ? entry.accountId : options.accountId,
        options.weekIso === undefined ? entry.weekIso : options.weekIso]);
    requireThat(result.rowCount, "This source was committed or changed.", 409);
    Object.assign(entry, options);
    if (options.weekIso !== undefined) entry.weekSource = "manual";
  } else {
    await removeSource(c, entry);
    Object.assign(entry, options, { sourceId: null, mapping: changedKind ? {} : options.mapping ?? entry.mapping });
    const cleanRaw = await createSource(c, entry, raw);
    await save(c, entry, cleanRaw);
    return hydrate(c, entry);
  }
  await save(c, entry, raw);
  return hydrate(c, entry);
}));
router.delete("/upload-center/:id", wrap(async (c, req) => {
  const { entry } = await load(c, String(req.params.id));
  await removeSource(c, entry);
  await c.query("DELETE FROM center_uploads WHERE id=$1", [entry.id]);
  return { success: true };
}));
router.post("/upload-center/:id/commit", wrap(async (c, req) => {
  const { entry, raw } = await load(c, String(req.params.id));
  if (entry.state === "committed") return entry;
  if (entry.kind === "soh") {
    const input = CommitCenterUploadBody.safeParse(req.body);
    requireThat(input.success, "Invalid SOH commit input.");
    const sourceId = Number(entry.sourceId);
    requireThat(Number.isSafeInteger(sourceId) && sourceId > 0, "SOH source is unavailable.", 404);
    requireThat(isCompletedWeekAsOf(input.data!.week_iso),
      unfinishedManualWeekMessage(input.data!.week_iso));
    const committed = await commitSohUpload(c, sourceId, input.data!.reseller_id, input.data!.week_iso,
      input.data!.mappings as MappingField[], input.data!.confirm_overwrite ?? false);
    entry.state = "committed";
    entry.accountId = input.data!.reseller_id;
    entry.weekIso = input.data!.week_iso;
    entry.weekSource = "manual";
    entry.errors = [];
    entry.summary = { ...entry.summary, ...committed };
    await save(c, entry, raw);
    return hydrate(c, entry);
  }
  requireThat(entry.kind === "price" || entry.kind === "program", "Review the SOH or financial column mapping before committing this source.");
  const data = parseReference(entry.kind, Object.values(raw)[0], entry.mapping);
  requireThat(!data.errors.length, data.errors.slice(0, 8).join(" "));
  if (entry.kind === "price") {
    for (const row of data.rows) await c.query(`INSERT INTO price_list(sku,description,rrp_inc_cents,dd_cost_ex_cents,t1_buy_ex_cents,upload_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sku) DO UPDATE SET description=EXCLUDED.description,
      rrp_inc_cents=EXCLUDED.rrp_inc_cents,dd_cost_ex_cents=EXCLUDED.dd_cost_ex_cents,
      t1_buy_ex_cents=EXCLUDED.t1_buy_ex_cents,upload_id=EXCLUDED.upload_id,updated_at=now()`,
    [row.sku, row.description, row.rrpIncCents, row.ddCostExCents, row.t1BuyExCents, entry.id]);
  }
  entry.state = "committed"; entry.errors = [];
  await save(c, entry, raw);
  return entry;
}));
router.use("/upload-center", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) res.status(400).json({ error: "Use files up to 50 MB, at most 20 per request. You can add further batches." });
  else next(err);
});
export default router;
