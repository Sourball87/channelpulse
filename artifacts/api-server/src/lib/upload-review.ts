import {
  analyzeReportData, applyMappingsToRows, computeMappingConfidence, isAutoCommitEligible, isValidWeekIso,
  type MappingField, type ParseResult, type ResellerProfile,
} from "./parser";

export interface ReviewReason { code: string; message: string }
export interface AiNote { status: string; message: string; evidence?: string[] }
export interface Recognition {
  version: 1;
  sheetName: string | null;
  weekSource: "filename" | "batch" | "manual" | "ai_suggested" | null;
  confirmedWeek?: string | null;
  confirmedResellerId?: number | null;
  ai?: AiNote;
  recheckedAt?: string;
  sheetMetadataMissing?: boolean;
  commitDeferred?: boolean;
}

export function readRecognition(value: unknown): Recognition | null {
  if (!value || typeof value !== "object" || (value as Recognition).version !== 1) return null;
  return value as Recognition;
}

export function selectReportingWeek(
  result: ParseResult, recognition: Recognition, batchWeek?: string,
): ParseResult {
  if (recognition.confirmedWeek && isValidWeekIso(recognition.confirmedWeek) &&
      ["manual", "batch"].includes(recognition.weekSource ?? "")) {
    return { ...result, detectedWeekIso: recognition.confirmedWeek };
  }
  if (result.detectedWeekIso) {
    recognition.weekSource = "filename";
    return result;
  }
  if (batchWeek && isValidWeekIso(batchWeek)) {
    recognition.weekSource = "batch";
    recognition.confirmedWeek = batchWeek;
    return { ...result, detectedWeekIso: batchWeek };
  }
  recognition.weekSource = null;
  return { ...result, detectedWeekIso: null };
}

export function withMappings(result: ParseResult, mappings: MappingField[]): ParseResult {
  const rows = applyMappingsToRows(result.rawRows, mappings);
  return { ...result, mappings, rows, rowsParsed: rows.length, rowsFlagged: rows.filter(r => r.flagged).length,
    overallConfidence: Math.max(0, Math.min(1, result.overallConfidence +
      (computeMappingConfidence(mappings) - computeMappingConfidence(result.mappings)) / 2)) };
}

