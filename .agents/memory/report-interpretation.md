---
name: Report interpretation
description: Reporting-period and attribution decisions for supplier report ingestion.
---

Show each reporting week alongside its Monday–Sunday calendar date range, not the week the file was uploaded.

**Why:** The user said week numbers were difficult to interpret and explicitly chose the report's calendar week over the upload week.

**How to apply:** Add calendar ranges to reporting-week labels while preserving ISO-week identifiers, grouping, and actual upload timestamps.

Do not assume all files supplied together share a reporting week or reseller. Undated reports require explicit week confirmation. The former PartNumber/SOH/SoldLast7Days/SoldMTD/AvgCost signature belongs uniquely to JW; it is not a shared V-Report format.

**Why:** The old parser tagged JW's headers as a shared PCCG/DigiDirect format. The corrected report structure and real files identify JW uniquely, while genuinely shared headers still need a reliable tie-breaker.

**How to apply:** Match a format only to its actual reseller candidates, using verified sheet-name tie-breakers for shared signatures. Keep week confirmation and commit/overwrite safeguards separate from format recognition.

Any customer serial report spanning more than three weeks is full history. Use the filename-derived week and keep only rows from that week. If the filename has no week, fall back to content dates; never keep older rows just because a serial is unseen, and show how many rows were skipped.

**Why:** Multi-month history can appear in any reseller's report, including small files; customer identity and file size do not reliably indicate report scope.

**How to apply:** Apply this rule to every customer serial upload before building its preview, and surface the excluded historical-row count in Upload Center.

Use the ISO calendar week of an explicit report date, or the ending date of a filename date range. Do not silently shift Monday-dated Centrecom reports into the preceding week.

**Why:** No confirmed business rule establishes a previous-week offset; 29 June 2026 is in 2026-W27.

**How to apply:** Keep calendar-derived dates unless the user establishes a different reporting convention.

Use whole UTC calendar days when calculating ISO week numbers.

**Why:** Carrying a noon time into a ceiling-based week calculation can shift all dates in an ISO year forward by one week when January 1 falls on Friday, repeating weeks when stepping backward.

**How to apply:** Cover 52/53-week year boundaries and consecutive weekly windows when changing reporting-period arithmetic.

Rechecking an existing pending upload must refresh recognition only, never retroactively import it. Missing original sheet metadata must stay missing, and unproven legacy week values must not become user-confirmed choices.

**Why:** Earlier parser results can contain guessed weeks and outdated flags. Applying new automatic-import rules to an old queue could change analytics without a deliberate import action.

**How to apply:** Preserve explicit batch/manual provenance, show lost-metadata limitations, and require a separate commit action after a recheck.

Keep unresolved AI mapping requests separate from authoritative mappings; do not present null mappings as existing confirmed assignments.

**Why:** The small-model smoke check initially returned no suggestions when given a complete list of null mappings alongside instructions to preserve existing mappings. Separating confident assignments from unresolved headers produced useful suggestions.

**How to apply:** Keep the deterministic parser authoritative, validate model evidence and structure, and require manual confirmation of AI suggestions. Do not let model-generated values replace source inventory numbers.

Enable AI upload assistance by default, retaining an explicit opt-out and the no-AI fast path for fully recognised reports.

**Why:** After reviewing the estimated per-upload cost, the user said "jsut default to it then".

**How to apply:** Default the UI and omitted upload/recheck API options to enabled. Explicit false disables AI. Keep billing/data disclosure and all evidence, confirmation and overwrite safeguards.

For WK-number filenames, compare the named week with the file creation date in Australia/Sydney (fall back to upload time). If created Monday–Wednesday within the named week, treat it as the previous completed week's data and show a warning. If created Thursday–Sunday within that week or later, keep the named week; when it is unfinished at upload time, preserve it and show the red unfinished-week flag. Keep the existing guard against committing unfinished weeks. Other detected filename and in-file dates still clamp to the latest completed week, and manual unfinished weeks remain blocked. Historical audits are read-only.

**Why:** The user corrected the earlier WK-number rule: WK46 created Monday 9 November belongs to W45, but WK45 created Friday 6 November stays in W45; WK42 created Sunday 18 October also stays in W42.

**How to apply:** Use Sydney-local creation dates for WK filenames, preserve warnings and red unfinished-week UI, and retain the server-side commit guard. Continue clamping date-range/in-file dates and blocking manual unfinished weeks. Historical audits stay read-only unless the user authorizes a specific correction.
