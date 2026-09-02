# Actor-forgery sweep predicate — triage of the 56 reported rows

**Date:** 2026-09-02
**Scope:** `scripts/db-invariant-sweeps/predicates/actor-forgery.sql` as rewritten in PR #449
(blob `a8e192daa7be301117ee7276084d6fd6c4b17f5d`, byte-identical on the split branch
`claude/actor-forgery-sweeps-20260902`).
**Method:** read-only live introspection of `rhyzpcqhnizqbxphqdkr` via the respelled MCP form
(see the `live-data-guard-blocks-sweep-predicates-via-mcp` note for why the predicate cannot be
run verbatim through `execute_sql`). No live data was mutated.

## Headline

**All 56 rows are false positives. Zero real actor-forgery holes were found.**

Every reported routine either binds the actor to `auth.uid()` and refuses on mismatch, or does so
in a callee it forwards to, or does not take an actor parameter at all. The rewritten predicate is
not surfacing a security backlog — it is failing to recognise the guard shapes and message
spellings that live code actually uses.

## Measured baseline

| Predicate version | Rows | Distinct routines | Sweep result |
|---|---|---|---|
| `main` (`ac71d1c2b…`) | 1 | 1 (`cancel_delivery`, allowlisted) | GREEN |
| PR #449 / split branch (`a8e192daa…`) | 56 | 55 | RED — 53 unallowlisted |

Population: 131 authenticated-executable `SECURITY DEFINER` routines carry an actor-shaped
parameter; 96 mention `ACTOR_MISMATCH`. `allowlist.json` holds exactly 2 actor-forgery entries
(`cancel_delivery`, `transfer_job_to_invoice`).

## Why each row fired

| # | Reason the predicate flagged it | Actually safe? |
|---|---|---|
| 17 | Canonical `ACTOR_MISMATCH` token, but the actor is bound in the **DECLARE initializer** (`v_actor uuid := auth.uid();`). The bound-local rule requires a separate assignment statement. | Yes |
| 10 | Canonical token **and** assignment-statement binding, but the refusal is **null-tolerant** (`IF p_x IS NOT NULL AND p_x IS DISTINCT FROM v_actor`). The required regex expects `IF <arg> IS DISTINCT FROM` immediately, so the `IS NOT NULL AND` prefix breaks the match. | Yes |
| 13 | **Thin dispatch wrapper.** Body is `PERFORM <lock/precheck>; RETURN public._<impl>(… p_performed_by …);`. The guard lives in the callee; the wrapper only forwards, which trips the new callable-forwarding arm. | Yes |
| 6 | Guard present but the message is prose: `'p_performed_by does not match authenticated user'`. | Yes |
| 5 | Guard present but the message is **prefixed**: `RAISE EXCEPTION 'ACTOR_MISMATCH: …'` rather than the bare literal. | Yes |
| 3 | **Not an actor parameter.** `p_group_by` (text: `'customer'`/`'product'`/`'month'`) in two reports; `p_received_by` is a read-only filter (`rr.received_by = p_received_by`) in `get_receiving_log`. Caught by the `^p_\w*by$` name pattern. | Yes |
| 2 | Guard present but the message is prose: `'Actor mismatch'`. | Yes |

### Wrapper chain, verified

The 13 wrappers forward to `_section9_*_serialized` / `_*_below_cost_impl_20260810`. **None of those
callees is executable by `authenticated` or `anon`** — they are reachable only through the wrapper,
so the forwarded actor cannot be supplied directly. Of the callees,
`_section9_cancel_purchase_order_serialized`, `_section9_delete_purchase_order_serialized` and
`_create_direct_order_below_cost_impl_20260810` carry no `ACTOR_MISMATCH` token but do bind
`v_actor := auth.uid()`, require authentication, and raise `'Actor mismatch'` — a spelling variant,
not a missing guard. The below-cost wrappers additionally call
`_begin_below_cost_money_write(…, p_performed_by, …)`, which itself carries the canonical guard, so
the actor is validated before the impl runs.

## Live guard spellings found

The predicate demands one house style. Live code uses at least four messages and two binding forms:

- `RAISE EXCEPTION 'ACTOR_MISMATCH'` — canonical (27 routines)
- `RAISE EXCEPTION 'ACTOR_MISMATCH: <description>'` — prefixed (5)
- `RAISE EXCEPTION 'Actor mismatch'` — prose (2, plus 3 callees)
- `RAISE EXCEPTION 'p_performed_by does not match authenticated user'` — prose (6)
- Binding: `v_actor := auth.uid();` (statement) vs `v_actor uuid := auth.uid();` (DECLARE initializer)
- Comparison: `IS DISTINCT FROM` vs `<>`, with and without a null-tolerant `IS NOT NULL AND` prefix

## Recommendation

**Do not write 53 allowlist entries.** The allowlist is for routines that are unsafe-looking but
verified safe by argument. These 53 are ordinary, correctly-guarded routines; allowlisting them
would suppress the detector on most of the surface it exists to watch, and every future routine in
the same house style would need another entry. That converts a detector into a list.

Fix the predicate instead, in three specific shape changes, each testable against the existing
PostgreSQL container fixtures:

1. Accept the **DECLARE-initializer** binding form alongside the assignment statement.
2. Accept a **null-tolerant** refusal (`IS NOT NULL AND` prefix) and the `<>` comparison.
3. Match the refusal by **shape, not message text** — bind-to-`auth.uid()`, compare, raise — or, if
   the canonical token is to stay load-bearing, normalise the 13 non-canonical routines to it in a
   follow-up and keep the strict match.

Item 3 is a genuine design choice and belongs to Mason, not to this triage. Option 3a
(shape-matching) keeps live code as-is but weakens the machine-checkable contract; option 3b
(normalise the messages) preserves the contract but touches 13 live routines.

Separately, the `^p_\w*by$` name pattern should exclude non-actor parameters; `p_group_by` is a
grouping mode and will keep re-appearing.

## Residual, stated plainly

This triage confirms the 56 reported rows are safe. It does **not** re-audit the routines the
predicate never reports. Both the 2026-09-01 cap entry's residuals and the `INTO`-target rebinding
form remain open and uncovered, and `main`'s current predicate excludes 96 of 131 routines on a bare
mention of the `ACTOR_MISMATCH` token — so a routine raising it in unreachable code is invisible to
today's green sweep. The green sweep on `main` is weaker than it looks; that is an argument for
fixing this predicate, not for keeping the old one.
