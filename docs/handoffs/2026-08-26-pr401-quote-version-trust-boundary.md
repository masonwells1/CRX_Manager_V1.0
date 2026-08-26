# Handoff — PR #401, quote-version restore trust boundary

**Written 2026-08-26, updated at handoff.** Mason ended the originating session here deliberately
(it had grown past 13 MB) and asked for the remaining work to move to a fresh session. **NOT
merged. Migration NOT applied. Database untouched.**

**Eight review rounds have run.** Rounds 1-6 are fully addressed. Round 7's three findings are
fixed in commit `612a0457`. Round 8 arrived from the Codex connector on 2026-08-26 (not
CodeRabbit, which had not re-reviewed `612a0457` when round 8 was fixed) and is addressed in the
commit that follows it — see the Round 8 section below. CodeRabbit is rate-limited to one review
per hour; read whatever it posts on the newest head before merging.

## What this PR does, in one paragraph

Restoring a quote version rebuilds `quote_items.cost_at_quote_cents` — real money. Before
`20260813080000` closed the browser write path, rows could be written to `quote_versions`
directly, and a normal-looking legacy row cannot prove it came through the owner RPC. This adds
`quote_versions.restore_trusted_at`, stamped by `create_quote_version` on its own first successful
insert; `_restore_quote_version_below_cost_impl_20260810` then refuses an unmarked version with
`QUOTE_VERSION_LEGACY_UNTRUSTED` before touching any row. **No backfill, deliberately** —
backfilling would convert an unprovable assertion into trust. Pre-boundary snapshots stay readable
but stop being restorable.

## Exactly where it stands

| | |
|---|---|
| Branch | `codex/quote-version-restore-trust-boundary` |
| Migration | `supabase/migrations/20260825190000_quote_version_restore_trust_boundary.sql` |
| Diff vs `main` | 19 files, ~1,722 insertions |
| Required checks | all three passing (Vercel; Lint/Type/Test/Build; SQL Migration Validation) |
| Local gate | full suite green — 340 files, 4,784 passed, 0 failed |
| Merged | **no** |
| Applied to live | **no** |

Mason approved both the merge and the apply in-session ("finish it"), and that approval was not
withdrawn — he stopped the session for size, not for doubt. **Even so, re-confirm before merging:**
a merge deploys production and the apply is irreversible by rollback (see step 4). Treat a handoff
as context, never as standing authorization.

The remaining blocker has been review-state mechanics, not the code. `reviewDecision` reads
`CHANGES_REQUESTED` from a review whose findings are all resolved; it does not auto-clear.

## Round 8 (Codex, 2026-08-26 12:30 UTC) — fixed on this branch

The Codex connector reviewed head `612a0457` and found a real hole in the invariant-sweep
predicate: every check pinned the **prefix** before the `QUOTE_VERSION_LEGACY_UNTRUSTED`
raise, and nothing pinned the tail. A re-emission could keep the prefix byte-identical,
move the sole owner call into an appended `EXCEPTION` handler, and deliberately raise into
it — catching the rejection restores legacy snapshots while the prefix pin, the exact-IF
count, the sole-owner-call count and the ordering check all still pass. Proven against
live PostgreSQL 17.6 both ways (as string literals, read-only): the handler body passes
every pre-round-8 check; only a whole-normalized-body length+md5 pin refuses it.

The fix pins the ENTIRE normalized body of both re-emitted functions
(`create_quote_version` 3972/`3723acbbf1821e9d5d212c3aea983f86`,
`_restore_quote_version_below_cost_impl_20260810` 3720/`b864c261854b760ff22f1f24e87ae22f`)
in the predicate (both create branches and the restore contract), the migration
postcondition, and the mirror test's mutation proofs. This is round 5's boundary lesson in
terminal form: whole-body pinning leaves no interval to argue about, on either side.

Both migration reviewers (RLS + drift) then re-verified every pin byte-for-byte through
independent toolchains, reported zero blockers, and converged on one HIGH: the migration
asserted overload uniqueness for the restore side but never for `create_quote_version`, whose
single-signature REVOKE a second overload would silently escape — the exact hazard
`20260813080000` spelled out. Fixed in the same commit: the precondition and postcondition now
pin the create-side overload count (measured 1 on live, read-only) and read the create-side
grant state back after the REVOKE/GRANT pair. The two exemption-marker citations were also
corrected per review. The maintenance obligation the whole-body pins create is recorded in
`docs/manual/KNOWN_ISSUES.md` (2026-08-26 entry).

