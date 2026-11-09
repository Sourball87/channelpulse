---
name: Weekly sales reconciliation
description: Business meaning of serial matching, missing reports, source fallback and DD sell-in warnings.
---

The user wants reseller/SKU/week serial counts compared against independently SOH-reported units sold. Missing a sold column, such as Scorptec's format, means using that week's serial count as sell-through, explicitly tagged **serials**. Missing reports must remain distinct from reports of zero.

**Why:** This reconciliation supports checking claims before payment. A serial-backed sales figure compared against its own serial count is not an independent 100% match; a stored default zero does not establish that a sold column existed.

**How to apply:** Preserve provenance and unknown values in any extension of weekly reporting. Use the committed source's mapping to distinguish an absent column from a real zero, and leave the match percentage unavailable without an independent positive SOH-sales denominator.

WOI uses only actual SOH/ST sales observations, not serial-count fallback. Its average is over observed weeks in the selected 4/8/13-week window; missing weeks stay missing, and reported zero-sales is distinct from absent sales data.

**Why:** The user requires a meaningful WOI and explicitly said no sales must not become infinity. Treating missing reports as zero would bias the average and obscure coverage.

**How to apply:** Keep WOI sales provenance independent from the serial-backed sell-through measure. Expose observed-week coverage with each result and use a separate no-sales state when the observed average is zero.

Reporting expectations control missing-report warnings, not whether received facts are displayed.

**Why:** A customer can submit a serial report even while configured as not expected to send one. Hiding the received count contradicts the independently calculated match percentage.

**How to apply:** Always show an available count, including zero, before considering an account's reporting preferences. Use “Not expected” only when no report/count was received.

DD sell-in is separate from customer sell-through and SOH. The user wants weekly Pronto sell-in alongside those figures, with a warning when available Pronto data ends before the selected week.

**Why:** An old or missing distributor extract must not be presented as proof that no units were invoiced in a later week.

**How to apply:** Keep DD availability explicit. Preserve the requested high-severity “More serials than sold — check before paying claims” and low-severity “Sold not serial-reported” warnings without silently changing payment eligibility or approval caps.
