## 2026-09-30 - Dependencies: patch brace-expansion and fast-uri so the CI security audit passes

On 2026-09-30 the `npm audit --audit-level=high` step in the "Lint, Type Check, Test, Build" check
started failing on every open PR (first seen on PR #795, CI run 36668847260). That run's audit report
listed three packages: `brace-expansion` (high), `undici` (high) and `fast-uri` (moderate). The dates
below are when the advisories reached CI, not when they were published.

- `brace-expansion` 5.0.9 → 5.0.12: the audit report rated it high and listed three denial-of-service
  advisories. It is pinned by an exact `overrides` entry in `package.json` (added in #360 to force a
  patched version), so the pin itself moves; it cannot float.
- `fast-uri` 3.1.7 → 3.1.8 (moderate), a transitive dependency of `workbox-build`, lockfile only.
- `undici` was already at 7.30.0 on `main`, so the other high finding needs no change here.

Proof: `npm audit` reports 0 vulnerabilities; `node scripts/verify-deps.mjs` passes; typecheck, lint
(which loads brace-expansion through eslint-plugin-jsx-a11y → minimatch), build (which loads fast-uri
through vite-plugin-pwa → workbox-build → ajv) and all unit tests pass. Both bumps are patch releases
within their existing major versions.

Not verified: the running app in a browser. Both packages are used only by development and build tools
(the linter and the PWA build step), not by code shipped to users, so no change in the app's behavior is
expected.
