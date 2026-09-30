## 2026-09-30 — Bump test-only `undici` to 7.30.0 so the CI security audit passes

CI's `npm audit --audit-level=high` step failed on every branch, including `main`. Ten
newly published advisories cover `undici` 7.0.0–7.29.0, and the lockfile pinned 7.29.0.
`undici` reaches the project only through `jsdom`, a dev dependency used by the unit
tests, so the live app never shipped it.

The lockfile now pins `undici` 7.30.0, still inside `jsdom`'s `^7.25.0` range. The
change is only those three lockfile lines (version, tarball URL, integrity hash).
`npm audit fix` also dropped unrelated `libc` fields in this environment's npm, so that
edit was set aside and the three lines were changed by hand.

### Proof observed

- `npm audit --audit-level=high` reports 0 vulnerabilities, where before it reported one high.
- `npm ci` installs `undici` 7.30.0.
- `npx vitest run`: 380 test files and 5411 tests pass, with 123 skipped.

### Not verified

- The exact-SHA Sol review was not run, because the cloud session that made this change
  has no Codex CLI login. It runs on Mason's machine before merge.
