---
name: Report interpretation
description: Reporting-period and attribution decisions for supplier report ingestion.
---

Do not assume all files supplied together share a reporting week or reseller. Undated reports require explicit week confirmation, and V-Report attribution must be reviewed rather than inferred from another report.

**Why:** These exports omit metadata, and the same V-Report structure can belong to PCCG or DigiDirect. Recognition does not establish ownership or reporting period.

**How to apply:** Distinguish successful format parsing from permission to commit. Validate report compatibility without importing or overwriting existing data unless requested.

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
