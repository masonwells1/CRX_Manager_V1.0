## 2026-09-05 — Run the correction-guard suite on the Windows CI job

**What changed.** `.github/workflows/ci.yml` only: the `Phase 3C Containment (Windows)`
job gains two steps after the existing supplier-pricing test.

- **Report 8.3 short-name generation on the runner volumes.** Prints
  `fsutil 8dot3name query` for `C:`, the checkout volume, and the `runner.temp`
  volume, then creates a long-named probe file under `runner.temp` and lists it
  with `dir /x`, so the log shows directly whether that volume hands out short
  aliases.
- **Guard-hook regression tests (win32 alias and path semantics).** Runs
  `npm run test:correction-guards` with `TMP`/`TEMP` redirected to `runner.temp`,
  the same redirect the supplier-pricing step already uses. No `npm ci` is added:
  every file in the suite imports only Node builtins and sibling scripts.

**Why.** Codex GitHub App P2 on PR #612 (comment 3941083883): the
`review-proof-guard.test.mjs` cases that open a proof through its Windows 8.3
alias skip on every non-Windows platform, and the only Windows job ran a single
unrelated test, so the `dir /x` parser and `realpathSync.native` handling could
regress with CI green. The job id and display name are unchanged so no required
check context moves.

**Proof observed.** The full suite passed locally on Windows 11 in a worktree with
no `node_modules` (38 files, exit 0). The CI result for this PR, including what the
probe step reported about the runner volume, is recorded in the PR description.

**Not verified here.** The alias cases themselves live on PR #612's branch and
reach `main` when that PR merges; on this branch the Windows step runs the current
`main` suite, which has no alias cases yet. Whether `windows-latest` generates 8.3
names on the `runner.temp` volume is answered by the probe step's log, not by
this entry.
