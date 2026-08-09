# Actor-binding guard hardening — review-cycle record

This records why the original exact-SHA review cycle parked and how the next
cycle resolved its remaining High-severity finding. It is retained so later
guard work does not repeat the unsafe variable-provenance approach.

## Scope

- Guard: `.claude/hooks/actor-binding-check.mjs`
- Tests: `.claude/hooks/actor-binding-check.test.mjs`
- Reference reader: `.claude/hooks/idempotency-body-check.mjs`
- No database, migration, Edge Function, FarmRx, or live-data work.

## Why the first cycle parked

Three exact-SHA reviews successively found that the SQL reader could miss:

1. newline-concatenated and encoded procedural bodies;
2. comments inside quoted SQL and additional `INTO` overwrite forms;
3. variable overwrites through legal PL/pgSQL constructs such as
   `RETURNING INTO`, conditional assignment, `FETCH INTO`, and `CALL INOUT`.

The third finding showed that enumerating every way a dynamic-SQL variable can
change is not a sound security boundary. The cycle correctly stopped without
minting a push proof.

## Resolution in the resumed cycle

The variable-provenance allow-list was removed. `EXECUTE` is accepted only when
the complete SQL text is supplied directly as one string literal. Variables,
`format()`, concatenation, calls, and other expressions fail closed with a clear
message directing intentionally complex migrations to the existing file-level
`-- actor-binding-check: exempt` marker and human review.

Focused regressions now deny all reproduced overwrite families and deny an
apparently harmless `format()` expression. A subsequent exact-SHA review also
found that doubled quotes in an executable standard string could create a fake
comment in the recursive mask; those nested-quoted payloads now fail closed.
The actor suite passes at 98
assertions; the idempotency reference suite remains green at 86 assertions.
Removing only the new direct-literal enforcement makes the actor suite fail,
then restoring it returns both suites to green. The real hook process denied a
`RETURNING INTO` overwrite followed by indirect execution and allowed a complete,
bound function supplied directly as one literal.

The full repository run passed 321 test files and 4,302 tests before two known
workbook tests exceeded their five-second timeout under parallel load; both
files passed immediately in isolation (23/23). Lint, type-check, build, agent
workflow tests, and diff checks also passed. Unrelated reference-document drift
for four 2026-08-08 migrations remains outside this hook-only change.

## Publish gate

The branch must still receive a terminal `CODEX_PROOF_VERDICT: CLEAN` for its
new committed SHA before it can be pushed. After that, it follows the protected
branch flow: branch push, pull request, required checks and Vercel, CodeRabbit
review, squash merge, and remote-main verification.
