import { Router, type IRouter } from "express";
import multer from "multer";
import { db, uploads, inventorySnapshots, resellers, parts, columnMappings, resellerFormatAssociations } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import {
  parseFile,
  applyMappingsToRows,
  hashBuffer,
  computeHeaderFingerprint,
  isValidWeekIso,
  detectWeekFromFilename,
  stableCollapsedFilename,
  type MappingField,
  type ParseResult,
} from "../lib/parser";
import { diagnoseUpload, readRecognition, reanalyzeStoredUpload, selectReportingWeek, withMappings, type Recognition } from "../lib/upload-review";
import { aiAssistEnabled, suggestRecognition } from "../lib/upload-ai";
import { deriveCategory } from "./parts";
import { CommitUploadBody, CommitUploadParams, SaveUploadMappingBody, SaveUploadMappingParams, DeleteUploadParams, GetUploadsQueryParams, RecheckUploadBody, RecheckUploadParams } from "@workspace/api-zod";

const router: IRouter = Router();

// Store files in memory
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 15 } });

async function getAllResellers() {
  const rows = await db.select().from(resellers);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    filenamePatterns: r.filenamePatterns ?? [],
    aliases: r.aliases ?? [],
  }));
}

/** Load all learned fingerprint → resellerId associations */
async function getLearnedFingerprints(): Promise<Map<string, number>> {
  const rows = await db.select().from(resellerFormatAssociations);
  const map = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (map.has(row.fingerprint) && map.get(row.fingerprint) !== row.resellerId) {
      ambiguous.add(row.fingerprint);
    }
    map.set(row.fingerprint, row.resellerId);
  }
  for (const fingerprint of ambiguous) map.delete(fingerprint);
  return map;
}

async function countExistingSnapshots(result: ParseResult): Promise<number> {
  if (!result.detectedResellerId || !result.detectedWeekIso || !result.rows.length) return 0;
  const incoming = result.rows.map(r => r.part_no).filter((p): p is string => !!p);
  const known = await db.select({ id: parts.id }).from(parts).where(inArray(parts.partNo, incoming));
  if (!known.length) return 0;
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(inventorySnapshots).where(and(
    eq(inventorySnapshots.resellerId, result.detectedResellerId),
    eq(inventorySnapshots.weekIso, result.detectedWeekIso),
    inArray(inventorySnapshots.partId, known.map(p => p.id)),
  ));
  return count?.count ?? 0;
}

async function savedMappingsFor(result: ParseResult) {
  if (!result.detectedResellerId) return result;
  const [saved] = await db.select().from(columnMappings).where(and(
    eq(columnMappings.resellerId, result.detectedResellerId),
    eq(columnMappings.fingerprint, computeHeaderFingerprint(result.headers)),
  ));
  return saved && Array.isArray(saved.mapping) ? withMappings(result, saved.mapping as MappingField[]) : result;
}

function diagnostics(result: ParseResult, count: number, recognition: Recognition | null, metadataMissing = false) {
  const assessment = diagnoseUpload(result, count > 0, recognition);
  return {
    review_reasons: assessment.reasons, ready_to_commit: assessment.ready,
    auto_eligible: assessment.autoEligible, week_source: recognition?.weekSource ?? (result.detectedWeekIso ? "filename" : null),
    metadata_missing: metadataMissing, ai: recognition?.ai,
  };
}

