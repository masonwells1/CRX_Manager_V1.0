## 2026-09-30 — Bump `brace-expansion` to 5.0.12 and `fast-uri` to 3.1.8 so the CI security audit passes

CI's `npm audit --audit-level=high` step failed on every branch, including `main`, after
new advisories were published on 2026-09-30:

- `brace-expansion` 4.0.0–5.0.11: three high-severity denial-of-service issues from
  crafted brace patterns. The project pins it through the `overrides` entry in
  `package.json` (last moved to a patched version in an earlier audit fix), at 5.0.9.
- `fast-uri` 3.0.0–3.1.7: one moderate issue with host case normalization. It is a
  dev-only dependency.

The `brace-expansion` override and lockfile now pin 5.0.12, still inside `minimatch`'s
`^5.0.2` range. The lockfile pins `fast-uri` 3.1.8, still inside its dependents'
`^3.0.1` range. Only the version, tarball URL and integrity hash lines changed, edited
by hand so this environment's npm would not rewrite unrelated lockfile fields.

### Proof observed

- `npm audit --audit-level=high` reports 0 vulnerabilities, where before it reported one
  high and one moderate.
- `npm ci` installs cleanly, resolving `brace-expansion` 5.0.12 and `fast-uri` 3.1.8.
- `npm run lint` passes.
- `npx vitest run`: 380 test files and 5411 tests pass, with 123 skipped.

### Not verified

- The exact-SHA Sol review was not run, because the cloud session that made this change
  has no Codex CLI login. It runs on Mason's machine before merge.
