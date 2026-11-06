import type { ScanbackMapping, ScanbackProntoPreview, ScanbackImportIssue } from "@workspace/api-zod";
import { serialKey } from "./scanback-engine";
import type { Account } from "./scanback-import";

// Suggestions are visible proposals, never applied as customer identity until
// the user explicitly maps/reviews them. No fuzzy matching or account creation.
const suggestionPrefixes: Record<string, string[]> = {
  ca: ["COMPUTERALLIANCE"], centrecom: ["CENTRECOM"], digi: ["DIGIDIRECT"],
  jw: ["JWCOMPUTERS"], ks: ["KSCOMPUTERTECH"], pccg: ["PCCASEGEAR"],
  ple: ["PLECOMPUTERS"], scorptec: ["SCORPTECCOMPUTERS"], umart: ["UMART"],
};
export const prontoMapping: Record<string, string> = {
  serial: "Serial Number", sku: "Stock Code", date: "Invoice Date", account: "Account Code",
  quantity: "Ship Qty", invoice: "Invoice No", unitPrice: "Item Price",
  amount: "", program: "", reference: "",
};
const columns = [...Object.values(prontoMapping).filter(Boolean), "Reseller Name", "Line Price Ex"];
export const isPronto = (headers: string[]) => columns.every(column => headers.includes(column));
export const prontoColumns = (headers: string[]) => headers.filter(column => columns.includes(column) || column === "Currency" ||
  /^(ourcost|ourunitcostexgst|purchasecost|unitcost|costex|costexgst|itemcost|ddcostex|ddcost|cost)$/.test(column.toLowerCase().replace(/[^a-z0-9]/g, "")));