**Rounds 9-10 (Codex, later on 2026-08-26)** extended the same lesson one level deeper and
were fixed the same day: the owner impls' bodies and the public restore wrapper's route are
now pinned too (live-measured, verified green against live), and the migration precondition
pins the PRE-images of the two functions it replaces so an apply after live drift fails
closed. The pinned set is closed at the five chain routines; see the CHANGELOG entry.

Two hook bugs surfaced while landing it, worth separate fixes: the grant-change guard and
the idempotency guard both apply an Edit's `old_string` against the on-disk file with an
exact string split, so on a CRLF working tree every Edit fragment silently fails to apply
and the guard evaluates the UNEDITED file — the marker it demands can then never be added
via Edit (worked around with a full-file Write, which the guards evaluate correctly). The
migration now also carries the `caller-analysis: create_quote_version` and
`idempotency-body-check: exempt` markers those guards require, with the analysis inline.

## Round 7 (the previous round)

Three findings, all fixed in the final commit, none in the trust guard itself — that has been clean
since round 5:

1. **The handoff overstated the safety net** (this file). It said the merge was one-click
   reversible via Vercel. True of application code, false once the migration applies. Corrected in
   steps 3 and 4 below, with the real undo path spelled out. **This was the important one.**
2. **The `GIT_DIR` fix used a hand-written denylist** of variable names — the exact anti-pattern the
   2026-08-26 DECISION_LOG entry warns against, committed hours after writing it. The repo already
   had `.claude/hooks/git-test-env.mjs` → `scratchHookEnvironment()`, which asks git itself via
   `git rev-parse --local-env-vars` and also strips indexed `GIT_CONFIG_KEY_n`/`VALUE_n`. Now uses
   it. Proven under a hostile env (`GIT_DIR` at the real repo **plus** an injected
   `GIT_CONFIG_KEY_0=core.bare=true`): 44 assertions pass, `core.bare` still `false`. The denylist
   would have let the config override through.
3. `afterwards` → `afterward`, per the repo's documented locale.

**Standing lesson from 2 and from rounds 3-6: check for an existing shared helper before writing a
private copy, and never close a hole by enumerating the ways through it.**

## A CI flake, recorded so it is not mistaken for a regression

`src/pages/JobDetail.billingHazard.test.tsx > REFUSES the save — no job RPC is called` failed once
on `dfe219af`, exhausting a 15s `waitFor` under load (the test's own budget is 30s, so it was the
inner wait, not the test timeout). This PR touches neither that page nor the job-save path, `main`
is green on it, and a re-run of the **identical commit** passed. It is the third timing-sensitive
failure in this repo recently — PR #479 fixed a sibling ExcelJS test the same way — which looks
systemic rather than like three unlucky tests. Worth a proper look; do not just retry until green.

## The two open review threads are NOT bugs

Both describe the **in-transaction cutover race**, which is an owner-accepted risk recorded in
`docs/manual/DECISION_LOG.md`, scoped to this apply window, with the revoking condition named. They
are deliberately left unresolved so the acceptance stays visible. **Do not resolve them to make the
PR look clean.** Sol's `BLOCKERS` verdict names this same finding and will never clear, by design.

Measured live 2026-08-26: `quote_versions` holds **3 rows across 2 quotes**;
`restore_quote_version` has been invoked **0 times ever**. The race needs a user mid-create or
mid-restore at the commit instant.

## Read this before touching the invariant sweep

`scripts/db-invariant-sweeps/predicates/quote-versions-rpc-owned.sql` took **six review rounds**,
and in four of them the *fix* was the defective thing. In order:

1. **Round 3** — every `regexp_count` call passed the flag as the 3rd argument. Postgres's 3rd
   parameter is a start position; flags are 4th. All ten call sites raised
   `invalid input syntax for type integer: "i"`. The standing security sweep **crashed rather than
   reported**, and the test pinned the broken string with `toContain`, going green on it.
2. **Round 4** — the ordering fix enumerated forbidden assignment spellings (`v_version_id :=`,
   `v_result :=`). `SELECT ... INTO` walked past it.
3. **Round 5** — the replacement closed allowlist was anchored at the `v_version_id` assignment,
   leaving the interval between the owner impl *returning* and that assignment unguarded. A forged
   `v_result := jsonb_build_object('status','created','version_id', <legacy id>)` in that gap
   passed every check and would stamp an arbitrary legacy row as trusted.
