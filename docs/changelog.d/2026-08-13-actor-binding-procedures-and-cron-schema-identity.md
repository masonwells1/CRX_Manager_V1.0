## 2026-08-13 — Actor-binding guard covers procedures and cron schema identity

Fresh review of the cross-schema repair found two additional HIGH bypasses. A
caller-accessible `SECURITY DEFINER PROCEDURE` could mutate with a forged actor
because the write-time reader inspected functions only, and a migration could
temporarily rename the `cron` schema, rewrite `cron_shadow.job.command`, then
restore the name outside the delayed-SQL reader. Function and procedure
definitions now share the same actor-binding analysis; later `ALTER FUNCTION`,
`ALTER PROCEDURE`, and `ALTER ROUTINE` security modes use the same exact
schema/signature identity. Renames involving the canonical `cron` schema are
refused before its command table can become invisible. Eight regressions cover
both exploit paths plus unrelated-schema, bound-procedure, and invoker-demotion
controls. A subsequent exact-head review found that a single canonical
`ACTOR_MISMATCH` guard could incorrectly clear a second actor parameter, and
that a definer procedure could forward a forged actor through `CALL` or
`PERFORM`. Each actor-shaped parameter now needs its own proven identity refusal
before any direct write, dynamic SQL, `CALL`, or `PERFORM`; the two live
actor-forgery predicates now inspect authenticated-executable procedures as
well as functions. Review also required the historical scan to stay compatible
with private helpers that explicitly revoke both PUBLIC and authenticated
EXECUTE, and with nullable actor arguments that first prove non-null before a
`<>` mismatch check; ambiguous grants and null-unsafe comparisons still fail
closed. A nested cleanup handler no longer obscures an already-run outer actor
refusal, while an outer handler still fails closed. Eight regressions pin those
cases. Unicode-escaped later EXECUTE grantees are now treated as opaque rather
than trusted-private, so an encoded authenticated grant cannot bypass review.
The full focused hook suite now passes 380 assertions.

The final application-integrity review also found that Offline Work Review could
leave a permanent-resolution confirmation open while its authoritative queue was
being refreshed. Every refresh now invalidates the selected receipt and its
idempotency key before the new snapshot arrives; the UI and handler refuse a
resolution while loading or after a load error. A deferred-refresh regression
proves that no stale resolution RPC can be sent.

The last exact-head review also closed a privilege-analysis bypass in the
private-helper compatibility path. PostgreSQL default, schema-wide, and
inherited-role grants make a static grant history insufficient proof that a
`SECURITY DEFINER` routine is unreachable by a client. The narrow compatibility
path now requires an explicit `PUBLIC`, `anon`, and `authenticated` revoke;
rejects later schema-wide or untrusted-role grants; and permits only explicit
`postgres`/`service_role` regrants for known internal helpers. Regressions cover
the `anon` default grant and a later schema-wide authenticated grant. The
focused hook suite now passes 383 assertions.

The renewed exact-head review also found that a same-named ACL on a different
PostgreSQL overload could be mistaken for the actor-writing routine's private
ACL. The compatibility check now parses the ACL signature and routine kind and
matches both to the created routine's exact identity; a wrong-overload revoke
remains under actor-binding review. The focused hook suite now passes 384
assertions.

The next exact-head review found that a direct internal-only execute ACL could
still become browser-reachable through a newly granted role membership. The
guard now refuses that ambiguity anywhere in the same migration, before or
after the routine definition, rather than attempting to infer PostgreSQL's
recursive role graph. Two regressions cover both statement orderings; the
focused hook suite now passes 386 assertions.

The fourth authorized review round found that a `MERGE INTO` branch could
mutate from an unbound actor parameter while escaping the hook's otherwise
consistent mutation reader. The hook and its read-only live companion sweep
now classify that form, with function-insert and procedure-delete regressions.
The focused hook suite now passes 388 assertions.

The next exact-head review found a quoted-schema ACL bypass in the internal
helper compatibility path: `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public"`
and Unicode-escaped spellings were not recognized as schema-wide grants. The
guard now keeps every later schema-wide EXECUTE grant fail-closed rather than
attempting to normalize an identifier whose effective target may be ambiguous.
Quoted and Unicode-escaped regressions prove the real hook denies both forms.

