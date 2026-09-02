# Actor-forgery sweep predicate — triage of the 56 reported rows, and the checker fix

**Date:** 2026-09-02
**Scope:** `scripts/db-invariant-sweeps/predicates/actor-forgery.sql` and
`actor-forgery-fin-audit.sql`, starting from the PR #449 rewrite (blob
`a8e192daa7be301117ee7276084d6fd6c4b17f5d`, byte-identical on the split branch
`claude/actor-forgery-sweeps-20260902`).
**Method:** read-only live introspection of `rhyzpcqhnizqbxphqdkr` via a respelled MCP form, plus a
disposable PostgreSQL 17 container for the regression fixtures. No live data was mutated and no
live routine was changed.

## Headline

**All 56 rows the PR #449 predicate reported are false positives. Zero real actor-forgery holes.**
The predicate was not surfacing a security backlog — it demanded one house style that live code does
not follow. Per Mason's 2026-09-02 decision ("fix checker, don't add exceptions") the predicate was
fixed rather than allowlisted. **Live rows: 56 → 18.**

## Measured baseline

| Predicate version | Rows | Distinct routines | Sweep |
|---|---|---|---|
| `main` (`ac71d1c2b…`) | 1 | 1 (`cancel_delivery`, allowlisted) | GREEN, but see caveat |
| PR #449 (`a8e192daa…`) | 56 | 55 | RED — 53 unallowlisted |
| This branch | 18 | 18 | 17 unallowlisted |

Population: 131 authenticated-executable `SECURITY DEFINER` routines carry an actor-shaped
parameter; 96 mention `ACTOR_MISMATCH`. `allowlist.json` holds 2 actor-forgery entries.

**Caveat on `main`'s green.** `main` excludes any routine whose source merely *mentions*
`ACTOR_MISMATCH` — 96 of 131 — so a routine that raises the token in unreachable or commented-out
code clears it without trying. The 1-row green is weaker than it looks.

## Why the 56 fired

| # | Cause | Safe? |
|---|---|---|
| 17 | Canonical token, actor bound in the **DECLARE initializer** (`v_actor uuid := auth.uid();`); the bound-local rule required a separate assignment statement. | Yes |
| 10 | Canonical token and assignment binding, but a **null-tolerant** refusal (`IF p_x IS NOT NULL AND p_x IS DISTINCT FROM v_actor`); the `IS NOT NULL AND` prefix broke the required regex. | Yes |
| 13 | **Thin dispatch wrapper** — `PERFORM <lock/precheck>; RETURN public._<impl>(… p_performed_by …);`. The guard lives in the callee. | Yes |
| 6 | Prose message `'p_performed_by does not match authenticated user'`. | Yes |
| 5 | **Prefixed** `'ACTOR_MISMATCH: …'` rather than the bare literal. | Yes |
| 3 | **Not an actor parameter** — `p_group_by` is a text grouping mode; `get_receiving_log.p_received_by` is a read filter. | Yes |
| 2 | Prose message `'Actor mismatch'`. | Yes |

Live code uses **four** refusal-message spellings, **two** actor-binding forms, and both
`IS DISTINCT FROM` and `<>`. The predicate accepted exactly one combination.

### Wrapper chain, verified

The 13 wrappers forward to `_section9_*_serialized` / `_*_below_cost_impl_20260810`. **None of those
callees is executable by `authenticated` or `anon`**, so the forwarded actor cannot be supplied
directly. Three callees carry no `ACTOR_MISMATCH` token but do bind `v_actor := auth.uid()`, require
authentication, and raise `'Actor mismatch'` — a spelling variant, not a missing guard. The
below-cost wrappers additionally call `_begin_below_cost_money_write(…, p_performed_by, …)`, which
carries the canonical guard, before the impl runs.

## What changed in the checker

Three shape fixes plus a candidacy gate, applied to both predicates:

1. **Refusal credited by shape, not message text.** `RAISE EXCEPTION` + any message, instead of the
   bare `'ACTOR_MISMATCH'` literal. Safe because the lexer masks string literals first, so a
   semicolon inside a message cannot derail the statement match.
2. **DECLARE-initializer binding accepted** alongside the assignment statement. Ordering is still
   enforced (binding must precede the refusal) by comparing match positions.
3. **Null-tolerant refusals and `<>`/`!=` accepted.** On a `NOT NULL`-guarded operand these are
   equivalent to `IS DISTINCT FROM`.
