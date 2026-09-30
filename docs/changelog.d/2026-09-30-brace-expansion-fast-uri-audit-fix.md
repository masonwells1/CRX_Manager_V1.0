## 2026-09-30 — Bump dev-only `brace-expansion` and `fast-uri` so the CI security audit passes

CI's `npm audit --audit-level=high` step failed on every branch, including `main`, in two
waves. All three packages below reach the project only through dev dependencies, and nothing
under `src/` imports them, so the live app never shipped any of them.

- `undici` 7.0.0–7.29.0 (ten advisories), through `jsdom`, a unit-test dependency. This PR
  first bumped it to 7.30.0, still inside `jsdom`'s `^7.25.0` range; the same bump then
  landed on `main` with #825, so it is no longer part of this diff.
- `brace-expansion` 4.0.0–5.0.11, through `eslint-plugin-jsx-a11y` → `minimatch` (lint
  time). Three denial-of-service advisories published 2026-09-29 at about 23:45Z, two high
  and one medium: GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7 and GHSA-q2hr-2g5m-vwhr, first
  patched in 5.0.10, 5.0.11 and 5.0.12. `package.json` pins it exactly through
  `overrides`, so it cannot float to a patch on its own (the reason #360 moved it from
  5.0.8 to 5.0.9); the override is now `5.0.12`.
- `fast-uri` 3.0.0–3.1.7, through `vite-plugin-pwa` → `workbox-build` → `ajv` (build
  time). One medium advisory published 2026-09-29 at about 23:54Z, GHSA-hrr3-gc8f-f4qj,
  patched in 3.1.8. Below the gate's threshold, but fixed in the same pass by
  `npm audit fix --package-lock-only`.

Made with `npm install --package-lock-only --ignore-scripts` then
`npm audit fix --package-lock-only`. The lockfile changes only six lines: the version,
tarball URL and integrity hash of `brace-expansion` 5.0.12 and `fast-uri` 3.1.8.

### Proof observed

- `npm audit --audit-level=high` reports 0 vulnerabilities (before: two high, one moderate).
- Both lockfile integrity hashes equal `npm view <package>@<version> dist.integrity`.
- `npm ci` installs `brace-expansion` 5.0.12, `fast-uri` 3.1.8 and `undici` 7.30.0.
- `npm run lint` (ESLint, which loads `minimatch` → `brace-expansion`) passes with zero
  warnings, and `npm run build` (which runs `workbox-build` → `ajv` → `fast-uri` to write
  the service worker) succeeds.
- `npx vitest run`: 380 test files and 5411 tests pass, with 123 skipped.

### Not verified

- The exact-SHA Sol review runs last, on Mason's machine, just before the merge, so its
  result is recorded on the PR rather than in this entry. (The cloud session that opened
  this PR could not run it: no Codex CLI login there.)
