## 2026-09-01 — PR #449 lands under the cap: 19 closed bypasses ship, the hardening programme does not resume

Mason's decision, in chat on 2026-09-01, after being shown the 15 open Codex P1 findings on this PR:
**dismiss them, cite the cap, land the work.** This entry records what shipped, what was deliberately
not fixed, and why that is not a shortcut.

### What the cap already settled

`docs/manual/DECISION_LOG.md` (2026-09-01, "the write-time actor-binding guard is CAPPED as
best-effort") records the operative rule: *do not open another pattern-hardening round on this
guard; cite this entry and close the request.* The same entry states that **PR #449 itself is
parked, not abandoned — it holds the 19 closed bypasses and is worth landing after one clean review
round.** This is that landing. Shipping it is an improvement to a capped control, not a resumption
of the programme.

### The 15 open P1 findings are dismissed, not fixed

Every one asks the guard to recognise one more PL/pgSQL spelling — `CREATE PROCEDURE` headers,
pre-list `SELECT INTO`, user-defined casts, loop targets, cursor fetches, multi-target `INTO`
mapping, `GET STACKED DIAGNOSTICS`, `IS DISTINCT FROM` / `BETWEEN` / `IN`, subscripted assignment
targets, qualified `SELECT INTO`, implicit return coercions, and three parallel requests against the
sweep predicates. They are, as far as can be told, **individually correct**; that is precisely the
evidence the cap was built on. The finding count on this PR went 10 → 23 across two rounds of genuine
work, 16 of the new ones dated 2026-09-01 — objections to the fixes themselves. Fixing this batch
buys the next batch.

Each thread is closed on the PR with a one-line citation of the cap entry rather than silently. The
residual is already written down in `docs/manual/DECISION_LOG.md` and
`docs/manual/KNOWN_ISSUES.md`, both of which state plainly that this guard **reduces** actor forgery
and does not prevent it, and that the load-bearing controls are the post-apply sweep predicates, the
exact-SHA `gpt-5.6-sol` proof on migration diffs, and the CodeRabbit final review.

### What was fixed before landing

**The `docs/CHANGELOG.md` contract violation (CodeRabbit P1).** This branch appended ~840 lines and
11 entries to `docs/CHANGELOG.md`, which `AGENTS.md` forbids: that file is over 15,000 lines and
every parallel session lands in it, so per-change files under `docs/changelog.d/` are the required
form. The appended entries were also out of reverse-chronological order and tripped markdownlint
MD022. All 11 have been relocated verbatim to `docs/changelog.d/` — line count verified at 840 in,
840 out — and `docs/CHANGELOG.md` is restored byte-identical to `main`. One truncated heading
(`…quoted…`) was completed from the entry's own first paragraph.

**Undocumented dataflow limits (CodeRabbit minor).** The round-2 fragment listed only the
name-scope limit as out of scope. It now also names `EXECUTE … USING`,
`INSERT … RETURNING … INTO`, and temp-table round trips, and states explicitly that the post-apply
sweeps do **not** compensate for them.

**Actor rebinding is now caught by the post-apply sweeps (CodeRabbit Major).** This one was fixed
rather than dismissed, and the distinction matters: the cap closed pattern-hardening on the
*write-time hook*, while naming the **sweep predicates as a load-bearing control**. Strengthening
that control is not the capped activity.

The gap: both predicates truncate the scanned body at the refusal, so
`p_performed_by := p_target_id;` *after* a passing `ACTOR_MISMATCH` check was invisible — the very
presence of the check it defeated is what hid it. `docs/manual/DECISION_LOG.md` records this as
residual (2); it is now closed for the assignment form. Both predicates fail closed and scan the
whole body when the actor parameter is assigned to at statement position.

**The pinning to statement position is load-bearing, not tidiness.** PL/pgSQL named-argument syntax
is lexically identical to assignment, so an unpinned match also flags
`PERFORM f(p_delivery_id := x, p_performed_by := v_actor)`. Live `batch_cancel_deliveries` is exactly
that shape and binds its actor correctly — the first draft made it a false positive. A named argument
is always preceded by `(` or `,`; an assignment statement is preceded by a terminator or block opener.

**Proof — real PostgreSQL 17, not a regex unit test.**
`scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs` runs both predicates in a disposable
container. Two new fixtures: `actor_rebound_param_forward` (must be detected) and
`actor_named_argument_forward` (must NOT be). Mutation-tested in both directions — removing the
rebinding clause makes the first go red; removing the pinning makes the second go red. Reverted, no
residue, suite green.

Live read-only check against the production catalog before and after: the unpinned form matched one
authenticated-executable `SECURITY DEFINER` routine (`batch_cancel_deliveries`, verified safe — it
binds `v_actor := auth.uid()`, refuses a mismatched `p_performed_by`, and role-checks); the shipped
pinned form matches **zero**. The change therefore adds no sweep noise on live.

### Not changed

No migration is applied and no live data is touched. The three files under
`scripts/.staging-migrations/` remain parked; their diff is comments only.
