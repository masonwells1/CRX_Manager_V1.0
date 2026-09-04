## 2026-09-04 - CHECK 2 keeps the bounded local-search method; the overload-evidence rules are deferred

**Scope decision by Mason, 2026-09-04.** Five rounds of exact-SHA `gpt-5.6-sol` review on PR #594
ended with rounds 4 and 5 asking for opposite things, so the pull request was split. This entry
records the half that landed and, in enough detail to resume, the half that did not.

## What landed

`.claude/agents/migration-drift-reviewer.md` — CHECK 2 gains ONE paragraph, and changes nothing
else. The diff against `origin/main` is a strict addition: no rule was removed, no severity lowered.

The paragraph makes the local search **mandatory rather than a preference**. The reviewer must
answer CHECK 2 with a small, bounded number of local `Grep`/`Bash` searches across
`supabase/migrations/`, and must NOT use a remote/GitHub file-reading tool (`fetch_blob` or similar)
to walk history file by file.

**Superseded the same day** — see `2026-09-04-check2-two-phase-search-and-identifier-scrub.md`. As
first written this paragraph prescribed a single `grep -rnoiE` pass, which prints only matched names
and so cannot see the argument types or preceding `DROP FUNCTION` that steps 2 and 3 consume.
CodeRabbit caught it on `21fec2b16`; the method is now two-phase (discover, then read the
candidates). The measurement and the remote-enumeration ban below are unchanged.

This is not a style note. Measured 2026-09-03, the local one-pass grep answered CHECK 2 in **0.17
seconds**, while the per-file remote walk **died twice — after 598 and 751 fetches — producing no
verdict at all**. An unfinished review is worth less than a fast one, and a reviewer that reliably
dies is a gate that is not running.

`scripts/check-agent-guidance.mjs` — five exact-text assertions pin that paragraph and main's two
original CHECK 2 rules, so a future rewrite that drops the method or weakens the finding fails the
guard rather than passing silently. Mutation-tested: removing the paragraph turns three assertions
red; restoring it returns the suite to green.

`docs/reference/migration-history.md` row 910 — records the F2 live apply, and no longer contains
the literal parked-candidate marker phrase in prose. `worktree-awareness-lib.test.mjs` counts parked
candidates by scanning for that phrase, so a prose mention read as a live marker and failed CI.

## What was deferred, and why

The contested half tried to make CHECK 2 decide overload collisions from **live catalog evidence**
rather than authored history alone. It is now recorded in `docs/manual/KNOWN_ISSUES.md` as an open
item with the four constraints any real fix must satisfy. The short version:

- CHECK 2 can only see what is authored in `supabase/migrations/`. An overload that exists live but
  was never authored is invisible to it. That gap is **pre-existing on `main`** and untouched here.
- The obvious fix — require live evidence before clearing the check — is unshippable as written.
  `scripts/write-apply-proofs.mjs` (`buildReviewerCharterPrompt`, line 75) runs this charter as a
  sandboxed read-only Codex process whose prompt carries only the charter text and the migration
  path; it injects no catalog result. Every migration containing a `CREATE OR REPLACE FUNCTION`
  would have emitted a finding forever, returned BLOCKERS, and blocked the sanctioned apply path. A
  gate that always fails is a gate that gets routed around.
- Closing it therefore needs a change to the **proof runner**, not only to the charter prose. That
  is its own task with its own plan, which is why it is not in this pull request.

Also captured there, so the next attempt does not have to rediscover them: argument types must be
compared by `proargtypes` (the canonical OID vector) because `regprocedure` renders types
search_path-dependently; a COUNT can never acquit, since live `f(integer)` plus a migration adding
`f(text)` reads as a pre-apply count of 1 and applies to 2 overloads; and detection must stay
separate from acquittal so the check always reaches a verdict without a database.

## Verification

- `node scripts/check-agent-guidance.mjs` — green; mutation test red then green.
- `npm run test:agent-workflows` and `npm run test:correction-guards` — both run before pushing.
  Running only the first is what let the row-910 marker reach CI on the previous round.
