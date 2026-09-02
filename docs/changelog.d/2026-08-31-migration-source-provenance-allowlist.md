## 2026-08-31 — the migration apply gate now checks where the SQL came from

**Plain English.** Before this change, the gate that protects a live database migration
could confirm everything *about* a migration except the one thing underneath all of it:
that the SQL being sent is actually a migration this repository holds. It checked the
name, it checked that the SQL matched its review proof, it checked ordering and
destructiveness — but every one of those values is supplied by whoever is asking to
apply. Parked or rejected SQL, submitted under a normal-looking migration name with
proofs minted against that same text, satisfied all of them. The locks were sound; they
were all bolted to the same door frame, and nothing was bolted to the floor.

Found by CodeRabbit on PR #525 (Major). It was correctly ruled out of scope there — that
PR does not touch the apply gate and strictly reduces exposure — but the gap is real and
pre-existing.

**What changed.** One new rule in the shared rule book, `.claude/hooks/migration-apply-lib.mjs`:
the SQL about to be transmitted must be the exact content of
`<checkout>/supabase/migrations/<migration name>.sql`. Line endings are normalized on both
sides so a CRLF working copy is not refused for that alone.

**It is an allowlist, deliberately.** The obvious shape — refuse `scripts/.staging-migrations/`,
refuse a `.REJECTED` suffix — is a blocklist, and blocklists have been reopened repeatedly
in this repo: the PR #401 guard region gained a new PL/pgSQL assignment form every round
until it was pinned as a closed region (`DECISION_LOG` 2026-08-25), and three successive
hand-written parsers in `bash-safety-lib` each left a real destructive bypass before an
allowlist held (`KNOWN_ISSUES` 2026-08-31: eight holes across five rounds). A suffix rule
closes `.REJECTED` and leaves `.rejected`, `.REJECTED.sql`, a scratch copy, a temp
directory, and text that was never a file. Naming only the permitted location closes all
of those at once, including spellings nobody has thought of.

**Scope** matches the reviewer-proof lookup exactly: this session's own checkout and the
primary one, never a sibling worktree. A file sitting in another concurrent session's
checkout is not this session's reviewed work.

**Both doors, every spelling.** The rule lives in the shared library, so the PreToolUse
hook and `scripts/apply-migration-file.mjs` inherit it and neither can drift laxer. The
hook is registered once on matcher `mcp__.*` and filters on a tool name containing
`apply_migration`, which is what makes all three MCP server spellings in
`.claude/settings.json` equivalent — now asserted rather than assumed, so a fourth server
name would be covered automatically. `apply-migration-file.mjs` also asks the same
exported resolver early, purely so the operator gets a refusal naming the file they
passed; it is not a second implementation.

**Proof observed.**

- `migration-apply-lib.test.mjs` 163 assertions, `migration-apply-guard.test.mjs` 107,
  `guards.test.mjs` 168, `codex-push-lib.test.mjs`, `production-action-guard.test.mjs`,
  `npm run test:agent-workflows`, `npm run agent-health`, `npm run typecheck` — all green.
- **Mutation-tested**, per the standing rule that a guard only ever observed passing has
  not been tested. Disabling the check turned the headline case red with `got allow`,
  confirming the gap was reachable and not hypothetical. Checking the filename but not the
  content turned the name/body-disagreement case red. Widening the scope to every worktree
  turned the suite red.
- **Real path, this repo, read-only.** A genuinely pending migration
  (`20260827041000_align_recognized_invoice_report_statuses`) passes provenance and
  advances to the pre-existing ordering check. A genuinely parked one
  (`scripts/.staging-migrations/20260813010000_wave_a_order_cost_authority_and_finiteness.sql`)
  is refused by name. Nothing was transmitted; no migration was applied.
- Attack cases are seeded from the pinned alias cases in the existing suite, including
  path traversal through the caller-supplied name, five suffix spellings the rule never
  mentions, and a directory sitting where the file should be.
