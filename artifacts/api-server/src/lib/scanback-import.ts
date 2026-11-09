import * as XLSX from "xlsx";
import type { ScanbackImport, ScanbackImportRow, ScanbackMapping } from "@workspace/api-zod";
import { cents, serialKey, validDate } from "./scanback-engine";
import { dateStringToWeekIso, mostCommonWeek, parseDateValue } from "./dates";
import { parseCsvBuffer } from "./csv-stream";
import { isPronto, prontoColumns, prontoMapping, scopePronto, splitSerials, unmatchedCreditReason } from "./scanback-pronto";

export type Sheets = Record<string, Record<string, unknown>[]>;
export interface Account { id: number; code: string; name: string; active?: boolean }
const fields: Record<string, string[]> = {
  serial: ["serial", "serials", "serialno", "serialnumber", "sn", "imei"],
  sku: ["sku", "model", "modelnumber", "stockcode", "part", "partnumber", "productcode"],
  date: ["date", "saleday", "invoicedate", "selldate", "saledate", "orderdate", "approved"],
  account: ["accountcode", "customer", "customername", "account", "reseller", "prontoaccount"],
  quantity: ["qty", "quantity", "invoiceqty"],
  invoice: ["invoice", "invoiceno", "invoicenumber", "invoicereference"],
  unitPrice: ["invoicedunitpriceex", "invoicedunitpriceexgst", "unitpriceex", "unitprice", "price", "sellprice", "invoiceprice", "invoicecost"],
  cost: ["ourcost", "ourunitcostexgst", "purchasecost", "unitcost", "costex", "costexgst", "itemcost", "ddcostex", "ddcost", "cost"],
  amount: ["claim", "claimamount", "claimvalue", "amount", "claim$"],
  program: ["promotion", "program", "promotionname"],
  reference: ["batch", "reference", "claimreference"],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]/g, "");
const matchesField = (field: string, heading: string) => {
  const normalized = norm(heading);
  return fields[field].includes(normalized) ||
    (field === "serial" && (normalized.includes("serial") || normalized.includes("imei")));
};
export function detectImportKind(headers: string[]): ScanbackImport["kind"] {
  if (isPronto(headers)) return "evidence";
  const has = (key: string) => headers.some(h => matchesField(key, h));
  const evidence = ["invoice", "quantity", "unitPrice"].every(has);
  const history = ["amount", "program", "reference"].every(has);
  if (evidence && history)
    throw new Error("This sheet contains both invoice and approval columns. Choose its spreadsheet type explicitly.");
  if (history) return "history";
  if (evidence) return "evidence";
    if (["invoice", "unitPrice", "amount", "program", "reference"].some(has))
    throw new Error("Could not confidently detect this spreadsheet type. Choose Invoice / credit evidence or Customer claim.");
  if (has("serial")) return "claim";
  throw new Error("Could not detect the spreadsheet type. A serial-number heading is required.");
}
export function suggestMapping(headers: string[]): Record<string, string> {
  if (isPronto(headers)) {
    const costs = headers.filter(h => fields.cost.includes(norm(h)));
    return { ...prontoMapping, cost: costs.length === 1 ? costs[0] : "" };
  }
  const saleDay = headers.filter(h => norm(h) === "saleday");
  return Object.fromEntries(Object.entries(fields).map(([f, aliases]) => {
    const matches = headers.filter(h => matchesField(f, h));
    if (f === "date" && saleDay.length === 1) return [f, saleDay[0]];
    // Multiple candidate date/price columns require an explicit choice.
    return [f, matches.length === 1 ? matches[0] : ""];
  }));
}

export async function parseCsvSheets(buffer: Buffer): Promise<Sheets> {
  const parsed = await parseCsvBuffer(buffer);
  if (!parsed.headers.some(h => matchesField("serial", h)))
    throw new Error("No serial-number heading found. Include a Serial Number column.");
  const retained = isPronto(parsed.headers) ? prontoColumns(parsed.headers) : parsed.headers;
  const rows = parsed.rows.map((row, index) => ({
    ...Object.fromEntries(retained.map(h => [h, row[h] ?? ""])),
    __sourceRow: index + 2,
  })).filter(row => Object.entries(row).some(([key, value]) => key !== "__sourceRow" && value !== "" && value != null));
  if (!rows.length) throw new Error("The CSV contains no serial rows.");
  return { CSV: rows };
}

