## 2026-09-30 - dependency audit: brace-expansion 5.0.12, fast-uri 3.1.8

New npm advisories made CI's `npm audit --audit-level=high` step fail on `main` from
2026-09-30 12:51Z, which failed "Lint, Type Check, Test, Build" on every branch:

- brace-expansion 4.0.0-5.0.11, high: GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p;
- fast-uri 3.0.0-3.1.7, moderate: GHSA-hrr3-gc8f-f4qj.

Changes:

- `package.json` override for `brace-expansion` changed from the exact `5.0.9` to `^5.0.12`. The exact
  pin is what blocked `npm audit fix`, the same trap #360 recorded when an exact `5.0.8` pin held the
  package on a vulnerable version. A caret range lets later 5.x patches in.
- `package-lock.json`: brace-expansion 5.0.12, minimatch 10.2.6 and fast-uri 3.1.8.

All three are build and lint tooling (reached through `eslint-plugin-jsx-a11y`) or schema tooling; none
ships in the app bundle. Verified locally: `npm audit --audit-level=high` reports 0 vulnerabilities (it
reported 2 high before), `npm run lint` passes with zero warnings, and `npm run build` succeeds.
