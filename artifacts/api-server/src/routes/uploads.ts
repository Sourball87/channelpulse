import { Router, type IRouter } from "express";
import multer from "multer";
import { db, uploads, inventorySnapshots, resellers, parts, columnMappings } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import {
  parseFile,
  applyMappingsToRows,
  hashBuffer,
  computeHeaderFingerprint,
  currentWeekIso,
  type MappingField,
} from "../lib/parser";
import { deriveCategory } from "./parts";
import { CommitUploadBody, CommitUploadParams, SaveUploadMappingBody, SaveUploadMappingParams, DeleteUploadParams, GetUploadsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// Store files in memory
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

async function getSavedMappings(resellerId: number): Promise<MappingField[] | null> {
  const rows = await db
    .select()
    .from(columnMappings)
    .where(eq(columnMappings.resellerId, resellerId))
    .limit(10);
  if (rows.length === 0) return null;
  // Return the most recent mapping
  const latest = rows[rows.length - 1];
  const mapping = latest.mapping as Record<string, unknown>;
  if (Array.isArray(mapping)) return mapping as MappingField[];
  return null;
}

router.get("/uploads", async (req, res) => {
  try {
    const q = GetUploadsQueryParams.safeParse(req.query);
    const limit = q.success ? (q.data.limit ?? 50) : 50;
    const offset = q.success ? (q.data.offset ?? 0) : 0;

    const rows = await db
      .select({
        id: uploads.id,
        reseller_id: uploads.resellerId,
        reseller_name: resellers.name,
        filename: uploads.filename,
        report_date: uploads.reportDate,
        week_iso: uploads.weekIso,
        uploaded_at: uploads.uploadedAt,
        status: uploads.status,
        parser_used: uploads.parserUsed,
        confidence: uploads.confidence,
        rows_parsed: uploads.rowsParsed,
        rows_flagged: uploads.rowsFlagged,
        raw_headers: uploads.rawHeaders,
      })
      .from(uploads)
      .leftJoin(resellers, eq(uploads.resellerId, resellers.id))
      .orderBy(desc(uploads.uploadedAt))
      .limit(limit)
      .offset(offset);

    res.json(
      rows.map((r) => ({
        id: r.id,
        reseller_id: r.reseller_id,
        reseller_name: r.reseller_name,
        filename: r.filename,
        report_date: r.report_date,
        week_iso: r.week_iso,
        uploaded_at: r.uploaded_at?.toISOString(),
        status: r.status,
        parser_used: r.parser_used,
        confidence: r.confidence !== null ? Number(r.confidence) : null,
        rows_parsed: r.rows_parsed,
        rows_flagged: r.rows_flagged,
        raw_headers: r.raw_headers,
      })),
    );
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

    const allResellers = await getAllResellers();
    const reviewCards: unknown[] = [];

    for (const file of files) {
      const buf = file.buffer;
      const filename = file.originalname;

      // Check for duplicate (same hash already committed)
      const fileHash = hashBuffer(buf);
      const existing = await db
        .select()
        .from(uploads)
        .where(eq(uploads.fileHash, fileHash))
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
        });
        continue;
      }

      try {
        // Load saved mappings for this reseller if known
        const parseResult = await parseFile(buf, filename, allResellers);

        // Build saved mappings lookup if reseller detected
        let finalMappings = parseResult.mappings;
        if (parseResult.detectedResellerId) {
          const savedMappingRows = await db
            .select()
            .from(columnMappings)
            .where(eq(columnMappings.resellerId, parseResult.detectedResellerId));

          if (savedMappingRows.length > 0) {
            const fingerprint = computeHeaderFingerprint(parseResult.headers);
            const match = savedMappingRows.find((m) => m.fingerprint === fingerprint);
            if (match && Array.isArray(match.mapping)) {
              finalMappings = match.mapping as MappingField[];
            }
          }
        }

        // Check if this would overwrite existing data
        let overwritesExisting = false;
        let existingSnapshotCount: number | null = null;
        if (parseResult.detectedResellerId && parseResult.detectedWeekIso) {
          const existing = await db
            .select()
            .from(inventorySnapshots)
            .where(
              and(
                eq(inventorySnapshots.resellerId, parseResult.detectedResellerId),
                eq(inventorySnapshots.weekIso, parseResult.detectedWeekIso),
              ),
            );
          if (existing.length > 0) {
            overwritesExisting = true;
            existingSnapshotCount = existing.length;
          }
        }

        // Save upload record
        const confidence = parseResult.overallConfidence;
        const status = confidence >= 0.9 ? "review" : "review";
        const detectedWeek = parseResult.detectedWeekIso ?? currentWeekIso();

        const [uploadRow] = await db
          .insert(uploads)
          .values({
            resellerId: parseResult.detectedResellerId,
            filename,
            fileHash,
            reportDate: parseResult.detectedReportDate,
            weekIso: detectedWeek,
            status,
            parserUsed: parseResult.parserUsed,
            confidence: String(confidence),
            rowsParsed: parseResult.rowsParsed,
            rowsFlagged: parseResult.rowsFlagged,
            rawHeaders: parseResult.headers as unknown as Record<string, unknown>,
            rawRows: parseResult.rawRows as unknown as Record<string, unknown>,
            detectedMappings: finalMappings as unknown as Record<string, unknown>,
          })
          .returning();

        // Auto-commit if confidence >= 0.9 and no overwrite
        let finalStatus = "needs_review";
        if (confidence >= 0.9 && !overwritesExisting && parseResult.detectedResellerId) {
          // Auto commit
          await commitUploadInternal(uploadRow.id, parseResult.detectedResellerId, detectedWeek, finalMappings, parseResult.rawRows, false);
          finalStatus = "auto_committed";
        }

        reviewCards.push({
          upload_id: uploadRow.id,
          filename,
          status: finalStatus,
          detected_reseller_id: parseResult.detectedResellerId,
          detected_reseller_name: parseResult.detectedResellerName,
          detected_week_iso: detectedWeek,
          detected_report_date: parseResult.detectedReportDate,
          confidence,
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
        });
      }
    }

    res.json(reviewCards);
  } catch (err) {
    req.log.error({ err }, "Failed to process uploads");
    return res.status(500).json({ error: "Internal server error" });
  }
});