async function uploadView(row: typeof uploads.$inferSelect, profiles: Awaited<ReturnType<typeof getAllResellers>>) {
  const { result: base, recognition, metadataMissing } = reanalyzeStoredUpload(row, profiles);
  const originalRecognition = readRecognition(row.recognition);
  let result = originalRecognition && Array.isArray(row.detectedMappings)
    ? withMappings(base, row.detectedMappings as MappingField[]) : base;
  // Keep evidenced AI metadata visible after reload, but never treat it as confirmed.
  if (originalRecognition?.weekSource === "ai_suggested" && row.weekIso) {
    result = { ...result, detectedWeekIso: row.weekIso };
    recognition.weekSource = "ai_suggested";
  }
  if (originalRecognition?.ai?.status === "suggested" && !result.detectedResellerId && row.resellerId) {
    result = { ...result, detectedResellerId: row.resellerId,
      detectedResellerName: profiles.find(p => p.id === row.resellerId)?.name ?? null };
  }
  const committed = row.status === "committed";
  const count = committed ? 0 : await countExistingSnapshots(result);
  return {
    id: row.id, filename: row.filename, status: row.status,
    reseller_id: committed ? row.resellerId : result.detectedResellerId,
    reseller_name: profiles.find(r => r.id === (committed ? row.resellerId : result.detectedResellerId))?.name ?? null,
    report_date: row.reportDate,
    week_iso: committed ? row.weekIso : result.detectedWeekIso,
    uploaded_at: row.uploadedAt.toISOString(), parser_used: row.parserUsed,
    confidence: committed ? Number(row.confidence ?? 0) : result.overallConfidence,
    rows_parsed: committed ? row.rowsParsed : result.rowsParsed,
    rows_flagged: committed ? row.rowsFlagged : result.rowsFlagged,
    raw_headers: Array.isArray(row.rawHeaders) ? row.rawHeaders : [],
    detected_mappings: row.status === "review" ? result.mappings : undefined,
    week_not_detected: row.status === "review" && !result.detectedWeekIso,
    candidates: result.detectedCandidates.map(c => ({ id: c.id, name: c.name, code: c.code })),
    detected_format_id: result.detectedFormatId, detection_reasoning: result.detectionReasoning,
    diagnostics: committed ? undefined : diagnostics(result, count, originalRecognition ? recognition : null, metadataMissing),
  };
}