export const prontoAllowed = (accounts: Account[]) => accounts.filter(a => a.active !== false);
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function parseProntoSerials(value: unknown) {
  const serials: string[] = [], placeholders: string[] = [];
  for (const token of String(value ?? "").split(/[|,;\n]+/)) {
    const normalized = serialKey(token);
    if (!normalized) continue;
    if (normalized.length < 6 || /^0+$/.test(normalized) ||
      !/[A-Z]/.test(normalized) || !/[0-9]/.test(normalized)) {
      placeholders.push(token.trim());
    } else serials.push(normalized);
  }
  return { serials, placeholders };
}
export const splitSerials = (value: unknown) => parseProntoSerials(value).serials;
export const unmatchedCreditReason = "Unmatched credit — no serial number";
export const serialCountExceedsQuantityReason = "More serials than Ship Qty";
export const unmatchedCreditKey = (accountId: number, sku: string) => `${accountId}|${sku.trim().toUpperCase()}`;
function normalizeCreditDate(value: unknown, mode: "dmy" | "mdy" = "dmy"): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : String(value).trim();
  }
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (dmy) {
    const day = mode === "dmy" ? dmy[1] : dmy[2];
    const month = mode === "dmy" ? dmy[2] : dmy[1];
    return `${dmy[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return text.toUpperCase();
}
/** Stable identity for a Pronto credit, independent of its import file and row. */
export const prontoCreditIdentity = (
  accountCode: unknown, sku: unknown, invoice: unknown, quantity: unknown, date: unknown, dateFormat: "dmy" | "mdy" = "dmy",
) => JSON.stringify([
  String(accountCode ?? "").trim().toUpperCase(),
  String(sku ?? "").trim().toUpperCase(),
  String(invoice ?? "").trim().toUpperCase(),
  Number(quantity),
  normalizeCreditDate(date, dateFormat),
]);
export function indexProntoSource(
  rows: Record<string, unknown>[], accounts: Record<string, number | null>,
) {
  const credits: Record<string, unknown>[] = [], restrictedSerials = new Set<string>();
  rows.forEach((row, index) => {
    const sourceRow = index + 2;
    const code = String(row["Account Code"] ?? "").trim();
    const quantity = Number(row["Ship Qty"]);
    const serialValue = row["Serial Number"];
    if (Number.isFinite(quantity) && quantity < 0) credits.push({
      sourceRow, "Account Code": code, "Stock Code": row["Stock Code"],
      "Invoice No": row["Invoice No"], "Invoice Date": row["Invoice Date"],
      "Ship Qty": quantity, "Serial Number": serialValue,
    });
    if (accounts[code] == null) for (const serial of splitSerials(serialValue)) restrictedSerials.add(serial);
  });
  return { creditRows: credits, restrictedSerials: [...restrictedSerials] };
}

export interface ProntoCreditResolution {
  sourceRow: number;
  creditKey?: string;
  mode: "serials" | "reviewed";
  serials: string[];
  note: string;
  resolvedAt: string;
  resolvedBy: string;
}
export interface ProntoCreditReport {
  id: string;
  createdAt?: string;
  committedAt?: string;
  prontoAccounts?: Record<string, number | null>;
  prontoCreditResolutions?: ProntoCreditResolution[];
  dateFormat?: "dmy" | "mdy";
  rows: Record<string, unknown>[];
}

export interface PendingProntoCredit {
  id: string;
  importId: string;
  sourceRow: number;
  accountId: number;
  accountSkuKey: string;
  accountCode: string;
  sku: string;
  invoice: string;
  date: string;
  quantity: number;
}

/** Unresolved credits remain active until matched by a serial-bearing credit
 * or explicitly resolved and audit-logged by an administrator. */
export function pendingProntoCredits(reports: ProntoCreditReport[]): PendingProntoCredit[] {
  const resolved = new Set<string>();
  for (const report of reports) for (const resolution of report.prontoCreditResolutions ?? []) {
    if (resolution.creditKey) resolved.add(resolution.creditKey);
    else {
      const row = report.rows.find((item, index) =>
        Number(item.sourceRow) === resolution.sourceRow || (!item.sourceRow && index + 2 === resolution.sourceRow));
      if (row) resolved.add(prontoCreditIdentity(
        row["Account Code"], row["Stock Code"], row["Invoice No"], row["Ship Qty"], row["Invoice Date"], report.dateFormat,
      ));
    }
  }
  const pending = new Map<string, PendingProntoCredit>();
  const matched = new Set<string>();
  const ordered = [...reports].sort((a, b) =>
    (a.committedAt ?? a.createdAt ?? "").localeCompare(b.committedAt ?? b.createdAt ?? "") || a.id.localeCompare(b.id));
  for (const report of ordered) {
    report.rows.forEach((row, index) => {
      const accountId = report.prontoAccounts?.[String(row["Account Code"] ?? "").trim()];
      const sku = String(row["Stock Code"] ?? "").trim().toUpperCase();
      const quantity = Number(row["Ship Qty"]);
      const invoice = String(row["Invoice No"] ?? "").trim().toUpperCase();
      if (accountId == null || !sku || !Number.isFinite(quantity) || quantity >= 0) return;
      const sourceRow = Number(row.sourceRow) || index + 2;
      const creditKey = prontoCreditIdentity(row["Account Code"], sku, invoice, quantity, row["Invoice Date"], report.dateFormat);
      const serials = splitSerials(row["Serial Number"]);
      if (serials.length) {
        matched.add(creditKey);
        pending.delete(creditKey);
      } else if (!resolved.has(creditKey) && !matched.has(creditKey)) {
        const credit: PendingProntoCredit = {
          id: `${report.id}:${sourceRow}`, importId: report.id, sourceRow, accountId,
          accountSkuKey: unmatchedCreditKey(accountId, sku),
          accountCode: String(row["Account Code"] ?? "").trim(), sku,
          invoice: String(row["Invoice No"] ?? "").trim(),
          date: String(row["Invoice Date"] ?? "").trim(),
          quantity,
        };
        pending.set(creditKey, credit);
      }
    });
  }
  for (const key of resolved) pending.delete(key);
  return [...pending.values()];
}

export function scopePronto(
  rows: Record<string, unknown>[], options: ScanbackMapping, accounts: Account[],
) {
  const allowed = prontoAllowed(accounts), byCode = new Map<string, { names: Set<string>; rows: number; serials: number }>();
  const errors: ScanbackImportIssue[] = [], warnings: string[] = [], include = new Map<number, number>();
  const mapping = options.prontoAccounts ?? {};
  let serialEvents = 0;
  rows.forEach((row, index) => {
    const code = String(row["Account Code"] ?? "").trim(), name = String(row["Reseller Name"] ?? "").trim();
    const parsed = parseProntoSerials(row["Serial Number"]);
    const serials = parsed.serials.length;
    if (parsed.placeholders.length) warnings.push(
      `Row ${index + 2} (${String(row["Invoice No"] ?? "").trim() || "no invoice"}): ignored placeholder serial token(s): ${parsed.placeholders.join(", ")}.`,
    );
    const item = byCode.get(code) ?? { names: new Set<string>(), rows: 0, serials: 0 };
    item.names.add(name); item.rows++; item.serials += serials; byCode.set(code, item);
    serialEvents += serials;
  });
  if (serialEvents > 100_000) throw new Error("Limit each Pronto import to 100,000 serial events; split this extract.");
  for (const [code, id] of Object.entries(mapping)) {
    if (!byCode.has(code)) errors.push({ row: 0, message: "Account mapping contains a Pronto code not present in this worksheet." });
    if (id != null && (!Number.isSafeInteger(id) || !allowed.some(a => a.id === id)))
      errors.push({ row: 0, message: "Pronto accounts may map only to an active ChannelPulse reseller." });
  }
  const preview: ScanbackProntoPreview = {
    sourceRows: rows.length, sourceSerialEvents: serialEvents, includedSourceRows: 0, excludedSourceRows: 0,
    accounts: [...byCode].map(([code, source]) => {
      const suggestions = [...source.names].map(name => {
        const matches = allowed.filter(a => (suggestionPrefixes[a.code.toLowerCase()] ?? []).some(prefix => normalize(name).startsWith(prefix)));
        return matches.length === 1 ? matches[0].id : null;
      });
      return {
        code, name: [...source.names].join(" / "), rowCount: source.rows, serialCount: source.serials,
        accountId: allowed.some(a => a.id === mapping[code]) ? mapping[code]! : null,
        suggestedAccountId: suggestions.length && suggestions[0] != null && suggestions.every(id => id === suggestions[0]) ? suggestions[0] : null,
      };
    }).sort((a, b) => Number(b.suggestedAccountId != null) - Number(a.suggestedAccountId != null) || a.name.localeCompare(b.name)),
    excludedCounts: {}, excludedSamples: [],
  };
  if (!preview.accounts.some(a => a.accountId != null))
    errors.push({ row: 0, message: "Map at least one Pronto account to an active reseller in Settings, then apply mapping. Suggestions are not applied automatically." });
  rows.forEach((row, i) => {
    const code = String(row["Account Code"] ?? "").trim(), sku = String(row["Stock Code"] ?? "").trim().toUpperCase();
    const id = mapping[code], serials = splitSerials(row["Serial Number"]), quantity = Number(row["Ship Qty"]);
    const validAccount = id != null && allowed.some(a => a.id === id);
    const countExceedsQuantity = Number.isSafeInteger(quantity) && serials.length > Math.abs(quantity);
    const reason = !validAccount ? "Account not selected"
      : countExceedsQuantity ? serialCountExceedsQuantityReason
      : !serials.length && quantity < 0 ? unmatchedCreditReason
      : !serials.length ? "No serial number — not serial-level evidence" : "";
    if (!reason) { include.set(i, id!); preview.includedSourceRows++; return; }
    preview.excludedSourceRows++;
    preview.excludedCounts[reason] = (preview.excludedCounts[reason] ?? 0) + 1;
    if (reason === serialCountExceedsQuantityReason)
      warnings.push(`Row ${i + 2} (${String(row["Invoice No"] ?? "").trim() || "no invoice"}): found ${serials.length} valid serials, exceeding Ship Qty ${Math.abs(quantity)}. This row was excluded.`);
    if (preview.excludedSamples.filter(sample => sample.reason === reason).length < 15) preview.excludedSamples.push({
      row: i + 2, accountCode: code, accountName: String(row["Reseller Name"] ?? ""), sku,
      invoice: String(row["Invoice No"] ?? ""), quantity: Number.isFinite(quantity) ? quantity : 0, serialCount: serials.length, reason,
    });
  });
  rows.forEach((row, i) => {
    const quantity = Number(row["Ship Qty"]);
    const serials = splitSerials(row["Serial Number"]);
    if (mapping[String(row["Account Code"] ?? "").trim()] != null &&
      Number.isSafeInteger(quantity) && serials.length > 0 && serials.length < Math.abs(quantity)) {
      warnings.push(`Row ${i + 2} (${String(row["Invoice No"] ?? "").trim() || "no invoice"}): serial count shortfall — expected ${Math.abs(quantity)}, found ${serials.length}. Retained the valid serials.`);
    }
  });
  return { preview, include, errors, warnings };
}