- **The symlink-escape case is present but did NOT run here.** An earlier draft of this
  entry claimed it as covered before the test existed; Codex caught the overclaim on the
  exact-SHA review of `f498c473`. The test is now written, and it *skips* on this machine
  because Windows needs Developer Mode or elevation to create a symlink — it prints
  `SKIP symlink-escape case` rather than passing silently, so a case that cannot run is
  never counted as one that succeeded. It will run wherever symlink creation is permitted.

  **Superseded description, corrected 2026-08-31 (CodeRabbit, PR #533):** this paragraph
  originally described the containment logic as "`realpathSync` on both the directory and the
  file". That was the *first* implementation, and it was the bypass Codex found in round 2 —
  a redirected migrations directory made both sides resolve outside together. The shipped rule
  resolves the **checkout root**, requires the real migrations directory to equal
  `<real-root>/supabase/migrations`, and then requires the real migration file to sit inside
  that directory. See `2026-08-31-provenance-anchor-boundary-at-checkout-root.md`.

**What the exact-SHA Codex review caught** (`gpt-5.6-sol`, high effort, head `f498c473`,
verdict CLEAN, no blockers or high-severity — both findings below are fixed in the follow-up
commit):

1. **A new gate can make an old test pass for the wrong reason.** The expired- and
   malformed-autopilot cases sent destructive SQL while the fixture's migration file still
   held benign SQL, so source provenance refused on content-mismatch *before* the autopilot
   rule was reached. Both cases stayed green and would have gone on being green through an
   autopilot regression. This is the general hazard of inserting a check early in a chain:
   every downstream test that does not supply the new precondition silently stops testing
   what it names. The fixtures now supply it, and both cases assert the `LAPSED` reason
   rather than merely asserting a refusal.
2. **The evidence claim outran the evidence.** This entry asserted a symlink-escape test
   that did not exist. Corrected above, and the test now exists.

**Not verified / limits.**

- **This does not stop a determined agent that copies a parked file into
  `supabase/migrations/`.** Provenance would then pass, and the reviewer and Codex proofs
  would still be required. That is the honest boundary: the rule closes the *quiet* path
  (paste the body under a canonical name, leaving no trace on disk) and forces the loud
  one (a tracked, diffable, reviewable file move). It is the same class of residual as the
  proof self-attestation documented in `KNOWN_ISSUES` §4b.
- **The rejected ledger-order migration IS parked on `main`** at
  `scripts/.staging-migrations/20260827223000_enforce_global_migration_ledger_order.sql.REJECTED`,
  and is therefore refused by this guard — the outcome the guard exists for.

  *Corrected 2026-08-31 (CodeRabbit, PR #533).* This bullet originally read "is not yet
  parked on `main`", claiming the file was still armed in `supabase/migrations/` and that the
  parking commit sat on an unmerged branch. **That was already false when written.** The
  branch had landed as #525; because it was squash-merged, the source branch was deleted and
  a `git log` glance read as unmerged. The claim was then repeated from earlier in the session
  instead of being re-derived from `main`.
  Kept as a labelled correction rather than a silent rewrite: the failure mode — trusting a
  fact established earlier in a long session instead of re-reading the tree — is the useful
  part, and the two mechanics that produce it (squash-merge hides that a branch landed;
  a stale in-session fact outlives the state it described) are worth leaving visible.
- The six pending return-credit migrations (`20260827041000`–`20260827041500`) are all in
  `supabase/migrations/` and are unaffected.
- `.claude/hooks/codex-push-lib.mjs` is a blob-pinned protected input; extracting
  `sessionCheckoutRoots` from `sessionProofDirs` required the sanctioned re-pin in
  `scripts/apply-live-testdata-maintenance-20260812.mjs`. The transform is identity, and
  the output blob was taken from the producer test's printed candidate, not hand-computed.
