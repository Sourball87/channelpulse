---
name: Dependency security verification
description: Official SheetJS releases and audit limitations; composite declarations after dependency changes
---

Use the official patched SheetJS CE distribution rather than the abandoned npm
release, preserving both legacy XLS and XLSX imports. Compare scan results with
maintainer advisories; do not suppress the SheetJS findings merely to get zero.

**Why:** The npm advisory records have no fixed upper bound and continue to flag
official releases that the maintainer explicitly confirms contain both fixes.

**How to apply:** Consult `docs/dependency-security.md` for evidence and recheck
the maintainer's advisories when updating the spreadsheet parser.

Pin the official CDN archive's SHA-512 integrity in the lockfile and confirm
that it survives dependency updates.

**Why:** pnpm initially recorded only the remote tarball URL, without an
integrity field, so a frozen install alone did not protect against changed
archive bytes.

**How to apply:** Check the resolution for an explicit integrity field, not just
a versioned URL, when changing CDN dependencies.

Force-rebuild composite library declarations after upgrading type dependencies.

**Why:** Incremental TypeScript checks can reuse declarations inferred against
the old dependency, producing misleading downstream implicit-any errors even
when the new source types are correct.

**How to apply:** Run `pnpm exec tsc --build --force` before the workspace typecheck
when changing shared type-producing dependencies.
