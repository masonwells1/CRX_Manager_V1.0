## 2026-09-04 - migration-drift-reviewer CHECK 2 requires live identity signatures, not an overload count

**Files:** `.claude/agents/migration-drift-reviewer.md` (CHECK 2 step 4),
`scripts/check-agent-guidance.mjs` (14 new deterministic assertions)
**Found by:** exact-SHA `gpt-5.6-sol` high-effort push proof on PR #594, commit `b450967`, HIGH-1

## The defect

The same-day rewrite of CHECK 2 added a step 4 saying that a live `pg_proc` overload **count**
supplied by the orchestrator outranks the historical migration text, and that a count of one clears
the finding. That is weaker than it looks: a count does not say *which* signature exists.

Live holds `f(integer)`. A migration adds `f(text)` and does not `DROP FUNCTION` the old one. The
pre-apply count is **1**, so the weaker rule clears it — and applying the migration leaves **2**
overloads. That is precisely the collision CHECK 2 exists to prevent, and it is invisible to a
count. `pronargs` is also a count and fails the same way: it cannot tell `f(integer)` from
`f(text)`.

This mattered because the charter feeds the proof-minting migration gate. The earlier claim that
"no check was removed and no severity was lowered" was incorrect, and the F2 changelog entry that
carried it has been corrected.

## The fix

Step 4 now requires, per function name, the complete identity signature of **every** live overload,
obtained as `oid::regprocedure::text` — the live-data guard refuses
`pg_get_function_identity_arguments()`, and a bare table alias like `AS a(argname)` trips its
function-call regex, so aliases need a read prefix such as `AS list_arg(...)`. From that, compute
the expected **post-migration** signature set:

- the authored signature matches an existing live signature exactly → it REPLACES it, no new
  overload → clean;
- it matches none while other live signatures for that name exist and nothing is dropped →
  applying ADDS an overload → **BLOCKER**;
- the name does not exist live at all → plain create → clean.

A count, `pronargs`, or candidate-authored prose asserting "exactly one overload" never clears the
finding. Absent identity-signature evidence the reviewer emits **HIGH** naming exactly what to run.
Step 2 — the BLOCKER on a differing-argument overload with no `DROP FUNCTION` — is unchanged.

## Deterministic backstop

`scripts/check-agent-guidance.mjs` pins the CHECK 2 block the same way it already pins CHECK 6: the
worked example above, the `oid::regprocedure::text` requirement, the computed post-migration
signature set, the added-overload BLOCKER branch, the fail-closed HIGH, the untouched step 2, and
the bounded local-search method. A semantic detector rejects any sentence that lets a count or
`pronargs` clear, outrank, satisfy, or settle the finding.

Mutation-tested rather than assumed: regressing step 4 to the rejected wording turns **8** of the
assertions red, including the semantic detector, and restoring the charter turns them green again.
So the detector demonstrably fires.

## Applied to the eight F2 generators

Re-checked live under the stronger rule: 8 names, 8 identity signatures, `next_invoice_number(text)`
matching the migration exactly. No collision occurred — now confirmed by identity signatures rather
than by the overload count originally cited.
