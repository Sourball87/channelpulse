# Scanback Claims

Open **Scanback Claims** in ChannelPulse. This section records claim decisions;
it does not send payments or issue credits in Pronto.

## First-time setup

1. In **Programs**, create a promotion with inclusive calendar dates, existing
   Account Codes and Stock Codes.
2. Enter **GTM Buy Ex** for each SKU. A blank customer/SKU quantity cap is
   unlimited; zero makes that customer ineligible for the SKU.
3. In **Imports**, upload Pronto invoice/credit evidence. Review the worksheet,
   column mappings, date format and account attribution, then commit.
4. Import **historical approved claims** before approving new claims, so previous
   payouts are included in duplicate checks and applicable promotion caps.

Existing account and SKU records are reused. Unknown accounts/SKUs must be
resolved, not automatically created from an unverified financial file.

## Evidence and claim files

Download the CSV templates from Imports and replace their example values with
real Account Codes, Stock Codes and serials. XLS and XLSX are also supported.

- **Invoice / credit evidence:** Serial, SKU, Date, Invoice, signed Quantity,
  Account and Invoiced Unit Price Ex GST. An explicit fallback account can be
  selected for a single-account file. Credits have negative quantities.
- **Customer claim:** Serial is required. Date is needed for the customer-sale-date
  eligibility basis; SKU, account and quantity are checked when supplied.
- **Historical approved claims:** Serial, SKU, original approval Date, Account,
  Amount, Promotion and Claim Reference. Amount is the previously approved
  claim amount, not a new rebate calculation.

Store serials as text to preserve leading zeros and long identifiers. Put one
serial per claim/history row. An invoice row can contain a semicolon-separated
serial list, but the signed quantity must match the number of serials.

Money inputs allow at most two decimal places. **Invoiced unit price (ex GST)**
is the price charged to the reseller, not the distributor's purchase cost,
line total or GST-inclusive price.

Uploading creates a persistent preview only. Invalid mappings/rows block commit.
Changing worksheets refreshes suggested mappings; check them again. Preview
responses contain a sample of at most 200 rows; the displayed record count
represents the full import. Limits: 10 MB per file, 20,000 rows per sheet,
150 columns per sheet and 50,000 rows per import.

Committed evidence is immutable. Re-importing identical invoice events does not
add units; conflicting prices for the same invoice event require investigation.
There is intentionally no silent overwrite or deletion of financial evidence.

## Verification and approval

The confirmed calculation is:

**Claim per serial = invoiced reseller unit price excluding GST − GTM Buy Ex**

Only positive differences can be approved. Verification checks invoices,
credits/returns, customer/SKU ownership, chronology, selected date basis,
promotion dates, prior approvals across every promotion and remaining caps.
Ambiguous invoice ownership, missing dates/prices and non-unit claim quantities
need review/correction rather than an inferred payment.

Choose the promotion, account, committed claim file, date basis and period.
Inspect each reason. Change the eligible selection and **Recheck selection**
before approval; excluded rows do not consume caps. Drafts survive reloads.

Approval requires confirmation and a reference. The server re-verifies under a
database transaction and rejects stale results. Concurrent requests cannot
approve a serial twice or overrun a cap. Retrying an already-approved draft
returns its existing batch rather than creating another approval.

## History and safeguards

- Approved batches retain the actual terms, invoice prices, GTM values, results,
  source references and date settings used at approval.
- Changing a promotion later does not rewrite an approved statement.
- XLSX/CSV exports come from these snapshots. Draft statements are explicitly
  marked **not approved**.
- Historical imports are marked historical and never create new payable claims.
- Exact promotion-name matches link historical quantities to that promotion's
  caps, including when the promotion is created after importing history.
- No new authentication or preparer/approver roles are introduced. Access is the
  existing app access; do not treat it as a verified individual approver audit.
- Batch reversal/reapproval and automated payments are intentionally not provided.
- No invoice, serial, price or claim content is sent to external AI or analytics.
- Existing SOH/Sell Through totals are not serial-level eligibility evidence.

## Developer verification

The additive Drizzle schema is applied in development with the existing database
push command, and the existing post-merge script applies it when work is merged.
Publishing/production schema changes still use the project's normal publishing
workflow; do not point test fixtures at production.

```sh
pnpm --filter @workspace/api-server test
pnpm run typecheck
# Requires the managed API workflow and development proxy to be running:
SCANBACK_INTEGRATION_URL=http://localhost:80/api \
  pnpm --filter @workspace/api-server exec vitest run src/lib/scanback.integration.test.ts
```

The opt-in integration test exercises import previews, remapping, credits,
selection/caps, stale verification, idempotent/concurrent approvals, historical
claims and immutable exports. It removes only IDs it created.
