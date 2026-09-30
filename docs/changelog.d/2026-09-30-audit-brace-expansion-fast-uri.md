## 2026-09-30 - dependency audit: brace-expansion 5.0.12, fast-uri 3.1.8

New npm advisories made CI's `npm audit --audit-level=high` step fail on `main` from
2026-09-30 12:51Z, which failed "Lint, Type Check, Test, Build" on every branch:

- brace-expansion 4.0.0-5.0.11, high: GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p;
- fast-uri 3.0.0-3.1.7, moderate: GHSA-hrr3-gc8f-f4qj.

Changes:

- `package.json`: the `brace-expansion` override moves from the exact `5.0.9` to the exact `5.0.12`.
  The project pins this library exactly, so the next advisory needs another manual bump; #360 hit the
  same situation with `5.0.8`.
- `package-lock.json`, regenerated from `main`'s lockfile: only brace-expansion (5.0.9 → 5.0.12) and
  fast-uri (3.1.7 → 3.1.8) change. minimatch stays at 10.2.4.

Both are build, lint or schema tooling (brace-expansion is reached through `eslint-plugin-jsx-a11y`);
neither ships in the app bundle. Verified locally after a clean `npm ci`:

- `npm audit --audit-level=high` reports 0 vulnerabilities (it reported 2 high before);
- `npm run lint` passes with zero warnings;
- `npm run build` succeeds.
