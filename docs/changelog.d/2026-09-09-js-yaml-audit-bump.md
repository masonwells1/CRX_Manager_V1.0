## 2026-09-09 — Bump js-yaml 4.3.1 → 4.3.2 (new high-severity advisory blocked every CI run)

### What was wrong

GitHub published GHSA-2883-xcg3-v3hh at 2026-09-08 21:24Z ("js-yaml: maxTotalMergeKeys does
not limit CPU use for empty merge sources", high). CI's `npm audit --audit-level=high` step
then failed on `main` at the first run after it (run 34301529018 on `8deb2e48a`, a test-only
merge that touched no dependency), and would fail every PR in the repo until the lock moved.

js-yaml is **not shipped to customers**: it is a transitive dependency of ESLint only
(`eslint@9.39.3 → @eslint/eslintrc@3.3.3 → js-yaml@4.3.1`, per `npm ls`). Nothing in the
Vite bundle imports it.

### What changed

`package-lock.json` only, three lines: js-yaml `4.3.1 → 4.3.2` (version, resolved URL,
integrity). Applied with `npm audit fix --package-lock-only --audit-level=high`, the plain
variant; `--force` is banned on this repo because it downgrades react-router.

### Proof observed

- `git diff --stat`: 1 file, 3 insertions, 3 deletions, all under `node_modules/js-yaml`.
- `npm audit --audit-level=high --package-lock-only`: `found 0 vulnerabilities`.
- CI on the PR head: see the PR checks (the audit step is the one that matters here).

### Not verified

- No local `npm ci` with the new lock; CI's install is the real run of that.
