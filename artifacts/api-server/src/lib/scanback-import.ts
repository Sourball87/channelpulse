import * as XLSX from "xlsx";
import type { ScanbackImport, ScanbackImportRow, ScanbackMapping } from "@workspace/api-zod";
import { cents, serialKey, validDate } from "./scanback-engine";

export type Sheets = Record<string, Record<string, unknown>[]>;
export interface Account { id: number; code: string; name: string }
const fields: Record<string, string[]> = {
  serial: ["serial", "serials", "serialno", "serialnumber", "sn", "imei"],
  sku: ["sku", "model", "stockcode", "part", "partnumber", "productcode"],
  date: ["date", "invoicedate", "selldate", "saledate", "orderdate", "approved"],
  account: ["accountcode", "customer", "customername", "account", "reseller", "prontoaccount"],
  quantity: ["qty", "quantity", "invoiceqty"],
  invoice: ["invoice", "invoiceno", "invoicenumber", "invoicereference"],
  unitPrice: ["invoicedunitpriceex", "invoicedunitpriceexgst", "unitpriceex", "unitprice", "price", "sellprice", "invoiceprice", "invoicecost"],
  amount: ["claim", "claimamount", "claimvalue", "amount", "claim$"],
  program: ["promotion", "program", "promotionname"],
  reference: ["batch", "reference", "claimreference"],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]/g, "");
export function suggestMapping(headers: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([f, aliases]) => {
    const matches = headers.filter(h => aliases.includes(norm(h)));
    // Multiple candidate date/price columns require an explicit choice.
    return [f, matches.length === 1 ? matches[0] : ""];
  }));
}
export function parseSheets(buffer: Buffer): Sheets {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: true, sheetRows: 20002 });
  const out: Sheets = {};
  let total = 0;
  for (const name of wb.SheetNames.slice(0, 15)) {
    const sheet = wb.Sheets[name];
    const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
    if (range.e.r > 20000 || range.e.c > 150) throw new Error("Limit each sheet to 20,000 rows and 150 columns.");
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: false });
    const headerAt = grid.slice(0, 20).findIndex(row => row.some(v => fields.serial.includes(norm(String(v)))));
    if (headerAt < 0) continue;
    const headers = grid[headerAt].map((v, i) => String(v || `Column ${i + 1}`).trim());
    if (new Set(headers).size !== headers.length) throw new Error(`Duplicate column headings in sheet ${name}; rename them before uploading.`);
    out[name] = grid.slice(headerAt + 1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])))
      .filter(row => Object.values(row).some(v => v !== "" && v != null));
    total += out[name].length;
    if (total > 50000) throw new Error("Limit each import to 50,000 rows.");
  }
  if (!Object.keys(out).length) throw new Error("No sheet with a serial-number heading found. Include a Serial Number column.");
  return out;
}
export function parseDate(v: unknown, mode: "dmy" | "mdy"): string {
  if (v === "" || v == null) return "";
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    const date = d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : "";
    return validDate(date) ? date : "";
  }
  const text = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validDate(text) ? text : "";
  const match = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2}|\d{4})$/);
  if (!match) return "";
  const year = match[3].length === 2 ? "20" + match[3] : match[3];
  const month = mode === "dmy" ? match[2] : match[1];
  const day = mode === "dmy" ? match[1] : match[2];
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return validDate(date) ? date : "";
}

