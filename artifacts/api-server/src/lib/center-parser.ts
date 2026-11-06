import * as XLSX from "xlsx";
import { detectImportKind, type Sheets } from "./scanback-import";
import { cents } from "./scanback-engine";
import { readProgramGrid, readProgramText } from "./program-source";
import type { ProgramTableSource } from "@workspace/api-zod";

export const centerKinds = ["soh", "claim", "evidence", "history", "price", "program", "unknown"] as const;
export type CenterKind = typeof centerKinds[number];
export const normalizeHeading = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const aliases: Record<string, string[]> = {
  sku: ["sku", "stockcode", "partno", "partnumber", "model", "modelcode"],
  description: ["description", "stockdescription", "productdescription"],
  rrpIncCents: ["rrpinc", "rrpincgst", "rrpinclgst", "rrp"],
  ddCostExCents: ["ddstdcostex", "ddcostex", "ddcostexgst", "cost", "costex"],
  t1BuyExCents: ["t1buyex", "t1ex", "t1buyexgst"],
  gtmBuyCents: ["gtmbuyex", "gtmbuyexgst"],
};
export function referenceMapping(headers: string[]) {
  const program = headers.some(h => aliases.gtmBuyCents.includes(normalizeHeading(h)));
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => {
    const matches = headers.filter(h => names.includes(normalizeHeading(h)));
    return [key, matches.length === 1 || (program && matches.length) ? matches[0] : ""];
  }));
}
export function detectCenterKind(headers: string[], sheetName = "", filename = ""): CenterKind {
  const mapping = referenceMapping(headers);
  if (mapping.sku && mapping.gtmBuyCents) return "program";
  if (mapping.sku && mapping.rrpIncCents && mapping.ddCostExCents && mapping.t1BuyExCents) return "price";
  try { return detectImportKind(headers); } catch { /* Try inventory rules next, never guess financial evidence. */ }
  const h = headers.map(normalizeHeading);
  if (h.some(v => /^(soh|stockonhand|totalonhand|quantityonhand|onhand)$/.test(v)) &&
      h.some(v => /^(sku|model|modelcode|partno|partnumber|manufacturermodel|itemcode|productcode)$/.test(v))) return "soh";
  if (/itemfor[ec]astreport/i.test(sheetName) && h.includes("soldqty")) return "soh";
  // Names are hints only; a filename alone cannot establish financial columns.
  void filename;
  return "unknown";
}
export function readCenterSheets(buffer: Buffer): Sheets {
  return readCenterWorkbook(buffer).sheets;
}
export function readCenterWorkbook(buffer: Buffer): { sheets: Sheets; programSources: Record<string, ProgramTableSource> } {
  const programSources: Record<string, ProgramTableSource> = {};
  if (buffer[0] !== 0x50 && buffer[0] !== 0xD0) {
    const text = buffer.toString("utf8");
    if (!text.includes("\0") && /gtm\s*buy\s*ex/i.test(text)) {
      const source = readProgramText(text, new Date(), 10_000_000);
      return { sheets: { Sheet1: source.rows }, programSources: { Sheet1: source.meta } };
    }
  }
  const wb = XLSX.read(buffer, { type: "buffer", raw: true, cellDates: false, sheetRows: 20002 });
  if (wb.SheetNames.length > 30) throw new Error("Limit each workbook to 30 worksheets.");
  const result: Sheets = {};
  let total = 0;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
    if (range.e.r > 20000 || range.e.c > 150) throw new Error("Limit sheets to 20,000 rows and 150 columns.");
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: false });
    const candidates = grid.map((r, index) => ({
      index, kind: detectCenterKind(r.map(String), name),
      fields: r.filter(v => /sku|serial|model|stock|part|rrp/i.test(String(v))).length,
    }));
    const best = candidates.find(r => r.kind !== "unknown") ?? candidates.sort((a, b) => b.fields - a.fields)[0];
    if (!best || !grid[best.index]?.length) continue;
    if (best.kind === "program") {
      const source = readProgramGrid(grid);
      result[name] = source.rows; programSources[name] = source.meta;
      total += source.rows.length;
      if (total > 50000) throw new Error("Limit each workbook to 50,000 rows.");
      continue;
    }
    const headers = grid[best.index].map((v, i) => String(v || `Column ${i + 1}`).trim());
    if (new Set(headers).size !== headers.length) throw new Error(`Duplicate headings in ${name}. Rename them before uploading.`);
    const rows = grid.slice(best.index + 1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])))
      .filter(r => Object.values(r).some(v => v !== "" && v != null));
    total += rows.length;
    if (total > 50000) throw new Error("Limit each workbook to 50,000 rows.");
    result[name] = rows;
  }
  if (!Object.keys(result).length) throw new Error("No tabular data found.");
  return { sheets: result, programSources };
}
export function sheetsBuffer(raw: Sheets): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(raw))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
export function parseReference(kind: "price" | "program", rows: Record<string, unknown>[], mapping: Record<string, string>) {
  const errors: string[] = [];
  const seen = new Set<string>();
  const headers = Object.keys(rows[0] ?? {});
  const assigned = Object.values(mapping).filter(Boolean);
  if (assigned.some(h => !headers.includes(h))) errors.push("Mappings must use columns from this worksheet.");
  if (new Set(assigned).size !== assigned.length) errors.push("Map each source column only once.");
  const required = kind === "price" ? ["sku", "rrpIncCents", "ddCostExCents", "t1BuyExCents"] : ["sku", "gtmBuyCents"];
  for (const key of required) if (!mapping[key]) errors.push(`Map ${key}.`);
  const parsed = rows.map((row, i) => {
    const sku = String(row[mapping.sku] ?? "").trim().toUpperCase();
    if (!sku || sku.length > 120 || /[\x00-\x1F]/.test(sku)) errors.push(`Row ${i + 2}: valid SKU required.`);
    if (seen.has(sku)) errors.push(`Row ${i + 2}: duplicate SKU ${sku}.`);
    seen.add(sku);
    const result: Record<string, unknown> = { ...row, sku, description: String(row[mapping.description] ?? "") };
    for (const key of required.filter(k => k !== "sku")) {
      const value = cents(row[mapping[key]]);
      if (value == null || value < 0 || (key === "gtmBuyCents" && value === 0) || value >= 2_000_000_000)
        errors.push(`Row ${i + 2}: valid ${key} required.`);
      result[key] = value;
    }
    // Preserve numeric customer-cap columns as source fields; the promotion
    // builder asks the user to choose eligible customers before saving.
    return result;
  });
  if (!rows.length) errors.push("This worksheet has no data rows.");
  return { rows: parsed, errors };
}
