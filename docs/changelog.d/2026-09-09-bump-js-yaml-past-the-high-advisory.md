## 2026-09-09 - Bump `js-yaml` past the HIGH advisory that turned every PR red

Same shape as the `fast-uri` bump on 2026-09-02 (#562): a newly published HIGH advisory against a
transitive dev dependency trips the `Check for vulnerable dependencies` step, which runs BEFORE
lint/typecheck/test/build — so an affected PR shows a red `Lint, Type Check, Test, Build` row
while none of those four actually ran.

```
js-yaml  4.0.0 - 4.3.1
Severity: high
js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources
https://github.com/advisories/GHSA-2883-xcg3-v3hh
```

**Not PR-specific.** `main` itself fails the same step: run `34301529018` at `8deb2e48a`
(2026-09-09T02:01:18Z), failing job `102309821093`, failing step `Check for vulnerable
dependencies`. `main`'s previous run at `914a6d36a` (2026-09-08T18:03:41Z) was green with no
dependency change in between, so the advisory published in that window. PR #642 then inherited
it: run `34302010441`, job `102311226421` — same single failing step, with `Run Vitest unit tests
+ coverage`, `Run ESLint`, `Run TypeScript type check` and `Build (Vite)` all reported `skipped`.

**Path and range.** `eslint@9.39.3 -> @eslint/eslintrc@3.3.3 -> js-yaml@4.3.1`. `@eslint/eslintrc`
asks for `^4.1.1` and the patched `4.3.2` sits inside that range, so this is a lockfile-only bump:
three lines (version/resolved/integrity), no manifest change, no other resolution moved. The entry
carries `"dev": true` — `js-yaml` reaches the lint toolchain only and is not in the shipped bundle.

`npm audit fix --package-lock-only` produces exactly this diff. `--package-lock-only` is the
documented choice here: a plain `npm audit fix` reinstalls into `node_modules`, and where a
worktree's `node_modules` is a junction to the root install, an install through it severs the
junction. This change was then installed and verified in a standalone worktree with its own real
`node_modules` (`npm ci`), so no junction was involved.

**Verified after the bump**, in `C:/CRX_auditfix` at `8deb2e48a`:

- `npm audit --audit-level=high` — exit 1 (`1 high severity vulnerability`) before, exit 0
  (`found 0 vulnerabilities`) after. This is the CI gate command verbatim.
- installed `js-yaml` is `4.3.2` after `npm ci` from the updated lockfile.
- `npm run lint` (eslint, the only consumer of this package) — exit 0.
- `npx tsc --noEmit` — exit 0.
- `npm run build` — exit 0, PWA precache 219 entries.
- `npm run check:docs` — exit 0.
- `npm test` (full Vitest suite) — **372 files, 5,225 passed, 123 skipped, exit 0**.
