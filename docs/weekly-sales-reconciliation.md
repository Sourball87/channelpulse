# Sell Through reconciliation

The Sell Through page shows twelve consecutive calendar weeks and a selected-week account/SKU reconciliation table. Category, account and SKU filters apply to both. Clicking a populated heatmap cell selects its week; the table also has a week selector.

## Calculations and source provenance

- **Serials reported:** first occurrences of serials in committed customer reports, following global report commit order. Repeated rows and later re-reports do not create additional sales.
- **Serial match %:** serials reported divided by SOH-reported units sold, multiplied by 100. It is not capped at 100%. A missing report, absent sold column or nonpositive denominator is not comparable and displays a dash.
- **Sell-through:** the SOH sold figure when the source has a sold column, including an explicit zero. If mapping metadata confirms there was no sold column, use the week's serial count and mark the number **serials**. The existing heatmap uses these same reconciled figures.
- **SOH:** actual reported stock. A missing account report is distinct from a report that does not include this SKU, and neither is fabricated as zero.
- **DD sell-in (week):** committed Pronto invoice quantities less credits, deduplicated across evidence files. It is independent of customer sell-through. An uncovered week displays a dash, not zero. Coverage is inferred from the transaction date ranges in each committed extract; gaps between separate extracts are not assumed covered.

An explicit report week in Upload Center determines the report's weekly grouping; legacy reports without that metadata use valid row sale dates. Upload timestamps never determine the sales week. Serial-only reports can obtain their SKU from invoice evidence for the same known reseller at the sale date. The invoice customer is not used to invent a missing reporting reseller. Unassignable serials are disclosed separately.

Missing sales-column mappings are determined from the committed SOH upload's saved mappings, not the customer's name or a stored zero. Legacy sources without reliable mappings retain their existing stored sold figure but do not get a fabricated match percentage or discrepancy alert. A reseller's most recent known source format may establish serial fallback in a subsequent week without an SOH report; SOH itself stays missing.

## Alerts

- **High:** `More serials than sold — check before paying claims` when a received serial count exceeds known nonnegative SOH sales. This appears as **critical** in the existing Alerts page.
- **Low:** `Sold not serial-reported` when positive SOH sales exceed the reported count. A missing report also triggers this for customers configured to send serial reports. This appears as **info** in the existing Alerts page.
- No comparison is invented for serial-backed sell-through: comparing serials against the same serials would falsely imply a 100% match.
- Pronto's last available transaction date is displayed. A note warns if it precedes the selected week, or if the selected week is only partially covered.

These are reporting warnings, not changes to promotion caps, payment eligibility or the immutable approved-claims ledger.

## Upload behavior

Manual SOH commitment requires a valid customer/week and unique mappings for Part Number and SOH. A sold column is optional, with an explicit explanation that weekly serial reports will supply sell-through when available. Automatic commitment retains its existing stricter safeguards.

## Verification

The pure reconciliation tests cover percentages, excess and partial serial reporting, zero versus missing, no-sold-column fallback, global serial reuse, explicit report weeks, serial-only evidence matching, calendar gaps, filters, credits, DD coverage and ISO year boundaries.

The opt-in development HTTP test stages and commits SOH, DD and customer reports through the real API, checks both discrepancy alerts and the existing heatmap, replaces only its own test SOH with a no-sold-column file, and removes its fixtures. Run live financial suites sequentially because they share verification fingerprints:

```sh
SCANBACK_INTEGRATION_URL=http://localhost:80/api \
UPLOAD_CENTER_INTEGRATION_URL=http://localhost:80/api \
SALES_RECONCILIATION_INTEGRATION_URL=http://localhost:80/api \
pnpm --filter @workspace/api-server exec vitest run \
  src/lib/scanback.integration.test.ts \
  src/lib/center.integration.test.ts \
  src/lib/sales-reconciliation.integration.test.ts \
  --no-file-parallelism
```
