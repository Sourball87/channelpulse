---
name: ChannelPulse build decisions
description: Key architecture choices, gotchas, and conventions for the ChannelPulse project
---

## Stack
- **Backend:** Express + TypeScript, Drizzle ORM, PostgreSQL — `artifacts/api-server/`
- **Frontend:** React + Vite, Wouter routing, TanStack Query, Shadcn UI — `artifacts/channel-pulse/`

## Library packages (composite TypeScript)
- `lib/api-client-react` and `lib/api-zod` use `composite: true` with `emitDeclarationOnly` to `dist/`.
- **After editing any source in these libs, you MUST run `npx tsc --build lib/api-client-react lib/api-zod`** to regenerate the `.d.ts` files — otherwise downstream artifacts see stale types.
- The `api-client-react` package.json exports `./src/index.ts` but TypeScript project references resolve through the composite `dist/` declarations.

## Global Filter Bar (Phase 2)
- `FilterProvider` lives inside `WouterRouter` (in `Router()` in App.tsx) so it can use wouter's `useSearch`.
- Filter state is URL-driven (`?parts=1,2&resellers=3&period=last4` or `from=`/`to=` for custom range).
- `apiParams` from `useFilters()` is passed directly to all backend queries via `part_ids`/`reseller_ids`/`week_from`/`week_to`.
- `insightWeek` = `weekTo ?? resolvedWeek` — always a single point-in-time for insight calls.
- Nav links in layout.tsx preserve `?search` params when navigating between filter-enabled pages.

## Backend filter utility
- `artifacts/api-server/src/lib/filter-params.ts` exports `parseFilterParams`, `resolveRange`, `buildConditions`.
- `buildConditions(bases, filters)` — `bases` array may contain `undefined`/`false`/`null`; filtered out. Adds `inArray(partId, ...)` and `inArray(resellerId, ...)` from filter params.
- **Apply buildConditions to ALL queries including history/trailing queries**, not just the main current-week queries. Missing it on history queries causes inconsistent results within a single response.

## Period mode conventions
- SOH = `latestWeek` (most recent in range)
- ST = sum or avg over `weekList`
- WOI = `Math.round(latestSOH / avgWeeklyST)` — always integer, never decimals
- Delta comparison: prior period of equal length to the selected range

## Explorer pivot types
- Valid pivots: `category_model_reseller`, `reseller_model`, `model_week`
- `model_week` pivot only works in period mode (requires `isPeriod`)
- Added `model_week` to `GetExplorerDataPivot` in both `lib/api-zod` and `lib/api-client-react`

## Generated type patterns
- `useGetExplorerTrend` and `useGetTrends` accept `{ query?: UseQueryOptions<...> }` but `UseQueryOptions` requires `queryKey`. Workaround: cast `{ enabled: bool } as any`.
- AG Grid `columnDefs` field must be `NestedFieldPaths<RowType>` in v32+. Workaround: type the `colDefs` array as `any[]`.

## Insights routes
- All 6 insights routes (`health`, `stockout`, `overstock`, `rebalancing`, `whitespace`, `reseller-perf`) updated to use `parseFilterParams` + `buildConditions`.
- `catFilter`/`catJoin` pattern replaced with `buildConditions([week condition, category condition?], filters)`.
- Insights page (`insights.tsx`) uses `insightWeek` from `useFilters()` as the reference week (no own week Select). Category Select remains.
- `useInsightQuery` passes `part_ids`/`reseller_ids` from `apiParams` and includes them in `queryKey`.
