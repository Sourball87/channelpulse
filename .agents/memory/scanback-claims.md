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
