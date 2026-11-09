import * as XLSX from "xlsx";
import { parseCsvBuffer } from "./csv-stream";
import { analyzeReportData, hashBuffer, type MappingField, type ParseResult, type ResellerProfile } from "./parser";

function readXlsx(
  buf: Buffer,
  filename: string,
): { headers: string[]; rawRows: Record<string, unknown>[]; sheetName: string } {
  const workbook = XLSX.read(buf, { type: "buffer" });
  let sheetName = workbook.SheetNames[0];
  for (const name of workbook.SheetNames) {
    const normalized = name.toLowerCase();
    if (normalized.includes("soh") || normalized.includes("forecast") ||
        normalized.includes("computeralliance") || normalized.includes("sheet1") ||
        normalized.startsWith("itemforcast")) {
      sheetName = name;
      break;
    }
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  if (!rows.length) return { headers: [], rawRows: [], sheetName };
  const headers = Object.keys(rows[0]).filter(
    heading => !/^__EMPTY(?:_\d+)?$/.test(heading) ||
      rows.some(row => row[heading] != null && row[heading] !== ""),
  );
  const rawRows = rows.map(row => Object.fromEntries(headers.map(heading => [heading, row[heading]])));
  return { headers, rawRows, sheetName };
}

export async function parseFile(
  buf: Buffer,
  filename: string,
  resellers: ResellerProfile[],
  savedMappings?: Map<string, MappingField[]>,
  learnedFingerprints?: Map<string, number>,
): Promise<ParseResult> {
  const fileHash = hashBuffer(buf);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  let headers: string[];
  let rawRows: Record<string, unknown>[];
  let sheetName: string | null;

  if (ext === "csv") {
    const result = await parseCsvBuffer(buf);
    headers = result.headers;
    rawRows = result.rows;
    sheetName = null;
  } else {
    const result = readXlsx(buf, filename);
    headers = result.headers;
    rawRows = result.rawRows;
    sheetName = result.sheetName;
  }

  return analyzeReportData({
    filename, headers, rawRows, sheetName, fileHash,
    parserUsed: ext === "csv" ? "papaparse" : "sheetjs",
  }, resellers, savedMappings, learnedFingerprints);
}
