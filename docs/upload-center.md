# Upload Center

Open **Upload Center** from ChannelPulse navigation. This is the only file-intake
screen. Scanback Claims, Programs and Claims History link here instead of
offering separate upload controls.

## Upload and confirm

1. Drop CSV, XLS or XLSX files onto the large drop zone or choose files. There is
   no total selection-count limit; the browser sends batches of up to 20 files.
   Each file must be at most 10 MB. Workbook safety limits are 20,000 rows and
   150 columns per sheet, 50,000 rows overall.
2. Review the detected type, reseller, reporting week, column mapping and sample.
   Types are Customer SOH, Customer serial/sales report, DD serial/invoice
   evidence, Price list and Scanback program table.
   Unknown layouts remain pending until a type is chosen.
3. Use **Correct type / reseller / week** to correct a pending file. The reporting
   week dropdown includes recent weeks, and the ISO field allows older weeks.
   An optional intake week is used only for otherwise undated files. Dropping
   directly on a customer card explicitly pins its customer, type and week.
4. Commit from the relevant reviewer. No file commits automatically. SOH retains
   mapping checks and the separate overwrite-confirmation step. Financial
   evidence retains date-format selection, fixed native Pronto columns,
   explicit account scope, credits, duplicate and conflict validation.

AI assistance is enabled by default and can be turned off. Only ambiguous
recognition invokes it. Type suggestions remain suggestions: choose the proposed
type yourself. Metadata and column suggestions never invent quantities, prices,
serials, dates or account identities. The existing Replit AI integration uses
credits; it receives bounded headings, sheet/filename metadata and explicitly
supported recognition evidence, never complete financial or inventory rows.

## Weekly customer reports

The view defaults to the last completed Monday–Sunday week. Use the week dropdown
or previous/next arrows to change weeks. **Customer SOH** and **Serial reports**
each show one card for every active customer:

- **Received** means at least one committed report exists for that customer/week.
- **Missing** means a report is expected but none is committed.
- **Not expected** means the relevant Settings flag is off and none was received.

Pending previews do not count as received. SOH cards show file names, SKU count,
total SOH and units sold. Serial cards show file names, distinct serials, SKUs and
source date range. DD coverage compares reported serials against committed DD
invoice evidence; the invoiced-to-customer count excludes conflicting ownership
and returns. It is **coverage only**, not a claim-eligibility decision.

In **Settings → Resellers**, configure **Sends SOH** and **Sends serial reports**.
Initial defaults retain SOH expectations and do not assume serial expectations.
The missing-report summary and **Copy chase list** use those flags for the
selected week. The copied list is numbered and includes masked account codes and
the reporting week ending Sunday.

**Verify claim** opens the committed serial report and its customer in Scanback
Claims. A unique applicable promotion is preselected; when several apply, choose
one on the card. The report's dates, or its reporting week if dates are absent,
prepopulate verification. No claim is approved by this navigation.

## DD data, prices and programs

The DD data panel shows the latest committed DD invoice/serial report, current
price-list SKU count and last-updated date. Previously committed historical
approvals remain readable in Claims History; new historical-claim uploads are
retired.

Price-list headings: **SKU, Description, RRP Inc, DD Cost Ex, T1 Buy Ex**.
Description is optional; the three prices are required, validated and stored as
integer cents. Explicit mappings are supported. New committed price lists update
their SKUs without removing unrelated prices. Earlier upload previews remain
immutable.

Program-table headings: **SKU, GTM Buy Ex**, with optional per-customer cap
columns. Existing account codes, masked labels and exact account-name headings
can identify cap columns; blank means uncapped and zero means ineligible.
After committing a table, open **Scanback Claims → Programs → Build from program
table**. This opens an editable draft. Enter the promotion name, dates and
eligible customers, review caps, then save. It never creates a promotion just
because a file was uploaded.

The program editor shows stored RRP Inc, DD Cost Ex and T1 Buy Ex as reference
amounts. Claim calculation still uses the reseller's invoiced ex-GST unit price
minus GTM Buy Ex; DD purchase cost is not claim evidence.

## History and corrections

**All uploads** combines legacy SOH and financial imports with new unified
uploads. It shows type, reseller, reporting week, file, row count, upload date and
state. Filter by type, reopen pending reviews, correct metadata or delete pending
previews. Committed reports and financial evidence cannot be changed or deleted
through these actions or their corresponding APIs.

Original file bytes are not archived. The database retains parsed source records
and queryable metadata; reclassification rebuilds a pending preview from those
records inside the same transaction. Failure leaves the earlier preview intact.
Pronto retains only the existing verification-related source columns, not
unrelated addresses/contact information.

The ItemForcastReport / ItemForecastReport forecast layout is attributed to
**Centrecom**, not Umart. Historical committed reports are not silently
reattributed.

## Developer verification

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server test
UPLOAD_CENTER_INTEGRATION_URL=http://localhost:80/api \
  pnpm --filter @workspace/api-server exec vitest run src/lib/center.integration.test.ts
```

The opt-in HTTP test uses the running development workflow, creates uniquely
named test data and removes only its own records. Never point tests at production.