router.get("/uploads", async (req, res) => {
  try {
    const q = GetUploadsQueryParams.safeParse(req.query);
    const limit = q.success ? (q.data.limit ?? 50) : 50;
    const offset = q.success ? (q.data.offset ?? 0) : 0;
    const profiles = await getAllResellers();

    const rows = await db.select().from(uploads)
      .orderBy(desc(uploads.uploadedAt))
      .limit(limit)
      .offset(offset);

    res.json(await Promise.all(rows.map(row => uploadView(row, profiles))));
  } catch (err) {
    req.log.error({ err }, "Failed to get uploads");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/uploads", upload.array("files"), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files provided" });
    }
    const batchWeek = typeof req.body.batch_week === "string" ? req.body.batch_week.trim() : undefined;
    if (batchWeek && !isValidWeekIso(batchWeek)) return res.status(400).json({ error: "Enter a valid batch week, for example 2026-W27." });
    const aiAssist = aiAssistEnabled(req.body.ai_assist);

    const [allResellers, learnedFingerprints] = await Promise.all([
      getAllResellers(),
      getLearnedFingerprints(),
    ]);
    const reviewCards: unknown[] = [];
    // Track hashes seen within this batch to catch same-batch duplicates
    const batchHashes = new Set<string>();

    for (const file of files) {
      const buf = file.buffer;
      const filename = file.originalname;

      // Check for duplicate (same hash already committed, or seen in this batch)
      const fileHash = hashBuffer(buf);

      if (batchHashes.has(fileHash)) {
        reviewCards.push({
          upload_id: null,
          filename,
          status: "duplicate",
          detected_reseller_id: null,
          detected_reseller_name: null,
          detected_week_iso: null,
          detected_report_date: null,
          confidence: 0,
          rows_parsed: null,
          rows_flagged: null,
          mappings: [],
          preview_rows: [],
          error_message: "Identical file already in this batch — skipped",
          overwrites_existing: false,
          existing_snapshot_count: null,
          week_not_detected: false,
          candidates: [],
          detected_format_id: null,
          detection_reasoning: null,
        });
        continue;
      }
      batchHashes.add(fileHash);

      const existing = await db
        .select()
        .from(uploads)
        .where(and(eq(uploads.fileHash, fileHash), eq(uploads.status, "committed")))
        .limit(1);

      if (existing.length > 0 && existing[0].status === "committed") {
        reviewCards.push({
          upload_id: existing[0].id,
          filename,
          status: "duplicate",
          detected_reseller_id: existing[0].resellerId,
          detected_reseller_name: null,
          detected_week_iso: existing[0].weekIso,
          detected_report_date: existing[0].reportDate,
          confidence: Number(existing[0].confidence ?? 0),
          rows_parsed: existing[0].rowsParsed,
          rows_flagged: existing[0].rowsFlagged,
          mappings: [],
          preview_rows: [],
          error_message: "Exact duplicate file already committed",
          overwrites_existing: false,
          existing_snapshot_count: null,
          week_not_detected: false,
          candidates: [],
          detected_format_id: null,
          detection_reasoning: null,
        });
        continue;
      }

      try {
        let parseResult = await parseFile(buf, filename, allResellers, undefined, learnedFingerprints);
        const recognition: Recognition = { version: 1, sheetName: parseResult.sheetName, weekSource: null };

        // Build saved mappings lookup if reseller detected
        parseResult = await savedMappingsFor(parseResult);
        parseResult = selectReportingWeek(parseResult, recognition, batchWeek);
        if (aiAssist) {
          const priorWeek = parseResult.detectedWeekIso;
          const suggestion = await suggestRecognition(parseResult, filename, allResellers);
          parseResult = suggestion.result;
          recognition.ai = suggestion.note;
          if (!priorWeek && parseResult.detectedWeekIso) recognition.weekSource = "ai_suggested";
        }
        const finalMappings = parseResult.mappings;

        // Week detection result
        const weekNotDetected = !parseResult.detectedWeekIso;
        const detectedWeek = parseResult.detectedWeekIso;

        // Check if this would overwrite existing data — scoped to incoming parts
        let overwritesExisting = false;
        let existingSnapshotCount: number | null = null;
        if (parseResult.detectedResellerId && detectedWeek) {
          const parsedRows = applyMappingsToRows(parseResult.rawRows, finalMappings);
          const incomingPartNos = [...new Set(parsedRows.map(r => r.part_no).filter(Boolean))] as string[];

          if (incomingPartNos.length > 0) {
            const knownParts = await db.select({ id: parts.id }).from(parts)
              .where(inArray(parts.partNo, incomingPartNos));
            const knownPartIds = knownParts.map(p => p.id);

            if (knownPartIds.length > 0) {
              const existingSnaps = await db
                .select()
                .from(inventorySnapshots)
                .where(
                  and(
                    eq(inventorySnapshots.resellerId, parseResult.detectedResellerId),
                    eq(inventorySnapshots.weekIso, detectedWeek),
                    inArray(inventorySnapshots.partId, knownPartIds),
                  ),
                );
              if (existingSnaps.length > 0) {
                overwritesExisting = true;
                existingSnapshotCount = existingSnaps.length;
              }
            }
          }
        }

        // ── §3 Auto-commit gate (hardened) ────────────────────────────────────
        // All conditions must hold:
        //  1. Reseller uniquely resolved (not null, no ambiguous candidates)
        //  2. Detection agreement:
        //       - format_unique: header format maps to exactly this one reseller (no filename needed)
        //       - filename_token: filename token + format both pointed to same reseller
        //       - sheet_name + filenameResolved: sheet name AND filename both agree
        //     (learned-association tie-breaks always go to review for safety)
        //  3. Overall confidence ≥ 0.9
        //  4. Week detected from filename (not inferred)
        //  5. No overwrite conflict
        let reviewDiagnostics = diagnostics(parseResult, existingSnapshotCount ?? 0, recognition);
        const canAutoCommit = reviewDiagnostics.auto_eligible;

        const [uploadRow] = await db
          .insert(uploads)
          .values({
            resellerId: parseResult.detectedResellerId,
            filename,
            fileHash,
            reportDate: parseResult.detectedReportDate,
            weekIso: detectedWeek,
            status: "review",
            parserUsed: parseResult.parserUsed,
            confidence: String(parseResult.overallConfidence),
            rowsParsed: parseResult.rowsParsed,
            rowsFlagged: parseResult.rowsFlagged,
            rawHeaders: parseResult.headers as unknown as Record<string, unknown>,
            rawRows: parseResult.rawRows as unknown as Record<string, unknown>,
            detectedMappings: finalMappings as unknown as Record<string, unknown>,
            recognition,
          })
          .returning();

        let finalStatus = "needs_review";
        if (canAutoCommit) {
          try {
            await commitUploadInternal(uploadRow.id, parseResult.detectedResellerId!, detectedWeek!, finalMappings, parseResult.rawRows, false, true);
            finalStatus = "auto_committed";
          } catch (err) {
            // Parsing succeeded. Retain the one pending upload on a commit failure.
            req.log.warn({ err, uploadId: uploadRow.id }, "Automatic commit deferred to review");
            recognition.commitDeferred = true;
            await db.update(uploads).set({ recognition }).where(eq(uploads.id, uploadRow.id));
            const count = await countExistingSnapshots(parseResult);
            reviewDiagnostics = diagnostics(parseResult, count, recognition);
            reviewDiagnostics.auto_eligible = false;
            reviewDiagnostics.ready_to_commit = false;
            overwritesExisting = count > 0;
            existingSnapshotCount = count;
          }
        }

        reviewCards.push({
          upload_id: uploadRow.id,
          filename,
          status: finalStatus,
          detected_reseller_id: parseResult.detectedResellerId,
          detected_reseller_name: parseResult.detectedResellerName,
          detected_week_iso: detectedWeek,
          detected_report_date: parseResult.detectedReportDate,
          confidence: parseResult.overallConfidence,
          rows_parsed: parseResult.rowsParsed,
          rows_flagged: parseResult.rowsFlagged,
          mappings: finalMappings.map((m) => ({
            source_col: m.source_col,
            canonical_field: m.canonical_field,
            confidence: m.confidence,
            sample_values: m.sample_values,
          })),
          preview_rows: parseResult.rawRows.slice(0, 5),
          error_message: null,
          overwrites_existing: overwritesExisting,
          existing_snapshot_count: existingSnapshotCount,
          week_not_detected: weekNotDetected,
          // New fields for review card enrichment
          candidates: parseResult.detectedCandidates.map(r => ({ id: r.id, name: r.name, code: r.code })),
          detected_format_id: parseResult.detectedFormatId,
          detection_reasoning: parseResult.detectionReasoning,
          diagnostics: reviewDiagnostics,
        });
      } catch (parseErr) {
        req.log.error({ err: parseErr, filename }, "Failed to parse file");

        const [uploadRow] = await db
          .insert(uploads)
          .values({
            filename,
            fileHash,
            status: "failed",
            confidence: "0",
            rawHeaders: {},
            rawRows: [],
            detectedMappings: [],
          })
          .returning();

        reviewCards.push({
          upload_id: uploadRow.id,
          filename,
          status: "failed",
          detected_reseller_id: null,
          detected_reseller_name: null,
          detected_week_iso: null,
          detected_report_date: null,
          confidence: 0,
          rows_parsed: null,
          rows_flagged: null,
          mappings: [],
          preview_rows: [],
          error_message: String(parseErr instanceof Error ? parseErr.message : parseErr),
          overwrites_existing: false,
          existing_snapshot_count: null,
          week_not_detected: false,
          candidates: [],
          detected_format_id: null,
          detection_reasoning: null,
        });
      }
    }

    res.json(reviewCards);
  } catch (err) {
    req.log.error({ err }, "Failed to process uploads");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/uploads/:id/recheck", async (req, res) => {
  const params = RecheckUploadParams.safeParse(req.params);
  const body = RecheckUploadBody.safeParse(req.body);
  if (!params.success || !body.success) return res.status(400).json({ error: "Invalid recheck input." });
  const batchWeek = body.data.batch_week?.trim();
  if (batchWeek && !isValidWeekIso(batchWeek)) return res.status(400).json({ error: "Enter a valid batch reporting week." });
  try {
    const [row] = await db.select().from(uploads).where(eq(uploads.id, params.data.id));
    if (!row) return res.status(404).json({ error: "Upload not found." });
    if (row.status !== "review") return res.status(409).json({ error: "Only pending review uploads can be rechecked. Committed data is unchanged." });
    if (!Array.isArray(row.rawRows) || !row.rawRows.length || !Array.isArray(row.rawHeaders) || !row.rawHeaders.length) {
      return res.status(422).json({ error: "The original source cells are unavailable. Re-upload the original report; no data was changed." });
    }
    const profiles = await getAllResellers();
    const analyzed = reanalyzeStoredUpload(row, profiles);
    const recognition = analyzed.recognition;
    delete recognition.ai;
    delete recognition.commitDeferred;
    let result = await savedMappingsFor(analyzed.result);
    result = selectReportingWeek(result, recognition, batchWeek);
    if (body.data.ai_assist) {
      const priorWeek = result.detectedWeekIso;
      const suggestion = await suggestRecognition(result, row.filename, profiles);
      result = suggestion.result;
      recognition.ai = suggestion.note;
      if (!priorWeek && result.detectedWeekIso) recognition.weekSource = "ai_suggested";
    }
    recognition.recheckedAt = new Date().toISOString();
    const [updated] = await db.update(uploads).set({
      resellerId: result.detectedResellerId, weekIso: result.detectedWeekIso,
      reportDate: result.detectedReportDate, confidence: String(result.overallConfidence),
      rowsParsed: result.rowsParsed, rowsFlagged: result.rowsFlagged,
      detectedMappings: result.mappings, recognition,
    }).where(and(eq(uploads.id, row.id), eq(uploads.status, "review"))).returning();
    if (!updated) return res.status(409).json({ error: "The upload changed while being rechecked. Refresh and try again." });
    // Explicit rechecks update recognition only; they never commit snapshots.
    return res.json(await uploadView(updated, profiles));
  } catch (err) {
    req.log.error({ err }, "Failed to recheck upload");
    return res.status(500).json({ error: "Unable to recheck this upload. Your saved data is unchanged." });
  }
});