export function mapImport(
  base: ScanbackImport, raw: Sheets, options: ScanbackMapping, accounts: Account[],
  skuCodes: Set<string>,
): ScanbackImport {
  const mapping = options.mapping;
  const rawRows = raw[options.sheet];
  if (!rawRows) throw new Error("Choose a valid worksheet.");
  const headers = Object.keys(rawRows[0] ?? {});
  if (Object.entries(mapping).some(([key, column]) => !fields[key] || (column && !headers.includes(column))))
    throw new Error("Mapping contains an unknown field or column.");
  const required = base.kind === "evidence"
    ? ["serial", "sku", "date", "invoice", "quantity", "unitPrice"]
    : base.kind === "history" ? ["serial", "sku", "date", "amount", "program", "reference"] : ["serial"];
  const errors: ScanbackImport["errors"] = [];
  for (const key of required) if (!mapping[key]) errors.push({ row: 0, message: `Map the ${key} column.` });
  if (base.kind !== "claim" && !mapping.account && !options.accountId)
    errors.push({ row: 0, message: "Map Account Code or choose an account for this file." });
  if (options.accountId && !accounts.some(a => a.id === options.accountId))
    throw new Error("Choose an existing Account Code.");
  if (base.kind === "evidence" && mapping.unitPrice && /cost|rrp|inc(?:l|gst)|total/i.test(mapping.unitPrice))
    errors.push({ row: 0, message: "Rename/select the invoiced UNIT PRICE EX GST column. Cost, total and GST-inclusive columns are not valid evidence prices." });
  const rows: ScanbackImportRow[] = [];
  rawRows.forEach((row, i) => {
    const value = (key: string) => mapping[key] ? row[mapping[key]] : "";
    const text = (key: string) => String(value(key) ?? "").trim();
    const serials = text("serial").split(/[|,;\n]+/).map(serialKey).filter(Boolean);
    const sku = text("sku").toUpperCase();
    const date = parseDate(value("date"), options.dateFormat);
    const name = text("account").toUpperCase();
    const matches = accounts.filter(a => a.code.toUpperCase() === name || a.name.toUpperCase() === name);
    let accountId = matches.length === 1 ? matches[0].id : options.accountId ?? null;
    const error = (message: string) => errors.push({ row: i + 2, message });
    if (typeof value("serial") === "number")
      error("Store serial numbers as text, not numeric cells, to preserve leading zeros and long identifiers.");
    if (!serials.length) { error("Serial is required; remove totals/non-serial rows."); return; }
    if (base.kind === "claim" && serials.length !== 1)
      error("Use exactly one serial per customer claim row; split serial lists into separate rows.");
    if (serials.some(s => !/^[A-Z0-9._/-]{3,100}$/.test(s))) error("Serial has unsupported characters or length.");
    if (matches.length > 1) { error("Account name is ambiguous; use an exact Account Code."); accountId = null; }
    if (matches.length === 1 && options.accountId && matches[0].id !== options.accountId)
      error("Account column conflicts with the selected fallback account.");
    if (name && !matches.length && !options.accountId) error(`Unmapped account: ${text("account")}`);
    if (base.kind !== "claim" && accountId === null) error("An existing Account Code is required.");
    if (sku && !skuCodes.has(sku)) error(`Unknown Stock Code: ${sku}`);
    if (base.kind !== "claim" && !sku) error("Stock Code is required.");
    if (value("date") !== "" && !date) error("Invalid date for the selected date format.");
    if (base.kind !== "claim" && !date) error("Date is required.");
    if (base.kind === "evidence" && !text("invoice")) error("Invoice / credit reference is required.");
    const quantity = value("quantity") === "" ? 1 : Number(value("quantity"));
    if (!Number.isSafeInteger(quantity) || quantity === 0) error("Quantity must be a nonzero whole number.");
    if (base.kind === "evidence" && Math.abs(quantity) !== serials.length)
      error("Invoice quantity must match the number of serials on the row.");
    const price = cents(value("unitPrice"));
    const amount = cents(value("amount"));
    if (base.kind === "evidence" && (price == null || price === 0 || (quantity > 0 && price < 0)))
      error("Valid invoiced unit price excluding GST is required.");
    if (base.kind === "history" && (amount == null || amount <= 0)) error("Historical approved claim amount must be positive.");
    if (base.kind === "history" && (!text("program") || !text("reference"))) error("Historical promotion and batch reference are required.");
    if (base.kind === "history" && (serials.length !== 1 || quantity !== 1)) error("Historical claims need exactly one serial and one unit per row.");
    for (const serial of serials) rows.push({
      rowIndex: rows.length, serial, sku, date, accountId,
      quantity: base.kind === "evidence" ? Math.sign(quantity) : quantity,
      invoice: text("invoice"), unitPriceCents: price == null ? null : Math.abs(price),
      amountCents: amount, program: text("program"), reference: text("reference"),
    });
  });
  if (!rows.length) errors.push({ row: 0, message: "No serial records found." });
  return {
    ...base, ...options, accountId: options.accountId ?? null, headers,
    rows, errors, recordCount: rows.length, warnings: [
      "Review dates and column mappings before committing. No AI is used.",
      ...(base.kind === "evidence" ? ["Unit price must be the amount invoiced to the reseller, excluding GST—not purchase cost."] : []),
    ],
  };
}
