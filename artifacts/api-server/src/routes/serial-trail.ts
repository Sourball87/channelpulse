import { Router } from "express";
import type { ScanbackImport, ScanbackSerialEvent, ScanbackSerialTrail } from "@workspace/api-zod";
import { transaction, requireThat, ScanbackError } from "../lib/scanback-store";
import { serialKey, cents } from "../lib/scanback-engine";
import { parseDate, suggestMapping, type Sheets } from "../lib/scanback-import";
import { splitSerials } from "../lib/scanback-pronto";
import { reportedSales, firstReportedSales, earlierReportReason } from "../lib/serial-tracking";

const router = Router();
router.get("/scanback/serials/:serial", async (req, res) => {
  try {
    const serial = serialKey(req.params.serial);
    requireThat(/^[A-Z0-9._/-]{3,100}$/.test(serial), "Enter a valid complete serial number.");
    const trail = await transaction(async c => {
      const records = await c.query(`SELECT payload,raw_sheets FROM scanback_imports
        WHERE payload->>'state'='committed' AND payload->>'kind' IN ('evidence','claim')
        AND (payload @> $1::jsonb OR payload ? 'pronto')`, [JSON.stringify({ rows: [{ serial }] })]);
      const accounts = new Map((await c.query("SELECT id,code FROM resellers")).rows.map(r => [r.id as number, r.code as string]));
      const imports = records.rows.map(r => r.payload as ScanbackImport);
      const first = firstReportedSales(reportedSales(imports));
      const claimed = (await c.query(`SELECT s.*,b.created_at AS "recordedAt",
        b.payload->>'createdAt' AS date,b.payload->>'programName' AS promotion,
        b.payload->>'reference' AS reference FROM scanback_approved_serials s
        JOIN scanback_batches b ON b.id=s.batch_id WHERE s.serial=$1`, [serial])).rows[0];
      const events: ScanbackSerialEvent[] = [];
      for (const record of records.rows) {
        const imp = record.payload as ScanbackImport;
        const raw = (record.raw_sheets as Sheets)[imp.sheet] ?? [];
        const costHeading = imp.mapping.cost || suggestMapping(Object.keys(raw[0] ?? {})).cost;
        if (imp.kind === "evidence" && imp.pronto) {
          // Include excluded Pronto serials in the audit trail, but never grant
          // them ownership/eligibility or bypass the selected-account scope.
          for (const [i, source] of raw.entries()) {
            if (!splitSerials(source["Serial Number"]).includes(serial)) continue;
            const id = imp.prontoAccounts?.[String(source["Account Code"] ?? "").trim()] ?? null;
            const qty = Number(source["Ship Qty"]);
            events.push({
              kind: qty < 0 ? "credit" : "invoice", date: parseDate(source["Invoice Date"], imp.dateFormat),
              sourceId: imp.id, sourceName: imp.name, sourceRow: i + 2, accountId: id,
              accountCode: id != null ? accounts.get(id) ?? "" : String(source["Reseller Name"] || source["Account Code"] || ""),
              sku: String(source["Stock Code"] ?? ""), invoice: String(source["Invoice No"] ?? ""),
              unitPriceCents: cents(source["Item Price"]), costCents: costHeading ? cents(source[costHeading]) : null,
              reused: false, reason: id == null ? "Excluded Pronto account — audit only, not eligible invoice evidence." :
                qty < 0 ? "Credit / return recorded; original source retained." : "Invoiced reseller unit price ex GST; our cost is reference only.",
            });
          }
          continue;
        }
        for (const row of imp.rows.filter(r => serialKey(r.serial) === serial)) {
          const accountId = row.accountId ?? imp.accountId;
          const base = {
            date: row.date, sourceId: imp.id, sourceName: imp.name, sourceRow: row.sourceRow ?? row.rowIndex + 2,
            accountId, accountCode: accountId != null ? accounts.get(accountId) ?? "" : "", sku: row.sku,
          };
          if (imp.kind === "evidence") {
            const source = raw[(row.sourceRow ?? row.rowIndex + 2) - 2];
            events.push({ ...base, kind: row.quantity < 0 ? "credit" : "invoice",
              invoice: row.invoice, unitPriceCents: row.unitPriceCents,
              costCents: row.costCents ?? (source && costHeading ? cents(source[costHeading]) : null),
              reused: false, reason: row.quantity < 0 ? "Credit / return recorded." : "Invoiced reseller unit price ex GST; our cost is reference only." });
          } else {
            const earlierClaim = claimed && new Date(claimed.recordedAt).getTime() <=
              new Date(imp.committedAt ?? imp.createdAt).getTime();
            const reason = row.reuseReason || earlierReportReason(first.get(serial), imp.id, row.rowIndex) ||
              (earlierClaim ? `Already claimed: promotion ${claimed.promotion}, batch ${claimed.batch_id} (${claimed.reference})` : "");
            events.push({ ...base, kind: "sold", reused: !!reason,
              reason: reason || "First customer sale report. This source owns the reported sale; later reports cannot reuse it." });
          }
        }
      }
      if (claimed) events.push({
        kind: "claimed", date: claimed.date, sourceId: claimed.batch_id, sourceName: claimed.reference,
        accountId: claimed.account_id, accountCode: accounts.get(claimed.account_id) ?? "", sku: claimed.sku ?? "",
        promotion: claimed.promotion, batchId: claimed.batch_id, batchReference: claimed.reference,
        amountCents: claimed.amount_cents, reused: false, reason: "Approved claim — this serial is permanently blocked from reuse across all promotions.",
      });
      const rank = { invoice: 0, credit: 1, sold: 2, claimed: 3 };
      events.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind] || a.sourceId.localeCompare(b.sourceId));
      const status = claimed ? "CLAIMED" : events.some(e => e.kind === "sold" && !e.reused) ? "SOLD" :
        events.some(e => e.kind === "invoice" || e.kind === "credit") ? "INVOICED" : "UNKNOWN";
      return { serial, status, events } satisfies ScanbackSerialTrail;
    });
    return res.json(trail);
  } catch (e) {
    if (e instanceof ScanbackError) return res.status(e.status).json({ error: e.message });
    req.log.error({ err: e }, "Serial lookup failed");
    return res.status(500).json({ error: "Could not load the serial trail." });
  }
});
export default router;