async function commitUploadInternal(
  uploadId: number,
  resellerId: number,
  weekIso: string,
  mappings: MappingField[],
  rawRows: Record<string, unknown>[],
  confirmOverwrite: boolean,
) {
  const parsedRows = applyMappingsToRows(rawRows, mappings);

  // Get or create parts
  const partMap = new Map<string, number>();
  const existingParts = await db.select().from(parts);
  for (const p of existingParts) {
    partMap.set(p.partNo, p.id);
  }

  const snapshotValues = [];

  for (const row of parsedRows) {
    if (!row.part_no) continue;

    let partId = partMap.get(row.part_no);
    if (!partId) {
      // Create new part
      const category = deriveCategory(row.part_no);
      const [newPart] = await db
        .insert(parts)
        .values({ partNo: row.part_no, category })
        .onConflictDoNothing()
        .returning();

      if (newPart) {
        partId = newPart.id;
        partMap.set(row.part_no, partId);
      } else {
        // Race condition — fetch the existing
        const existing = await db
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

    snapshotValues.push({
      uploadId,
      resellerId,
      partId,
      weekIso,
      soh: row.soh,
      sellThrough7d: row.sell_through_7d,
      soldMtd: row.sold_mtd ?? 0,
      onOrder: row.on_order ?? 0,
      avgCost: row.avg_cost !== null ? String(row.avg_cost) : null,
      sold14d: row.sold_14d,
      sold30d: row.sold_30d,
    });
  }

  // Delete existing snapshots for this reseller+week if overwriting
  if (confirmOverwrite) {
    await db
      .delete(inventorySnapshots)
      .where(
        and(
          eq(inventorySnapshots.resellerId, resellerId),
          eq(inventorySnapshots.weekIso, weekIso),
        ),
      );
  }

  // Batch insert with conflict resolution (upsert)
  if (snapshotValues.length > 0) {
    // Insert in batches to avoid parameter limits
    const batchSize = 100;
    for (let i = 0; i < snapshotValues.length; i += batchSize) {
      const batch = snapshotValues.slice(i, i + batchSize);
      await db
        .insert(inventorySnapshots)
        .values(batch)
        .onConflictDoNothing();
    }
  }

  // Update upload status
  await db
    .update(uploads)
    .set({ status: "committed" })
    .where(eq(uploads.id, uploadId));
}

router.post("/uploads/:id/commit", async (req, res) => {
  const params = CommitUploadParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  const body = CommitUploadBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid input", details: body.error.issues });

  const { reseller_id, week_iso, mappings, confirm_overwrite } = body.data;

  try {
    const uploadRow = await db
      .select()
      .from(uploads)
      .where(eq(uploads.id, params.data.id))
      .limit(1);

    if (!uploadRow[0]) return res.status(404).json({ error: "Upload not found" });

    const rawRows = (uploadRow[0].rawRows as Record<string, unknown>[]) ?? [];

    if (!confirm_overwrite) {
      // Check for existing snapshots
      const existing = await db
        .select()
        .from(inventorySnapshots)
        .where(
          and(
            eq(inventorySnapshots.resellerId, reseller_id),
            eq(inventorySnapshots.weekIso, week_iso),
          ),
        );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "conflict",
          message: `This would overwrite ${existing.length} existing snapshots for ${week_iso}. Set confirm_overwrite=true to proceed.`,
          existing_count: existing.length,
        });
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
    });
  } catch (err) {
    req.log.error({ err }, "Failed to commit upload");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/uploads/:id", async (req, res) => {
  const params = DeleteUploadParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid id" });

  try {
    // Cascades to inventory_snapshots due to ON DELETE CASCADE
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
