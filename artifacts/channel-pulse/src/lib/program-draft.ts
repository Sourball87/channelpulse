import type { Part, ScanbackProgram, ScanbackProgramInput, ScanbackProgramLine } from "@workspace/api-client-react";
import type { PriceRow } from "@/lib/upload-center";

/** Program line including optional reference money (reference only, never used in the claim formula). */
export type ProgramLineX = ScanbackProgramLine & {
  rrpIncCents?: number | null;
  gtmIncCents?: number | null;
  ddCostExCents?: number | null;
  t1ExCents?: number | null;
};

export interface ProgramStat { programId: string; accountId: number; sku: string; count: number; amountCents: number }

export type DraftLine = {
  key: string; sku: string; rrp: string; gtmInc: string; dd: string; t1: string; gtmBuy: string;
  caps: Record<number, string>;
};

export type ProgramDraft = {
  id?: string; version?: number; archived: boolean;
  name: string; start: string; end: string; notes: string;
  customerIds: number[]; lines: DraftLine[];
};

let seq = 0;
export const lineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export function centsStr(c: number | null | undefined): string {
  if (c == null) return "";
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Null-safe money display: null renders blank. */
export function money(c: number | null | undefined): string {
  if (c == null) return "";
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? "-" : ""}$${Math.floor(a / 100).toLocaleString("en-AU")}.${String(a % 100).padStart(2, "0")}`;
}

/** Returns null for blank, NaN for invalid. */
export function toCents(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const validMoney = (raw: string) => { const c = toCents(raw); return c != null && !Number.isNaN(c) ? c : null; };

export function discPct(rrp: number | null, gtmInc: number | null): string {
  if (rrp == null || gtmInc == null || rrp <= 0) return "";
  return `${(((rrp - gtmInc) / rrp) * 100).toFixed(1)}%`;
}
export function discFromDraft(l: DraftLine) { return discPct(validMoney(l.rrp), validMoney(l.gtmInc)); }
export function staFromDraft(l: DraftLine): number | null {
  const t1 = validMoney(l.t1), g = validMoney(l.gtmBuy);
  return t1 == null || g == null ? null : t1 - g;
}
export function cappedQty(caps: Record<number, string>, customerIds: number[]): number {
  return customerIds.reduce((s, id) => { const v = (caps[id] ?? "").trim(); return /^\d+$/.test(v) ? s + Number(v) : s; }, 0);
}

export function emptyLine(): DraftLine {
  return { key: lineKey(), sku: "", rrp: "", gtmInc: "", dd: "", t1: "", gtmBuy: "", caps: {} };
}

export function emptyDraft(): ProgramDraft {
  return { archived: false, name: "", start: "", end: "", notes: "", customerIds: [], lines: [emptyLine()] };
}

export function lineSku(l: ScanbackProgramLine, parts: Part[]): string {
  return l.sku ?? parts.find((p) => p.id === l.partId)?.part_no ?? "";
}

export function draftFromProgram(p: ScanbackProgram, parts: Part[]): ProgramDraft {
  return {
    id: p.id, version: p.version, archived: p.archived,
    name: p.name, start: p.start?.slice(0, 10) ?? "", end: p.end?.slice(0, 10) ?? "", notes: p.notes ?? "",
    customerIds: [...p.customerIds],
    lines: (p.lines as ProgramLineX[]).map((l) => ({
      key: lineKey(), sku: lineSku(l, parts),
      rrp: centsStr(l.rrpIncCents), gtmInc: centsStr(l.gtmIncCents), dd: centsStr(l.ddCostExCents), t1: centsStr(l.t1ExCents),
      gtmBuy: centsStr(l.gtmBuyCents),
      caps: Object.fromEntries(l.caps.map((c) => [c.resellerId, c.quantity == null ? "" : String(c.quantity)])),
    })),
  };
}

/** Comparable fingerprint ignoring row keys. */
export function fingerprint(d: ProgramDraft): string {
  return JSON.stringify({
    n: d.name, s: d.start, e: d.end, o: d.notes, c: d.customerIds,
    l: d.lines.map((l) => [l.sku, l.rrp, l.gtmInc, l.dd, l.t1, l.gtmBuy, d.customerIds.map((id) => l.caps[id] ?? "")]),
  });
}

export function findPrice(prices: PriceRow[], sku: string): PriceRow | undefined {
  const k = sku.trim().toUpperCase();
  return k ? prices.find((p) => p.sku.trim().toUpperCase() === k) : undefined;
}

/** Apply price-list references for a SKU. No match clears references so stale prices never remain. */
export function withPriceRefs(l: DraftLine, prices: PriceRow[]): DraftLine {
  const pr = findPrice(prices, l.sku);
  return { ...l, rrp: centsStr(pr?.rrpIncCents), dd: centsStr(pr?.ddCostExCents), t1: centsStr(pr?.t1BuyExCents) };
}

export function uniqueName(base: string, taken: string[]): string {
  const set = new Set(taken.map((t) => t.trim().toLowerCase()));
  let name = `${base} (copy)`; let i = 2;
  while (set.has(name.toLowerCase())) name = `${base} (copy ${i++})`;
  return name;
}

export type ProgramStatus = { kind: "upcoming" | "live" | "ended" | "unset"; label: string };
export function programStatus(start: string, end: string, now = new Date()): ProgramStatus {
  if (!start || !end) return { kind: "unset", label: "Set dates" };
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const s = Date.parse(`${start.slice(0, 10)}T00:00:00Z`), e = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return { kind: "unset", label: "Set dates" };
  const day = 86_400_000;
  if (today < s) { const d = Math.round((s - today) / day); return { kind: "upcoming", label: `Upcoming \u00b7 starts in ${d}d` }; }
  if (today > e) return { kind: "ended", label: "Ended" };
  const left = Math.round((e - today) / day) + 1;
  return { kind: "live", label: `Live \u00b7 ${left}d left` };
}

/** Validate and build the save payload. Returns error string on failure. */
export function buildInput(d: ProgramDraft, parts: Part[]): ScanbackProgramInput | string {
  if (!d.name.trim()) return "Promotion name is required.";
  if (!d.start || !d.end) return "Start and end dates are required.";
  if (d.end < d.start) return "End date must be on or after the start date.";
  if (d.customerIds.length === 0) return "Add at least one customer column.";
  if (d.lines.length === 0) return "Add at least one SKU.";
  const seen = new Set<string>();
  const lines: ProgramLineX[] = [];
  for (const [i, l] of d.lines.entries()) {
    const n = i + 1;
    const sku = l.sku.trim().toUpperCase();
    if (!sku) return `Row ${n}: enter a SKU.`;
    if (seen.has(sku)) return `Row ${n}: ${sku} is listed twice.`;
    seen.add(sku);
    const gtm = toCents(l.gtmBuy);
    if (gtm == null || Number.isNaN(gtm) || gtm < 1) return `Row ${n} (${sku}): GTM Buy Ex must be a positive amount with up to 2 decimals.`;
    const refs: Record<string, number | null> = {};
    for (const [field, label, raw] of [["rrpIncCents", "RRP Inc", l.rrp], ["gtmIncCents", "GTM Inc", l.gtmInc], ["ddCostExCents", "DD Cost Ex", l.dd], ["t1ExCents", "T1 Ex", l.t1]] as const) {
      const c = toCents(raw);
      if (c != null && Number.isNaN(c)) return `Row ${n} (${sku}): ${label} must be blank or an amount with up to 2 decimals.`;
      refs[field] = c;
    }
    const caps = [];
    for (const cid of d.customerIds) {
      const raw = (l.caps[cid] ?? "").trim();
      if (raw === "") caps.push({ resellerId: cid, quantity: null });
      else if (!/^\d+$/.test(raw)) return `Row ${n} (${sku}): caps must be whole numbers (blank = unlimited, 0 = not eligible).`;
      else caps.push({ resellerId: cid, quantity: Number(raw) });
    }
    const part = parts.find((p) => p.part_no.toUpperCase() === sku);
    lines.push({ sku, partId: part?.id ?? null, gtmBuyCents: gtm, caps, ...refs });
  }
  return {
    ...(d.id ? { id: d.id, version: d.version } : {}),
    archived: d.archived,
    name: d.name.trim(), start: d.start, end: d.end, notes: d.notes,
    customerIds: d.customerIds, lines,
  };
}

/* ---------- Program-table preview API ---------- */
export type PreviewFieldKey = "sku" | "rrpIncCents" | "gtmIncCents" | "ddCostExCents" | "t1ExCents" | "gtmBuyCents";
export const PREVIEW_FIELDS: { key: PreviewFieldKey; label: string }[] = [
  { key: "sku", label: "SKU" }, { key: "rrpIncCents", label: "RRP Inc" }, { key: "gtmIncCents", label: "GTM Inc" },
  { key: "ddCostExCents", label: "DD Cost Ex" }, { key: "t1ExCents", label: "T1 Ex" }, { key: "gtmBuyCents", label: "GTM Buy Ex" },
];
export interface PreviewMapping { fields: Record<string, string>; customers: Record<string, number | null>; ignored: string[] }
export interface PreviewRow {
  sourceRow: number; sku: string;
  rrpIncCents: number | null; gtmIncCents: number | null; ddCostExCents: number | null; t1ExCents: number | null; gtmBuyCents: number | null;
  caps: { resellerId: number; quantity: number | null }[];
}
export interface PreviewIssue { row: number | null; column: string; message: string; blocking: boolean }
export interface ProgramTablePreview {
  headers: string[]; mapping: PreviewMapping; rows: PreviewRow[]; customerIds: number[];
  issues: PreviewIssue[]; sourceName: string; aiNote: string | null;
  startDate?: string | null; endDate?: string | null; dateNote?: string | null;
  ignoredColumns?: { heading: string; reason: string }[];
}
/** Build an unsaved draft from preview rows. Source data only: no price-list autofill, no invented values. */
export function draftFromPreview(p: ProgramTablePreview): ProgramDraft {
  return {
    archived: false, name: p.sourceName.replace(/\.[a-z0-9]+$/i, ""), start: p.startDate ?? "", end: p.endDate ?? "", notes: `Built from ${p.sourceName}`,
    customerIds: [...p.customerIds],
    lines: p.rows.map((r) => ({
      key: lineKey(), sku: r.sku,
      rrp: centsStr(r.rrpIncCents), gtmInc: centsStr(r.gtmIncCents), dd: centsStr(r.ddCostExCents), t1: centsStr(r.t1ExCents),
      gtmBuy: centsStr(r.gtmBuyCents),
      caps: Object.fromEntries(r.caps.map((c) => [c.resellerId, c.quantity == null ? "" : String(c.quantity)])),
    })),
  };
}
