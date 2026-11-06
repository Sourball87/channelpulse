import Papa from "papaparse";
import type { ProgramTableMapping, ProgramTablePreview, ProgramTableRow, ScanbackProgramLine } from "@workspace/api-zod";
import { cents } from "./scanback-engine";
import { maskCustomerText } from "./customer-display";

export const programFields = ["sku", "rrpIncCents", "gtmIncCents", "ddCostExCents", "t1ExCents", "gtmBuyCents"] as const;
export type ProgramField = typeof programFields[number];
export type ProgramAccount = { id: number; name: string; code: string; aliases?: string[] };
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const aliases: Record<ProgramField, string[]> = {
  sku: ["sku", "model", "stockcode", "partno", "partnumber", "modelcode", "productcode"],
  rrpIncCents: ["rrpinc", "rrpincgst", "rrpinclgst", "rrp"],
  gtmIncCents: ["gtminc", "gtmincgst", "gtminclgst", "gtmretailinc"],
  ddCostExCents: ["ddcostex", "ddcostexgst", "ddcost", "costex", "cost"],
  t1ExCents: ["t1ex", "t1buyex", "t1buyexgst", "t1exgst"],
  gtmBuyCents: ["gtmbuyex", "gtmbuyexgst"],
};
const computed = new Set(["discount", "disc", "discpercent", "discountpercent", "sta", "stat1gtmbuy", "cappedqty", "claimed"]);
export function matchProgramAccount(heading: string, accounts: ProgramAccount[]): number | null {
  const value = norm(maskCustomerText(heading));
  const candidates = accounts.filter(a => [a.code, a.name, ...(a.aliases ?? []), maskCustomerText(a.name), maskCustomerText(a.code)]
    .some(name => {
      const key = norm(maskCustomerText(name));
      return key.length >= 2 && [key, `${key}cap`, `${key}qty`, `${key}quantity`, `${key}cappedqty`, `cap${key}`, `qty${key}`].includes(value);
    }));
  return candidates.length === 1 ? candidates[0].id : null;
}
export function mapProgramHeadings(headers: string[], accounts: ProgramAccount[]): ProgramTableMapping {
  const fields: Record<string, string> = {};
  const customers: Record<string, number | null> = {};
  const ignored: string[] = [];
  for (const field of programFields) {
    const found = headers.filter(h => aliases[field].includes(norm(h)));
    if (found.length === 1) fields[field] = found[0];
  }
  for (const header of headers) {
    if (Object.values(fields).includes(header)) continue;
    const accountId = matchProgramAccount(header, accounts);
    if (accountId != null) customers[header] = accountId;
    else if (computed.has(norm(header))) ignored.push(header);
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
export function readPastedProgram(text: string): { headers: string[]; rows: Record<string, unknown>[] } {
  if (!text.trim() || text.length > 1_000_000) throw new Error("Paste a table with headings, up to 1 MB.");
  // Excel clipboard is TSV. CSV and pipe-separated email tables are also
  // supported; repeated spaces are a last resort, not inferred cell values.
  const cleaned = text.replace(/^\uFEFF/, "").replace(/^[\r\n]+|[\r\n]+$/g, "");
  const first = cleaned.split(/\r?\n/)[0];
  const delimiter = first.includes("\t") ? "\t" : first.includes(",") ? "," : first.includes("|") ? "|" : "\t";
  const input = delimiter === "\t" && !first.includes("\t") ? cleaned.replace(/ {2,}/g, "\t") : cleaned;
  const parsed = Papa.parse<string[]>(input, { delimiter, skipEmptyLines: "greedy" });
  if (parsed.errors.length) throw new Error("Could not read the pasted table. Use tab-separated Excel cells or CSV with matching quotes.");
  const grid = parsed.data;
  const headers = (grid.shift() ?? []).map(h => h.trim());
  if (!headers.length || headers.some(h => !h) || new Set(headers.map(norm)).size !== headers.length)
    throw new Error("Every pasted column needs a distinct, nonempty heading.");
  if (headers.length > 150 || grid.length > 1000) throw new Error("Limit programs to 1,000 SKU rows and 150 columns.");
  if (grid.some(row => row.length !== headers.length))
    throw new Error("Pasted rows have different column counts. Copy the full rectangular table including blank cells.");
  return { headers, rows: grid.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))) };
}
export function previewProgramRows(
  headers: string[], raw: Record<string, unknown>[], accounts: ProgramAccount[],
  provided?: ProgramTableMapping, sourceName = "Pasted program",
): ProgramTablePreview {
  const mapping = provided ?? mapProgramHeadings(headers, accounts);
  const result: ProgramTablePreview = {
    headers, mapping, rows: [], customerIds: [], issues: [], sourceName, aiNote: null,
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
    const sku = String(source[mapping.fields.sku] ?? "").trim().toUpperCase();
    if (!sku || sku.length > 120 || /[\x00-\x1F\x7F]/.test(sku)) issue(i + 2, mapping.fields.sku ?? "", "Enter a valid SKU.");
    if (seenSkus.has(sku)) issue(i + 2, mapping.fields.sku, "Duplicate SKU. Combine or correct the source rows.");
    seenSkus.add(sku);
    const money = (field: Exclude<ProgramField, "sku">) => {
      const heading = mapping.fields[field];
      const value = heading ? source[heading] : null;
      if (value == null || String(value).trim() === "") return null;
      const amount = cents(value);
      if (amount == null || amount < 0 || amount >= 2_000_000_000 || (field === "gtmBuyCents" && amount === 0)) {
        issue(i + 2, heading, "Use a valid source amount with up to two decimal places.");
        return null;
      }
      return amount;
    };
    const row: ProgramTableRow = {
      sourceRow: i + 2, sku, rrpIncCents: money("rrpIncCents"), gtmIncCents: money("gtmIncCents"),
      ddCostExCents: money("ddCostExCents"), t1ExCents: money("t1ExCents"), gtmBuyCents: money("gtmBuyCents"), caps: [],
    };
    if (row.gtmBuyCents == null) issue(i + 2, mapping.fields.gtmBuyCents ?? "", "GTM Buy Ex is blank; complete it before saving the draft.", false);
    for (const [heading, id] of Object.entries(mapping.customers)) {
      if (id == null || !seenCustomers.has(id)) continue;
      const text = String(source[heading] ?? "").trim();
      let quantity: number | null = null;
      if (text !== "") {
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 1_000_000)
          issue(i + 2, heading, "Caps must be whole numbers from 0 to 1,000,000; blank means unlimited.");
        else quantity = Number(text);
      }
      row.caps.push({ resellerId: id, quantity });
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
