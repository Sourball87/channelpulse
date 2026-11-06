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

Native Pronto POS accounts may map to any active reseller configured in Settings; name-prefix suggestions are hints only.

**Why:** The user later corrected the earlier nine-reseller restriction and asked to allow any active Settings reseller.

**How to apply:** Keep source-to-reseller mapping explicit and do not create reseller accounts or product-catalogue SKUs automatically from the extract. Retain selected-account evidence with uncatalogued SKUs; those codes are usable only if manually entered on a promotion.

Pronto credits are duplicates by account code, SKU, invoice number, quantity and invoice date, regardless of source file or row. A newer extract that covers an older date range supersedes it, while unique older evidence remains available. Scanback exports contain customer data and must stay private; keep weekly backups and retain the latest 12.

**Why:** The user requested cross-import credit deduplication, coverage-based superseding without losing unique evidence, and private recurring workbook exports.

**How to apply:** Use source identity rather than import identity for credit resolutions. Preserve older unique rows when transferring duplicate evidence to a covering extract. Keep customer names masked in workbooks and store scheduled exports only in private App Storage with 12-backup retention.

The user wants imports to auto-detect the spreadsheet type and no template-download step.

**Why:** The user asked “have the import auto detect... also whats the template? remove that”.

**How to apply:** Default to detection from the uploaded headings, keep manual selection for unclear layouts, and retain preview/review before financial commit.

Scoping out Pronto accounts must never hide conflicting serial ownership or returns.

**Why:** Keeping only a selected customer's invoice while discarding another customer's event can turn ambiguous serial ownership into a false payable result.

**How to apply:** Excluded events cannot grant eligibility, but serial overlaps must still trigger review across committed extracts. A missing-serial credit for a selected reseller/known SKU requires source correction, not silent exclusion.

Promotion SKUs may be typed even when no product-catalogue row exists.

**Why:** The user explicitly chose to allow custom SKU codes outside the catalogue.

**How to apply:** Keep SKU text on promotion lines, invoice evidence, and the approved-serial ledger. Match codes exactly after uppercase/trim normalization and track caps by code; never create a catalogue product as a side effect.

Promotion caps are per SKU/customer only; never add an all-SKU customer-total cap.

**Why:** The user explicitly requested “Do NOT add a customer total cap (all SKUs) row or any total-cap rule.”

**How to apply:** Keep row and footer cap sums as display totals, not extra eligibility limits. Reference prices and calculated discount/STA are informational, not substitutes for the invoiced-price claim basis. Paste/file previews must preserve missing source prices/caps, never invent or silently fill them.

Reported-sale ownership is global across customers, not just claimed-serial uniqueness.

**Why:** The user requested that a serial already sold or claimed cannot be reused in a later customer report, while preserving the existing approval transaction and caps.

**How to apply:** The first committed customer report owns the sale; staged previews must not reserve it, and its own first row must remain verifiable until claimed. Keep later occurrences as flagged audit facts, never new sales or payable units. Use immutable source records and the approved ledger as the tracking authority, rather than adding a separately mutable claimed-state writer.

Run development HTTP financial suites serially when they share the same database.

**Why:** Verification fingerprints intentionally include the approved ledger. A parallel suite's unrelated historical approval can invalidate both freshly verified race-test drafts, even when each suite uses distinct serials.

**How to apply:** Disable test-file parallelism for combined live-API financial suites; do not weaken approval freshness checks to make concurrent fixtures pass.
