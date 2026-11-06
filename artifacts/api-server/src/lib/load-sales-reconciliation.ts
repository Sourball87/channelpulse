import { pool } from "@workspace/db";
import type { ScanbackImport } from "@workspace/api-zod";
import { dateStringToWeekIso, isValidWeekIso } from "./parser";
import { validDate } from "./scanback-engine";
import { weeklySalesWeeks } from "./weekly-sales";
import { mappedSoldColumn, salesReconciliation, type SalesAccount, type SalesPart, type SalesScope, type SalesUpload } from "./sales-reconciliation";

/** A consistent read-only source projection. No financial state or stored SOH
 * numbers are changed to implement the serial fallback. */
export async function loadSalesReconciliation(requestedWeek: string | undefined, scope: SalesScope = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const accounts = (await c.query(`SELECT id,code,sends_serial_reports AS "sendsSerialReports" FROM resellers`)).rows as SalesAccount[];
    const parts = (await c.query("SELECT id,part_no AS code,category FROM parts")).rows as SalesPart[];
    const imports = (await c.query(`SELECT payload FROM scanback_imports WHERE payload->>'state'='committed'
      AND payload->>'kind' IN ('evidence','claim')`)).rows.map(r => r.payload as ScanbackImport);
    const reports = (await c.query(`SELECT payload->>'sourceId' AS "sourceId",
      (payload->>'accountId')::int AS "accountId",payload->>'weekIso' AS "weekIso"
      FROM center_uploads WHERE payload->>'kind'='claim' AND payload->>'sourceId' IS NOT NULL`)).rows;
    const sources = (await c.query(`SELECT reseller_id AS "resellerId",week_iso AS week,detected_mappings AS mapping
      FROM uploads WHERE status='committed' AND reseller_id IS NOT NULL AND week_iso IS NOT NULL
      ORDER BY uploaded_at DESC,id DESC`)).rows;
    const uploads: SalesUpload[] = sources.map(s => ({ resellerId: s.resellerId, week: s.week, soldColumn: mappedSoldColumn(s.mapping) }));
    const candidates = [
      ...uploads.map(s => s.week), ...reports.map(r => r.weekIso),
      ...imports.flatMap(i => i.rows.filter(r => validDate(r.date)).map(r => dateStringToWeekIso(r.date))),
    ].filter((w): w is string => typeof w === "string" && isValidWeekIso(w)).sort();
    const week = requestedWeek ?? candidates.at(-1) ?? null;
    const snapshots = week ? (await c.query(`SELECT s.reseller_id AS "resellerId",p.part_no AS sku,
      s.week_iso AS week,s.soh,s.sell_through_7d AS sold,u.detected_mappings AS mapping
      FROM inventory_snapshots s JOIN parts p ON p.id=s.part_id LEFT JOIN uploads u ON u.id=s.upload_id
      WHERE s.week_iso=ANY($1::text[])`, [weeklySalesWeeks(week)])).rows.map(s => ({
        resellerId: s.resellerId, sku: s.sku, week: s.week, soh: Number(s.soh), sold: Number(s.sold),
        soldColumn: mappedSoldColumn(s.mapping, Number(s.sold)),
      })) : [];
    await c.query("COMMIT");
    return salesReconciliation(week, { accounts, parts, snapshots, uploads, imports, reports }, scope);
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
}
