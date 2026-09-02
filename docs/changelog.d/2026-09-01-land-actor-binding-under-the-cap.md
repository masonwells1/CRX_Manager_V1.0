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

**Actor rebinding by ASSIGNMENT is now caught by the post-apply sweeps (CodeRabbit Major).** Read
that scope literally — the `INTO`-target form is proven still open, see the deadlock note at the end
of this entry. This one was fixed
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

**Widening the scan was NOT enough, and the first attempt at this fix proved it.** CodeRabbit's
actual attack stashes the caller value in a local, overwrites the parameter with `auth.uid()` so the
canonical refusal can never fire, and then uses the **stash** at the sink. Failing closed put the
whole body in scope, but every detection pattern keys on the *parameter* — which by then holds a
legitimate value — so the routine still went unreported. The fixture
`actor_stash_then_rebind_forward` was added specifically to catch that, and it failed the first
version of this fix. `has_actor_rebinding` is therefore **also a reportable condition in its own
right** in both predicates' final `WHERE`, scoped in the financial-audit predicate to routines that
actually write `financial_audit_log`. A `SECURITY DEFINER` routine that overwrites its own actor
parameter cannot be cleared by reading its refusal.

**Proof — real PostgreSQL 17, not a regex unit test.**
`scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs` runs both predicates in a disposable
container. Four new fixtures: `actor_rebound_param_forward` and `actor_stash_then_rebind_forward`
(must be detected), `actor_named_argument_forward` (must NOT be), and
`actor_unbound_local_refusal_forward` (below). Mutation-tested in both directions — removing the
rebinding clause makes the first go red; removing the pinning makes the named-argument one go red.
Reverted, no residue, suite green.

**Two more Codex P1s against the sweeps, checked rather than argued.** *"Reject guards nested in
nonexecuting branches"* was already fixed and already pinned by `actor_unreachable_refusal_forward`.
*"Require the complete auth binding in the sweep"* does not reproduce — the binding and the refusal
are already one regex sequence, so `has_bound_local_refusal` is false without the `auth.uid()`
assignment. Rather than assert that from reading the regex, `actor_unbound_local_refusal_forward`
now pins it. The third, *"Trace aliases in the post-apply actor sweep"*, is genuine dataflow over a
local alias and is dismissed as documented residual — not a spelling, and the cap says rebuild rather
than re-harden.

Live read-only check against the production catalog before and after: the unpinned form matched one
authenticated-executable `SECURITY DEFINER` routine (`batch_cancel_deliveries`, verified safe — it
binds `v_actor := auth.uid()`, refuses a mismatched `p_performed_by`, and role-checks); the shipped
pinned form matches **zero**. The change therefore adds no sweep noise on live.

### Two further sweep gaps closed, then a hard stop (Mason, 2026-09-01)

Both were reported after the fixes above, both are in the load-bearing control rather than the capped
hook, and both had a **structural** fix rather than another pattern — which is the test the cap sets
for whether work is worth doing. Mason authorised these two and only these two: the next finding on
this PR, whatever it is, is a follow-up, not another round here.

**A logically dead refusal was credited.** `IF p_actor IS DISTINCT FROM auth.uid() AND false THEN`
is textually canonical, so the slop (`[^;]*`) between the comparison and `THEN` accepted it and the
scan was truncated at a `RAISE` that can never run. The block counter accepted it too — there is only
one `IF`. Fixed by shape, not by enumerating weakeners: the credited condition may now contain only
whitespace and balancing parentheses between `IF` and the actor, and between the comparison and
`THEN`. Any added term — `AND false`, `OR true`, anything else — fails to be credited and the routine
is reported. Applied to all three refusal patterns in both predicates. Fixtures
`actor_weakened_condition_forward` and `actor_weakened_local_condition_forward`.

**A dynamic audit write hid the sink.** The financial-audit predicate decided its own scope with
`executable_src ~* 'financial_audit_log'` — the *lexed* source, in which strings and dollar-quoted
bodies are masked. An `EXECUTE 'INSERT INTO financial_audit_log …'` therefore removed the routine from
the predicate entirely while its actor parameter stayed plainly visible. Raw `prosrc` is now carried
through `lexed` as `raw_src` and used for the sink-**presence** test only; every analysis test still
runs on the lexed source, so masked text still cannot forge a refusal. Fixture
`actor_dynamic_audit_sink_forward`.

Both mutation-proved (restoring the slop, and reverting to `executable_src`, each turn the matching
fixture red). Live read-only checks: **zero** production routines lose refusal credit under the
tightening, and **zero** are newly reported. Neither change adds sweep noise.

### The merge gate and the cap now contradict each other — owner decision required (2026-09-02)

The exact-SHA `gpt-5.6-sol` proof on head `4976ed08` returned **BLOCKERS**, so
`.claude/hooks/pr-merge-guard.mjs` will not let this PR merge from a session: the diff touches
`.claude/hooks/`, which is a risky path, and a risky merge requires a fresh CLEAN proof. Self-certifying
is forbidden and was not attempted.

**The blocker is real and was executed, not theorised.** Codex ran
`SELECT 1, p_target_id INTO v_dummy, p_performed_by` through the candidate's real hook with an
authenticated grant and observed `permissionDecision: "allow"`; moving the actor to the *first* `INTO`
target returns `deny`. The same second-target overwrite of a trusted `v_actor := auth.uid()` local
also returns `allow`. Both sweep predicates miss it as well — the rebinding rule added above reads
assignment syntax, not `INTO` target lists.

**Why this cannot be fixed under the cap.** Codex's required fix names the hook first: inspect every
`INTO` target when invalidating actor parameters and trusted locals. That is pattern-hardening of the
write-time hook — precisely what the 2026-09-01 cap forbids. Fixing only the sweep half would leave
the proof BLOCKED, so it would not unlock the merge either. The gate and the cap therefore point in
opposite directions, and nothing an agent can do resolves that.

**State handed to Mason.** Branch green, current, all review threads closed, head `4976ed08`. Three
ways forward, all his: (a) lift the cap for this one bounded `INTO`-target fix and re-run the proof;
(b) merge by hand using the administrator override, accepting the documented gap, which the docs above
now state accurately; or (c) leave the PR parked. Recorded rather than decided, per the standing rule
that a stuck review is handed over with the reason.

### Not changed

No migration is applied and no live data is touched. The three files under
`scripts/.staging-migrations/` remain parked; their diff is comments only.
