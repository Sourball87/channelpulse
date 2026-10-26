# Dependency security

## SheetJS advisories and the npm audit discrepancy

The application reads both modern `.xlsx` and legacy `.xls` reports. It uses
SheetJS CE **0.20.3**, obtained from the maintainer's official, versioned release:

https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

The lockfile pins the archive's SHA-512 integrity hash, which pnpm verifies on
download:

```
sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==
```

pnpm initially records URL-only resolutions for this CDN tarball; preserve the
explicit integrity field during lockfile updates. The npm `xlsx` release
(0.18.5) is unmaintained and must not be substituted for this release.

Verification used an isolated frozen install with a fresh package store:
the pinned checksum accepted the official archive. Repeating with a deliberately
incorrect checksum and another fresh store failed with
`ERR_PNPM_TARBALL_INTEGRITY`. The workspace frozen install also passed with the
explicit integrity field in place.

The maintainer confirms these fixed versions:

| Advisory | Issue | Fixed in |
| --- | --- | --- |
| [CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533) / GHSA-4r6h-8v6p-xvw6 | Prototype pollution | 0.19.3 |
| [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363) / GHSA-5pgg-2g8v-p4x9 | Regular-expression denial of service | 0.20.2 |

Both are fixed in 0.20.3. As of October 26, 2026, the dependency scanner's npm
advisory records have an unbounded affected range (`introduced: "0"` without a
fixed version), so they still report these two issues against the patched
archive. This is a reporting limitation, not an accepted vulnerable version.
No advisory exclusions or scanner suppressions are configured.

## Withdrawn braces advisory

The original findings included
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
against braces 3.0.3. GitHub withdrew it on October 23, 2026 because it is
“not a practically exploitable vulnerability.” There is no patched release,
and the current scan no longer reports it. The latest braces release remains
3.0.3; its development-only use through fast-glob is unchanged.

## Transitive overrides

Prefer updating direct dependencies first. Some current parent releases still
retain old or pinned transitive packages:

- Tailwind Typography pins selector-parser 6.0.10; use the patched 7.x release
  and verify the CSS production build.
- Tailwind's Node tooling pins source-map-js 1.2.1; require 1.2.2 or newer.
- Babel's dependency tree retains an older Browserslist; require the patched
  4.x release.
- Orval's Scalar dependency pins an affected Undici 7.x release; update only
  that major to a patched version, leaving its separate 8.x dependency alone.
- Resolve Vite consistently to patched 7.x so the preview plugins and Vitest
  use compatible plugin types.

The one-day minimum release age remains enabled. Orval 8.44 is used because
8.45 had not cleared that safety window when these updates were made.

## Verification

- `pnpm install --frozen-lockfile`
- `pnpm exec tsc --build --force` after dependency changes, to invalidate
  composite-library declarations built against old dependency types.
- `pnpm run typecheck`
- `pnpm --filter @workspace/api-server test` (includes `.xlsx`, `.xls`, and CSV
  parser regression tests)
- Build each artifact with its configured `PORT` and `BASE_PATH`.

When interpreting security results, compare actual installed versions with the
maintainer advisories rather than removing or suppressing findings to obtain
a clean scan.
