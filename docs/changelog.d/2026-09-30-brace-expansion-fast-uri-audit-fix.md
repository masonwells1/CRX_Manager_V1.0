## 2026-09-30 - Dependencies: patch brace-expansion and fast-uri so the CI security audit passes

New advisories published on 2026-09-30 made `npm audit --audit-level=high` fail in the
"Lint, Type Check, Test, Build" check, which blocked every open PR.

- `brace-expansion` 5.0.9 → 5.0.12 (high: three denial-of-service advisories). It is pinned by an
  exact `overrides` entry in `package.json` (added in #360 to force a patched version), so the pin
  itself moves; it cannot float.
- `fast-uri` 3.1.7 → 3.1.8 (moderate), a transitive dependency of `workbox-build`, lockfile only.
- `undici` was already at 7.30.0 on `main`.

Proof: `npm audit` reports 0 vulnerabilities; `node scripts/verify-deps.mjs` passes; typecheck, lint
(which loads brace-expansion through eslint-plugin-jsx-a11y → minimatch), build (which loads fast-uri
through vite-plugin-pwa → workbox-build → ajv) and all unit tests pass. Both bumps are patch releases
within their existing major versions.