export function diagnoseUpload(result: ParseResult, overwrite: boolean, recognition: Recognition | null) {
  const reasons: ReviewReason[] = [];
  const fields = result.mappings.map(m => m.canonical_field).filter(Boolean);
  const supported = new Set(["part_no", "soh", "sell_through_7d", "sold_mtd", "on_order", "avg_cost", "sold_14d", "sold_30d"]);
  if (!result.detectedWeekIso || !isValidWeekIso(result.detectedWeekIso)) {
    reasons.push({ code: "missing_week", message: "No reliable reporting week. Select a week for this file or use the batch-week selector." });
  }
  if (!result.detectedResellerId) {
    reasons.push({ code: "ambiguous_reseller", message: result.detectedCandidates.length
      ? `Select the reseller: ${result.detectedCandidates.map(r => r.name).join(" or ")}.`
      : "Reseller could not be identified. Select the correct reseller." });
  }
  if (result.detectionReasoning?.includes("different resellers") && !recognition?.confirmedResellerId) {
    reasons.push({ code: "detection_conflict", message: "Filename and report layout disagree about the reseller. Confirm the owner." });
  }
  if (!["part_no", "soh", "sell_through_7d"].every(f => fields.includes(f)) ||
      fields.length !== new Set(fields).size ||
      result.mappings.some(m => m.canonical_field && (!supported.has(m.canonical_field) || !result.headers.includes(m.source_col))) ||
      new Set(result.mappings.map(m => m.source_col)).size !== result.mappings.length) {
    reasons.push({ code: "invalid_mapping", message: "Map Part Number, SOH and 7-day Sales exactly once, using supported fields and source columns." });
  }
  if (!result.rows.length) reasons.push({ code: "empty_rows", message: "No product rows found. Check the source columns or re-upload the original report." });
  if (result.rows.some(r => r.flag_reason === "Invalid numeric value")) {
    reasons.push({ code: "invalid_numbers", message: "Invalid numeric cells found. Correct the source report or mapping before committing." });
  }
  const flagged = result.rows.filter(r => r.flagged);
  if (flagged.length) {
    reasons.push({ code: "flagged_rows", message: `${flagged.length} flagged row(s): ${[...new Set(flagged.map(r => r.flag_reason))].join(", ")}. Values have not been changed.` });
  }
  if (new Set(result.rows.map(r => r.part_no)).size !== result.rows.length) {
    reasons.push({ code: "duplicate_sku", message: "Repeated SKU rows need explicit aggregation. Correct the source report before committing." });
  }
  if (overwrite) reasons.push({ code: "snapshot_conflict", message: "This reseller/week already has data for these SKUs. Committing requires overwrite confirmation." });
  if (result.detectedFormatId === "v_report") {
    reasons.push({ code: "shared_format", message: "V-Report is shared by multiple resellers. Verify the reseller and week before committing." });
  }
  if (!recognition) reasons.push({ code: "legacy_recheck", message: "Saved with an older parser. Recheck to refresh recognition and remove unsupported guessed weeks." });
  if (recognition?.ai?.status === "suggested") {
    reasons.push({ code: "ai_suggestion", message: "AI suggested changes. Verify the cited evidence and mappings before committing." });
  }
  if (recognition?.weekSource === "ai_suggested") {
    reasons.push({ code: "confirm_ai_week", message: "The week is an AI suggestion. Confirm it before committing." });
  }
  if (recognition?.commitDeferred && !overwrite) {
    reasons.push({ code: "automatic_commit_deferred", message: "Automatic import could not complete. Your parsed report is saved for manual confirmation." });
  }
  // Explain every remaining auto-commit gate, rather than showing a generic badge.
  if (!isAutoCommitEligible(result, result.mappings, false) &&
      !reasons.some(r => ["missing_week", "ambiguous_reseller", "invalid_mapping", "flagged_rows", "duplicate_sku", "shared_format", "empty_rows"].includes(r.code))) {
    reasons.push({ code: "low_recognition_confidence", message: "Recognition is not strong enough for automatic import. Confirm the reseller, week and mappings." });
  }
  const autoEligible = isAutoCommitEligible(result, result.mappings, overwrite) && reasons.length === 0;
  return { reasons, autoEligible, ready: reasons.length === 0 };
}

export function reanalyzeStoredUpload(
  source: { filename: string; rawHeaders: unknown; rawRows: unknown; fileHash: string; parserUsed: string | null; recognition: unknown },
  profiles: ResellerProfile[],
): { result: ParseResult; recognition: Recognition; metadataMissing: boolean } {
  const old = readRecognition(source.recognition);
  const recognition: Recognition = old ? { ...old } : { version: 1, sheetName: null, weekSource: null,
    sheetMetadataMissing: !source.filename.toLowerCase().endsWith(".csv") };
  let result = analyzeReportData({
    filename: source.filename,
    headers: Array.isArray(source.rawHeaders) ? source.rawHeaders.filter((h): h is string => typeof h === "string") : [],
    rawRows: Array.isArray(source.rawRows) ? source.rawRows as Record<string, unknown>[] : [],
    sheetName: recognition.sheetName ?? null,
    fileHash: source.fileHash, parserUsed: source.parserUsed ?? "stored-cells",
  }, profiles);
  result = selectReportingWeek(result, recognition);
  if (recognition.confirmedResellerId) {
    const reseller = profiles.find(r => r.id === recognition.confirmedResellerId);
    if (reseller) result = { ...result, detectedResellerId: reseller.id, detectedResellerName: reseller.name };
  }
  return { result, recognition, metadataMissing: !!recognition.sheetMetadataMissing };
}
