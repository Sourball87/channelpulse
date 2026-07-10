import * as XLSX from "xlsx";
import Papa from "papaparse";
import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedRow {
  part_no: string | null;
  soh: number;
  sell_through_7d: number;
  sold_mtd: number | null;
  on_order: number | null;
  avg_cost: number | null;
  sold_14d: number | null;
  sold_30d: number | null;
  raw: Record<string, unknown>;
  flagged: boolean;
  flag_reason?: string;
}

export interface MappingField {
  source_col: string;
  canonical_field: string | null;
  confidence: number;
  sample_values: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  rawRows: Record<string, unknown>[];
  headers: string[];
  mappings: MappingField[];
  overallConfidence: number;
  parserUsed: string;
  detectedResellerId: number | null;
  detectedResellerName: string | null;
  detectedWeekIso: string | null;
  detectedReportDate: string | null;
  fileHash: string;
  rowsParsed: number;
  rowsFlagged: number;
  sheetName: string | null;
}

export interface ResellerProfile {
  id: number;
  name: string;
  code: string;
  filenamePatterns: string[];
  aliases: string[];
}

// ─── Synonym dictionary ───────────────────────────────────────────────────────

const SYNONYMS: Record<string, string[]> = {
  part_no: [
    "model", "modelcode", "partnumber", "sku", "manufacturermodel",
    "productmodel", "partno", "productcode", "itemcode",
    "itemno", "itemsku",
  ],
  soh: [
    "soh", "stockonhand", "onhand", "totalonhand", "quantityonhand",
    "stock", "totalstock", "availablestock", "currentstock",
  ],
  sell_through_7d: [
    "soldlast7days", "soldqty", "7d", "invoicedquantity", "soldlastweek",
    "weeklysales", "saleslastweek",
  ],
  sold_mtd: ["soldmtd", "salesmtd", "monthtodatesales"],
  sold_14d: ["14d", "soldlast14days", "last14days"],
  sold_30d: ["30d", "soldlast30days", "last30days"],
  on_order: [
    "qtyonpo", "stockonorder", "qtyonorder", "onorderqty",
    "quantityonorder", "onorder", "ordered",
  ],
  avg_cost: [
    "avgcost", "averagecostexgst", "itemaveragecostexgst",
    "averagecostextax", "avgstockvalue", "cost", "averagecost",
    "unitcost",
  ],
};

// Samsung part number prefixes for validation
const SAMSUNG_PREFIXES = ["MZ-", "MU-", "MUF-", "LS", "LU", "SM-", "MB-", "MJ-", "HAJ"];

// ─── Utility functions ────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function coerceInt(val: unknown): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = parseFloat(String(val).replace(/,/g, ""));
  if (isNaN(n)) return 0;
  return Math.round(n);
}

function coerceFloat(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(String(val).replace(/,/g, ""));
  if (isNaN(n)) return null;
  return n;
}

function isSamsungPart(partNo: string): boolean {
  const upper = partNo.toUpperCase().trim();
  return SAMSUNG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─── Date detection ───────────────────────────────────────────────────────────

export function detectWeekFromFilename(filename: string): {
  weekIso: string | null;
  reportDate: string | null;
} {
  // 2026_WK_27 or 2026_WK27
  const wkMatch = filename.match(/(\d{4})[_\-]?WK[_\-]?(\d{1,2})/i);
  if (wkMatch) {
    const year = wkMatch[1];
    const week = wkMatch[2].padStart(2, "0");
    return { weekIso: `${year}-W${week}`, reportDate: null };
  }

  // 2026-06-29_2026-07-05 (range: use end date)
  const rangeMatch = filename.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  if (rangeMatch) {
    const endDate = rangeMatch[2];
    const weekIso = dateStringToWeekIso(endDate);
    return { weekIso, reportDate: endDate };
  }

  // 29.06.2026 or 29_06_2026
  const dmy = filename.match(/(\d{2})[._](\d{2})[._](\d{4})/);
  if (dmy) {
    const dateStr = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    return { weekIso: dateStringToWeekIso(dateStr), reportDate: dateStr };
  }

  // 20260705060455 (yyyymmddHHMMSS)
  const compact = filename.match(/(\d{4})(\d{2})(\d{2})\d{6}/);
  if (compact) {
    const dateStr = `${compact[1]}-${compact[2]}-${compact[3]}`;
    return { weekIso: dateStringToWeekIso(dateStr), reportDate: dateStr };
  }

  // YYYY-MM-DD
  const iso = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) {
    return { weekIso: dateStringToWeekIso(iso[1]), reportDate: iso[1] };
  }

  return { weekIso: null, reportDate: null };
}

