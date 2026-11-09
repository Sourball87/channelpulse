import crypto from "crypto";
import { detectWeekFromFilename, isValidWeekIso } from "./dates";

export {
  currentWeekIso, dateStringToWeekIso, detectWeekFromFilename, isValidWeekIso,
  previousCompletedWeekIso, previousWeekIso,
} from "./dates";

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

export interface ResellerProfile {
  id: number;
  name: string;
  code: string;
  filenamePatterns: string[];
  aliases: string[];
}

/** Resolution source for header-based detection */
export type HeaderResolutionSource =
  | "format_unique"   // format maps to exactly one reseller
  | "sheet_name"      // sheet name disambiguated a shared format
  | "filename_token"  // filename token result broke the tie
  | "learned"         // learned fingerprint association broke the tie
  | null;             // unresolved / no format matched

export interface ParseResult {
  rows: ParsedRow[];
  rawRows: Record<string, unknown>[];
  headers: string[];
  mappings: MappingField[];
  overallConfidence: number;
  parserUsed: string;
  // Reseller detection
  detectedResellerId: number | null;
  detectedResellerName: string | null;
  /** All candidate resellers when detection is ambiguous (empty = fully resolved or no match) */
  detectedCandidates: ResellerProfile[];
  // Format detection
  detectedFormatId: string | null;
  headerResolutionSource: HeaderResolutionSource;
  /** True when filename detection gave a unique (non-ambiguous) reseller match */
  filenameResolved: boolean;
  detectionReasoning: string | null;
  // Week detection
  detectedWeekIso: string | null;
  detectedReportDate: string | null;
  fileHash: string;
  rowsParsed: number;
  rowsFlagged: number;
  sheetName: string | null;
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
    "sohqty", "stock", "totalstock", "availablestock", "currentstock",
  ],
  sell_through_7d: [
    "sold", "soldlast7days", "soldqty", "7d", "invoicedquantity", "soldlastweek",
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
    "averagecostextax", "unitcostexgst", "avgstockvalue", "cost", "averagecost",
    "unitcost",
  ],
};

// Samsung part number prefixes for validation
const SAMSUNG_PREFIXES = ["MZ-", "MU-", "MUF-", "LS", "LU", "LC", "LF", "LH", "SM-", "MB-", "MJ-", "HAJ", "GP-", "EF-"];

// ─── Utility functions ────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .replace(/^products\s*\[\s*([^\]]+)\s*\]$/i, "$1")
    .replace(/^\[\s*([^\]]+)\s*\]$/, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
  return Math.round(coerceFloat(val) ?? 0);
}

