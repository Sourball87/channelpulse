import type { ScanbackMapping, ScanbackProntoPreview, ScanbackImportIssue } from "@workspace/api-zod";
import { serialKey } from "./scanback-engine";
import type { Account } from "./scanback-import";

// Suggestions are visible proposals, never applied as customer identity until
// the user explicitly maps/reviews them. No fuzzy matching or account creation.
const names: Record<string, string[]> = {
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
export const prontoAllowed = (accounts: Account[]) => accounts.filter(a => Object.hasOwn(names, a.code.toLowerCase()));
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const splitSerials = (value: unknown) => String(value ?? "").split(/[|,;\n]+/).map(serialKey).filter(Boolean);
export const unmatchedCreditReason = "Unmatched credit — no serial number";
export const unmatchedCreditKey = (accountId: number, sku: string) => `${accountId}|${sku.trim().toUpperCase()}`;

export interface ProntoCreditReport {
  id: string;
  createdAt?: string;
  committedAt?: string;
  prontoAccounts?: Record<string, number | null>;
  rows: Record<string, unknown>[];
}

/** Missing-serial credits remain active until a later selected Pronto file
 * supplies a serial for the same reseller, SKU and credit reference. */
export function pendingProntoCreditKeys(reports: ProntoCreditReport[]): Set<string> {
  const pending = new Map<string, string>();
  const ordered = [...reports].sort((a, b) =>
    (a.committedAt ?? a.createdAt ?? "").localeCompare(b.committedAt ?? b.createdAt ?? "") || a.id.localeCompare(b.id));
  for (const report of ordered) {
    const events = report.rows.flatMap(row => {
      const accountId = report.prontoAccounts?.[String(row["Account Code"] ?? "").trim()];
      const sku = String(row["Stock Code"] ?? "").trim().toUpperCase();
      const quantity = Number(row["Ship Qty"]);
      const invoice = String(row["Invoice No"] ?? "").trim().toUpperCase();
      if (accountId == null || !sku || !Number.isFinite(quantity) || quantity >= 0) return [];
      const accountSku = unmatchedCreditKey(accountId, sku);
      const serials = splitSerials(row["Serial Number"]);
      return [{ key: JSON.stringify([accountId, sku, invoice]), accountSku, hasSerial: serials.length > 0 }];
    });
    for (const event of events) if (event.hasSerial) pending.delete(event.key);
    for (const event of events) if (!event.hasSerial) pending.set(event.key, event.accountSku);
  }
  return new Set(pending.values());
}

export function scopePronto(
  rows: Record<string, unknown>[], options: ScanbackMapping, accounts: Account[],
) {
  const allowed = prontoAllowed(accounts), byCode = new Map<string, { names: Set<string>; rows: number; serials: number }>();
  const errors: ScanbackImportIssue[] = [], include = new Map<number, number>();
  const mapping = options.prontoAccounts ?? {};
  let serialEvents = 0;
  for (const row of rows) {
    const code = String(row["Account Code"] ?? "").trim(), name = String(row["Reseller Name"] ?? "").trim();
    const serials = splitSerials(row["Serial Number"]).length;
    const item = byCode.get(code) ?? { names: new Set<string>(), rows: 0, serials: 0 };
    item.names.add(name); item.rows++; item.serials += serials; byCode.set(code, item);
    serialEvents += serials;
  }
  if (serialEvents > 100_000) throw new Error("Limit each Pronto import to 100,000 serial events; split this extract.");
  for (const [code, id] of Object.entries(mapping)) {
    if (!byCode.has(code)) errors.push({ row: 0, message: "Account mapping contains a Pronto code not present in this worksheet." });
    if (id != null && (!Number.isSafeInteger(id) || !allowed.some(a => a.id === id)))
      errors.push({ row: 0, message: "Pronto accounts may map only to the existing nine ChannelPulse resellers." });
  }
  const preview: ScanbackProntoPreview = {
    sourceRows: rows.length, sourceSerialEvents: serialEvents, includedSourceRows: 0, excludedSourceRows: 0,
    accounts: [...byCode].map(([code, source]) => {
      const suggestions = [...source.names].map(name => {
        const matches = allowed.filter(a => names[a.code.toLowerCase()].some(prefix => normalize(name).startsWith(prefix)));
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
    errors.push({ row: 0, message: "Map at least one Pronto account to an existing reseller, then apply mapping. Suggestions are not applied automatically." });
  rows.forEach((row, i) => {
    const code = String(row["Account Code"] ?? "").trim(), sku = String(row["Stock Code"] ?? "").trim().toUpperCase();
    const id = mapping[code], serials = splitSerials(row["Serial Number"]), quantity = Number(row["Ship Qty"]);
    const validAccount = id != null && allowed.some(a => a.id === id);
    const reason = !validAccount ? "Account not selected"
      : !serials.length && quantity < 0 ? unmatchedCreditReason
      : !serials.length ? "No serial number — not serial-level evidence" : "";
    if (!reason) { include.set(i, id!); preview.includedSourceRows++; return; }
    preview.excludedSourceRows++;
    preview.excludedCounts[reason] = (preview.excludedCounts[reason] ?? 0) + 1;
    if (preview.excludedSamples.filter(sample => sample.reason === reason).length < 15) preview.excludedSamples.push({
      row: i + 2, accountCode: code, accountName: String(row["Reseller Name"] ?? ""), sku,
      invoice: String(row["Invoice No"] ?? ""), quantity: Number.isFinite(quantity) ? quantity : 0, serialCount: serials.length, reason,
    });
  });
  return { preview, include, errors };
}
