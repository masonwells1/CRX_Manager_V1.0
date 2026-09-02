## 2026-09-01 — The guard could not see a routine written `FUNCTION"f"(`

Round 1 closed the reported laundering channels and then probed its own repair,
finding four more. Round 2 applied the same exit criterion to round 1's output:
probe the repaired hook, and treat a non-empty result as "not converged". The
probe came back with **seven bypasses across four root causes**, so it had not
converged.

## What was actually broken

**1. `\s+` between a keyword and an identifier is a hole, not a separator.**
PostgreSQL's lexer needs no whitespace before a double-quoted identifier, so
`UPDATE"financial_audit_log"`, `INTO"v_actor"`, `FOR"v_row"`,
`CREATE OR REPLACE FUNCTION"public"."f"(` and `ALTER FUNCTION"public"."f"(`
are all legal and all mean exactly what their spaced spellings mean. Every one
of those patterns used a plain `\s+`, so:

- `CREATE FUNCTION"name"(` / `CREATE PROCEDURE"name"(` — the routine was never
  matched, so the whole definition was skipped and never inspected at all. This
  was a total bypass of the guard for any routine written that way.
- `ALTER FUNCTION"name"(...) SECURITY DEFINER` — the same, for the
  elevate-without-a-readable-body refusal.
- `UPDATE"table"` — the only static mutation keyword whose target can abut it
  (INSERT/DELETE/MERGE all need a second keyword first). Paired with a wrapper
  that keeps the actor away from any operator — `(SELECT p_actor)` or
  `CASE WHEN true THEN p_actor END` — the routine read as non-mutating and was
  allowed while stamping a caller-supplied actor.
- `INTO"v_actor"` / `INTO STRICT"v_actor"` / `FOR"v_actor" IN` — an overwrite of
  a trusted `auth.uid()` local that the stability check could not see, so a
  legacy guard could compare the actor against a value the caller controls.

Fixed with two shared constants, `SQL_KEYWORD_IDENTIFIER_GAP` and
`SQL_IDENTIFIER_KEYWORD_GAP`, applied to every deny-path boundary — the routine
heads, the mutation keywords, INTO/FETCH/FOR/FOREACH/OPEN targets, and the
pg_cron and `execute_sql_readonly` identity-change detectors. The
violation-suppressing allowlists were deliberately left alone: they already fail
closed when they do not match.

**2. The refusal proves a NAME, and the name is mutable.** A PL/pgSQL parameter
is an ordinary local variable. A guard that passes, followed by
`p_performed_by := p_target_id;`, stamps a value `auth.uid()` never approved
while the guard still reads as bound. Same through `=`, `SELECT ... INTO`, a
`FOR` loop target, `GET STACKED DIAGNOSTICS`, a quoted or block-qualified
target, or a nested block. A recognized refusal now requires that the actor name
is never re-bound anywhere in the routine.

**3. `SET search_path TO 'evil', 'pg_catalog'` was invisible.** The check that a
user schema precedes `pg_catalog` — which is what makes `IS DISTINCT FROM`
resolution untrustworthy — ran on the masked text, where string CONTENTS are
blanked. It only ever matched the bare and double-quoted spellings, never the
single-quoted one that every CRX migration actually uses. It now also reads the
unmasked attribute ranges and accepts `'pg_catalog'`.

**4. Two reachability holes.** File scope matched `supabase/migrations/` and
`.sql` case-sensitively, but Windows and macOS resolve paths case-insensitively —
`Supabase/Migrations/x.SQL` is the same directory and the same file. And an edit
payload the reader cannot reconstruct (the settings matcher `Write|Edit` is an
unanchored regex, so a batched edit shape reaches this hook with neither
`content` nor `new_string`) rebuilt as `""` and was allowed. Both now fail
closed.

## Two more false safety claims in the header

Round 1 found the header claiming "Non-mutating functions are never flagged",
which was false. Two more of the same family were found and corrected:

- *"SECURITY INVOKER functions are never flagged"* — false. The file-level
  checks (unparseable SQL, dynamic CREATE FUNCTION text, an ALTER that renames
  the `execute_sql_readonly` or `cron.job` boundary, SQL handed to a callable
  not proven data-only) refuse the migration regardless of any routine's
  security mode. Demonstrated: a `SECURITY INVOKER` routine assembling dynamic
  SQL from a variable is denied.
- *"A routine with NO reachable use of the actor is never flagged"* — false. The
  mutation test scans body text, not the actor's data flow, so a definer routine
  that declares an actor parameter and mutates any table — even one it never
  stamps the actor into — is flagged. Demonstrated: a routine whose body never
  mentions its actor parameter is denied.

## Known and deliberate limits (not bugs, but not covered)

The guard keys on parameter NAME shape (`^p_\w*by$|^p_actor|^p_user`), matching
the live sweep predicates. A caller-supplied id with any other name —
`p_target_id`, `p_acting_user_id` — is out of scope, including when it is
stamped into an actor column right after a correctly proven guard on a sibling
actor parameter. Closing that needs real dataflow over the write targets, not a
wider name regex.

**The reader is a regex reader, not a parser, so the dataflow limits below are
structural and will not be closed by another pattern.** Naming them here so no
future session re-derives them or credits the guard with coverage it lacks:

- `EXECUTE … USING` — the actor reaches the statement as a bound parameter, not
  as text the reader can follow into a sink.
- `INSERT … RETURNING … INTO` — the actor round-trips through a returned column
  into a local, which the taint model does not track.
- Temporary tables — the actor is stashed in one statement and read back in
  another, so no single-statement pattern spans it.

The **post-apply sweep predicates do not compensate for any of these**: both
select only where `prosrc !~* 'ACTOR_MISMATCH'`, so a routine that passes a
binding check and then launders the actor is excluded outright, and a temp-table
round trip matches neither predicate's sink test. The controls that stand here
are the exact-SHA Codex proof on the migration diff and the CodeRabbit final
review — see the 2026-09-01 cap entry in `docs/manual/DECISION_LOG.md`.

## Evidence

87 adversarial probe payloads across four batches, run against the real hook.
All bypasses closed; the canonical bound routine, the `SECURITY INVOKER`
routine, the exempt marker, and out-of-scope paths all still allowed. Each fix
was mutation-tested — broken in turn, the specific probe confirmed to go red,
then restored. Hook suite 469 -> 492 assertions passing; sweep predicate tests,
typecheck, lint, `test:agent-workflows` and `check:docs` all green.
