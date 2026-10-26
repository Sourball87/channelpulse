---
name: Scanback claims rules
description: User-confirmed scope and payment eligibility constraints for ChannelPulse scanback claims.
---

The first release of Scanback Claims covers Programs, verification and claims history. Pronto invoice and credit records come from spreadsheet uploads.

**Why:** The user explicitly selected the core workflow and spreadsheet uploads when discussing their supplied claim-verifier model.

**How to apply:** Add the section within ChannelPulse. Do not expand initial scope into every section of the standalone model or a direct Pronto connection without a new request.

A serial can be paid only once across all promotions, not once per promotion.

**Why:** The user explicitly selected “No—once across all promotions, as in the model”.

**How to apply:** Check the shared approved-claims history during verification and enforce the rule again when approving a batch. Never treat changing promotions as permission to pay the same serial again.

Claim per serial equals the price charged to the reseller, excluding GST, minus GTM Buy Ex. It does not use the distributor's purchase cost.

**Why:** The user explicitly selected the reseller invoiced price after the model's “Invoice Cost” label was identified as ambiguous.

**How to apply:** Label the amount “Invoiced unit price (ex GST)”, distinguish it from purchase cost during import mapping, and calculate currency using exact decimal arithmetic or integer cents.

Verification fingerprints must canonicalize JSON object keys before hashing.

**Why:** PostgreSQL JSONB reorders object keys; hashing ordinary JSON serialization caused freshly saved verification results to appear stale immediately on approval.

**How to apply:** Any new fields included in financial verification fingerprints must round-trip through JSONB without changing their hash. Keep genuine changes to program terms, invoice evidence and prior approvals invalidating stale verification.

Keep CSV cell tokens raw until explicit date/serial normalization.

**Why:** The spreadsheet reader otherwise interprets slash dates as month/day before the user's chosen day/month format can run. The same inference can erase leading zeros from numeric serials.

**How to apply:** Preserve raw CSV strings at the reader boundary. Test both date formats using the same ambiguous input and preserve text serial identifiers; applying a date format after automatic spreadsheet inference is too late.

Native Pronto POS imports cover only the existing nine ChannelPulse resellers.

**Why:** The user chose “Use the existing nine resellers (recommended)” rather than adding other Pronto accounts.

**How to apply:** Keep source-to-reseller mapping explicit, report excluded accounts and unknown Stock Codes, and do not create accounts or SKUs automatically from the extract.

The user wants imports to auto-detect the spreadsheet type and no template-download step.

**Why:** The user asked “have the import auto detect... also whats the template? remove that”.

**How to apply:** Default to detection from the uploaded headings, keep manual selection for unclear layouts, and retain preview/review before financial commit.

Scoping out Pronto accounts must never hide conflicting serial ownership or returns.

**Why:** Keeping only a selected customer's invoice while discarding another customer's event can turn ambiguous serial ownership into a false payable result.

**How to apply:** Excluded events cannot grant eligibility, but serial overlaps must still trigger review across committed extracts. A missing-serial credit for a selected reseller/known SKU requires source correction, not silent exclusion.