export function dateStringToWeekIso(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function currentWeekIso(): string {
  return dateStringToWeekIso(new Date().toISOString().split("T")[0]);
}

/** Returns the most recently completed ISO week (the week that ended last Sunday). */
export function previousCompletedWeekIso(): string {
  const now = new Date();
  const dow = now.getUTCDay() || 7; // 1=Mon..7=Sun
  // Go back to last Sunday (end of the previous full week), then use Thursday of that week
  const lastSunday = new Date(now.getTime() - dow * 86400000);
  return dateStringToWeekIso(lastSunday.toISOString().split("T")[0]);
}

/** Returns the ISO week immediately before weekIso, correctly handling 53-week years. */
export function previousWeekIso(weekIso: string): string {
  const [yearStr, weekStr] = weekIso.split("-W");
  const year = parseInt(yearStr);
  const week = parseInt(weekStr);
  // Find Monday of the given week via ISO week arithmetic, then subtract 7 days
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const weekMonday = new Date(jan4.getTime() - (dow - 1) * 86400000 + (week - 1) * 7 * 86400000);
  const prevMonday = new Date(weekMonday.getTime() - 7 * 86400000);
  return dateStringToWeekIso(prevMonday.toISOString().split("T")[0]);
}

// ─── Reseller detection ───────────────────────────────────────────────────────

export function detectResellerFromFilename(
  filename: string,
  resellers: ResellerProfile[],
): { resellerId: number | null; resellerName: string | null; confidence: number } {
  const lower = filename.toLowerCase();

  // Built-in filename hints (in addition to DB patterns)
  const builtinHints: Record<string, string[]> = {
    scorptec: ["scorptec", "scorp"],
    ks: ["_ks_", "_ks.", "ks_report", "samsung_ssd_soh_reports_ks", "samsung_monitor_soh_reports_ks", "samsung_mobility_soh_reports_ks"],
    computeralliance: ["computeralliance", "computer_alliance", "samsung_soh_report"],
    umart: ["umart", "sell_thru_and_soh", "samsung_ssd_sell_thru"],
    ple: ["reportingprocurementcustom", "ple"],
    centrecom: ["centrecom"],
    pccg: ["pccg"],
    jw: ["jw_", "_jw_", "jw."],
    digi: ["digi", "digidirect"],
  };

  for (const reseller of resellers) {
    // Check DB filename patterns
    for (const pattern of reseller.filenamePatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.95 };
      }
    }

    // Check built-in hints by code
    const hints = builtinHints[reseller.code.toLowerCase()] ?? [];
    for (const hint of hints) {
      if (lower.includes(hint.toLowerCase())) {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.9 };
      }
    }

    // Check aliases
    for (const alias of reseller.aliases) {
      if (lower.includes(alias.toLowerCase())) {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.85 };
      }
    }
  }

  return { resellerId: null, resellerName: null, confidence: 0 };
}

export function detectResellerFromHeaders(
  headers: string[],
  sheetName: string | null,
  resellers: ResellerProfile[],
): { resellerId: number | null; resellerName: string | null; confidence: number } {
  const normalizedHeaders = new Set(headers.map((h) => normalize(h)));

  // Known header fingerprints per reseller code
  const fingerprints: Record<string, string[][]> = {
    // CA / KS style
    computeralliance: [["model", "stockonhand", "stockonorder", "soldlast7days", "soldmtd", "averagecostexgst"]],
    ks: [["model", "stockonhand", "stockonorder", "soldlast7days", "soldmtd", "averagecostexgst"]],
    // Scorptec CSV
    scorptec: [["category", "model", "onhand", "soldlast7days", "itemaveragecostexgst", "itemaveragecostincgst", "qtyonorder"]],
    // PLE
    ple: [["inventoryitemid", "manufacturermodel", "quantityonhand", "quantityonorder", "invoicedquantity", "averagecostextax"]],
    // Umart
    umart: [["sapcode", "sku", "totalonhand", "otheronhand", "daystosale", "onorderqty", "soldqty"]],
    // JW
    jw: [["modelcode", "soh", "soldlast7days", "soldmtd", "qtyonpo", "avgcost"]],
    // V Report
    vreport: [["partnumber", "soh", "soldlast7days", "soldmtd", "avgcost"]],
    // Centrecom legacy .xls
    centrecom: [["productname", "productmodel", "30d", "14d", "7d", "stock", "avgstockvalue"]],
  };

  // Sheet name detection
  if (sheetName) {
    const sl = sheetName.toLowerCase();
    for (const reseller of resellers) {
      if (sl.includes("computeralliance")) {
        if (reseller.code.toLowerCase() === "ca") return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.9 };
      }
      if (sl.includes("samsung soh report") || sl.includes("samsungsohreport")) {
        if (reseller.code.toLowerCase() === "ks") return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.9 };
      }
      if (sl.includes("itemforcastreport") || sl.includes("itemforecastreport")) {
        if (reseller.code.toLowerCase() === "umart") return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.9 };
      }
      if (sl === "forecast") {
        if (reseller.code.toLowerCase() === "centrecom") return { resellerId: reseller.id, resellerName: reseller.name, confidence: 0.85 };
      }
    }
  }

  let bestMatch = { resellerId: null as number | null, resellerName: null as string | null, confidence: 0 };

  for (const reseller of resellers) {
    const fp = fingerprints[reseller.code.toLowerCase()];
    if (!fp) continue;

    for (const knownHeaders of fp) {
      const knownSet = new Set(knownHeaders.map(normalize));
      const sim = jaccardSimilarity(normalizedHeaders, knownSet);
      if (sim >= 0.7 && sim > bestMatch.confidence) {
        bestMatch = { resellerId: reseller.id, resellerName: reseller.name, confidence: sim };
      }
    }
  }

  // If nothing matched yet, try a looser match against the V report (single-reseller files)
  // Could be any reseller sending the V_ report style
  if (bestMatch.confidence === 0) {
    const vReportHeaders = new Set(["partnumber", "soh", "soldlast7days", "soldmtd", "avgcost"].map(normalize));
    const sim = jaccardSimilarity(normalizedHeaders, vReportHeaders);
    if (sim >= 0.7) {
      bestMatch = { resellerId: null, resellerName: "Unknown (V-Report style)", confidence: sim * 0.6 };
    }
  }

  return bestMatch;
}

