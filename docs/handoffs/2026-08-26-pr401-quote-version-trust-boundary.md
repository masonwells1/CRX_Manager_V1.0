# Handoff — PR #401, quote-version restore trust boundary

**Written 2026-08-26.** State at writing: branch green, CodeRabbit clean through round 5,
round 6's Trivial finding fixed and pushed. **NOT merged. Migration NOT applied.**

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

Mason approved both the merge and the apply in-session ("finish it"). The remaining blocker has
been review-state mechanics, not the code.

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
3. Merge (squash). **This deploys production via Vercel**; rollback is one click there.
4. Apply the migration through the gated file-bytes door
   (`scripts/apply-migration-file.mjs`) with a fresh same-session apply-guard proof. Non-destructive:
   it adds a nullable column and re-emits two functions.
5. After applying, re-read live and update `docs/reference/migration-history.md` entry 892 plus the
   `quote_versions` row in `docs/reference/database-schema.md`.

## Verification to re-run before the apply

Preconditions confirmed live 2026-08-26 and expected to still hold: `restore_trusted_at` absent;
`quote_versions` 3 rows / 2 quotes; exactly one policy; exactly one overload each of
`create_quote_version` and `_restore_quote_version_below_cost_impl_20260810`. Re-read them — another
session may have moved live state, and this repo has had that happen mid-flight before.