function coerceFloat(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  let text = String(val).trim().replace(/^AUD\s*/i, "").replace(/^A\$/i, "$");
  if (/^\(.*\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  text = text.replace(/[$,\s]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function isSamsungPart(partNo: string): boolean {
  const upper = partNo.toUpperCase().trim();
  return SAMSUNG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─── Filename tokenisation helpers ────────────────────────────────────────────

/**
 * Splits a filename (extension removed) into lowercase alpha-numeric tokens.
 * All runs of non-alphanumeric characters are treated as delimiters.
 * "2026 WK 28 Samsung SSD SOH reports - KS.xlsx" → ["2026","wk","28","samsung","ssd","soh","reports","ks"]
 */
export function tokenizeFilename(filename: string): string[] {
  const withoutExt = filename.replace(/\.[^.]+$/, "");
  return withoutExt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Returns a lowercase string with every non-alphanumeric character removed.
 * Used for collapsed matching against hints and DB patterns.
 */
export function collapseStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Returns a stable collapsed filename for learning — strip pure-number tokens
 * and ISO week tokens (wk, w, year digits) so the resulting pattern is
 * file-type specific rather than date-specific.
 * e.g. "2026 WK 28 Samsung SSD SOH reports - KS.xlsx" → "samsungssdsohreportsks"
 */
export function stableCollapsedFilename(filename: string): string {
  const tokens = tokenizeFilename(filename);
  const filtered = tokens.filter(t => {
    if (/^\d+$/.test(t)) return false; // pure number (year, week number, timestamp)
    if (t === "wk" || t === "w") return false;
    return true;
  });
  return filtered.join("");
}

// ─── Report format definitions ────────────────────────────────────────────────

interface ReportFormat {
  formatId: string;
  /** Normalized column names (lowercase, alphanumeric) that define this format */
  headers: string[];
  /** Known extra export columns that must not dilute the identifying signature. */
  optionalHeaders?: string[];
  /** Reseller codes (lowercase) that produce this format */
  resellerCodes: string[];
}

const REPORT_FORMATS: ReportFormat[] = [
  {
    formatId: "ca_ks_weekly",
    headers: ["model", "stockonhand", "stockonorder", "soldlast7days", "soldmtd", "averagecostexgst"],
    resellerCodes: ["ca", "ks"],
  },
  {
    formatId: "v_report",
    headers: ["partnumber", "soh", "soldlast7days", "soldmtd", "avgcost"],
    resellerCodes: ["pccg", "digi"],
  },
  {
    formatId: "scorptec_csv",
    headers: ["model", "onhand", "soldlast7days", "itemaveragecostexgst", "qtyonorder"],
    optionalHeaders: ["brand", "category", "title", "active", "itemaveragecostincgst", "totalcostexgst", "stockage"],
    resellerCodes: ["scorptec"],
  },
  {
    formatId: "ple_weekly",
    headers: ["inventoryitemid", "manufacturermodel", "quantityonhand", "quantityonorder", "invoicedquantity", "averagecostextax"],
    resellerCodes: ["ple"],
  },
  {
    formatId: "centrecom_forecast",
    headers: ["sapcode", "sku", "totalonhand", "otheronhand", "daystosale", "onorderqty", "soldqty"],
    optionalHeaders: ["sapprice", "cost", "totalonhandallwhrevenue", "revenue", "purchaseqty", "purchasevalue", "ageing90", "ageing90cost", "ageing120", "ageing120cost"],
    resellerCodes: ["centrecom"],
  },
  {
    formatId: "jw_weekly",
    headers: ["modelcode", "soh", "soldlast7days", "soldmtd", "qtyonpo", "avgcost"],
    resellerCodes: ["jw"],
  },
  {
    formatId: "pccg_forecast",
    headers: ["productname", "productmodel", "30d", "14d", "7d", "stock", "avgstockvalue"],
    resellerCodes: ["pccg"],
  },
  {
    formatId: "umart_csv",
    headers: ["productmodel", "sold", "onhand"],
    optionalHeaders: ["category", "brand", "productname", "promotion", "period"],
    resellerCodes: ["umart"],
  },
  {
    formatId: "jw_weekly",
    headers: ["partnumber", "soh", "soldlast7days", "soldmtd", "avgcost"],
    resellerCodes: ["jw"],
  },
  {
    formatId: "digi_weekly",
    headers: ["modelcode", "soh", "soldlast7days", "soldmtd", "qtyonpo", "avgcost"],
    resellerCodes: ["digi"],
  },
];

// ─── Reseller detection — built-in filename hints ─────────────────────────────

/**
 * Per-reseller filename matching hints.
 * - shortCodes:          exact-token match (≤3 chars treated as token-only to avoid substring collisions)
 * - collapsedHints:      collapsed substring match against the collapsed filename
 * - collapsedNeedToken:  if set, collapsed hints only fire when this token is present in the
 *                        filename tokens OR no other reseller was already token-matched
 */
const BUILTIN_HINTS: Record<string, {
  shortCodes?: string[];
  collapsedHints?: string[];
  collapsedNeedToken?: string;
}> = {
  ca:         { shortCodes: ["ca"],  collapsedHints: ["computeralliance"] },
  ks:         {
    shortCodes: ["ks"],
    // These collapsed hints imply KS only when the 'ks' token is present
    // (or when no other reseller was token-matched), preventing collisions with generic
    // "Samsung SOH" filenames that could equally be CA.
    collapsedHints: ["samsungssdsohreports", "samsungmonitorsohreports", "samsungmobilitysohreports"],
    collapsedNeedToken: "ks",
  },
  scorptec:   { collapsedHints: ["scorptec", "scorp"] },
  umart:      { collapsedHints: ["umart"] },
  ple:        { shortCodes: ["ple"], collapsedHints: ["reportingprocurementcustom"] },
  centrecom:  { collapsedHints: ["centrecom"] },
  pccg:       { collapsedHints: ["pccg"] },
  jw:         { shortCodes: ["jw"] },
  digi:       { collapsedHints: ["digi", "digidirect"] },
};

// ─── Reseller detection — filename ────────────────────────────────────────────

export function detectResellerFromFilename(
  filename: string,
  resellers: ResellerProfile[],
): { resellerId: number | null; resellerName: string | null; confidence: number; candidates: ResellerProfile[] } {
  const tokens = new Set(tokenizeFilename(filename));
  const collapsed = collapseStr(filename.replace(/\.[^.]+$/, ""));

  function tokenOrCollapsedMatch(hint: string): boolean {
    const ch = collapseStr(hint);
    // Short codes (≤3 chars): exact-token match only — never substring-match
    // This prevents "ks" matching "weeks", "ca" matching "cable", etc.
    if (ch.length <= 3) return tokens.has(ch);
    return collapsed.includes(ch);
  }

  // ── Pass 1: collect all resellers that match via short codes, collapsed hints
  //    (without collapsedNeedToken), aliases, or DB filename patterns ──────────
  const pass1Matched = new Set<string>(); // lower reseller codes

  for (const reseller of resellers) {
    const code = reseller.code.toLowerCase();
    const hints = BUILTIN_HINTS[code];
    let matched = false;

    // DB filename patterns (collapsed for long, token for short)
    for (const pattern of reseller.filenamePatterns) {
      if (tokenOrCollapsedMatch(pattern)) { matched = true; break; }
    }

    // Built-in short codes
    if (!matched && hints?.shortCodes) {
      for (const sc of hints.shortCodes) {
        if (tokens.has(sc)) { matched = true; break; }
      }
    }

    // Built-in collapsed hints (only if they don't need a specific token)
    if (!matched && hints?.collapsedHints && !hints.collapsedNeedToken) {
      for (const ch of hints.collapsedHints) {
        if (tokenOrCollapsedMatch(ch)) { matched = true; break; }
      }
    }

    // Aliases
    if (!matched) {
      for (const alias of reseller.aliases) {
        if (tokenOrCollapsedMatch(alias)) { matched = true; break; }
      }
    }

    if (matched) pass1Matched.add(code);
  }

  // ── Pass 2: apply conditional collapsed hints (collapsedNeedToken) ────────
  for (const reseller of resellers) {
    const code = reseller.code.toLowerCase();
    if (pass1Matched.has(code)) continue; // already matched

    const hints = BUILTIN_HINTS[code];
    if (!hints?.collapsedHints || !hints.collapsedNeedToken) continue;

    const needToken = hints.collapsedNeedToken;
    // Fire if: the required token is present in the filename, OR no other reseller was matched yet
    if (!tokens.has(needToken) && pass1Matched.size > 0) continue;

    for (const ch of hints.collapsedHints) {
      if (tokenOrCollapsedMatch(ch)) { pass1Matched.add(code); break; }
    }
  }

  const matchedResellers = resellers.filter(r => pass1Matched.has(r.code.toLowerCase()));

  if (matchedResellers.length === 0) {
    return { resellerId: null, resellerName: null, confidence: 0, candidates: [] };
  }
  if (matchedResellers.length === 1) {
    return {
      resellerId: matchedResellers[0].id,
      resellerName: matchedResellers[0].name,
      confidence: 0.9,
      candidates: matchedResellers,
    };
  }
  // Multiple matches → ambiguous, surface all candidates
  return { resellerId: null, resellerName: null, confidence: 0, candidates: matchedResellers };
}

// ─── Reseller detection — headers ─────────────────────────────────────────────

export function detectResellerFromHeaders(
  headers: string[],
  sheetName: string | null,
  resellers: ResellerProfile[],
  filenameResult?: { resellerId: number | null; candidates: ResellerProfile[]; confidence: number },
  learnedFingerprints?: Map<string, number>, // fingerprint -> resellerId
): {
  resellerId: number | null;
  resellerName: string | null;
  confidence: number;
  formatId: string | null;
  candidates: ResellerProfile[];
  resolutionSource: HeaderResolutionSource;
} {
  const normalizedHeaders = new Set(headers.map((h) => normalize(h)).filter(Boolean));

  // Find best matching format
  let bestFormat: ReportFormat | null = null;
  let bestSim = 0;

  for (const format of REPORT_FORMATS) {
    const knownSet = new Set(format.headers.map(normalize));
    const optional = new Set(format.optionalHeaders ?? []);
    const relevantHeaders = new Set([...normalizedHeaders].filter(h => !optional.has(h)));
    const sim = jaccardSimilarity(relevantHeaders, knownSet);
    if (sim >= 0.7 && sim > bestSim) {
      bestSim = sim;
      bestFormat = format;
    }
  }

  if (!bestFormat) {
    return { resellerId: null, resellerName: null, confidence: 0, formatId: null, candidates: [], resolutionSource: null };
  }

  // Expand format candidates to full ResellerProfile objects from DB
  const formatCandidates = resellers.filter(r =>
    bestFormat!.resellerCodes.includes(r.code.toLowerCase())
  );

  // Single-reseller format → fully resolved
  if (formatCandidates.length === 1) {
    return {
      resellerId: formatCandidates[0].id,
      resellerName: formatCandidates[0].name,
      confidence: bestSim,
      formatId: bestFormat.formatId,
      candidates: formatCandidates,
      resolutionSource: "format_unique",
    };
  }

  // Multi-reseller format → try tie-breakers in order

  // (a) Sheet name rules
  if (sheetName) {
    const sl = sheetName.toLowerCase();
    for (const reseller of formatCandidates) {
      const code = reseller.code.toLowerCase();
      if (sl.includes("computeralliance") && code === "ca") {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: bestSim, formatId: bestFormat.formatId, candidates: formatCandidates, resolutionSource: "sheet_name" };
      }
      if ((sl.includes("samsung soh report") || sl.includes("samsungsohreport")) && code === "ks") {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: bestSim, formatId: bestFormat.formatId, candidates: formatCandidates, resolutionSource: "sheet_name" };
      }
      if ((sl.includes("itemforcastreport") || sl.includes("itemforecastreport")) && code === "centrecom") {
        return { resellerId: reseller.id, resellerName: reseller.name, confidence: bestSim, formatId: bestFormat.formatId, candidates: formatCandidates, resolutionSource: "sheet_name" };
      }
    }
  }

  // (b) Filename token result matches one of the format's candidates
  if (filenameResult?.resellerId) {
    const match = formatCandidates.find(r => r.id === filenameResult.resellerId);
    if (match) {
      return {
        resellerId: match.id,
        resellerName: match.name,
        confidence: bestSim,
        formatId: bestFormat.formatId,
        candidates: formatCandidates,
        resolutionSource: "filename_token",
      };
    }
  }

  // (c) Learned fingerprint associations
  if (learnedFingerprints) {
    const fingerprint = computeHeaderFingerprint(headers);
    const learnedId = learnedFingerprints.get(fingerprint);
    if (learnedId) {
      const match = formatCandidates.find(r => r.id === learnedId);
      if (match) {
        return {
          resellerId: match.id,
          resellerName: match.name,
          confidence: 0.85,
          formatId: bestFormat.formatId,
          candidates: formatCandidates,
          resolutionSource: "learned",
        };
      }
    }
  }

  // No tie-breaker resolved it — ambiguous
  return {
    resellerId: null,
    resellerName: null,
    confidence: 0,
    formatId: bestFormat.formatId,
    candidates: formatCandidates,
    resolutionSource: null,
  };
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

export function computeMappingConfidence(mappings: MappingField[]): number {
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

    const partNo = String(canonical.part_no ?? "").trim().toUpperCase();
    const openedBox = /^(?:opened\s*box|open\s*box)$/i.test(partNo) ||
      /-\d{5}$/.test(partNo) ||
      Object.values(raw).some(value => /opened\s*box/i.test(String(value ?? "")));
    if (!partNo || /^(grand\s*)?totals?[:\s]*$/i.test(partNo) || openedBox) continue;

    const flagged = !isSamsungPart(partNo);
    const soh = coerceInt(canonical.soh);
    const negativeSoh = soh < 0;
    const invalidNumber = Object.entries(canonical).some(([field, value]) =>
      field !== "part_no" && value !== null && value !== undefined && value !== "" &&
      coerceFloat(value) === null,
    );

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
      flagged: flagged || negativeSoh || invalidNumber,
      flag_reason: invalidNumber
        ? "Invalid numeric value"
        : flagged
        ? "Not a Samsung part number"
        : negativeSoh
        ? "Negative SOH value"
        : undefined,
    });
  }

  return results;
}

/** Re-run recognition on persisted source cells; absent workbook metadata stays absent. */
export function analyzeReportData(
  source: { filename: string; headers: string[]; rawRows: Record<string, unknown>[];
    sheetName: string | null; fileHash: string; parserUsed: string },
  resellers: ResellerProfile[],
  savedMappings?: Map<string, MappingField[]>,
  learnedFingerprints?: Map<string, number>,
): ParseResult {
  const { filename, headers, rawRows, sheetName, fileHash, parserUsed } = source;
  // ── Reseller detection ──────────────────────────────────────────────────────

  // Step 1: filename-based detection
  const filenameResult = detectResellerFromFilename(filename, resellers);
  const filenameResolved = filenameResult.resellerId !== null;

  // Step 2: header/format-based detection, with filename result as a tie-break hint
  const headerResult = detectResellerFromHeaders(
    headers,
    sheetName,
    resellers,
    filenameResult,
    learnedFingerprints,
  );

  // Step 3: combine results
  let finalResellerId: number | null = null;
  let finalResellerName: string | null = null;
  let finalCandidates: ResellerProfile[] = [];
  let finalConfidence = 0;
  let headerResolutionSource: HeaderResolutionSource = headerResult.resolutionSource;

  const conflict = filenameResult.resellerId === null && filenameResult.candidates.length > 0 &&
    headerResult.resellerId !== null &&
    !filenameResult.candidates.some(r => r.id === headerResult.resellerId);

  if (filenameResult.resellerId !== null) {
    finalResellerId = filenameResult.resellerId;
    finalResellerName = filenameResult.resellerName;
    finalCandidates = conflict
      ? [...new Map([...headerResult.candidates, ...filenameResult.candidates].map(r => [r.id, r])).values()]
      : filenameResult.candidates;
    finalConfidence = filenameResult.confidence;
    if (conflict) headerResolutionSource = null;
    else if (headerResult.resellerId === filenameResult.resellerId)
      headerResolutionSource = headerResult.resolutionSource ?? "filename_token";
    else headerResolutionSource = "filename_token";
  } else if (conflict) {
    finalCandidates = [...new Map(
      [...headerResult.candidates, ...filenameResult.candidates].map(r => [r.id, r]),
    ).values()];
    headerResolutionSource = null;
  } else if (headerResult.resellerId !== null) {
    // Header detection resolved → use it (it already incorporated filename as tie-break)
    finalResellerId = headerResult.resellerId;
    finalResellerName = headerResult.resellerName;
    finalCandidates = headerResult.candidates;
    finalConfidence = headerResult.confidence;
  } else if (filenameResult.resellerId !== null) {
    // Header detection didn't resolve but filename did — use filename result
    finalResellerId = filenameResult.resellerId;
    finalResellerName = filenameResult.resellerName;
    finalCandidates = filenameResult.candidates;
    finalConfidence = filenameResult.confidence;
  } else {
    // Neither resolved — surface combined candidates for review
    const allCandidates = [
      ...(filenameResult.candidates.length > 0 ? filenameResult.candidates : []),
      ...(headerResult.candidates.length > 0 ? headerResult.candidates : []),
    ];
    // Deduplicate by id
    const seen = new Set<number>();
    finalCandidates = allCandidates.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  }

  // ── Detection reasoning string ──────────────────────────────────────────────

  const reasonParts: string[] = [];
  if (filenameResolved) {
    const token = tokenizeFilename(filename).find(t => BUILTIN_HINTS[filenameResult.candidates[0]?.code?.toLowerCase()]?.shortCodes?.includes(t));
    reasonParts.push(`filename token '${token ?? filenameResult.candidates[0]?.code ?? "?"}'`);
  } else if (filenameResult.candidates.length > 1) {
    reasonParts.push(`filename ambiguous (${filenameResult.candidates.map(r => r.code).join(", ")})`);
  }
  if (headerResult.formatId) {
    reasonParts.push(`format '${headerResult.formatId}'`);
    if (headerResult.resolutionSource === "sheet_name") reasonParts.push(`sheet '${sheetName}'`);
    if (headerResult.resolutionSource === "learned") reasonParts.push("learned association");
    if (headerResult.resolutionSource === "filename_token") reasonParts.push("filename tie-break");
  }

  const detectionReasoning = conflict
    ? `Filename identifies ${filenameResult.resellerName}; it is selected over the conflicting report format/sheet. Confirm before committing.`
    : reasonParts.length > 0
    ? `Detected ${finalResellerName ?? "unknown"} via: ${reasonParts.join(" + ")}`
    : null;

  // ── Date detection from filename ────────────────────────────────────────────
  const { weekIso, reportDate } = detectWeekFromFilename(filename);

  // ── Column mapping ──────────────────────────────────────────────────────────
  let mappings: MappingField[];

  if (savedMappings && finalResellerId) {
    const fingerprint = computeHeaderFingerprint(headers);
    const saved = savedMappings.get(`${finalResellerId}:${fingerprint}`);
    if (saved) {
      mappings = saved;
    } else {
      mappings = mapHeaders(headers, rawRows);
    }
  } else {
    mappings = mapHeaders(headers, rawRows);
  }

  // ── Apply mappings to rows ──────────────────────────────────────────────────
  const parsedRows = applyMappingsToRows(rawRows, mappings);
  const rowsParsed = parsedRows.length;
  const rowsFlagged = parsedRows.filter((r) => r.flagged).length;

  // ── Overall confidence ──────────────────────────────────────────────────────
  const resellerConf = finalResellerId !== null ? finalConfidence : 0;
  const mappingConf = computeMappingConfidence(mappings);
  const overallConfidence = resellerConf * 0.5 + mappingConf * 0.5;

  return {
    rows: parsedRows,
    rawRows,
    headers,
    mappings,
    overallConfidence,
    parserUsed,
    detectedResellerId: finalResellerId,
    detectedResellerName: finalResellerName,
    detectedCandidates: finalCandidates,
    detectedFormatId: headerResult.formatId,
    headerResolutionSource,
    filenameResolved,
    detectionReasoning,
    detectedWeekIso: weekIso,
    detectedReportDate: reportDate,
    fileHash,
    rowsParsed,
    rowsFlagged,
    sheetName,
  };
}

/** A filename or a confidence number alone is never sufficient to commit data. */
export function isAutoCommitEligible(
  result: ParseResult,
  mappings: MappingField[] = result.mappings,
  overwritesExisting = false,
): boolean {
  const agreement = result.headerResolutionSource === "format_unique" ||
    result.headerResolutionSource === "filename_token" ||
    (result.filenameResolved && result.headerResolutionSource === "sheet_name");
  const rows = applyMappingsToRows(result.rawRows, mappings);
  const fields = mappings.map(m => m.canonical_field).filter(Boolean);
  const uniqueFields = new Set(fields);
  return result.detectedResellerId !== null && agreement &&
    result.detectedFormatId !== "v_report" &&
    result.overallConfidence >= 0.9 && computeMappingConfidence(mappings) >= 0.9 &&
    !!result.detectedWeekIso && isValidWeekIso(result.detectedWeekIso) &&
    !overwritesExisting && rows.length > 0 && !rows.some(r => r.flagged) &&
    fields.length === uniqueFields.size &&
    new Set(rows.map(r => r.part_no)).size === rows.length;
}

export function computeHeaderFingerprint(headers: string[]): string {
  return headers.map((h) => normalize(h)).sort().join("|");
}
