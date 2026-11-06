import type { ProgramTableMapping, ProgramTablePreview, ProgramTableRow, ProgramTableSource, ScanbackProgramLine } from "@workspace/api-zod";
import { cents } from "./scanback-engine";
import { maskCustomerText } from "./customer-display";
import { readProgramText } from "./program-source";

export const programFields = ["sku", "rrpIncCents", "gtmIncCents", "ddCostExCents", "t1ExCents", "gtmBuyCents"] as const;
export type ProgramField = typeof programFields[number];
export type ProgramAccount = { id: number; name: string; code: string; aliases?: string[] };
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const aliases: Record<ProgramField, string[]> = {
  sku: ["sku", "model", "stockcode", "partno", "partnumber", "modelcode", "productcode"],
  rrpIncCents: ["rrpinc", "rrpincgst", "rrpinclgst", "rrp"],
  gtmIncCents: ["gtminc", "gtmincgst", "gtminclgst", "gtmretailinc"],
  ddCostExCents: ["ddstdcostex", "ddcostex", "ddcostexgst", "ddcost", "costex", "cost"],
  t1ExCents: ["t1ex", "t1buyex", "t1buyexgst", "t1exgst"],
  gtmBuyCents: ["gtmbuyex", "gtmbuyexgst"],
};
const computed = new Set(["discount", "disc", "discpercent", "discountpercent", "sta", "staqty", "stacost", "revtotal", "total", "stat1gtmbuy", "cappedqty", "claimed"]);
export function matchProgramAccount(heading: string, accounts: ProgramAccount[]): number | null {
  const value = norm(maskCustomerText(heading));
  const candidates = accounts.filter(a => [a.code, a.name, ...(a.aliases ?? []), maskCustomerText(a.name), maskCustomerText(a.code)]
    .some(name => {
      const key = norm(maskCustomerText(name));
      return key.length >= 2 && [key, `${key}cap`, `${key}qty`, `${key}quantity`, `${key}cappedqty`, `cap${key}`, `qty${key}`].includes(value);
    }));
  return candidates.length === 1 ? candidates[0].id : null;
}
export function mapProgramHeadings(headers: string[], accounts: ProgramAccount[], rows?: Record<string, unknown>[]): ProgramTableMapping {
  const fields: Record<string, string> = {};
  const customers: Record<string, number | null> = {};
  const ignored: string[] = [];
  for (const field of programFields) {
    const found = headers.filter(h => aliases[field].includes(norm(h)));
    if (found.length) fields[field] = found[0];
  }
  for (const header of headers) {
    if (Object.values(fields).includes(header)) continue;
    const accountId = matchProgramAccount(header, accounts);
    if (accountId != null) {
      if (Object.values(customers).includes(accountId)) ignored.push(header);
      else customers[header] = accountId;
    }
    else if (computed.has(norm(header)) || /\[duplicate \d+\]$/.test(header) ||
      programFields.some(f => f !== "sku" && aliases[f].includes(norm(header)))) ignored.push(header);
  }
  if (rows?.length) for (const header of headers) {
    if (header !== fields.sku && aliases.sku.includes(norm(header)) &&
      rows.every(r => String(r[header] ?? "").trim().toUpperCase() === String(r[fields.sku] ?? "").trim().toUpperCase()))
      ignored.push(header);
  }
  return { fields, customers, ignored };
}
export function applyProgramSuggestions(
  mapping: ProgramTableMapping, headers: string[], accounts: ProgramAccount[], suggestion: unknown,
): ProgramTableMapping {
  const out = { fields: { ...mapping.fields }, customers: { ...mapping.customers }, ignored: [...mapping.ignored] };
  if (!suggestion || typeof suggestion !== "object") return out;
  const value = suggestion as { fields?: unknown; customers?: unknown };
  const used = new Set([...Object.values(out.fields).filter(Boolean), ...Object.keys(out.customers), ...out.ignored]);
  if (value.fields && typeof value.fields === "object" && !Array.isArray(value.fields)) {
    for (const [key, heading] of Object.entries(value.fields)) {
      if (programFields.includes(key as ProgramField) && !out.fields[key] && typeof heading === "string" &&
          headers.includes(heading) && !used.has(heading)) {
        out.fields[key] = heading; used.add(heading);
      }
    }
  }
  if (value.customers && typeof value.customers === "object" && !Array.isArray(value.customers)) {
    for (const [heading, id] of Object.entries(value.customers)) {
      if (headers.includes(heading) && !used.has(heading) && typeof id === "number" &&
        accounts.some(a => a.id === id) && !Object.values(out.customers).includes(id)) {
        out.customers[heading] = id; used.add(heading);
      }
    }
  }
  return out;
}
export const readPastedProgram = readProgramText;
export function previewProgramRows(
  headers: string[], raw: Record<string, unknown>[], accounts: ProgramAccount[],
  provided?: ProgramTableMapping, sourceName = "Pasted program",
  sourceMeta?: ProgramTableSource,
): ProgramTablePreview {
  const mapping = provided ?? mapProgramHeadings(headers, accounts, raw);
  const result: ProgramTablePreview = {
    headers, mapping, rows: [], customerIds: [], issues: [...(sourceMeta?.issues ?? [])], sourceName, aiNote: null,
    startDate: sourceMeta?.startDate ?? null, endDate: sourceMeta?.endDate ?? null, dateNote: sourceMeta?.dateNote ?? null,
    ignoredColumns: mapping.ignored.map(heading => ({ heading, reason:
      computed.has(norm(heading)) ? (norm(heading) === "total" ? "Calculated Total: cross-check only, never an eligibility cap." : "Calculated column; not a source price or customer cap.") :
      aliases.sku.includes(norm(heading)) ? "Repeats the primary SKU values." : /\[duplicate \d+\]$/.test(heading) ? "Repeated heading; kept the first column." :
      Object.entries(mapping.fields).some(([field]) => aliases[field as ProgramField]?.includes(norm(heading)))
        ? `Duplicate ${Object.entries(mapping.fields).find(([field]) => aliases[field as ProgramField]?.includes(norm(heading)))?.[0]} field/synonym; the mapped source is kept.`
        : "Ignored source column." })),
  };
  const issue = (row: number | null, column: string, message: string, blocking = true) =>
    result.issues.push({ row, column, message, blocking });
  const used: string[] = [];
  for (const [field, heading] of Object.entries(mapping.fields)) {
    if (!programFields.includes(field as ProgramField) || (heading && !headers.includes(heading)))
      issue(null, heading, "Choose a supported field and an existing source heading.");
    if (heading) used.push(heading);
  }
  const seenCustomers = new Set<number>();
  for (const [heading, id] of Object.entries(mapping.customers)) {
    if (!headers.includes(heading) || id == null || !accounts.some(a => a.id === id))
      issue(null, heading, "Choose an existing customer or explicitly ignore this column.");
    else {
      if (seenCustomers.has(id)) issue(null, heading, "This customer is mapped more than once.");
      seenCustomers.add(id);
    }
    used.push(heading);
  }
  for (const heading of mapping.ignored) {
    if (!headers.includes(heading)) issue(null, heading, "Ignored column does not exist in this source.");
    used.push(heading);
  }
  if (new Set(used).size !== used.length) issue(null, "", "A source column may be assigned only once.");
  for (const heading of headers) if (!used.includes(heading))
    issue(null, heading, "Unmatched column: map its field/customer or explicitly ignore it.");
  if (!mapping.fields.sku) issue(null, "", "Map the SKU column.");
  if (!mapping.fields.gtmBuyCents) issue(null, "", "GTM Buy Ex is not mapped. Enter it in the draft before saving.", false);
  result.customerIds = [...seenCustomers];
  if (!raw.length) issue(null, "", "The table has no SKU rows.");
  if (raw.length > 1000) issue(null, "", "Limit a promotion to 1,000 SKU rows.");
  const seenSkus = new Set<string>();
  for (const [i, source] of raw.slice(0, 1000).entries()) {
    const sourceRow = sourceMeta?.rowNumbers[i] ?? i + 2;
    const sku = String(source[mapping.fields.sku] ?? "").trim().toUpperCase();
    if (!sku || sku.length > 120 || /[\x00-\x1F\x7F]/.test(sku)) issue(sourceRow, mapping.fields.sku ?? "", "Enter a valid SKU.");
    if (seenSkus.has(sku)) issue(sourceRow, mapping.fields.sku, "Duplicate SKU. Combine or correct the source rows.");
    seenSkus.add(sku);
    const money = (field: Exclude<ProgramField, "sku">) => {
      const heading = mapping.fields[field];
      const value = heading ? source[heading] : null;
      if (value == null || String(value).trim() === "") return null;
      const amount = cents(value);
      if (amount == null || amount < 0 || amount >= 2_000_000_000 || (field === "gtmBuyCents" && amount === 0)) {
        issue(sourceRow, heading, "Use a valid source amount with up to two decimal places.");
        return null;
      }
      return amount;
    };
    const row: ProgramTableRow = {
      sourceRow, sku, rrpIncCents: money("rrpIncCents"), gtmIncCents: money("gtmIncCents"),
      ddCostExCents: money("ddCostExCents"), t1ExCents: money("t1ExCents"), gtmBuyCents: money("gtmBuyCents"), caps: [],
    };
    if (row.gtmBuyCents == null) issue(sourceRow, mapping.fields.gtmBuyCents ?? "", "GTM Buy Ex is blank; complete it before saving the draft.", false);
    for (const [heading, id] of Object.entries(mapping.customers)) {
      if (id == null || !seenCustomers.has(id)) continue;
      const text = String(source[heading] ?? "").trim().replace(/[,\s]/g, "");
      let quantity: number | null = null;
      if (text !== "") {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 1_000_000)
          issue(sourceRow, heading, "Caps must be whole numbers from 0 to 1,000,000; blank means unlimited.");
        else quantity = Number(text);
      }
      row.caps.push({ resellerId: id, quantity });
    }
    const totalHeading = headers.find(h => norm(h) === "total");
    if (totalHeading && headers.some(h => !used.includes(h))) {
      const totalText = String(source[totalHeading] ?? "").replace(/[,\s]/g, "");
      if (totalText) issue(sourceRow, totalHeading, "Total could not be cross-checked until every source and customer column is mapped or ignored.", false);
    } else if (totalHeading) {
      const totalText = String(source[totalHeading] ?? "").replace(/[,\s]/g, "");
      if (totalText && /^\d+$/.test(totalText) && row.caps.every(c => c.quantity != null)) {
        const sum = row.caps.reduce((s, c) => s + c.quantity!, 0);
        if (sum !== Number(totalText)) issue(sourceRow, totalHeading, `Total ${totalText} does not match customer caps ${sum}. Review the allocations.`, false);
      } else if (totalText) issue(sourceRow, totalHeading, "Total could not be cross-checked: a cap/customer or Total is missing or invalid.", false);
    }
    result.rows.push(row);
  }
  return result;
}

/** Reference amounts never become claim inputs; the existing engine is unchanged. */
export function validateProgramReferences(line: ScanbackProgramLine): boolean {
  return ["rrpIncCents", "gtmIncCents", "ddCostExCents", "t1ExCents"].every(key => {
    const amount = line[key as keyof ScanbackProgramLine];
    return amount == null || (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 && amount < 2_000_000_000);
  });
}