4. **Round 6** — the test asserted three fragments of the concatenated literal separately, so
   reordering them still passed.

**The rule that came out of it:** a closed allowlist only closes what is *inside* it, and choosing
its boundaries **is** the security argument. The region must begin at the first statement whose
result the rest depends on — the owner call — not at the first statement mentioning the variable
you care about. Collapse whitespace **before** `btrim`; the reverse order leaves a trailing space
and the real body fails its own guard.

**And the process lesson:** every one of those fixes was verified against live PostgreSQL both
ways, and each verification tested *what had just changed* rather than the property the guard is
supposed to guarantee. A both-ways proof is necessary and not sufficient. Ask afterwards: *which
inputs did this proof not cover?*

## Two real bugs found in the review threads, not by the tests

- `scripts/smoke/run-smoke.mjs` referenced `PASS_TOKEN` without importing it —
  `node scripts/smoke/run-smoke.mjs --help` died with `ReferenceError`, taking out `--help`, the
  no-argument path, and Claude/MCP mode. Fixed by exporting/importing.
- `src/lib/rpcIdempotencyScope.test.ts` compared `indexOf(...) < indexOf(...)`. `indexOf` returns
  `-1` when absent, so the assertion **passed in exactly the case it existed to catch** — a
  re-emission dropping the `check_idempotency` lookup. Both tokens must now exist first.

## Do not trust the CodeRabbit status tick

It was wrong four distinct ways on this PR alone: green while stale; green while contradicting its
own submitted verdict; green with no review for the head at all; and a "no remaining issue" comment
posted four minutes before a `CHANGES_REQUESTED` review carrying a real finding. **Always read
`pulls/401/reviews` and the unresolved `reviewThreads`.** The account is now rate-limited to one
review per hour.

## `docs/CHANGELOG.md` is a guaranteed conflict

`main` moved **seven times** during this work and `docs/CHANGELOG.md` was the *only* file that ever
conflicted — every PR prepends a dated entry at the same offset, so any two open PRs collide there
and nowhere else. Resolution is always "keep both entries, newest first." Worth fixing structurally
(dated entries in separate files, merged at release); it is the single biggest tax on landing
anything in this repo.

## Remaining steps

1. Update the branch with `main` (server-side `gh pr update-branch` is faster than a local merge and
   CI re-runs the same required gate).
2. Confirm the three required checks, then read the actual CodeRabbit review — not the tick.
3. Merge (squash). **This deploys production via Vercel.** The one-click Vercel rollback reverts
   **application code only** — it does not revert an applied migration, so the two steps have
   separate undo paths and step 4 is the point of no easy return.
4. Apply the migration through the gated file-bytes door
   (`scripts/apply-migration-file.mjs`) with a fresh same-session apply-guard proof. Non-destructive
   in the sense that it destroys no data: it adds a nullable column and re-emits two functions.

   **But it is a behavior change that a Vercel rollback will not undo.** Once applied, every
   `quote_versions` row with a NULL `restore_trusted_at` — which is every row written before this
   migration — becomes **non-restorable**, raising `QUOTE_VERSION_LEGACY_UNTRUSTED`. That is the
   intended effect, not a side effect, and it is why there is deliberately no backfill. Rolling the
   application back to the previous deploy leaves the database exactly as the migration left it.

   **If it must be undone**, the path is a forward-fix migration, not a rollback: re-emit
   `_restore_quote_version_below_cost_impl_20260810` without the trust check, and re-emit
   `create_quote_version` without the marker `UPDATE`. Dropping the column is a separate decision —
   the standing sweep in `scripts/db-invariant-sweeps/predicates/quote-versions-rpc-owned.sql` pins
   both function bodies, so any such re-emission will be reported until the predicate is updated in
   the same change. Leaving the column in place with the checks removed is the smaller, safer undo.

   Live blast radius makes this cheap in practice rather than theoretically alarming: 3
   `quote_versions` rows across 2 quotes, and `restore_quote_version` invoked 0 times ever.
5. After applying, re-read live and update `docs/reference/migration-history.md` entry 892 plus the
   `quote_versions` row in `docs/reference/database-schema.md`.

## Verification to re-run before the apply

Preconditions confirmed live 2026-08-26 and expected to still hold: `restore_trusted_at` absent;
`quote_versions` 3 rows / 2 quotes; exactly one policy; exactly one overload each of
`create_quote_version` and `_restore_quote_version_below_cost_impl_20260810`. Re-read them — another
session may have moved live state, and this repo has had that happen mid-flight before.