// ─── Column mapping ───────────────────────────────────────────────────────────

export function mapHeaders(headers: string[], rawRows: Record<string, unknown>[]): MappingField[] {
  return headers.map((header) => {
    const norm = normalize(header);
    let bestField: string | null = null;
    let bestConfidence = 0;

    for (const [field, synonyms] of Object.entries(SYNONYMS)) {
      // Exact match
      if (synonyms.includes(norm)) {
        bestField = field;
        bestConfidence = 1.0;
        break;
      }

      // Near match (Levenshtein ≤ 2)
      for (const syn of synonyms) {
        const dist = levenshtein(norm, syn);
        const maxLen = Math.max(norm.length, syn.length);
        if (dist <= 2 && maxLen > 0) {
          const conf = 1 - dist / maxLen;
          if (conf > bestConfidence) {
            bestField = field;
            bestConfidence = conf;
          }
        }
      }
    }

    const sampleValues = rawRows
      .slice(0, 5)
      .map((r) => String(r[header] ?? ""))
      .filter(Boolean);

    return {
      source_col: header,
      canonical_field: bestConfidence >= 0.6 ? bestField : null,
      confidence: bestConfidence,
      sample_values: sampleValues,
    };
  });
}

function computeMappingConfidence(mappings: MappingField[]): number {
  const hasPartNo = mappings.some((m) => m.canonical_field === "part_no" && m.confidence >= 0.8);
  const hasSoh = mappings.some((m) => m.canonical_field === "soh" && m.confidence >= 0.8);
  const hasSt = mappings.some((m) => m.canonical_field === "sell_through_7d" && m.confidence >= 0.8);

  if (!hasPartNo) return 0.2;

  let score = 0.4;
  if (hasPartNo) score += 0.25;
  if (hasSoh) score += 0.2;
  if (hasSt) score += 0.15;

  const avgFieldConf = mappings
    .filter((m) => m.canonical_field)
    .reduce((acc, m) => acc + m.confidence, 0) / Math.max(1, mappings.filter((m) => m.canonical_field).length);

  return Math.min(1, score * avgFieldConf + score * (1 - avgFieldConf) * 0.7);
}

// ─── Row parsing ──────────────────────────────────────────────────────────────

export function applyMappingsToRows(
  rawRows: Record<string, unknown>[],
  mappings: MappingField[],
): ParsedRow[] {
  const fieldMap: Record<string, string> = {};
  for (const m of mappings) {
    if (m.canonical_field) {
      fieldMap[m.source_col] = m.canonical_field;
    }
  }

  const results: ParsedRow[] = [];

  for (const raw of rawRows) {
    const canonical: Record<string, unknown> = {};
    for (const [srcCol, canonField] of Object.entries(fieldMap)) {
      canonical[canonField] = raw[srcCol];
    }

    const partNo = String(canonical.part_no ?? "").trim();
    if (!partNo) continue;

    const flagged = !isSamsungPart(partNo);
    const soh = coerceInt(canonical.soh);
    const negativeSoh = soh < 0;

    results.push({
      part_no: partNo || null,
      soh,
      sell_through_7d: coerceInt(canonical.sell_through_7d),
      sold_mtd: canonical.sold_mtd !== undefined ? coerceInt(canonical.sold_mtd) : null,
      on_order: canonical.on_order !== undefined ? coerceInt(canonical.on_order) : null,
      avg_cost: coerceFloat(canonical.avg_cost),
      sold_14d: canonical.sold_14d !== undefined ? coerceInt(canonical.sold_14d) : null,
      sold_30d: canonical.sold_30d !== undefined ? coerceInt(canonical.sold_30d) : null,
      raw,
      flagged: flagged || negativeSoh,
      flag_reason: flagged
        ? "Not a Samsung part number"
        : negativeSoh
        ? "Negative SOH value"
        : undefined,
    });
  }

  return results;
}

