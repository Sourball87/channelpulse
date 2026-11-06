---
name: Program-table ingestion
description: User requirements for tolerant program-table pastes and Upload Center previews.
---

The user wants real Excel/email program tables handled without pre-cleaning. Ignore preamble and group rows; tolerate blank/duplicate headings and trailing/wrapped cells; match customers by existing code/name; and show inferred promotion dates so they can correct the year. Use automatic rules first and AI only for unresolved headings or customers.

**Why:** Pasted tables may lose cell separators, and actual source tables contain duplicated SKU labels, spacing artifacts, calculated columns and partial rows. A rigid rectangle check rejects usable source data; guessing financial fields or allocations can create an incorrect promotion.

**How to apply:** Keep normalized parsing shared between paste and Upload Center. Preserve source row numbers and warnings in the review. Discard a redundant Part No. only when its row values match SKU. Split collapsed quantities only when there is one valid source-consistent solution; otherwise mark them unresolved, never as unlimited caps.

Display only explicit source price fields. Discount, STA, calculated totals, and customer caps are not added to claim inputs; Total is a warning cross-check of per-customer caps, never an additional eligibility cap. A customer cap of zero means that customer is ineligible.

**Why:** The user explicitly separated calculated/source reference data from customer-specific eligibility and claim-price inputs.

**How to apply:** Retain preview and manual correction before building a draft. Keep immutable financial verification and approval safeguards unchanged.