export function filterFullHistorySerialRows(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
  knownSerials: Iterable<string>,
  fallbackWeek: string | null = null,
) {
  const dateColumn = mapping.date;
  const serialColumn = mapping.serial;
  const contentWeek = mostCommonWeek(dateColumn ? rows.map(row => row[dateColumn]) : []).weekIso;
  const detectedWeek = contentWeek ?? fallbackWeek;
  const seen = new Set([...knownSerials].map(serialKey).filter(Boolean));
  const kept: Record<string, unknown>[] = [];
  let skippedKnownHistory = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const serials = String(serialColumn ? row[serialColumn] ?? "" : "")
      .split(/[|,;\n]+/).map(serialKey).filter(Boolean);
    const rowWeek = dateColumn ? dateStringToWeekIso(parseDate(row[dateColumn], "dmy")) : "";
    const inDetectedWeek = !!detectedWeek && rowWeek === detectedWeek;
    const unseen = serials.some(serial => !seen.has(serial));
    if (inDetectedWeek || unseen) {
      kept.push({ ...row, __sourceRow: Number(row.__sourceRow) || i + 2 });
      for (const serial of serials) seen.add(serial);
    } else {
      skippedKnownHistory++;
    }
  }
  return { rows: kept, weekIso: detectedWeek, contentWeek, skippedKnownHistory };
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
    const headerAt = grid.slice(0, 20).findIndex(row => row.some(v => matchesField("serial", String(v))));
    if (headerAt < 0) continue;
    const headers = grid[headerAt].map((v, i) => String(v || `Column ${i + 1}`).trim());
    if (new Set(headers).size !== headers.length) throw new Error(`Duplicate column headings in sheet ${name}; rename them before uploading.`);
    // Pronto contains addresses, phones, contacts and user IDs unrelated to
    // verification. Do not retain those columns in persistent preview data.
    const retained = isPronto(headers) ? prontoColumns(headers) : headers;
    const indices = retained.map(h => headers.indexOf(h));
    out[name] = grid.slice(headerAt + 1).map(row => Object.fromEntries(retained.map((h, i) => [h, row[indices[i]] ?? ""])))
      .filter(row => Object.values(row).some(v => v !== "" && v != null));
    total += out[name].length;
    if (total > 50000) throw new Error("Limit each import to 50,000 rows.");
  }
  if (!Object.keys(out).length) throw new Error("No sheet with a serial-number heading found. Include a Serial Number column.");
  return out;
}
export function parseDate(v: unknown, mode: "dmy" | "mdy"): string {
  return parseDateValue(v, mode);
}

export function prontoDateRange(rows: Record<string, unknown>[], mode: "dmy" | "mdy") {
  const dates = rows.map(row => parseDate(row["Invoice Date"], mode)).filter(Boolean).sort();
  return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
}
export function prontoRangeCovers(
  newerRows: Record<string, unknown>[], newerMode: "dmy" | "mdy",
  olderRows: Record<string, unknown>[], olderMode: "dmy" | "mdy",
) {
  const newer = prontoDateRange(newerRows, newerMode), older = prontoDateRange(olderRows, olderMode);
  return !!newer && !!older && newer.from <= older.from && newer.to >= older.to;
}

