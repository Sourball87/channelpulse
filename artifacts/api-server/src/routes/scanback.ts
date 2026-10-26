import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomUUID, createHash } from "node:crypto";
import {
  SaveScanbackProgramBody, RemapScanbackImportBody, VerifyScanbackClaimBody, ApproveScanbackClaimBody,
  type ScanbackProgram, type ScanbackImport, type ScanbackDraft, type ScanbackBatch, type ScanbackResult,
} from "@workspace/api-zod";
import { parseSheets, suggestMapping } from "../lib/scanback-import";
import { validDate } from "../lib/scanback-engine";
import {
  transaction, all, get, put, catalog, publicImport, rebuildImport, calculateDraft,
  total, recordApprovedSerials, statementRows, requireThat, ScanbackError, type Client,
} from "../lib/scanback-store";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const route = (fn: (c: Client, req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      const data = await transaction(c => fn(c, req, res));
      // Never acknowledge a financial write before COMMIT succeeds.
      if (!res.headersSent) res.json(data);
    }
    catch (e) {
      if (e instanceof ScanbackError) res.status(e.status).json({ error: e.message });
      else if (e && typeof e === "object" && "issues" in e) res.status(400).json({ error: "Invalid input. Check dates, required fields and amounts." });
      else if (e && typeof e === "object" && "code" in e && e.code === "23505")
        res.status(409).json({ error: "This claim or serial was already saved. Refresh history before retrying." });
      else {
        req.log.error({ err: e }, "Scanback request failed");
        res.status(500).json({ error: "Could not complete this operation. Nothing was approved; refresh and retry." });
      }
    }
  };
const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ScanbackError("Invalid request. Check required fields and amounts.");
  return result.data!;
};
const idParam = (req: Request) => String(req.params.id);

