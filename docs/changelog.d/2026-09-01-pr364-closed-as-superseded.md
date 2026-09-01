## 2026-09-01 — PR #364 closed as superseded, and the three protections that did not survive with it

PR #364, "harden money-repair replay and SQL safety gates," was open since 2026-08-10, sat 109
commits behind `main`, and read `DIRTY`/`CONFLICTING`. The task that opened this session was to
rescue three guard commits believed to be stranded on it. The answer turned out to be that two of
the three should never be rescued, and that the branch's real value was somewhere else entirely.

**Its headline deliverable had already shipped.** `20260810025159_backfill_stale_line_profit.sql` is
byte-identical on `main` and on the PR head — same blob `f4f97722be903f431d1f4f30cebfe14c8d2ab3ca` —
and was applied live on 2026-08-09. The PR added **zero** migrations `main` lacked, and was missing
ten that `main` had.

**`main` had independently rebuilt the same guard.** Since the merge base `14378963c`, four merged
PRs hardened `.claude/hooks/migration-apply-lib.mjs`: #483 (normalized exact proof-name matching on
both doors), #514 (exact production-project pin, empty-SQL rejection, mandatory proof `queryHash` in
every mode), #502 (pending-migration queue enforcement, fresh-`origin/main` requirement, fail-closed
git timeouts), and #533 (name → repository file → passed path → transmitted SQL must all agree).

**The three stranded commits are superseded, not stranded.** A `gpt-5.6-sol` high-effort review did
the line-by-line comparison and found `main` strictly stronger on every protection `1692978f2` and
`286a38d2a` introduced — proof identity, proof content, canonical file identity, outside/nested/
symlinked file rejection, and the MCP pasted-SQL door. The clearest single instance:
`scripts/apply-migration-file.mjs` on `main` (463 lines) carries the `NOT A PERMITTED MIGRATION
SOURCE` and `LEDGER NAME` refusals that the branch (382 lines) does not. Its refusal set is a strict
superset. **Re-applying those commits would be a regression**, which is the opposite of the premise
this task started from.

**Merging was not viable.** Both sides rewrote the same security-critical file from a 495-line
common ancestor — to 1,068 lines on `main`, 1,812 on the branch. The three-way merge touches 20
files on both sides across 29 conflict hunks, spanning both migration-apply files, their tests, hook
config, CI, and shared evidence helpers.

**Correction to a claim made earlier in this session.** It was asserted that the event-trigger guard
was the branch's *only* surviving value, and that it could be ported as a small standalone PR. The
Sol review returned `MIXED` and refuted both halves. Three protections have no equivalent on `main`:
apply-time one-shot replay enforcement (`main` consults `one-shot-migrations.json` only at
replay-plan time, never at the live apply door, and cannot detect a renamed or disguised repeat of a
one-time data repair); fresh project-bound live evidence (`main` accepts a per-checkout snapshot up
to 24 hours old that does not record which project it came from); and event-trigger plus transitive
fanout protection. The extraction is roughly 8 files and +9,250 lines, dominated by
`.claude/hooks/apply-time-dml-lib.mjs` at 2,612 lines — not a small port. A second claim, that the
divergence was "354 files," was also overstated: 354 is a tip-to-tip snapshot, while the branch's
own contribution since the merge base is 45 files, +25,728/−962.

**Proof observed.**

- All ancestry, blob-identity, line-count, and refusal-family facts above were read from git objects
  in this session, not inferred from the PR description or the handoff that opened it.
- The handoff's claim that the branch's 18 commits were unpushed was **false** — they were already
  on `origin` as `claude/pr364-guard-commits-local-20260831` (the handoff wrote the name with a
  doubled `claude/claude/` prefix, so its own verification missed them). Nothing was ever at risk.
- The merge was executed locally to enumerate the real conflict set, then aborted. Nothing was
  pushed, merged, rebased, reset, or force-pushed, and the Codex lane's worktree was never written
  to.
- The Sol review ran read-only via `codex exec` (`codex review` self-recurses in this repo) and was
  explicitly prompted to refute rather than confirm.
- Sol could not verify live database state from its sandbox. The six enabled event triggers were
  confirmed separately by read-only Supabase query on 2026-09-01 — `pgrst_ddl_watch`,
  `pgrst_drop_watch`, `issue_pg_net_access`, `issue_pg_cron_access`, `issue_pg_graphql_access`,
  `issue_graphql_placeholder` — matching the branch's 2026-08-24 manifest exactly, which confirms
  that manifest is still accurate.

**Not verified.** Whether the three-contract extraction can be built cleanly on current `main`. It
is scoped in `docs/audits/2026-09-01-pr364-guard-extraction-scope.md` and **not approved to build**.

Branch `claude/pr364-guard-commits-local-20260831` (tip `57d27e79`) is deliberately preserved as the
only remaining home for those three protections. It is recorded in `KNOWN_ISSUES.md` so a future
cleanup sweep does not delete it.
