## 2026-09-01 — the authorized set must be decided where the validation happens

Final round on the migration source-provenance gate. Two reviewers found what looked like
opposite defects on the same line of `scripts/apply-migration-file.mjs`, and they were the same
defect:

- **Codex (P2): too STRICT.** With the migration present in both the primary checkout and the
  session's worktree, `resolveMigrationSource()` returned on its first match — the primary — so
  applying the worktree's *own valid file* was refused. Reproduced at exit code 2.
- **CodeRabbit (minor, security): too LOOSE.** The caller compensated by comparing against
  candidates re-derived from `source.dirs`, which includes roots the resolver never validated. A
  same-named symlink to an external file in a second checkout resolves to the same target and
  was accepted — though the resolver itself rejects it as `escapes-dir`.

**One root cause.** The authorized set was being decided somewhere other than where the
validation happens. Rebuilding candidate paths at the call site cannot know which of them
passed the root-anchor, direct-child, and content checks — so it was simultaneously too narrow
(first match only) and too wide (unvalidated roots included).

**The fix.** `resolveMigrationSource()` no longer returns on first match. It collects every file
that passes all three checks and returns them as `files`; the caller's `approved` set is exactly
that list, never a re-derived one. Strictness and looseness are now settled in one place under
one rule.

Fixing either direction alone would have silently reopened the other — which is why both are
pinned below.

**Proof observed.**

- **Both directions mutation-tested, and both fail on this machine** — which matters, because
  the symlink-based half of the escape test needs elevation and skips here:
  - Re-deriving `files` from `dirs` → `the validated list never contains a path the resolver
    itself rejects as escapes-dir` goes red.
  - Restoring the early `break` (first match wins) → `both validated copies are authorized, so
    neither checkout shadows the other (got 1)` goes red.
- Added a **platform-independent** case for the loose direction: a same-named file that exists
  at a permitted path but fails *content* validation must not be authorized. It needs no
  symlink, so it runs everywhere and guards the invariant even where the escape case skips.
- Suites: `migration-apply-lib` 171 → **177**, `migration-apply-guard` **109**, `guards` **168**,
  `codex-push-lib` pass.
- **Real path, read-only, both directions:** applying the *worktree's* copy while the primary
  holds an identical file now passes provenance and reaches the pre-existing ordering gate; a
  parked wave-A migration is still refused by name. Nothing transmitted; no migration applied.

**Not verified.** Three link-shaped cases still `SKIP` on this machine — Windows will not create
a *file* symlink without Developer Mode or elevation. A *junction* works unprivileged, which is
why the redirected-directory case does execute. Recorded rather than counted as passes.

**Correction to an earlier claim in this series.** Entries above described the untracked
`.agents/skills/source-command-*` directories as output of the current generator under a new
naming scheme. **That was an unverified inference and it is wrong.** Verified by a peer session:
`sync-agent-workflows.mjs` contains no `source-command` string, the 37 tracked adapters are all
unprefixed, each of the 24 prefixed directories *duplicates* an existing tracked adapter, the
generator's `--check` rejects all 24 as not generated from `.claude`, and they appeared across
six worktrees at the same second including ones with no session running. Something writes them;
it is not today's generator, and the writer is unidentified. The candidate remedy is deleting 24
untracked duplicates, **not** regenerating the tracked set — do not run
`sync-agent-workflows.mjs --write` as cleanup, which would mutate tracked files repo-wide and
destroy the evidence. Logged as an open item. The 24 directories from this worktree were *moved*
(not deleted) to the session scratchpad under `agents-drift/` to let the push-proof tool run,
which requires a clean worktree.
