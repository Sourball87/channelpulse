# ChannelPulse

Distributor reporting for reseller stock on hand, weekly sell-through and auditable scanback claims.

## Run & Operate

- Use the existing managed workflows for the API and ChannelPulse web app; services bind to their workflow-provided `PORT`.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live
- `artifacts/channel-pulse/` — React/Vite UI, SOH, Sell Through, Upload Center, Scanback Claims and Settings.
- `artifacts/api-server/` — authenticated Express API, deterministic parsers and financial verification.
- `lib/db/src/schema/` — additive PostgreSQL/Drizzle schema.
- `lib/api-spec/openapi.yaml` — API contract; regenerate clients after changes.
- `docs/upload-center.md` and `docs/scanback-claims.md` — operating instructions and safeguards.

## Architecture decisions

- Upload Center is the only file-intake UI. Other pages link to `/upload`; do not add file pickers elsewhere.
- Every upload requires human review and confirmation. Recognition and AI suggestions never commit reports or financial evidence automatically.
- Parsed spreadsheet records are retained in PostgreSQL, not original workbook bytes. Financial imports reuse the existing strict Pronto scope, returns and duplicate checks.
- Committed reports and financial evidence are immutable. Correct/delete pending previews; do not change committed source history.
- Claims use reseller invoiced unit price **excluding GST minus GTM Buy Ex**, never distributor purchase cost. A serial may be paid only once across all promotions.

## Product

- SOH and ST can appear together in a customer-by-Stock-Code table. A separate Sell Through page retains the newest-first 12-week history.
- Upload Center detects customer SOH, customer sales/serial reports, DD invoice/serial evidence, historical approved claims, price lists and scanback program tables.
- Weekly customer-report cards use reporting weeks ending Sunday, reseller-specific expectations, coverage summaries and copyable chase lists.
- Price lists are persistent reference data. Program-table uploads feed editable promotion drafts; name, dates and eligible customers must be chosen before saving.
- Scanback Claims provides Programs, Verify Claims and Claims History; it never sends payments or issues Pronto credits.

## User preferences

- Display the nine customers only as CA, CC, SC, PL, PC, UM, KS, JW and DI; keep internal matching identities.
- `ItemForcastReport` / `ItemForecastReport` is Centrecom, not Umart. The user confirmed its sold quantities match Centrecom serials SKU-for-SKU.
- Do not offer HDD & Memory as a category option or delete existing product/report data to achieve that.
- Preserve the SOH dashboard, reporting status, shared Focus filters and Pronto import safeguards.

## Gotchas

- Run codegen after contract edits, then typechecks. Composite shared-library declarations must be rebuilt after library edits.
- Financial writers share an advisory transaction lock. Canonicalize JSON keys for verification fingerprints because PostgreSQL JSONB reorders them.
- Preserve CSV date/serial strings before explicit normalization; leading zeroes and day/month dates must not be inferred away.
- Missing reporting metadata requires user confirmation. Never use upload time or another file to invent a reporting period or customer.
- AI assistance defaults on, can be disabled, and only sees bounded metadata when deterministic rules cannot decide. Never send source inventory, invoice, serial or claim rows to AI or analytics.
- Development schema push does not publish the application or update production automatically.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