class UploadCommitConflict extends Error {
  constructor(public count: number) { super("Existing snapshots require confirmation"); }
}
class UploadStateConflict extends Error {}

async function commitUploadInternal(
  uploadId: number,
  resellerId: number,
  weekIso: string,
  mappings: MappingField[],
  rawRows: Record<string, unknown>[],
  confirmOverwrite: boolean,
  automatic = false,
) {
  const parsedRows = applyMappingsToRows(rawRows, mappings);
  return db.transaction(async tx => {
  const [source] = await tx.select().from(uploads).where(eq(uploads.id, uploadId)).for("update");
  if (!source || source.status !== "review") throw new UploadStateConflict("This upload is no longer pending review. Refresh the page.");
  // Serialise commits for a reseller/week so a concurrent import cannot race the
  // overwrite check and silently replace values using the snapshot upsert.
  await tx.execute(sql`select pg_advisory_xact_lock(${resellerId}, hashtext(${weekIso}))`);

  // Get or create parts
  const partMap = new Map<string, number>();
  const existingParts = await tx.select().from(parts);
  for (const p of existingParts) {
    partMap.set(p.partNo, p.id);
  }

  const snapshotValues = [];
  const incomingPartIds: number[] = [];

  for (const row of parsedRows) {
    if (!row.part_no) continue;

    let partId = partMap.get(row.part_no);
    if (!partId) {
      const category = deriveCategory(row.part_no);
      const [newPart] = await tx
        .insert(parts)
        .values({ partNo: row.part_no, category })
        .onConflictDoNothing()
        .returning();

      if (newPart) {
        partId = newPart.id;
        partMap.set(row.part_no, partId);
      } else {
        const existing = await tx
          .select()
          .from(parts)
          .where(eq(parts.partNo, row.part_no))
          .limit(1);
        if (existing[0]) {
          partId = existing[0].id;
          partMap.set(row.part_no, partId);
        }
      }
    }

    if (!partId) continue;

    incomingPartIds.push(partId);
    snapshotValues.push({
      uploadId,
      resellerId,
      partId,
      weekIso,
      reportDate: source?.reportDate ?? null,
      soh: row.soh,
      sellThrough7d: row.sell_through_7d,
      soldMtd: row.sold_mtd ?? 0,
      onOrder: row.on_order ?? 0,
      avgCost: row.avg_cost !== null ? String(row.avg_cost) : null,
      sold14d: row.sold_14d,
      sold30d: row.sold_30d,
    });
  }

  // Delete existing snapshots scoped ONLY to the incoming part IDs
  if (!confirmOverwrite && incomingPartIds.length) {
    const conflict = await tx.select({ id: inventorySnapshots.id }).from(inventorySnapshots).where(and(
      eq(inventorySnapshots.resellerId, resellerId), eq(inventorySnapshots.weekIso, weekIso),
      inArray(inventorySnapshots.partId, incomingPartIds),
    ));
    if (conflict.length) throw new UploadCommitConflict(conflict.length);
  }
  if (confirmOverwrite && incomingPartIds.length > 0) {
    await tx
      .delete(inventorySnapshots)
      .where(
        and(
          eq(inventorySnapshots.resellerId, resellerId),
          eq(inventorySnapshots.weekIso, weekIso),
          inArray(inventorySnapshots.partId, incomingPartIds),
        ),
      );
  }

  // Repeated SKU rows need explicit aggregation rules, never "first row wins".
  if (new Set(snapshotValues.map(row => row.partId)).size !== snapshotValues.length) {
    throw new Error("Repeated SKU rows require aggregation before committing");
  }
  const deduplicatedValues = snapshotValues;

  // Upsert snapshots
  if (deduplicatedValues.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < deduplicatedValues.length; i += batchSize) {
      const batch = deduplicatedValues.slice(i, i + batchSize);
      await tx
        .insert(inventorySnapshots)
        .values(batch)
        .onConflictDoUpdate({
          target: [inventorySnapshots.resellerId, inventorySnapshots.partId, inventorySnapshots.weekIso],
          set: {
            uploadId: sql`excluded.upload_id`,
            reportDate: sql`excluded.report_date`,
            soh: sql`excluded.soh`,
            sellThrough7d: sql`excluded.sell_through_7d`,
            soldMtd: sql`excluded.sold_mtd`,
            onOrder: sql`excluded.on_order`,
            avgCost: sql`excluded.avg_cost`,
            sold14d: sql`excluded.sold_14d`,
            sold30d: sql`excluded.sold_30d`,
          },
        });
    }
  }

  // Update upload record
  const recognition: Recognition = readRecognition(source.recognition) ??
    { version: 1, sheetName: null, weekSource: null };
  if (!automatic) {
    if (recognition.confirmedWeek !== weekIso || !["batch", "manual"].includes(recognition.weekSource ?? "")) {
      recognition.weekSource = "manual";
    }
    recognition.confirmedWeek = weekIso;
    recognition.confirmedResellerId = resellerId;
  }
  await tx
    .update(uploads)
    .set({ status: "committed", resellerId, weekIso, recognition, detectedMappings: mappings,
      rowsParsed: parsedRows.length, rowsFlagged: parsedRows.filter(r => r.flagged).length })
    .where(eq(uploads.id, uploadId));
  });
}

