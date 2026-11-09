import { applyMappingsToRows, computeHeaderFingerprint, stableCollapsedFilename, type MappingField } from "./parser";
import { isValidWeekIso } from "./dates";
import { deriveCategory } from "../routes/parts";
import { ScanbackError, type Client } from "./scanback-store";

export class UploadCommitConflict extends Error {
  constructor(public existingCount: number, public partCount: number) {
    super("Existing snapshots require confirmation");
  }
}

export async function commitSohUpload(
  c: Client,
  uploadId: number,
  resellerId: number,
  weekIso: string,
  mappings: MappingField[],
  confirmOverwrite = false,
) {
  if (!isValidWeekIso(weekIso))
    throw new ScanbackError("Enter a valid ISO reporting week, for example 2026-W27.", 400);
  const fields = mappings.map(mapping => mapping.canonical_field).filter(Boolean);
  if (!fields.includes("part_no") || !fields.includes("soh") || fields.length !== new Set(fields).size)
    throw new ScanbackError("Map Part Number and SOH exactly once. Sales is optional; each standard field can only be mapped once.", 400);

  const source = (await c.query("SELECT * FROM uploads WHERE id=$1 FOR UPDATE", [uploadId])).rows[0];
  if (!source) throw new ScanbackError("Upload not found.", 404);
  if (source.status !== "review")
    throw new ScanbackError("This upload is no longer pending review. Refresh the page.", 409);
  const owner = (await c.query("SELECT id,filename_patterns FROM resellers WHERE id=$1", [resellerId])).rows[0];
  if (!owner) throw new ScanbackError("Select an existing customer.", 400);

  const rawRows = (source.raw_rows ?? []) as Record<string, unknown>[];
  const headers = (source.raw_headers ?? []) as string[];
  const allowedFields = new Set(["part_no", "soh", "sell_through_7d", "sold_mtd", "on_order", "avg_cost", "sold_14d", "sold_30d"]);
  if (new Set(mappings.map(mapping => mapping.source_col)).size !== mappings.length ||
      mappings.some(mapping => mapping.canonical_field &&
        (!allowedFields.has(mapping.canonical_field) || !headers.includes(mapping.source_col))))
    throw new ScanbackError("Mappings must reference uploaded columns and supported standard fields.", 400);

  const rows = applyMappingsToRows(rawRows, mappings);
  if (!rows.length) throw new ScanbackError("No product rows were found with these mappings.", 400);
  if (new Set(rows.map(row => row.part_no)).size !== rows.length)
    throw new ScanbackError("Repeated SKU rows require aggregation before committing. No data was changed.", 400);
  if (rows.some(row => row.flag_reason === "Invalid numeric value"))
    throw new ScanbackError("The file contains invalid numeric values. Correct the source file or column mappings before committing.", 400);

  const partNos = [...new Set(rows.map(row => row.part_no).filter((part): part is string => !!part))];
  await c.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [resellerId, weekIso]);
  const conflict = await c.query(`SELECT COUNT(*)::int AS count,COUNT(DISTINCT p.id)::int AS part_count FROM inventory_snapshots s
    JOIN parts p ON p.id=s.part_id
    WHERE s.reseller_id=$1 AND s.week_iso=$2 AND p.part_no=ANY($3::text[])`, [resellerId, weekIso, partNos]);
  const existingCount = Number(conflict.rows[0]?.count ?? 0);
  if (!confirmOverwrite && existingCount)
    throw new UploadCommitConflict(existingCount, Number(conflict.rows[0]?.part_count ?? 0));

  const partMap = new Map<string, number>();
  const existingParts = await c.query("SELECT id,part_no FROM parts");
  for (const part of existingParts.rows) partMap.set(part.part_no, Number(part.id));
  for (const partNo of partNos) {
    if (partMap.has(partNo)) continue;
    const inserted = await c.query(`INSERT INTO parts(part_no,category) VALUES($1,$2)
      ON CONFLICT(part_no) DO UPDATE SET part_no=EXCLUDED.part_no RETURNING id`, [partNo, deriveCategory(partNo)]);
    partMap.set(partNo, Number(inserted.rows[0].id));
  }
  const partIds = partNos.map(partNo => partMap.get(partNo)!).filter(Number.isSafeInteger);
  if (confirmOverwrite && partIds.length)
    await c.query("DELETE FROM inventory_snapshots WHERE reseller_id=$1 AND week_iso=$2 AND part_id=ANY($3::int[])",
      [resellerId, weekIso, partIds]);

  const snapshotRows = rows.map(row => ({
    partId: partMap.get(row.part_no!)!,
    soh: row.soh,
    sold: row.sell_through_7d,
    soldMtd: row.sold_mtd ?? 0,
    onOrder: row.on_order ?? 0,
    avgCost: row.avg_cost == null ? null : String(row.avg_cost),
    sold14d: row.sold_14d,
    sold30d: row.sold_30d,
  }));
  for (let offset = 0; offset < snapshotRows.length; offset += 100) {
    const batch = snapshotRows.slice(offset, offset + 100);
    const params: unknown[] = [];
    const values = batch.map((row, index) => {
      const first = index * 12 + 1;
      params.push(uploadId, resellerId, row.partId, weekIso, source.report_date ?? null,
        row.soh, row.sold, row.soldMtd, row.onOrder, row.avgCost, row.sold14d, row.sold30d);
      return `(${Array.from({ length: 12 }, (_, i) => `$${first + i}`).join(",")})`;
    });
    await c.query(`INSERT INTO inventory_snapshots
      (upload_id,reseller_id,part_id,week_iso,report_date,soh,sell_through_7d,sold_mtd,on_order,avg_cost,sold_14d,sold_30d)
      VALUES ${values.join(",")}
      ON CONFLICT(reseller_id,part_id,week_iso) DO UPDATE SET
        upload_id=EXCLUDED.upload_id, report_date=EXCLUDED.report_date, soh=EXCLUDED.soh,
        sell_through_7d=EXCLUDED.sell_through_7d, sold_mtd=EXCLUDED.sold_mtd,
        on_order=EXCLUDED.on_order, avg_cost=EXCLUDED.avg_cost,
        sold_14d=EXCLUDED.sold_14d, sold_30d=EXCLUDED.sold_30d`, params);
  }

  const recognition = source.recognition && typeof source.recognition === "object" ? source.recognition : {};
  recognition.weekSource = recognition.confirmedWeek === weekIso ? recognition.weekSource : "manual";
  recognition.confirmedWeek = weekIso;
  recognition.confirmedResellerId = resellerId;
  await c.query(`UPDATE uploads SET status='committed',reseller_id=$2,week_iso=$3,
    recognition=$4::jsonb,detected_mappings=$5::jsonb,rows_parsed=$6,rows_flagged=$7 WHERE id=$1`,
  [uploadId, resellerId, weekIso, JSON.stringify(recognition), JSON.stringify(mappings), rows.length, rows.filter(row => row.flagged).length]);

  const pattern = stableCollapsedFilename(source.filename);
  const patterns = (owner.filename_patterns ?? []) as string[];
  if (pattern && !patterns.includes(pattern))
    await c.query("UPDATE resellers SET filename_patterns=$2::text[] WHERE id=$1", [resellerId, [...patterns, pattern]]);
  if (headers.length) {
    const fingerprint = computeHeaderFingerprint(headers);
    await c.query(`INSERT INTO reseller_format_associations(reseller_id,fingerprint) VALUES($1,$2)
      ON CONFLICT(reseller_id,fingerprint) DO NOTHING`, [resellerId, fingerprint]);
  }
  return { rowsParsed: rows.length, rowsFlagged: rows.filter(row => row.flagged).length, learned: true };
}