router.get("/scanback/workspace", route(async (c, _req, res) => {
  const programs = await all<ScanbackProgram>(c, "scanback_programs");
  const imports = await all<ScanbackImport>(c, "scanback_imports");
  const batches = await all<ScanbackBatch>(c, "scanback_batches");
  const approvedDrafts = new Set((await c.query("SELECT draft_id FROM scanback_batches WHERE draft_id IS NOT NULL")).rows.map(r => r.draft_id));
  const drafts = (await all<ScanbackDraft>(c, "scanback_drafts")).filter(d => !approvedDrafts.has(d.id));
  return { programs, imports: imports.map(i => publicImport(i)), drafts, batches };
}));
router.post("/scanback/programs", route(async (c, req, res) => {
  const input = parse(SaveScanbackProgramBody, req.body);
  requireThat(input.name.trim() && input.name.length <= 200, "Promotion name is required (maximum 200 characters).");
  requireThat(validDate(input.start) && validDate(input.end) && input.start <= input.end, "Enter valid inclusive promotion dates.");
  requireThat(input.customerIds.length > 0 && input.lines.length > 0 && input.lines.length <= 1000, "Choose customers and at least one Stock Code.");
  const cat = await catalog(c);
  requireThat(new Set(input.customerIds).size === input.customerIds.length &&
    input.customerIds.every(id => cat.accounts.some(a => a.id === id)), "Use existing, distinct Account Codes.");
  requireThat(new Set(input.lines.map(l => l.partId)).size === input.lines.length, "Each Stock Code may appear only once.");
  for (const line of input.lines) {
    requireThat(cat.parts.some(p => p.id === line.partId) && Number.isSafeInteger(line.gtmBuyCents) && line.gtmBuyCents > 0 && line.gtmBuyCents < 2_000_000_000, "Enter an existing Stock Code and valid positive GTM Buy Ex.");
    requireThat(new Set(line.caps.map(cap => cap.resellerId)).size === line.caps.length, "Duplicate customer cap.");
    requireThat(line.caps.every(cap => input.customerIds.includes(cap.resellerId) &&
      (cap.quantity === null || (Number.isSafeInteger(cap.quantity) && cap.quantity >= 0 && cap.quantity <= 1_000_000))), "Caps must be blank or nonnegative whole numbers for eligible accounts.");
  }
  const old = input.id ? await get<ScanbackProgram>(c, "scanback_programs", input.id) : null;
  if (old) requireThat(input.version === old.version, "Promotion was edited elsewhere. Refresh before saving.", 409);
  const others = await all<ScanbackProgram>(c, "scanback_programs");
  requireThat(!others.some(p => p.id !== old?.id && p.name.toUpperCase() === input.name.trim().toUpperCase()), "Use a unique promotion name so historical claims can be matched safely.");
  const value: ScanbackProgram = { ...input, id: old?.id ?? randomUUID(), name: input.name.trim(),
    version: (old?.version ?? 0) + 1, archived: input.archived ?? false, createdAt: old?.createdAt ?? new Date().toISOString() };
  if (old) await put(c, "scanback_programs", value.id, value);
  else await c.query("INSERT INTO scanback_programs(id,payload) VALUES($1,$2::jsonb)", [value.id, JSON.stringify(value)]);
  await c.query(`UPDATE scanback_approved_serials s SET program_id=$1
    FROM scanback_batches b WHERE s.batch_id=b.id AND s.program_id IS NULL
    AND upper(b.payload->>'programName')=upper($2)`, [value.id, value.name]);
  return value;
}));
router.post("/scanback/imports/preview", upload.single("file"), route(async (c, req, res) => {
  requireThat(req.file, "Choose a CSV, XLS or XLSX file.");
  requireThat(/\.(csv|xlsx|xls)$/i.test(req.file.originalname), "Use a CSV, XLS or XLSX file.");
  const kind = req.body.kind as ScanbackImport["kind"];
  requireThat(["evidence", "claim", "history"].includes(kind), "Choose evidence, claim or history.");
  const key = createHash("sha256").update(kind).update(req.file.buffer).digest("hex");
  const existing = await c.query("SELECT payload FROM scanback_imports WHERE content_key=$1", [key]);
  if (existing.rowCount) return publicImport({ ...existing.rows[0].payload, duplicate: true }, true);
  let raw;
  try { raw = parseSheets(req.file.buffer); }
  catch (e) { throw new ScanbackError(e instanceof Error ? e.message : "Could not read this spreadsheet."); }
  const sheet = Object.keys(raw)[0], headers = Object.keys(raw[sheet][0] ?? {});
  const base: ScanbackImport = {
    id: randomUUID(), kind, name: req.file.originalname, state: "preview", createdAt: new Date().toISOString(),
    sheets: Object.keys(raw), sheet, headers, mapping: suggestMapping(headers), dateFormat: "dmy",
    accountId: null, rows: [], errors: [], warnings: [], duplicate: false, recordCount: 0,
  };
  const value = await rebuildImport(c, base, raw, base);
  await c.query("INSERT INTO scanback_imports(id,content_key,raw_sheets,payload) VALUES($1,$2,$3::jsonb,$4::jsonb)",
    [value.id, key, JSON.stringify(raw), JSON.stringify(value)]);
  return publicImport(value, true);
}));
router.post("/scanback/imports/:id/remap", route(async (c, req, res) => {
  const base = await get<ScanbackImport>(c, "scanback_imports", idParam(req));
  const options = parse(RemapScanbackImportBody, req.body);
  if (base.state === "committed") {
    requireThat(options.sheet === base.sheet && options.dateFormat === base.dateFormat &&
      (options.accountId ?? null) === base.accountId &&
      Object.entries(options.mapping).every(([key, column]) => (base.mapping[key] ?? "") === column),
    "Committed evidence is immutable.");
    return publicImport(base, true);
  }
  const raw = (await c.query("SELECT raw_sheets FROM scanback_imports WHERE id=$1", [base.id])).rows[0].raw_sheets;
  if (options.sheet !== base.sheet && raw[options.sheet])
    options.mapping = suggestMapping(Object.keys(raw[options.sheet][0] ?? {}));
  let value;
  try { value = await rebuildImport(c, base, raw, options); }
  catch (e) { throw new ScanbackError(e instanceof Error ? e.message : "Could not apply mapping."); }
  await put(c, "scanback_imports", value.id, value);
  return publicImport(value, true);
}));
router.post("/scanback/imports/:id/commit", route(async (c, req, res) => {
  const base = await get<ScanbackImport>(c, "scanback_imports", idParam(req));
  if (base.state === "committed") return publicImport(base, true);
  const raw = (await c.query("SELECT raw_sheets FROM scanback_imports WHERE id=$1", [base.id])).rows[0].raw_sheets;
  const value = await rebuildImport(c, base, raw, base);
  requireThat(value.errors.length === 0, "Resolve every preview error before committing.");
  // Rebuild while holding the same lock as approvals: a history import cannot
  // bypass the duplicate-serial rule, even if its preview was created earlier.
  if (value.kind === "history") {
    const cat = await catalog(c);
    const groups = new Map<string, typeof value.rows>();
    for (const row of value.rows) {
      const key = JSON.stringify([row.accountId, row.program, row.reference, row.date]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      const account = cat.accounts.find(a => a.id === rows[0].accountId)!;
      const results: ScanbackResult[] = rows.map(r => ({
        rowIndex: r.rowIndex, serial: r.serial, sku: r.sku, date: "", invoice: r.invoice, invoiceDate: "",
        unitPriceCents: null, gtmBuyCents: null, amountCents: r.amountCents!, quantity: 1, status: "eligible",
        reason: "Historical approved claim imported — not a new payment", include: true, selectable: false,
        source: `${value.name} [${value.id}], original approval date ${r.date}`,
      }));
      const batch: ScanbackBatch = {
        id: randomUUID(), reference: rows[0].reference, programName: rows[0].program, accountCode: account.code,
        createdAt: rows.map(r => r.date).sort()[0] + "T00:00:00.000Z", totalCents: total(results),
        approvedCount: rows.length, historical: true, basis: "Historical approval dates (source)", from: "", to: "", rows: results,
      };
      await c.query("INSERT INTO scanback_batches(id,payload) VALUES($1,$2::jsonb)", [batch.id, JSON.stringify(batch)]);
      // An exact program-name match makes historical units count against that
      // promotion cap. Global serial uniqueness does not depend on this match.
      const programs = await all<ScanbackProgram>(c, "scanback_programs");
      const matches = programs.filter(p => p.name.toUpperCase() === rows[0].program.toUpperCase());
      await recordApprovedSerials(c, batch, account.id, cat.parts, matches.length === 1 ? matches[0].id : null);
    }
  }
  value.state = "committed";
  await put(c, "scanback_imports", value.id, value);
  return publicImport(value, true);
}));
router.post("/scanback/verify", route(async (c, req, res) => {
  const input = parse(VerifyScanbackClaimBody, req.body);
  requireThat(validDate(input.from) && validDate(input.to) && input.from <= input.to, "Enter a valid claim date period.");
  requireThat(!input.selectedRows || (input.selectedRows.length <= 50000 && input.selectedRows.every(Number.isSafeInteger)), "Invalid selected rows.");
  if (input.draftId) {
    await get<ScanbackDraft>(c, "scanback_drafts", input.draftId);
    requireThat(!(await c.query("SELECT id FROM scanback_batches WHERE draft_id=$1", [input.draftId])).rowCount, "This draft is already approved.", 409);
  }
  const value = await calculateDraft(c, input);
  const id = input.draftId ?? randomUUID();
  const draft: ScanbackDraft = { id, settings: input, results: value.results, token: value.token,
    createdAt: new Date().toISOString(), totalCents: total(value.results) };
  const snapshot = { ...draft, programName: value.p.name, accountCode: value.accounts.find(a => a.id === input.accountId)?.code };
  await c.query("INSERT INTO scanback_drafts(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [id, JSON.stringify(snapshot)]);
  return draft;
}));
router.post("/scanback/approve", route(async (c, req, res) => {
  const input = parse(ApproveScanbackClaimBody, req.body);
  const draft = await get<ScanbackDraft>(c, "scanback_drafts", input.draftId);
  requireThat(input.token === draft.token, "Verification was changed. Recheck the claim.", 409);
  const existing = await c.query("SELECT payload FROM scanback_batches WHERE draft_id=$1", [draft.id]);
  if (existing.rowCount) return existing.rows[0].payload;
  const current = await calculateDraft(c, draft.settings);
  requireThat(current.token === draft.token, "Evidence, program terms or prior claims changed. Re-verify before approving.", 409);
  const included = current.results.filter(r => r.include);
  requireThat(included.length > 0 && included.every(r => r.status === "eligible"), "Select and verify at least one eligible serial.");
  requireThat(input.reference.trim() && input.reference.length <= 200, "Enter a claim reference (maximum 200 characters).");
  const account = current.accounts.find(a => a.id === draft.settings.accountId)!;
  const batch: ScanbackBatch = {
    id: randomUUID(), reference: input.reference.trim(), programName: current.p.name, accountCode: account.code,
    createdAt: new Date().toISOString(), totalCents: total(current.results), approvedCount: included.length, historical: false,
    basis: draft.settings.basis, from: draft.settings.from, to: draft.settings.to, rows: current.results,
  };
  // Extra snapshot fields are retained server-side even when callers use the
  // public batch contract. They must never be derived from edited prices later.
  const snapshot = { ...batch, programSnapshot: current.p, settings: draft.settings, verificationToken: draft.token };
  await c.query("INSERT INTO scanback_batches(id,draft_id,payload) VALUES($1,$2,$3::jsonb)", [batch.id, draft.id, JSON.stringify(snapshot)]);
  await recordApprovedSerials(c, batch, account.id, current.parts, current.p.id);
  return batch;
}));
function sendStatement(res: Response, data: ScanbackBatch | ScanbackDraft, format: string) {
  const rows = statementRows(data).map(row => row.map(value =>
    typeof value === "string" && /^[=+@\t\r-]/.test(value) ? "'" + value : value));
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (format === "csv") {
    res.type("text/csv").attachment(`scanback-${data.id}.csv`).send("\uFEFF" + XLSX.utils.sheet_to_csv(sheet));
  } else {
    sheet["!cols"] = Array.from({ length: 12 }, (_, i) => ({ wch: i === 9 || i === 11 ? 65 : 23 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Claim statement");
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`scanback-${data.id}.xlsx`)
      .send(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  }
}
router.get("/scanback/batches/:id/export/:format", route(async (c, req, res) => {
  requireThat(["csv", "xlsx"].includes(String(req.params.format)), "Choose CSV or XLSX.");
  sendStatement(res, await get<ScanbackBatch>(c, "scanback_batches", idParam(req)), String(req.params.format));
}));
router.get("/scanback/drafts/:id/export", route(async (c, req, res) => {
  sendStatement(res, await get<ScanbackDraft>(c, "scanback_drafts", idParam(req)), "xlsx");
}));
router.use("/scanback", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Maximum spreadsheet size is 10 MB." : "Upload one spreadsheet at a time." });
  else next(err);
});
export default router;
