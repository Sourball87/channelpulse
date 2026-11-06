# Scanback Claims

Open **Scanback Claims** in ChannelPulse. This section records claim decisions;
it does not send payments or issue credits in Pronto.

## First-time setup

1. In **Programs**, create a promotion with inclusive calendar dates, existing
   Account Codes and Stock Codes.
2. Enter **GTM Buy Ex** for each SKU. A blank customer/SKU quantity cap is
   unlimited; zero makes that customer ineligible for the SKU.
3. In **Upload Center**, upload Pronto invoice/credit evidence. Review the worksheet,
   column mappings, date format and account attribution, then commit.
4. Import **historical approved claims** before approving new claims, so previous
   payouts are included in duplicate checks and applicable promotion caps.

Existing account and SKU records are reused. Unknown accounts/SKUs must be
resolved, not automatically created from an unverified financial file.

## Programs: inline spreadsheet

Select a promotion above the grid, or use **New**, **Copy**, or **Archive**.
Name, inclusive Start/End dates, computed status and Notes live inside its
header band. Status is Upcoming, Live (calendar days remaining, including the
last eligible day), or Ended. Archive retains the promotion and its history;
Restore makes it available again. There is no delete operation.

The table columns are:

**SKU | RRP Inc | GTM Inc | Disc % | DD Cost Ex | T1 Ex | GTM Buy Ex |
STA (T1 − GTM Buy) | Capped Qty | each customer | Claimed**

- Type or pick a SKU to fill RRP Inc, DD Cost Ex and T1 Ex from the committed
  price list. **Refresh from price list** updates matching rows explicitly.
  Unknown SKUs clear those references rather than retaining another SKU's prices.
  Description stays in the price list, not this grid.
- Disc % is `(RRP Inc − GTM Inc) ÷ RRP Inc × 100`, with no dollar-discount
  column. STA is `T1 Ex − GTM Buy Ex`. Missing reference values stay blank.
  Reference prices are saved with the promotion; they never change the claim
  formula, which remains **invoiced unit price ex GST − GTM Buy Ex**.
- **Capped Qty** adds the numeric customer caps on that SKU. Blank means
  unlimited and is not included in that displayed sum; zero means ineligible.
  The **Total of SKU caps** footer sums numeric SKU caps for each customer.
  These are display totals only: there is **no all-SKU customer-total cap**
  and no total-cap enforcement rule.
- **+ Add customer**, next to **Add SKU**, adds a reseller column. Its heading's
  X removes that customer unless approved claims exist on this promotion.
  That protection is checked again on the server, including historical approvals.
- **Claimed** counts approved serials for the SKU, including linked historical
  approvals. Copying terms does not copy claims.

Use **Save changes** or **Save promotion** inline. Existing validation and
version checks still apply. Background refreshes do not overwrite unsaved
edits. A conflict offers reload/discard or copying your edits into a new draft.
Switching promotions, New, Copy and Archive warn before discarding edits.
Copy retains reference prices and SKU caps but receives a new name and ID only
when saved; its claim counts start at zero.

### Paste or upload a program table

1. Click **Paste program** and paste a rectangular Excel/email table including
   its headings. Tab-separated, CSV and pipe-separated tables are accepted.
   For a file, drop CSV/XLS/XLSX in **Upload Center**, choose Program table if
   detection is unclear, and use **Preview in Programs** / **Open in Programs**.
   **Preview latest upload** opens the latest committed program-table source.
2. Review heading assignments and the source-only row preview. Standard headings
   and existing customer names/codes are matched deterministically. When needed,
   AI proposes mappings using headings and the existing reseller list only;
   it does not receive source rows and cannot supply prices, caps or SKU values.
3. Highlighted unmatched columns must be mapped to a field/customer or explicitly
   ignored. **Apply mapping** reruns the preview using your assignments, without
   AI overriding them. Invalid prices/caps and duplicate SKUs block confirmation.
   Missing GTM Buy Ex can be completed in the resulting draft before saving.
4. Tick the review confirmation and **Build draft**. Enter name/dates, finish
   required fields and save inline. Previewing or building a draft does not save
   a promotion. Blank source prices remain blank; price-list values are not
   silently substituted during paste/file creation.

Paste limits are 1 MB, 1,000 SKU rows and 150 columns. Program-file previews use
the original first worksheet and source headings retained by Upload Center.
Below the active table, every other promotion is stacked newest first as a
muted, compact, read-only full table, with dates/status, approved units/dollars
and **Open**. Editing current program terms never rewrites approved batch
snapshots or their exported statements.

## Automatic serial tracking and lookup

Tracking is built from the durable, committed invoice/customer-report sources
and the existing approved-serial ledger, so it also covers existing imports.
There is no separate editable ledger to get out of sync with approvals.

