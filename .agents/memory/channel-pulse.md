---
name: ChannelPulse build decisions
description: Architecture choices, gotchas, and non-obvious decisions for the ChannelPulse Samsung channel inventory app
---

## TypeScript project references with @workspace/db

The db package (`lib/db`) uses `composite: true` in its tsconfig and `emitDeclarationOnly`. It has NO `build` script by default. Before typechecking the api-server, run `npx tsc -p lib/db/tsconfig.json` to generate declarations so TypeScript project references resolve.

**Why:** api-server tsconfig lists `lib/db` as a reference — without declarations in `lib/db/dist/`, TypeScript can't resolve `@workspace/db` named exports.

**How to apply:** Any time typecheck errors say `Module '@workspace/db' has no exported member 'X'`, build the db package first.

## noImplicitReturns and Express route handlers

The workspace `tsconfig.base.json` has `noImplicitReturns: true`. Express route handlers where `res.json()` is called as a side-effect (not returned) trigger TS7030. Override in api-server's tsconfig:

```json
"noImplicitReturns": false
```

**Why:** Express handlers don't use their return value — the response is a side-effect. Requiring `return` everywhere pollutes the code. The override is scoped only to api-server.

## Zod import in workspace packages

The db schema uses `zod/v4` (valid since the workspace uses Zod v4 via catalog). Route files should not import `zod` directly unless it's a declared dependency — api-server doesn't list `zod` as a dep. Use schemas from `@workspace/api-zod` instead.

## Canonical field name for sell-through

The parser uses `sell_through_7d` as the canonical field name (not `st`). The upload commit pipeline calls `applyMappingsToRows()` which outputs `row.sell_through_7d`. Any frontend manual review UI mapping must map to `"sell_through_7d"` not `"st"`.

## Explorer category delta calculation

When computing WoW delta for category-level rows in the explorer, filter prevRows to only parts belonging to that category (use a `catPartIds` Map). Using all prevRows for every category produces inflated/incorrect deltas.

## Explorer trend endpoint week constraint

`/explorer/trend` must add `inArray(inventorySnapshots.weekIso, weekList)` to the query conditions. Without it, all historical data is returned regardless of the `weeks` param.

## Insights page: custom hooks vs codegen

The Insights page uses inline `useQuery` with direct `fetch` calls rather than generated hooks from `@workspace/api-client-react`. This avoids needing to extend the OpenAPI spec + run codegen for endpoints that are only consumed by one page. Pattern: `useInsightQuery<T>(key, path, week, category)` helper defined at the top of insights.tsx.

**Why:** Codegen for Insights would require adding ~10 schema definitions to openapi.yaml and re-running orval. Not worth it for a single-page consumer. Use codegen when multiple packages need the types.

## Insights: category scoping pitfall

When adding category filter support to insight endpoints, ensure ALL sub-queries are category-scoped — not just the main aggregate. Specifically in health endpoint: `totalSkus` and `coveredSkus` both need `eq(parts.category, category)` added via a join.

**Why:** Coverage metric (X/27 SKUs) becomes misleading if it reports all categories while other KPIs are filtered to one category.

## Insights: reseller share delta denominator

Share-of-channel WoW delta must use the **previous week's** channel total as the denominator for prevShare (not the current week's total). Using current total makes all resellers' shares look flat even when the channel itself grew/shrank.

## Seed data approach

Used deterministic seeded-random (no Math.random) to generate 432 inventory snapshots across 3 weeks (2026-W25/W26/W27), 9 resellers, 27 parts. Math.random() is disabled in the durable PTC CodeExecution runtime — use a custom LCG instead.
