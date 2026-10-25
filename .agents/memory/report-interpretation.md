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