4. **Candidacy gate:** the actor parameter must be `uuid` **or a user-defined type**. The second half
   is load-bearing — the operator-overload attack class gives the actor a composite type — and only
   the remaining built-in scalars (`p_group_by text`, `p_signed_by text`) are excluded.

Four performance changes were required to keep the sweep runnable at all; each is commented at its
site. Removing the fixed literal removed the anchor that made most match attempts fail immediately,
and the predicate went from completing to timing out against the live catalog:

- whitespace runs collapsed once in `lexed` (the lexer masks literals to equal-length whitespace);
- ordering enforced by match position rather than a quadratic `.*?` bridge;
- the two operator arms use `~*` instead of `EXISTS (SELECT 1 FROM regexp_matches(…, 'gi'))`, which
  enumerated every match before EXISTS could stop;
- `OFFSET 0` fences on `lexed` / `guarded` / `analyzed`, because a plain CTE is inlined and
  `pre_refusal_src` was being recomputed once per WHERE arm. `AS MATERIALIZED` is the clearer
  spelling but the live-data read guard parses `MATERIALIZED (` as a function call and refuses the
  statement.

## Test coverage added

`scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs`, real PostgreSQL 17:

- **Four ALLOW fixtures**, one per live guard style, pinned so a future tightening cannot silently
  retake the sweep from 1 row to 56.
- **Three DENY canaries** for the loosening itself, each a near-miss of a style now accepted:
  `actor_notice_not_exception_forward` (compares correctly but only `RAISE NOTICE`, so execution
  continues), `actor_selfbound_declare_init_forward` (initializer binds the local to the *parameter*,
  so the refusal can never fire), and `actor_null_tolerant_wrong_identity_forward` (null-tolerant
  shape compared against a fresh random uuid rather than the caller).
- The pre-existing 22 must-report fixtures still report.

Both directions were **mutation-tested**: reverting the message-agnostic tail turns the
null-tolerant, prose and prefixed fixtures red; reverting the DECLARE-initializer branch turns that
fixture red. The fixes are load-bearing, not decorative.

## What still reports — 18 rows, three classes, none a forgery

| n | Class | Why it still fires |
|---|---|---|
| 13 | Thin dispatch wrappers | The guard is one call hop away. Clearing these needs the predicate to follow a call into a non-`authenticated`-executable callee and verify the callee's own refusal. That is a real extension, not a regex tweak. |
| 3 | `EXCEPTION WHEN OTHERS` later in the body (`complete_job`, `create_application_record_from_blend_ticket`, `unapply_credit_memo`) | The **pre-existing** fail-closed rule: a handler can catch a refusal, and PR #449 deliberately declined to prove PL/pgSQL block nesting in SQL. All three are correctly guarded at the top of the body. |
| 1 | `get_receiving_log.p_received_by` | A uuid read filter in a routine that writes nothing. Needs a "no write sink" rule to clear. |
| 1 | `cancel_delivery` | Already allowlisted; unchanged. |

**These are not recommended for allowlisting and were not allowlisted.** Each needs a specific
checker capability, and two of them (exception-block nesting, delegate-following) are analyses where
a wrong simplification produces a false negative in a security control. That is a scoping decision
for Mason, not something to improvise inside a triage.

## Separate finding — attribution gap, not forgery

Three routines take `p_performed_by`, **never reference it**, and record no actor at all:

- `link_fields_to_parent` (UPDATE)
- `save_field_polygons` (UPDATE + INSERT)
- `unlink_field_from_parent` (UPDATE)

There is nothing to forge because nothing is attributed, so they are correctly absent from both
predicates. They are **properly authorized** — each calls `require_admin_or_sales_rep()` — and each
**does enforce** `p_idempotency_key` via `check_idempotency` / `save_idempotency`, so the CRX
mutating-RPC rule is satisfied. The defects are narrower and worth tracking separately: field
boundary and parent/child link mutations record no actor, and the API advertises a `p_performed_by`
it silently ignores. Both predicates are blind to this class by construction, since both key on the
actor parameter reaching a sink.

## Residual, stated plainly

This triage confirms the 56 reported rows are safe and the 18 that remain are safe. It does **not**
re-audit the routines the predicates never report. The 2026-09-01 cap entry's residuals stand
unchanged, the `INTO`-target rebinding form remains open and uncovered, and the three classes in the
table above remain reported rather than resolved.