- **INVOICED:** the DD/Pronto evidence records the invoiced reseller, invoice
  number/date and invoiced unit price ex GST (what the reseller paid us).
  Optional **Our unit cost ex GST** / **Item Cost** is retained as reference
  only. It is never used to calculate a claim.
- **SOLD:** committing a customer serial report in Upload Center records its
  reseller, sell date and source report for every serial. Staged previews do
  not reserve serials. The first committed report owns each sale; backdating
  another report or uploading it earlier without committing cannot take over.
  Existing legacy reports without a commit timestamp use their saved creation
  time to establish their original order.
- **CLAIMED:** an approved serial is linked to its immutable promotion/batch.
  Historical approved imports count too. The existing approval transaction,
  unique-serial constraint and per-SKU/customer cap rules are unchanged.

Later reports from **any** customer retain repeated rows as flagged audit
events, but exclude them from new-sale serial counts and payable claims.
Duplicates within one report are also excluded after its first occurrence.
The first report remains verifiable without blocking itself until claimed;
rechecking it does not create another sale. Returns and later reports do not
silently reset SOLD or CLAIMED history.

**Verify Claims** shows invoice recipient, invoice number/date, customer-paid
price ex GST, GTM Buy Ex and their calculated difference, alongside the reason:
**red** for previously claimed/reported serials (with original batch/promotion
or report details), **orange** for sales outside promotion dates, and **green**
for payable rows. Other blockers remain neutral. A known sell date outside
promotion dates is blocked even when invoice-date basis is selected. Calculated
differences on blocked rows are not payable and do not enter approved totals.

Open **Serial lookup**, or click a serial in verification, for its full
invoice/credit → reported-sale → claimed trail, including repeated reports,
source rows and reference cost when supplied. Search matches the complete serial,
ignoring spaces and letter case without removing leading zeroes. Unknown serials
are shown explicitly, not fabricated. Excluded Pronto accounts remain visible as
audit-only events and never become eligible invoice evidence.

## Evidence and claim files

Upload your existing CSV, XLS or XLSX file in **Upload Center**, the sole file-intake
screen. Files default to **Auto-detect**:
the column headings identify invoice/credit evidence, customer serial reports or
historical approvals. Mixed or incomplete financial layouts require an explicit
type selection rather than a guess. The detected type is shown in the preview;
review mappings and issues before committing. No template download is needed.

The separate Imports tab has been removed. Use Upload Center's weekly customer
serial card to open Verify Claims with that report, customer and applicable
promotion preselected. Configure report expectations in Settings. See
[Upload Center](upload-center.md) for price lists, program tables, weekly report
tracking and pending-file corrections.

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
serial list, but the signed quantity must match the number of serials. SKU codes
not in the product catalogue can still be entered directly on promotion lines;
invoice and claim evidence must use the same code. No product-catalogue row is
created automatically.

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

### Native Pronto POS extracts

Upload the full Pronto export with **Auto-detect** selected. The importer
recognizes the combination of Invoice No, Invoice Date, Account Code, Reseller
Name, Stock Code, Ship Qty, Serial Number, Item Price and Line Price Ex.

- Fixed mapping uses **Invoice Date**, **Ship Qty**, pipe-separated **Serial
  Number** lists and **Item Price** (not Item Cost, Line Cost Ex, RRP or line totals).
- Each included line must satisfy `Item Price × Ship Qty = Line Price Ex` in
  exact cents. Explicit foreign-currency invoices are blocked rather than
  comparing them with AUD promotion prices without a known exchange rate.
- The account table maps Pronto codes to the **existing nine ChannelPulse
  resellers only**. Suggestions are proposals, not automatic assignments.
  Choose **Use suggested mappings** or map individual codes, review them, then
  **Apply mapping**. Changed mappings disable commit until reapplied.
- Unselected accounts and nonserial rows are reported as excluded. An
  uncatalogued Stock Code is retained as invoice evidence (never auto-created
  in the product catalogue); it is claimable only if the exact code is typed on
  a promotion. Included/excluded counts refer to original source rows; the
  record count refers to expanded serial events.
- A selected reseller's credit for a known SKU without serials blocks commit:
  skipping an unidentified return could make an ineligible serial payable.
  Malformed serials, inconsistent quantities and price mismatches also block.
- Serials appearing in excluded account/SKU rows are held for ownership/return
  review, including across committed Pronto extracts. Exclusion must not hide
  conflicting evidence and make a serial eligible.
- Source row numbers are retained for tracing errors and invoice evidence.
  Pronto contact/address/end-user/operator columns are not retained in saved
  previews. Explicit unit-cost columns are retained for the serial trail as
  reference only; they are never substituted for the invoiced unit price.
- Limits include **100,000 expanded serial events per import**. Other existing
  file/sheet limits still apply.

The original uploaded workbook is not changed by previewing or applying maps.
Committed mappings remain immutable, just like other financial evidence.

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
