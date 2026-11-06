import * as XLSX from "xlsx";
import type { ScanbackBatch, ScanbackProgram, ScanbackImport } from "@workspace/api-zod";
import { maskCustomerText } from "./customer-display";
import { indexProntoSource } from "./scanback-pronto";
import type { Client } from "./scanback-store";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const maskedCodes: Record<string, string> = {
  ca: "CA", centrecom: "CC", cc: "CC", scorptec: "SC", sc: "SC",
  ple: "PL", pl: "PL", pccg: "PC", pc: "PC", umart: "UM", um: "UM",
  ks: "KS", jw: "JW", digi: "DI", digidirect: "DI", di: "DI",
};
const resellerLabel = (code: string) => maskedCodes[code.toLowerCase()] ?? maskCustomerText(code);
const spreadsheetSafe = (value: unknown): string | number | boolean =>
  typeof value === "string" && /^[=+@\-]/.test(value) ? `'${value}` :
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";

export interface ScanbackExportData {
  programs: ScanbackProgram[];
  batches: ScanbackBatch[];
  approvedSerials: {
    serial: string; batchId: string; reference: string; programName: string;
    accountCode: string; sku: string; amountCents: number;
  }[];
  creditResolutions: (string | number | boolean)[][];
  resellers: { id: number; code: string; name: string; active: boolean; expectedWeeklyFiles: number }[];
}

export function makeScanbackWorkbook(data: ScanbackExportData): Buffer {
  const workbook = XLSX.utils.book_new();
  const programs: (string | number | boolean)[][] = [["Promotion", "Start", "End", "Archived", "Notes", "SKU", "GTM Buy Ex cents", "Reseller caps"]];
  for (const program of data.programs) for (const line of program.lines) {
    const caps = line.caps.map(cap => {
      const reseller = data.resellers.find(item => item.id === cap.resellerId);
      return `${reseller ? resellerLabel(reseller.code) : cap.resellerId}: ${cap.quantity ?? "unlimited"} units`;
    }).join("; ");
    programs.push([
      maskCustomerText(program.name), program.start, program.end, program.archived, maskCustomerText(program.notes),
      line.sku ?? String(line.partId ?? ""), line.gtmBuyCents, caps,
    ].map(spreadsheetSafe) as (string | number | boolean)[]);
  }
  const batches: (string | number | boolean)[][] = [[
    "Reference", "Promotion", "Reseller", "Approved at", "Basis", "From", "To",
    "Approved serial count", "Total cents", "Historical",
  ]];
  for (const batch of data.batches) batches.push([
    batch.reference, maskCustomerText(batch.programName), resellerLabel(batch.accountCode), batch.createdAt,
    batch.basis, batch.from, batch.to, batch.approvedCount, batch.totalCents, batch.historical,
  ].map(spreadsheetSafe) as (string | number | boolean)[]);
  const serials: (string | number | boolean)[][] = [[
    "Serial", "Batch reference", "Promotion", "Reseller", "SKU", "Claim cents",
  ]];
  for (const row of data.approvedSerials) serials.push([
    row.serial, row.reference, maskCustomerText(row.programName), resellerLabel(row.accountCode), row.sku, row.amountCents,
  ].map(spreadsheetSafe) as (string | number | boolean)[]);
  const credits = [[
    "Import", "Source row", "Reseller", "Pronto account", "SKU", "Invoice", "Invoice date",
    "Quantity", "Resolution", "Returned serials", "Review note", "Resolved at", "Resolved by",
  ], ...data.creditResolutions].map(row => row.map(spreadsheetSafe)) as (string | number | boolean)[][];
  const resellers: (string | number | boolean)[][] = [[
    "Reseller code", "Reseller name", "Active", "Expected files per week",
  ], ...data.resellers.map(item => [
    resellerLabel(item.code), maskCustomerText(item.name), item.active, item.expectedWeeklyFiles,
  ])].map(row => row.map(spreadsheetSafe)) as (string | number | boolean)[][];
  for (const [name, rows] of [
    ["Programs", programs], ["Approved batches", batches], ["Approved serials", serials],
    ["Credit resolutions", credits], ["Resellers", resellers],
  ] as const) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = rows[0].map((_, index) => ({ wch: index === 0 ? 28 : 22 }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function buildScanbackWorkbook(c: Client): Promise<Buffer> {
  const programs = (await c.query("SELECT payload FROM scanback_programs ORDER BY created_at")).rows.map(row => row.payload as ScanbackProgram);
  const batches = (await c.query("SELECT payload FROM scanback_batches ORDER BY created_at")).rows.map(row => row.payload as ScanbackBatch);
  const resellers = (await c.query(`SELECT id,code,name,active,expected_weekly_files AS "expectedWeeklyFiles"
    FROM resellers ORDER BY code`)).rows as ScanbackExportData["resellers"];
  const approvedSerials = (await c.query(`SELECT s.serial,s.batch_id AS "batchId",
      b.payload->>'reference' AS reference,b.payload->>'programName' AS "programName",
      r.code AS "accountCode",COALESCE(s.sku,p.part_no,'') AS sku,s.amount_cents AS "amountCents"
    FROM scanback_approved_serials s
    JOIN scanback_batches b ON b.id=s.batch_id
    JOIN resellers r ON r.id=s.account_id
    LEFT JOIN parts p ON p.id=s.part_id
    ORDER BY b.created_at,s.serial`)).rows as ScanbackExportData["approvedSerials"];
  const creditRows = (await c.query(`SELECT id,payload - 'rows' AS payload,
      CASE WHEN payload ? 'prontoCreditRows' THEN NULL ELSE raw_sheets END AS raw_sheets
    FROM scanback_imports WHERE payload->>'kind'='evidence' AND payload ? 'pronto'`)).rows;
  const creditResolutions: (string | number | boolean)[][] = [];
  for (const source of creditRows) {
    const value = source.payload as ScanbackImport & {
      prontoCreditRows?: Record<string, unknown>[];
      prontoCreditResolutions?: { sourceRow: number; creditKey?: string; mode: string; serials: string[]; note: string; resolvedAt: string; resolvedBy: string }[];
    };
    const resolutions = value.prontoCreditResolutions ?? [];
    const raw = source.raw_sheets as Record<string, Record<string, unknown>[]>;
    const indexed = value.prontoCreditRows ?? indexProntoSource(raw?.[value.sheet] ?? [], value.prontoAccounts ?? {}).creditRows;
    for (const resolution of resolutions) {
      const row = indexed.find(item => Number(item.sourceRow) === resolution.sourceRow);
      if (!row) continue;
      const accountCode = String(row["Account Code"] ?? "");
      creditResolutions.push([
        maskCustomerText(value.name), resolution.sourceRow,
        resellerLabel(resellers.find(item => item.id === value.prontoAccounts?.[accountCode])?.code ?? accountCode),
        resellerLabel(resellers.find(item => item.id === value.prontoAccounts?.[accountCode])?.code ?? accountCode),
        String(row["Stock Code"] ?? ""), String(row["Invoice No"] ?? ""),
        String(row["Invoice Date"] ?? ""), Number(row["Ship Qty"]), resolution.mode,
        resolution.serials.join(", "), maskCustomerText(resolution.note), resolution.resolvedAt, resolution.resolvedBy,
      ]);
    }
  }
  return makeScanbackWorkbook({ programs, batches, approvedSerials, creditResolutions, resellers });
}

export { XLSX_MIME };
