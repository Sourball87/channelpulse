import type {
  ScanbackProgram, ScanbackImportRow, ScanbackVerificationInput, ScanbackResult,
} from "@workspace/api-zod";

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
export interface ApprovedSerial { serial: string; batchId: string; programId: string | null; accountId: number; partId: number }
export interface CatalogPart { id: number; code: string }
export interface VerificationContext {
  program: ScanbackProgram;
  settings: ScanbackVerificationInput;
  claims: ScanbackImportRow[];
  evidence: EvidenceRow[];
  approved: ApprovedSerial[];
  parts: CatalogPart[];
  restrictedSerials?: Set<string>;
}

function ownerFor(events: EvidenceRow[]) {
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
  const parts = new Map(ctx.parts.map(a => [a.code.toUpperCase(), a.id]));
  const lines = new Map(p.lines.map(line => [line.partId, line]));
  const priorUnits = new Map<number, number>();
  for (const approval of ctx.approved) {
    if (approval.programId === p.id && approval.accountId === s.accountId)
      priorUnits.set(approval.partId, (priorUnits.get(approval.partId) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const running = new Map<number, number>();
  const selected = s.selectedRows ? new Set(s.selectedRows) : null;
  return ctx.claims.map(r => {
    const o: ScanbackResult = {
      rowIndex: r.rowIndex, serial: r.serial, sku: r.sku, date: r.date,
      invoice: "", invoiceDate: "", unitPriceCents: null, gtmBuyCents: null,
      amountCents: 0, quantity: r.quantity, status: "rejected", reason: "",
      include: false, selectable: false, source: "",
    };
    const reject = (reason: string, review = false) => {
      o.reason = reason; o.status = review ? "review" : "rejected"; return o;
    };
    if (seen.has(r.serial)) return reject("Duplicate serial in this claim file");
    seen.add(r.serial);
    if (used.has(r.serial)) return reject(`Already approved in batch ${used.get(r.serial)!.batchId}`);
    if (ctx.restrictedSerials?.has(r.serial))
      return reject("Serial also appears in excluded Pronto account/SKU rows — review source ownership and returns before approval", true);
    const events = bySerial.get(r.serial);
    if (!events?.length) return reject("Serial not found on an invoice");
    const resolution = ownerFor(events);
    if (resolution.review) return reject("Ambiguous invoice / credit ownership — review source evidence", true);
    const inv = resolution.owner;
    if (!inv) return reject("Credited / returned — no active invoice");
    o.invoice = inv.invoice; o.invoiceDate = inv.date; o.unitPriceCents = inv.unitPriceCents;
    o.sku = inv.sku; o.source = inv.source;
    if (inv.accountId !== s.accountId || (r.accountId !== null && r.accountId !== s.accountId))
      return reject("Invoiced or reported to a different customer");
    if (r.sku && r.sku !== inv.sku) return reject(`SKU mismatch: invoice is ${inv.sku}`);
    if (r.date && r.date < inv.date) return reject("Customer sell date precedes invoice date");
    const date = s.basis === "invoice" ? inv.date : r.date;
    if (!date) return reject("Customer sell date is required for this eligibility basis", true);
    if (date < p.start || date > p.end || date < s.from || date > s.to)
      return reject("Outside promotion or selected date period");
    if (!p.customerIds.includes(s.accountId)) return reject("Customer is not eligible for this promotion");
    const partId = parts.get(inv.sku);
    const line = partId == null ? undefined : lines.get(partId);
    if (!line) return reject("SKU is not in this promotion");
    o.gtmBuyCents = line.gtmBuyCents;
    if (!(line.gtmBuyCents > 0) || inv.unitPriceCents == null)
      return reject("Missing invoiced unit price or GTM Buy Ex", true);
    const amount = inv.unitPriceCents - line.gtmBuyCents;
    if (amount <= 0) return reject("Invoiced unit price is at or below GTM Buy Ex");
    if (r.quantity !== 1) return reject("Quantity is not 1 for this serial — correct the source and re-import", true);
    const cap = line.caps.find(c => c.resellerId === s.accountId)?.quantity;
    if (cap === 0) return reject("Customer/SKU cap is 0 — not eligible");
    const prior = priorUnits.get(partId!) ?? 0;
    o.selectable = true;
    const wants = selected ? selected.has(r.rowIndex) : true;
    const count = running.get(partId!) ?? 0;
    if (wants && cap != null && prior + count >= cap) return reject(`Customer/SKU cap reached (${cap} units)`);
    o.amountCents = amount; o.status = "eligible"; o.reason = wants ? "Eligible" : "Eligible — excluded from selection";
    o.include = wants;
    if (wants) running.set(partId!, count + 1);
    return o;
  });
}