// ─── File reading ─────────────────────────────────────────────────────────────

function readXlsx(
  buf: Buffer,
  filename: string,
): { headers: string[]; rawRows: Record<string, unknown>[]; sheetName: string } {
  const workbook = XLSX.read(buf, { type: "buffer" });

  // Prefer specific sheet names
  let sheetName = workbook.SheetNames[0];
  for (const name of workbook.SheetNames) {
    const nl = name.toLowerCase();
    if (
      nl.includes("soh") ||
      nl.includes("forecast") ||
      nl.includes("computeralliance") ||
      nl.includes("sheet1") ||
      nl.startsWith("itemforcast")
    ) {
      sheetName = name;
      break;
    }
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });

  if (rows.length === 0) return { headers: [], rawRows: [], sheetName };

  const headers = Object.keys(rows[0]);
  return { headers, rawRows: rows as Record<string, unknown>[], sheetName };
}

function readCsv(buf: Buffer): { headers: string[]; rawRows: Record<string, unknown>[]; sheetName: string } {
  const text = buf.toString("utf-8");
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  const headers = result.meta.fields ?? [];
  return { headers, rawRows: result.data, sheetName: "CSV" };
}

// ─── Main parse function ──────────────────────────────────────────────────────

export async function parseFile(
  buf: Buffer,
  filename: string,
  resellers: ResellerProfile[],
  savedMappings?: Map<string, MappingField[]>,
): Promise<ParseResult> {
  const fileHash = hashBuffer(buf);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  let headers: string[] = [];
  let rawRows: Record<string, unknown>[] = [];
  let sheetName: string | null = null;

  if (ext === "csv") {
    const r = readCsv(buf);
    headers = r.headers;
    rawRows = r.rawRows;
    sheetName = null;
  } else {
    const r = readXlsx(buf, filename);
    headers = r.headers;
    rawRows = r.rawRows;
    sheetName = r.sheetName;
  }

  // Reseller detection: filename first, then headers
  let resellerResult = detectResellerFromFilename(filename, resellers);
  if (resellerResult.confidence < 0.7) {
    const headerResult = detectResellerFromHeaders(headers, sheetName, resellers);
    if (headerResult.confidence > resellerResult.confidence) {
      resellerResult = headerResult;
    }
  }

  // Date detection from filename
  const { weekIso, reportDate } = detectWeekFromFilename(filename);

  // Column mapping
  let mappings: MappingField[];

  // Check for saved mappings for this reseller
  if (savedMappings && resellerResult.resellerId) {
    const fingerprint = computeHeaderFingerprint(headers);
    const saved = savedMappings.get(`${resellerResult.resellerId}:${fingerprint}`);
    if (saved) {
      mappings = saved;
    } else {
      mappings = mapHeaders(headers, rawRows);
    }
  } else {
    mappings = mapHeaders(headers, rawRows);
  }

  // Apply mappings to rows
  const parsedRows = applyMappingsToRows(rawRows, mappings);
  const rowsParsed = parsedRows.length;
  const rowsFlagged = parsedRows.filter((r) => r.flagged).length;

  // Overall confidence
  const resellerConf = resellerResult.confidence;
  const mappingConf = computeMappingConfidence(mappings);
  const overallConfidence = resellerConf * 0.5 + mappingConf * 0.5;

  return {
    rows: parsedRows,
    rawRows,
    headers,
    mappings,
    overallConfidence,
    parserUsed: ext === "csv" ? "papaparse" : "sheetjs",
    detectedResellerId: resellerResult.resellerId,
    detectedResellerName: resellerResult.resellerName,
    detectedWeekIso: weekIso,
    detectedReportDate: reportDate,
    fileHash,
    rowsParsed,
    rowsFlagged,
    sheetName,
  };
}

export function computeHeaderFingerprint(headers: string[]): string {
  return headers.map((h) => normalize(h)).sort().join("|");
}
