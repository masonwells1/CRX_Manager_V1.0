## 2026-09-05 — Run the correction-guard suite on the Windows CI job

**What changed.** `.github/workflows/ci.yml` only: the `Phase 3C Containment (Windows)`
job gains two steps after the existing supplier-pricing test.

- **Report 8.3 short-name generation on the runner volumes.** Prints
  `fsutil 8dot3name query` for `C:`, the checkout volume, and the `runner.temp`
  volume, then creates a long-named probe file under both `runner.temp` and
  `C:\crx-guard-temp` and lists each with `dir /x`, so the log shows directly
  which volume hands out short aliases.
- **Guard-hook regression tests (win32 alias and path semantics).** Runs
  `npm run test:correction-guards` with `TMP`/`TEMP` pointed at `C:\crx-guard-temp`.
  No `npm ci` is added: every file in the suite imports only Node builtins and
  sibling scripts.

**Why.** Codex GitHub App P2 on PR #612 (comment 3941083883): the
`review-proof-guard.test.mjs` cases that open a proof through its Windows 8.3
alias skip on every non-Windows platform, and the only Windows job ran a single
unrelated test, so the `dir /x` parser and `realpathSync.native` handling could
regress with CI green. The job id and display name are unchanged so no required
check context moves.

**What the runner reported (PR #620, first run).** On `windows-latest`, 8dot3 name
creation is ENABLED on `C:` and DISABLED on `D:`. The checkout (`D:\a\...`) and
`runner.temp` (`D:\a\_temp`) both live on `D:`, and the probe file under
`runner.temp` received no alias. That is why the suite's TEMP points at a long-form
directory on `C:` rather than at `runner.temp` like the supplier-pricing step: on
`D:` the alias cases would skip on every run. A long path on `C:` avoids the
`RUNNER~1` short-form problem the supplier-pricing step's comment describes, which
is specific to the default TEMP's spelling, not to the volume.

**Proof observed.** The full suite passed locally on Windows 11 in a worktree with
no `node_modules` (38 files, exit 0), and passed on `windows-latest` in the first
PR #620 run with TEMP on `runner.temp` (suite step 2 min 45 s; whole job about 8
min against a 15 min timeout). The result of the run with TEMP on `C:` is recorded
in the PR description.

**Not verified here.** The alias cases themselves live on PR #612's branch and
reach `main` when that PR merges; on this branch the Windows step runs the current
`main` suite, which has no alias cases yet. Once #612 lands, the same step either
exercises them or prints the skip note.