router.post("/uploads/:id/commit", async (req, res) => {
  const params = CommitUploadParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  const body = CommitUploadBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.issues });

  const { reseller_id, week_iso, mappings, confirm_overwrite } = body.data;
  if (!isValidWeekIso(week_iso)) {
    return res.status(400).json({ error: "Enter a valid ISO reporting week, for example 2026-W27." });
  }
  const fields = mappings.map(m => m.canonical_field).filter(Boolean);
  if (!fields.includes("part_no") || !fields.includes("soh") || !fields.includes("sell_through_7d") ||
      fields.length !== new Set(fields).size) {
    return res.status(400).json({ error: "Map Part Number, SOH and 7-day Sales exactly once. Each standard field can only be mapped to one source column." });
  }

  try {
    const uploadRow = await db
      .select()
      .from(uploads)
      .where(eq(uploads.id, params.data.id))
      .limit(1);

    if (!uploadRow[0]) return res.status(404).json({ error: "Upload not found" });
    if (uploadRow[0].status !== "review") return res.status(409).json({ error: "This upload is no longer pending review. Refresh the page." });
    const [owner] = await db.select({ id: resellers.id }).from(resellers).where(eq(resellers.id, reseller_id));
    if (!owner) return res.status(400).json({ error: "Select an existing reseller." });

    const rawRows = (uploadRow[0].rawRows as Record<string, unknown>[]) ?? [];
    const headers = uploadRow[0].rawHeaders as string[] | null;
    const allowedFields = new Set(["part_no", "soh", "sell_through_7d", "sold_mtd", "on_order", "avg_cost", "sold_14d", "sold_30d"]);
    if (new Set(mappings.map(m => m.source_col)).size !== mappings.length ||
      mappings.some(m => m.canonical_field &&
      (!allowedFields.has(m.canonical_field) || !Array.isArray(headers) || !headers.includes(m.source_col)))) {
      return res.status(400).json({ error: "Mappings must reference the uploaded file's columns and supported standard fields." });
    }
    const parsed = applyMappingsToRows(rawRows, mappings as MappingField[]);
    if (parsed.length === 0) return res.status(400).json({ error: "No product rows were found with these mappings." });
    if (new Set(parsed.map(r => r.part_no)).size !== parsed.length) {
      return res.status(400).json({ error: "Repeated SKU rows require aggregation before committing. No data was changed." });
    }
    if (parsed.some(r => r.flag_reason === "Invalid numeric value")) {
      return res.status(400).json({ error: "The file contains invalid numeric values. Correct the source file or column mappings before committing." });
    }

    if (!confirm_overwrite) {
      const parsedRows = applyMappingsToRows(rawRows, mappings as MappingField[]);
      const incomingPartNos = [...new Set(parsedRows.map(r => r.part_no).filter(Boolean))] as string[];

      if (incomingPartNos.length > 0) {
        const knownParts = await db.select({ id: parts.id, partNo: parts.partNo })
          .from(parts)
          .where(inArray(parts.partNo, incomingPartNos));
        const knownPartIds = knownParts.map(p => p.id);

        if (knownPartIds.length > 0) {
          const existing = await db
            .select()
            .from(inventorySnapshots)
            .where(
              and(
                eq(inventorySnapshots.resellerId, reseller_id),
                eq(inventorySnapshots.weekIso, week_iso),
                inArray(inventorySnapshots.partId, knownPartIds),
              ),
            );
          if (existing.length > 0) {
            return res.status(409).json({
              error: "conflict",
              message: `This would overwrite ${existing.length} existing snapshots for ${week_iso}. Confirm to proceed.`,
              existing_count: existing.length,
              part_count: knownPartIds.length,
            });
          }
        }
      }
    }

    await commitUploadInternal(
      params.data.id,
      reseller_id,
      week_iso,
      mappings as MappingField[],
      rawRows,
      confirm_overwrite ?? false,
    );

    // ── §4 Learn from manual corrections ─────────────────────────────────────
    // Save the stable collapsed filename pattern to the reseller's filename_patterns (deduped)
    // Save the header fingerprint to reseller_format_associations
    try {
      const rawHeaders = (uploadRow[0].rawHeaders as string[] | null) ?? [];
      const headers: string[] = Array.isArray(rawHeaders) ? rawHeaders : [];
      const filename = uploadRow[0].filename;

      await Promise.all([
        // Save stable collapsed filename → reseller's filename_patterns
        (async () => {
          const collapsed = stableCollapsedFilename(filename);
          if (!collapsed) return;

          const resellerRow = await db
            .select({ filenamePatterns: resellers.filenamePatterns })
            .from(resellers)
            .where(eq(resellers.id, reseller_id))
            .limit(1);

          if (!resellerRow[0]) return;
          const existing = resellerRow[0].filenamePatterns ?? [];
          if (!existing.includes(collapsed)) {
            await db
              .update(resellers)
              .set({ filenamePatterns: [...existing, collapsed] })
              .where(eq(resellers.id, reseller_id));
          }
        })(),

        // Save header fingerprint → reseller_format_associations
        (async () => {
          if (headers.length === 0) return;
          const fingerprint = computeHeaderFingerprint(headers);
          await db
            .insert(resellerFormatAssociations)
            .values({ resellerId: reseller_id, fingerprint })
            .onConflictDoUpdate({
              target: [resellerFormatAssociations.resellerId, resellerFormatAssociations.fingerprint],
              set: { resellerId: reseller_id }, // no-op update, just prevent duplicate error
            });
        })(),
      ]);
    } catch (learnErr) {
      // Non-fatal: learning failures must not block the commit response
      req.log.warn({ err: learnErr }, "Failed to save learned associations after commit");
    }

    const updated = await db
      .select()
      .from(uploads)
      .where(eq(uploads.id, params.data.id))
      .limit(1);

    const u = updated[0];
    res.json({
      id: u.id,
      reseller_id: u.resellerId,
      reseller_name: null,
      filename: u.filename,
      report_date: u.reportDate,
      week_iso: u.weekIso,
      uploaded_at: u.uploadedAt?.toISOString(),
      status: u.status,
      parser_used: u.parserUsed,
      confidence: u.confidence !== null ? Number(u.confidence) : null,
      rows_parsed: u.rowsParsed,
      rows_flagged: u.rowsFlagged,
      raw_headers: u.rawHeaders,
      // Signal to the frontend to show the "learned" toast
      learned: true,
    });
  } catch (err) {
    if (err instanceof UploadCommitConflict) return res.status(409).json({
      error: "conflict", message: `This would overwrite ${err.count} existing snapshots. Confirm to proceed.`,
      existing_count: err.count,
    });
    if (err instanceof UploadStateConflict) return res.status(409).json({ error: err.message });
    req.log.error({ err }, "Failed to commit upload");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/uploads/:id", async (req, res) => {
  const params = DeleteUploadParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  try {
    await db.delete(uploads).where(eq(uploads.id, params.data.id));
    res.json({ success: true, message: "Upload and associated snapshots deleted" });
  } catch (err) {
    req.log.error({ err }, "Failed to delete upload");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/uploads/:id/mapping", async (req, res) => {
  const params = SaveUploadMappingParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  const body = SaveUploadMappingBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input" });

  const { reseller_id, fingerprint, mapping } = body.data;

  try {
    const [row] = await db
      .insert(columnMappings)
      .values({
        resellerId: reseller_id,
        fingerprint,
        mapping: mapping as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [columnMappings.resellerId, columnMappings.fingerprint],
        set: { mapping: mapping as Record<string, unknown> },
      })
      .returning();

    res.json({
      id: row.id,
      reseller_id: row.resellerId,
      reseller_name: null,
      fingerprint: row.fingerprint,
      mapping: row.mapping,
      created_at: row.createdAt?.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to save mapping");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
