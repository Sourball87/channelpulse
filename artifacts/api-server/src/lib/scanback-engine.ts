import type {
  ScanbackProgram, ScanbackImportRow, ScanbackVerificationInput, ScanbackResult,
} from "@workspace/api-zod";
import { earlierReportReason, isSameCustomerReportRepeat, type ReportedSale } from "./serial-tracking";

export const serialKey = (value: unknown) => String(value ?? "").replace(/\s/g, "").toUpperCase();
export function cents(value: unknown): number | null {
  const s = String(value ?? "").trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith("-");
  const [whole, fraction = ""] = s.replace("-", "").split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(n) && n <= 2_000_000_000 ? (negative ? -n : n) : null;
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export const evidenceKey = (r: ScanbackImportRow) => JSON.stringify([
  r.serial, r.accountId, r.sku, r.date, r.invoice, Math.sign(r.quantity), r.unitPriceCents,
]);
export interface EvidenceRow extends ScanbackImportRow { source: string }
export interface ApprovedSerial { serial: string; batchId: string; programId: string | null; accountId: number; partId: number | null; sku?: string | null; programName?: string; batchReference?: string }
export interface CatalogPart { id: number; code: string }
export interface VerificationContext {
  program: ScanbackProgram;
  settings: ScanbackVerificationInput;
  claims: ScanbackImportRow[];
  evidence: EvidenceRow[];
  approved: ApprovedSerial[];
  parts: CatalogPart[];
  restrictedSerials?: Set<string>;
  reportedSales?: ReportedSale[];
  accounts?: { id: number; code: string }[];
  unmatchedCreditKeys?: Set<string>;
}

export function ownerFor(events: EvidenceRow[]) {
  const grouped = new Map<string, EvidenceRow[]>();
  for (const e of events) {
    const key = `${e.accountId}|${e.sku}`;
    grouped.set(key, [...(grouped.get(key) ?? []), e]);
  }
  const active: EvidenceRow[] = [];
  let unresolved = false;
  for (const group of grouped.values()) {
    // A credit on a day with multiple same-day invoice events is not enough to
    // prove which invoice price survives: fail for review rather than guess.
    const positives = group.filter(e => e.quantity > 0);
    const credits = group.filter(e => e.quantity < 0);
    const remaining = [...positives];
    for (const credit of credits.sort((a, b) => a.date.localeCompare(b.date))) {
      const candidates = remaining.filter(e => e.date <= credit.date);
      if (candidates.length === 1) remaining.splice(remaining.indexOf(candidates[0]), 1);
      else unresolved = true;
    }
    active.push(...remaining);
  }
  if (unresolved || active.length > 1) return { review: true, owner: null };
  return { review: false, owner: active[0] ?? null };
}

export function verifyClaim(ctx: VerificationContext): ScanbackResult[] {
  const { program: p, settings: s } = ctx;
  const bySerial = new Map<string, EvidenceRow[]>();
  const eventKeys = new Set<string>();
  for (const e of ctx.evidence) {
    const key = evidenceKey(e);
    if (eventKeys.has(key)) continue;
    eventKeys.add(key);
    bySerial.set(e.serial, [...(bySerial.get(e.serial) ?? []), e]);
  }
  const used = new Map(ctx.approved.map(a => [a.serial, a]));
  const firstSales = new Map<string, ReportedSale>();
  for (const sale of ctx.reportedSales ?? []) if (!firstSales.has(sale.serial)) firstSales.set(sale.serial, sale);
  const catalogCode = new Map(ctx.parts.map(part => [part.id, part.code.toUpperCase()]));
  const lines = new Map(p.lines.map(line => [
    (line.sku ?? catalogCode.get(line.partId ?? -1) ?? "").trim().toUpperCase(), line,
  ]));
  const priorUnits = new Map<string, number>();
  for (const approval of ctx.approved) {
    if (approval.programId === p.id && approval.accountId === s.accountId)
      {
        const sku = (approval.sku ?? catalogCode.get(approval.partId ?? -1) ?? "").trim().toUpperCase();
        if (sku) priorUnits.set(sku, (priorUnits.get(sku) ?? 0) + 1);
      }
  }
  const seen = new Set<string>();
  const running = new Map<string, number>();
  const selected = s.selectedRows ? new Set(s.selectedRows) : null;
  return ctx.claims.map(r => {
    let reportRepeatReason = "";
    const o: ScanbackResult = {
      rowIndex: r.rowIndex, serial: r.serial, sku: r.sku, date: r.date,
      invoice: "", invoiceDate: "", unitPriceCents: null, gtmBuyCents: null,
      amountCents: 0, quantity: r.quantity, status: "rejected", reason: "",
      include: false, selectable: false, source: "",
      invoicedAccountId: null, invoicedTo: "", costCents: null, trackingColor: "neutral",
    };
    const reject = (reason: string, review = false) => {
      o.reason = reportRepeatReason ? `${reportRepeatReason} — ${reason}` : reason;
      o.status = review ? "review" : "rejected";
      return o;
    };
    // Populate source invoice data even on blocked rows, without making
    // ambiguous evidence payable or changing the existing cap calculation.
    const events = bySerial.get(r.serial);
    const resolution = events?.length ? ownerFor(events) : { review: false, owner: null };
    const inv = resolution.owner;
    if (inv) {
      o.invoice = inv.invoice; o.invoiceDate = inv.date; o.unitPriceCents = inv.unitPriceCents;
      o.sku = inv.sku; o.source = inv.source; o.costCents = inv.costCents ?? null;
      o.invoicedAccountId = inv.accountId;
      o.invoicedTo = ctx.accounts?.find(a => a.id === inv.accountId)?.code ?? String(inv.accountId ?? "");
      o.gtmBuyCents = lines.get(inv.sku.trim().toUpperCase())?.gtmBuyCents ?? null;
    }
    if (used.has(r.serial)) {
      const prior = used.get(r.serial)!; o.trackingColor = "red";
      return reject(`Already approved in batch ${prior.batchId}${prior.batchReference ? ` (${prior.batchReference})` : ""}${prior.programName ? `, promotion ${prior.programName}` : ""}`);
    }
    const firstSale = firstSales.get(serialKey(r.serial));
    const reportReason = earlierReportReason(firstSale, s.claimImportId, r.rowIndex, s.accountId);
    if (reportReason && isSameCustomerReportRepeat(reportReason)) {
      reportRepeatReason = reportReason;
      o.trackingColor = "amber";
    } else if (reportReason) {
      o.trackingColor = "red";
      return reject(reportReason);
    }
    if (seen.has(r.serial)) { o.trackingColor = "red"; return reject("Duplicate serial in this claim file"); }
    seen.add(r.serial);
    const skuKey = (r.sku || inv?.sku || "").trim().toUpperCase();
    if (ctx.unmatchedCreditKeys?.has(`${s.accountId}|${skuKey}`)) {
      o.trackingColor = "amber";
      return reject(`Review — unmatched Pronto credit for ${skuKey}; waiting for a later credit report with its serial.`, true);
    }
    if (ctx.restrictedSerials?.has(r.serial))
      return reject("Serial also appears in excluded Pronto account/SKU rows — review source ownership and returns before approval", true);
    if (!events?.length) return reject("Serial not found on an invoice");
    if (resolution.review) return reject("Ambiguous invoice / credit ownership — review source evidence", true);
    if (!inv) return reject("Credited / returned — no active invoice");
    o.invoice = inv.invoice; o.invoiceDate = inv.date; o.unitPriceCents = inv.unitPriceCents;
    o.sku = inv.sku; o.source = inv.source;
    if (inv.accountId !== s.accountId || (r.accountId !== null && r.accountId !== s.accountId))
      return reject("Invoiced or reported to a different customer");
    if (r.sku && r.sku !== inv.sku) return reject(`SKU mismatch: invoice is ${inv.sku}`);
    if (r.date && r.date < inv.date) {
      if (r.date < p.start || r.date > p.end) o.trackingColor = "orange";
      return reject("Customer sell date precedes invoice date");
    }
    const sellDateOutside = !!r.date && (r.date < p.start || r.date > p.end);
    if (sellDateOutside) {
      o.trackingColor = "orange";
      if (s.basis !== "invoice") return reject("Outside promotion dates — customer sell date");
    }
    const date = s.basis === "invoice" ? inv.date : r.date;
    if (!date) return reject("Customer sell date is required for this eligibility basis", true);
    if (date < p.start || date > p.end || date < s.from || date > s.to) {
      return reject("Outside promotion or selected date period");
    }
    if (!p.customerIds.includes(s.accountId)) return reject("Customer is not eligible for this promotion");
    const sku = inv.sku.trim().toUpperCase();
    const line = lines.get(sku);
    if (!line) return reject("SKU is not in this promotion");
    o.gtmBuyCents = line.gtmBuyCents;
    if (!(line.gtmBuyCents > 0) || inv.unitPriceCents == null)
      return reject("Missing invoiced unit price or GTM Buy Ex", true);
    const amount = inv.unitPriceCents - line.gtmBuyCents;
    if (amount <= 0) return reject("Invoiced unit price is at or below GTM Buy Ex");
    if (r.quantity !== 1) return reject("Quantity is not 1 for this serial — correct the source and re-import", true);
    const cap = line.caps.find(c => c.resellerId === s.accountId)?.quantity;
    if (cap === 0) return reject("Customer/SKU cap is 0 — not eligible");
    const prior = priorUnits.get(sku) ?? 0;
    o.selectable = true;
    const wants = selected ? selected.has(r.rowIndex) : true;
    const count = running.get(sku) ?? 0;
    if (wants && cap != null && prior + count >= cap) return reject(`Customer/SKU cap reached (${cap} units)`);
    o.amountCents = amount; o.status = "eligible";
    const warnings = [
      reportRepeatReason,
      sellDateOutside && s.basis === "invoice" ? "Customer sell date outside promotion dates (warning only; DD invoice-date basis)" : "",
    ].filter(Boolean);
    o.reason = [...warnings, wants ? "Eligible" : "Eligible — excluded from selection"].join(" — ");
    if (!sellDateOutside) o.trackingColor = reportRepeatReason ? "amber" : "green";
    o.include = wants;
    if (wants) running.set(sku, count + 1);
    return o;
  });
}