export function mapImport(
  base: ScanbackImport, raw: Sheets, options: ScanbackMapping, accounts: Account[],
  skuCodes: Set<string>,
): ScanbackImport {
  const mapping = options.mapping;
  const rawRows = raw[options.sheet];
  if (!rawRows) throw new Error("Choose a valid worksheet.");
  const headers = Object.keys(rawRows[0] ?? {}).filter(h => h !== "__sourceRow");
  if (Object.entries(mapping).some(([key, column]) => !fields[key] || (column && !headers.includes(column))))
    throw new Error("Mapping contains an unknown field or column.");
  const required = base.kind === "evidence"
    ? ["serial", "sku", "date", "invoice", "quantity", "unitPrice"]
    : base.kind === "history" ? ["serial", "sku", "date", "amount", "program", "reference"] : ["serial"];
  const errors: ScanbackImport["errors"] = [];
  const native = isPronto(headers);
  if (native && base.kind !== "evidence") throw new Error("This is a Pronto POS extract. Choose Invoice / credit evidence, not customer claims or historical approvals.");
  if (native && (options.accountId != null || Object.entries(prontoMapping).some(([key, column]) => (mapping[key] ?? "") !== column)))
    throw new Error("Pronto POS uses its fixed invoice/price columns and per-Pronto-account mappings; a single fallback account is not allowed.");
  const scope = native ? scopePronto(rawRows, options, accounts) : undefined;
  if (scope) errors.push(...scope.errors);
  for (const key of required) if (!mapping[key]) errors.push({ row: 0, message: `Map the ${key} column.` });
  if (base.kind !== "claim" && !mapping.account && !options.accountId)
    errors.push({ row: 0, message: "Map Account Code or choose an account for this file." });
  if (options.accountId && !accounts.some(a => a.id === options.accountId))
    throw new Error("Choose an existing Account Code.");
  if (base.kind === "evidence" && mapping.unitPrice && /cost|rrp|inc(?:l|gst)|total/i.test(mapping.unitPrice))
    errors.push({ row: 0, message: "Rename/select the invoiced UNIT PRICE EX GST column. Cost, total and GST-inclusive columns are not valid evidence prices." });
  const rows: ScanbackImportRow[] = [];
  rawRows.forEach((row, i) => {
    if (scope && !scope.include.has(i)) return;
    const value = (key: string) => mapping[key] ? row[mapping[key]] : "";
    const text = (key: string) => String(value(key) ?? "").trim();
    const serials = scope ? splitSerials(value("serial")) : text("serial").split(/[|,;\n]+/).map(serialKey).filter(Boolean);
    if (rows.length + serials.length > 1_000_000)
      throw new Error("Limit each import to 1,000,000 serial events; split this extract.");
    const sku = text("sku").toUpperCase();
    const date = parseDate(value("date"), options.dateFormat);
    const name = text("account").toUpperCase();
    const matches = accounts.filter(a => a.code.toUpperCase() === name || a.name.toUpperCase() === name);
    let accountId = scope ? scope.include.get(i)! : matches.length === 1 ? matches[0].id : options.accountId ?? null;
    const error = (message: string) => errors.push({ row: i + 2, message });
    if (typeof value("serial") === "number")
      error("Store serial numbers as text, not numeric cells, to preserve leading zeros and long identifiers.");
    if (!serials.length) { error("Serial is required; remove totals/non-serial rows."); return; }
    if (base.kind === "claim" && serials.length !== 1)
      error("Use exactly one serial per customer claim row; split serial lists into separate rows.");
    if (serials.some(s => !/^[A-Z0-9._/-]{3,100}$/.test(s))) error("Serial has unsupported characters or length.");
    if (!scope && matches.length > 1) { error("Account name is ambiguous; use an exact Account Code."); accountId = null; }
    if (!scope && matches.length === 1 && options.accountId && matches[0].id !== options.accountId)
      error("Account column conflicts with the selected fallback account.");
    if (!scope && name && !matches.length && !options.accountId) error(`Unmapped account: ${text("account")}`);
    if (base.kind !== "claim" && accountId === null) error("An existing Account Code is required.");
    // Scanback promotions can name customer-supplied SKUs without creating
    // product-catalogue rows. A typo cannot pay unless an exact promotion line
    // and invoice both use the same code.
    if (base.kind !== "claim" && !sku) error("Stock Code is required.");
    if (value("date") !== "" && !date) error("Invalid date for the selected date format.");
    if (base.kind !== "claim" && !date) error("Date is required.");
    if (base.kind === "evidence" && !text("invoice")) error("Invoice / credit reference is required.");
    const quantity = value("quantity") === "" ? 1 : Number(value("quantity"));
    if (!Number.isSafeInteger(quantity) || quantity === 0) error("Quantity must be a nonzero whole number.");
    if (base.kind === "evidence" && !scope && Math.abs(quantity) !== serials.length)
      error("Invoice quantity must match the number of serials on the row.");
    const price = cents(value("unitPrice"));
    const cost = cents(value("cost"));
    if (base.kind === "evidence" && String(value("cost") ?? "").trim() !== "" && cost == null)
      error("Our cost must be blank or a valid unit amount with up to two decimal places (reference only).");
    const amount = cents(value("amount"));
    if (base.kind === "evidence" && (price == null || (quantity > 0 && price < 0)))
      error("Valid invoiced unit price excluding GST is required.");
    if (scope && (price == null || cents(row["Line Price Ex"]) == null || price * quantity !== cents(row["Line Price Ex"])))
      error("Item Price × Ship Qty does not equal Line Price Ex to exact cents. Review this Pronto invoice line.");
    if (scope && String(row.Currency ?? "").trim() && String(row.Currency).trim().toUpperCase() !== "AUD")
      error("Foreign-currency Pronto invoices cannot be compared with AUD promotion prices. Supply AUD evidence; no exchange rate is guessed.");
    if (base.kind === "history" && (amount == null || amount <= 0)) error("Historical approved claim amount must be positive.");
    if (base.kind === "history" && (!text("program") || !text("reference"))) error("Historical promotion and batch reference are required.");
    if (base.kind === "history" && (serials.length !== 1 || quantity !== 1)) error("Historical claims need exactly one serial and one unit per row.");
    for (const serial of serials) rows.push({
      rowIndex: rows.length, serial, sku, date, accountId,
      quantity: base.kind === "evidence" ? Math.sign(quantity) : quantity,
      invoice: text("invoice"), unitPriceCents: price == null ? null : Math.abs(price),
      costCents: cost == null ? null : Math.abs(cost),
      amountCents: amount, program: text("program"), reference: text("reference"),
      sourceRow: Number(row.__sourceRow) || i + 2,
    });
  });
  const unmatchedCreditCount = scope?.preview.excludedCounts[unmatchedCreditReason] ?? 0;
  if (!rows.length && !unmatchedCreditCount) errors.push({ row: 0, message: "No serial records found." });
  const unlistedSkus = [...new Set(rows.map(row => row.sku).filter(sku => !skuCodes.has(sku)))];
  return {
    ...base, ...options, accountId: options.accountId ?? null, headers,
    pronto: scope?.preview, prontoAccounts: scope ? options.prontoAccounts ?? {} : undefined,
    rows, errors, recordCount: rows.length, warnings: [
      "Review dates and column mappings before committing. No AI is used.",
      ...(base.kind === "evidence" ? ["Unit price must be the amount invoiced to the reseller, excluding GST—not purchase cost."] : []),
      ...(scope ? [
        "Pronto POS: Invoice Date, Ship Qty and Item Price are used. Cost, RRP, contact and address fields are not retained.",
        `${scope.preview.includedSourceRows} source rows included; ${scope.preview.excludedSourceRows} excluded. Excluded rows are not evidence and cannot make a serial payable.`,
        "Only explicitly mapped accounts and existing Stock Codes are included. Review every account mapping and exclusion before committing.",
        "Serials also appearing in excluded Pronto rows remain subject to ownership/return review; excluding an account cannot hide conflicting evidence.",
        ...scope.warnings,
        ...(unmatchedCreditCount ? [`${unmatchedCreditCount} selected Pronto credit(s) have no serial. They are listed in Upload Center and hold claims for the same reseller/SKU until resolved with returned serials or a review note.`] : []),
      ] : []),
      ...(unlistedSkus.length ? [`Not in the product catalogue (enter the exact code on a promotion to make these claimable): ${unlistedSkus.slice(0, 25).join(", ")}${unlistedSkus.length > 25 ? " …" : ""}. No product SKUs were created.`] : []),
    ],
  };
}
