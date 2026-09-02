## 2026-08-11 — Require enforced legacy actor-refusal guards

Closed two subsequent exact-SHA actor-binding review blockers. The compatibility path
for older CRX functions no longer accepts the message
`<actor parameter> does not match authenticated user` as free-standing text.
It now requires that exact declared actor parameter to be compared against
`auth.uid()` inside a simple mismatch `IF` (directly or through one stable,
non-reassigned local binding), requires that guard to be a top-level statement
before every recognized mutation, rejects bodies whose exception handler could
swallow the refusal, and requires the matching branch to execute a real
`RAISE EXCEPTION`. Stable identity bindings must be initialized
unconditionally in the outer declaration section or by a top-level assignment;
an assignment hidden behind an `IF`, loop, `CASE`, or nested block cannot prove
the authenticated identity. When a function declares more than one
actor-shaped parameter, every parameter must have its own enforced legacy
refusal instead of one guarded parameter clearing the whole function. Stable
identity bindings also cannot be overwritten as a
`FOR`/`FOREACH` loop target, and quoted identifiers such as `"END LOOP"` are
blanked before control-flow keywords are counted. The hook therefore denies the phrase when it appears in
`RAISE NOTICE`, an assignment, unrelated data, an unconditional exception, an
always-false condition, a comparison for another parameter, or behind a local
identity variable that was overwritten. Nested, caught, post-mutation, or
zero-iteration-loop exceptions cannot stand in for the direct refusal either.
Existing direct, quoted-parameter, and current-August
`v_actor := auth.uid()` refusal forms remain compatible. The focused real-hook
suite passes 317 assertions. Seventeen isolated mutations across the repair each
failed on their owning regression before the production clause was restored;
one additional procedure-call clause was removed when mutation testing proved
it redundant with the earlier mutation-order gate. Direct hook probes deny the
conditional-binding and partially guarded multi-actor exploits while allowing
their unconditional and fully guarded controls. All 30 current August
migrations pass the repaired hook without a denial or internal error.

A fresh exact-head review then reproduced a delayed-SQL bypass through an
updatable view that renamed `cron.job.command` to `payload`. Every UPDATE through
a tracked `cron.job` view now enters the command-write boundary. Assignments to
the canonical `command` column retain their existing direct-literal inspection;
an update through any renamed or otherwise unproven view column fails closed to
manual review. Same-file explicit-column-list and `command AS payload` probes,
plus a real two-migration persistent-view probe, deny unsafe actor DDL. The
existing direct harmless `command` controls remain allowed, while harmless SQL
through an unproven renamed column deliberately requires manual review.

A subsequent exact-head review found that PostgreSQL's implicit function-block
qualification could overwrite the otherwise stable identity local as
`function_name.v_actor := p_performed_by` without matching the reassignment
check. Stable identity bindings are now invalidated by both unqualified and
block-qualified `:=` or legacy `=` assignments. The focused real-hook suite has
319 passing assertions, including the unsafe qualified overwrite and a harmless
qualified assignment to an unrelated local. Disabling the qualifier-aware
clause makes the unsafe regression fail, proving that the new condition is
load-bearing.

The next exact-head review found an early-exit variant: a branch could evaluate
`RETURN helper(p_performed_by)` before the legacy mismatch guard, allowing the
helper to perform a definer-privileged write and skip the guard entirely. The
legacy compatibility path now rejects any pre-guard `RETURN`, `EXIT`, or
`CONTINUE` rather than attempting to prove arbitrary exit expressions harmless.
The focused real-hook suite has 321 passing assertions, including the unsafe
early helper return and a compatible return after the authenticated-actor guard.
Removing the exit tokens makes the unsafe assertion fail, mutation-proving the
new condition.

After merging current `origin/main`, the fail-closed dynamic-SQL boundary also
required manual review for three newly parked Wave A migrations. Each now carries
the repository's explicit actor-binding exemption marker with its narrow reason:
fixed identifier-only constraint DDL, rollback-only role/claim setup, or guarded
role revokes. The two files that define actor-taking SECURITY DEFINER functions
bind `auth.uid()` and raise `ACTOR_MISMATCH` before mutation; the finiteness file
defines no function. All 36 current August migrations therefore pass without
weakening the reader's indirect-SQL refusal.

Fresh-cycle review round one found the same local-overwrite attack through a
quoted function/block qualifier: PostgreSQL resolves `"function_name".v_actor`
like the unquoted form, but the reassignment scan previously recognized only
bare identifiers. The scan now reuses the reader's full PostgreSQL identifier
grammar, so ordinary, quoted, and Unicode-escaped block qualifiers all
invalidate the trusted local. The focused suite has 323 passing assertions;
the quoted exploit failed before the repair and passes after it, alongside a
Unicode-qualified regression. All 36 current August migrations still pass.

Review round two found two non-callable execution boundaries. A migration could
hide `execute_sql_readonly(text)` behind a user-defined PostgreSQL operator, or
place function-bearing SQL directly in a `COPY ... TO PROGRAM` command for an
external `psql` process. Creating an operator alias for the protected executor
now fails closed, and function-bearing literals in explicit operator expressions
or `COPY PROGRAM` statements enter the same runtime-SQL review boundary as
callables. Operator-alias discovery also inspects direct dynamic SQL and fails
closed on Unicode-escaped handler identities. The focused suite has 333 passing
assertions. Both exploit probes were confirmed red before the repair and green
after it; unrelated operators, harmless operator payloads, ordinary `COPY`, and
harmless program commands stay compatible. All 36 current August migrations
still pass without an internal reader error.

