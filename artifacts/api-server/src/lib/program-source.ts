import Papa from "papaparse";
import type { ProgramTableSource } from "@workspace/api-zod";
import { programDates } from "./program-dates";
import { collapsedHeadings, collapsedRow } from "./program-collapsed";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const skuHeading = (s: unknown) => ["sku", "partno", "partnumber", "stockcode", "model", "modelcode", "productcode"].includes(norm(s));
const group = (row: unknown[]) => row.filter(v => String(v ?? "").trim()).every(v => /^(allocation|allocations|program|promotion)$/i.test(String(v).trim()));
export interface ProgramSource { headers: string[]; rows: Record<string, unknown>[]; meta: ProgramTableSource }

export function readProgramGrid(grid: unknown[][], now = new Date()): ProgramSource {
  let headerAt = grid.findIndex(r => r.some(skuHeading));
  if (headerAt < 0) headerAt = grid.findIndex(r => r.length === 1 && /^(sku|part\s*no\.?|stock\s*code)(?=rrp|gtm|\s)/i.test(String(r[0]).trim()));
  if (headerAt < 0) throw new Error("No SKU, Part No. or Stock Code heading found.");
  const flat = grid[headerAt].length === 1;
  const original = flat ? collapsedHeadings(String(grid[headerAt][0])) : grid[headerAt].map(v => String(v ?? "").trim());
  if (original.length > 150 || grid.length > 5000) throw new Error("Limit programs to 1,000 SKU rows and 150 columns.");
  const meta: ProgramTableSource = { ...programDates(grid.slice(0, headerAt), now), issues: [], rowNumbers: [] };
  const note = (row: number | null, column: string, message: string, blocking = false) => meta.issues.push({ row, column, message, blocking });
  for (let i = 0; i < headerAt; i++)
    if (group(grid[i])) note(i + 1, "", "Ignored group-heading row.");
  const counts = new Map<string, number>(), columns: { index: number; heading: string }[] = [], blankColumns: number[] = [];
  original.forEach((heading, index) => {
    if (!heading) { blankColumns.push(index); note(null, `Column ${index + 1}`, "Ignored blank spacer column."); return; }
    const n = (counts.get(norm(heading)) ?? 0) + 1; counts.set(norm(heading), n);
    const unique = n === 1 ? heading : `${heading} [duplicate ${n}]`;
    if (n > 1) note(null, unique, `Ignored repeated heading "${heading}"; kept the first column.`);
    columns.push({ index, heading: unique });
  });
  const headers = columns.map(c => c.heading), sourceRows: { cells: unknown[]; line: number }[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    let cells = grid[i].map(v => v ?? "");
    if (cells.every(v => String(v).trim() === "")) continue;
    if (group(cells)) { note(i + 1, "", "Ignored group-heading row."); continue; }
    if (cells.some(skuHeading) && cells.some(v => /gtm|rrp/i.test(String(v)))) {
      note(i + 1, "", "Ignored a repeated table header."); continue;
    }
    if (flat) {
      const recovered = collapsedRow(cells.map(String).join(""), original);
      cells = recovered.cells;
      if (recovered.warning) note(i + 1, "", recovered.warning, !recovered.recovered);
    }
    const first = String(cells[Math.max(0, original.findIndex(skuHeading))] ?? "").trim();
    const startsSku = /^(?=.*[a-z])[a-z0-9][a-z0-9._/-]{0,119}$/i.test(first);
    const previous = sourceRows.at(-1);
    let used = previous?.cells.length ?? 0;
    while (used > 0 && String(previous!.cells[used - 1]).trim() === "") used--;
    if (!startsSku && previous && used < original.length) {
      const remaining = [...cells];
      while (remaining.length && String(remaining[0]).trim() === "") remaining.shift();
      previous.cells = [...previous.cells.slice(0, used), ...remaining];
      note(previous.line, "", `Joined wrapped continuation from source line ${i + 1}.`);
      continue;
    }
    if (/^(total|grand total)$/i.test(first)) { note(i + 1, "", "Ignored calculated total/footer row."); continue; }
    for (const index of blankColumns) if (String(cells[index] ?? "").trim())
      note(i + 1, `Column ${index + 1}`, "Unheaded column contains data; restore its heading or assign it before building a draft.", true);
    sourceRows.push({ cells, line: i + 1 });
  }
  if (sourceRows.length > 1000) throw new Error("Limit programs to 1,000 SKU rows and 150 columns.");
  const rows = sourceRows.map(({ cells, line }) => {
    if (cells.slice(original.length).some(v => String(v).trim())) note(line, "", "Extra cells after the last heading were ignored.");
    meta.rowNumbers.push(line);
    return Object.fromEntries(columns.map(c => [c.heading, cells[c.index] ?? ""]));
  });
  return { headers, rows, meta };
}
export function readProgramText(text: string, now = new Date(), maxLength = 1_000_000): ProgramSource {
  if (!text.trim()) throw new Error("Paste a table with headings, up to 1 MB.");
  if (text.length > maxLength) throw new Error("Program text exceeds the supported file/paste size.");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines.find(l => /(?:^|[\t,| ]+)(?:sku|part\s*no\.?|stock\s*code)(?:[\t,| ]|rrp|gtm|$)/i.test(l.replace(/"/g, "")));
  if (!header) throw new Error("No SKU, Part No. or Stock Code heading found.");
  const delimiter = header.includes("\t") ? "\t" : header.includes("|") ? "|" : header.includes(",") ? "," : /\s{2,}/.test(header) ? "spaces" : "flat";
  if (delimiter === "flat") return readProgramGrid(lines.map(l => [l.trim()]), now);
  if (delimiter === "spaces") return readProgramGrid(lines.map(l => l.trimEnd().split(/ {2,}/)), now);
  const parsed = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  const result = readProgramGrid(parsed.data, now);
  for (const err of parsed.errors) result.meta.issues.push({ row: err.row != null ? err.row + 1 : null, column: "",
    message: `Could not read part of this row: ${err.message}`, blocking: true });
  return result;
}
