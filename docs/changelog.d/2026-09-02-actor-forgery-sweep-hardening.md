## 2026-09-02 — the post-apply actor-forgery sweeps now catch assignment-form rebinding, dead refusals, and dynamic audit sinks

Split out of PR #449 on Mason's 2026-09-02 decision. **This PR contains no hook changes** — only the
two live sweep predicates, their PostgreSQL container test, the sweep README, and the two manual docs
that describe what the sweeps cover. The ~3,000-line write-time hook rewrite stays parked in #449
under the 2026-09-01 cap.

**Why split rather than land the whole thing.** #449 touches `.claude/hooks/`, so `pr-merge-guard`
requires a clean exact-SHA `gpt-5.6-sol` proof. That proof returned BLOCKERS on an *executed* bypass
whose required fix starts at the write-time hook — the exact surface the cap closed. The merge gate
and the cap pointed in opposite directions, and no agent action resolves that. Only 2 of #449's 28
files trigger the risky-path rule; the other 26 do not. The half that matters is here: the cap entry
itself names the **post-apply sweep predicates** as the load-bearing control and the hook as *"a speed
bump, not a boundary."*

### What changed in the sweeps

**Assignment-form rebinding is caught (CodeRabbit Major).** Both predicates truncated the scanned body
at the `ACTOR_MISMATCH` refusal, so `p_performed_by := p_target_id;` *after* a passing check was
invisible — the very presence of the check it defeated is what hid it. Both now fail closed and scan
the whole body when the actor parameter is assigned at statement position, and rebinding is reportable
in its own right, because a stash-then-rebind sends a *local* to the sink where no detector keyed on
the parameter fires.

**Both spellings.** PL/pgSQL accepts `:=` and bare `=`. Matching only the first left the cheaper
spelling open — a hole in the first version of this fix, caught in review.

**Statement pinning is load-bearing, not tidiness.** Named-argument syntax (`f(p_performed_by := v)`)
is lexically identical to assignment. Live `batch_cancel_deliveries` is exactly that shape and binds
its actor correctly; an unpinned match made it a false positive.

**Dead refusals are no longer credited.** `IF p_actor IS DISTINCT FROM auth.uid() AND false THEN` is
textually canonical but can never fire, and the slop between the comparison and `THEN` accepted it,
truncating the scan at a `RAISE` that never runs. Fixed by shape rather than by enumerating weakeners:
the credited condition may contain only whitespace and balancing parentheses.

**Dynamic audit sinks no longer hide the routine.** The financial-audit predicate decided its own
scope on the *lexed* source, in which strings are masked, so an
`EXECUTE 'INSERT INTO financial_audit_log …'` removed the routine from the predicate entirely while
its actor parameter stayed visible. Raw `prosrc` is now used for the sink-**presence** test only;
every analysis test still runs on lexed source, so masked text still cannot forge a refusal.

**Two Codex findings checked rather than argued.** *Guards nested in non-executing branches* was
already fixed and pinned. *Require the complete auth binding* does not reproduce — the binding and the
refusal are already one regex sequence — and now has a fixture proving it.

### Proof

`scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs` runs both predicates against a
disposable **real PostgreSQL 17** container. Seven new fixtures, including two that must NOT be
reported (`actor_named_argument_forward`, and the pre-existing safe set). Every change
mutation-tested in both directions — reverting it turns the matching fixture red, and reverting the
*pinning* turns the false-positive fixture red.

Live read-only checks against production, before and after: **zero** routines newly reported, and
**zero** routines lose refusal credit under the tightening. These changes add no sweep noise.

### Known open, stated so nobody credits coverage that does not exist

- **`INTO`-target rebinding.** `SELECT 1, p_target_id INTO v_dummy, p_performed_by` evades both the
  hook and both sweeps. Proven by execution, not theory. Closing it needs the hook half too, which is
  capped.
- **Prefixed `ACTOR_MISMATCH` messages** are a live false-positive source: six production routines
  (`unpost_invoice`, `transfer_invoice_to_job`, and four others) raise a descriptive message rather
  than the bare token, and the exact-literal credit test does not recognise them. Noise, not a missed
  forgery — the sweep stays fail-closed. Tracked separately.
- `EXECUTE … USING`, `INSERT … RETURNING … INTO`, and temp-table round trips remain uncovered; they
  are dataflow, not spellings.
