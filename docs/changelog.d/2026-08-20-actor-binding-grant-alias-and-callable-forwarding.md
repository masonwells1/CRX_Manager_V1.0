## 2026-08-20 — Actor-binding guard closes grant-alias and callable-forwarding gaps

Exact-head adversarial review found that the internal-helper ACL check parsed
`GRANT EXECUTE` but missed PostgreSQL's equivalent `GRANT ALL` and
`GRANT ALL PRIVILEGES` forms. An unbound `SECURITY DEFINER` actor mutator could
therefore be reopened to `authenticated` callers after its client-role revoke
and escape actor-binding review. Routine-specific and schema-wide ACL parsing
now treats all three grant forms equivalently and fails closed on the later
grant. Regressions cover the reported authenticated function grant, the `ALL`
shorthand, and a schema-wide `ALL PRIVILEGES` grant; the focused hook suite now
passes 393 assertions.

The next bounded review round found that a `SECURITY DEFINER` wrapper could
forward its unbound actor through a normal SQL function expression such as
`SELECT helper(p_performed_by)`, while the guard recognized only `CALL` and
`PERFORM`. Because a `SECURITY INVOKER` helper inherits the definer wrapper's
effective privileges, that split path could still forge a financial-audit
actor. The guard now treats actor arguments to any callable expression as a
mutation boundary, including assignment, `RETURN`, and `RETURN QUERY`, while
excluding control-flow parentheses. The post-apply actor-forgery sweep now
flags the same forwarding shape. Direct and local-aliased forwarding through
assignment, `SELECT INTO`, and PL/pgSQL `ALIAS` declarations is fail-closed.
Eight regressions cover the forwarding forms and the non-mutating control; the
focused hook suite now passes 401 assertions.

Review finding AB-ACL-001 then proved that the same internal-helper exception
trusted only statically parsed grants. A migration could revoke every browser
role, create an unbound actor mutator, and later reopen it through
`DO ... EXECUTE 'GRANT EXECUTE ... TO authenticated'`; a delayed `pg_cron`
command had the same effect. The first repair rejected quoted re-grants, and its
direct, assembled, and delayed regressions brought the focused suite to 404
assertions.

The renewed exact-head review found that parsing more statements still could
not prove effective access: `CREATE OR REPLACE` preserves existing ACLs, default
privileges can grant execute rights, and authenticated users may inherit access
through roles that are not declared in the migration. The static internal-helper
exception has therefore been removed. Every mutating `SECURITY DEFINER` routine
with an actor parameter must bind that actor, or use the existing explicit
manual-review exemption with catalog preconditions and postconditions. The
former internal-only allow case now denies, while all 404 focused assertions
remain green.

The next bounded review found that separate `ALTER FUNCTION` and
`ALTER PROCEDURE` statements recognized `SECURITY DEFINER` only when it was the
first action after the signature. Legal forms such as `VOLATILE SECURITY
DEFINER` and `EXTERNAL SECURITY DEFINER` could therefore elevate an existing
actor mutator without body review. The ALTER reader now scans the complete
masked action list, accepts the optional `EXTERNAL` keyword, and applies the
final declared security mode. Function, procedure, and final-mode regressions
bring the focused suite to 407 assertions.

The renewed cycle then found two callable-forwarding aliases outside that
model: PostgreSQL's `$n` positional argument names and explicit infix
`OPERATOR(schema.symbol)` calls. Actor parameters now carry both their declared
name and exact input position through direct, local-alias, callable, and
identity-refusal analysis; OUT-only parameters do not consume a caller input
position. An explicit user-defined operator receiving the actor in the same SQL
statement is also a fail-closed mutation boundary. Both live actor-forgery
predicates recognize positional aliases, and the general predicate recognizes
operator forwarding. Eight deny/control regressions bring the focused suite to
415 assertions. The next exact-head review found the same callable boundary in
ordinary symbolic syntax: `p_performed_by ## auth.uid()` invokes a user-defined
operator without the explicit `OPERATOR(public.##)` spelling. The hook and the
general live sweep now fail closed when a tainted actor is adjacent to any
non-comparison symbolic operator, including positional and local aliases, while
ordinary identity comparisons remain allowed. Four deny/control regressions
bring the focused suite to 419 assertions.

The final PR comment audit found one more delayed-DDL alias: the runtime SQL
reader used a function-only header check before recursively inspecting stored
commands, even though the routine parser already covered procedures. A direct
`cron.schedule` literal could therefore create an unbound mutating `SECURITY
DEFINER` procedure later. Stored and executed DDL now recognizes both `CREATE
FUNCTION` and `CREATE PROCEDURE` headers through the same routine boundary. The
reported scheduled-procedure regression brings the focused suite to 420
assertions, and removing procedure recognition makes that exact proof fail.

The renewed SEC-01 review found that PostgreSQL Unicode-escaped parameter names
could conceal an actor-shaped input from the guard. In particular,
`U&"p_\0075ser_id"` resolves to `p_user_id`, while the routine body can refer to
the same input as `$1`. Unicode-named inputs on mutating `SECURITY DEFINER`
routines now fail closed and must prove actor binding through their exact
positional alias (or use the existing explicit exemption). Named, positional,
and soundly-bound controls bring the focused suite to 423 assertions; removing
the Unicode positional treatment makes the reported `$1` regression fail.

The first exact-head rerun then exposed a second actor-forwarding alias before
timing out: an unbound actor could be assigned to a composite record field such
as `v_profile.id` and passed to an invoker helper because local taint tracking
recognized only simple variables. Qualified PL/pgSQL assignment targets now
remain actor-tainted through callable and operator analysis. Deny and
soundly-bound controls bring the focused suite to 425 assertions; removing the
qualified-reference matcher makes the reproduced forwarding regression fail.

CodeRabbit's exact-head pass then found SEC-01 in the read-only live predicates:
PostgreSQL permits `$` in an unquoted parameter name, but both predicates
interpolated catalog `argname` values directly into regular expressions. A
routine forwarding `p_actor$source` by name could therefore evade the callable
and financial-audit matches even though the positional `$1` spelling was caught.
Both predicates now escape regular-expression metacharacters in catalog names
before constructing any match. A disposable PostgreSQL 17 regression first
proved that only the positional controls were detected, then proved both named
and positional forms are caught by both predicates after the repair.

The next exact-head SEC-01 review found that the ordinary-symbol path still
treated `=`, `<>`, `!=`, `<`, `<=`, `>`, and `>=` as inherently safe identity
checks. PostgreSQL permits user-defined overloads for every one of those
symbols, so an authenticated caller could pass a forged actor through a custom
comparison function executing with its `SECURITY DEFINER` wrapper's effective
privileges. The hook and general live predicate now treat every actor-adjacent
symbolic operator as a fail-closed callable boundary unless the routine proves
the canonical `ACTOR_MISMATCH` refusal. A custom composite actor type with a
mutating overloaded `=` reproduced the hook allow and missing catalog row before
the fix; the restored code passes 426 focused assertions and a disposable
PostgreSQL 17 predicate run. Reinstating the comparison exclusions makes the
exact PostgreSQL regression fail while all named and positional controls remain
detected.

The final bounded SEC-01 repair closes two ordering and syntax gaps from the
next exact-head review. Parentheses, `CAST(...)`, PostgreSQL `::` casts, field
selection, and subscripts can no longer separate a caller-supplied actor from a
user-defined operator and make the forwarding look safe. A canonical refusal
also counts only when no actor-bearing helper or operator expression ran before
it; the catalog predicate now scans the routine prefix before the first
`ACTOR_MISMATCH` token instead of suppressing the whole routine whenever that
token appears anywhere. Eight hook regressions and three disposable PostgreSQL
17 routines cover wrapped/reverse operators and callable/operator execution
before refusal. The restored hook passes 434 assertions, the catalog proof is
green, and disabling each load-bearing guard reproduces its exact failure.

CodeRabbit's current-head review then found that both catalog predicates still
treated raw `ACTOR_MISMATCH` text as proof. A full fake guard in a comment, a
notice/string, or a refusal caught by `EXCEPTION WHEN` could therefore hide
later actor forwarding or a forged financial-audit write. Both predicates now
strip comments and truncate only at a recognized strict-actor `IF` followed by
an executable `RAISE EXCEPTION 'ACTOR_MISMATCH'`; any routine containing an
exception handler remains fail-closed. Disposable PostgreSQL 17 fixtures cover
comment, notice, full fake-guard string, caught-refusal, direct safe-refusal,
and `v_actor := auth.uid()` safe-refusal cases across both predicates. Removing
comment masking or caught-handler detection independently makes its exact
regression fail; the restored catalog proof passes.

The follow-up CodeRabbit pass found two more catalog-only gaps. A recognized
`v_actor := auth.uid()` binding made the truncation start at the binding rather
than the later refusal, hiding any forged forwarding or audit write between
them. The binding is now proven separately while the removed suffix starts at
the refusal's `IF`. PostgreSQL also numbers PL/pgSQL `$n` aliases across the
full declaration list, including `OUT` parameters; the predicates now use the
catalog ordinal instead of an input-only counter. Disposable PostgreSQL 17
fixtures reproduce both misses across the general and financial predicates,
and reverting either load-bearing change makes its exact fixture fail.

The next exact-head Sol review found two High variants behind those catalog
fixes. PostgreSQL equality is overloadable, so a custom actor type could make
`IS DISTINCT FROM auth.uid()` lie and skip the refusal. Actor refusals now count
only when the write-time declaration and live catalog prove the actor is UUID;
local `v_actor` bindings must also be declared UUID. The live predicates now
use a length-preserving lexer that masks comments plus ordinary, escape,
Unicode, and dollar-quoted data strings before looking for a refusal, while
preserving the executable canonical exception literal. Unterminated or
nested-comment residue fails closed. Lying equality, custom local identity,
ordinary/E/U&/dollar fake-guard, nested-comment, and safe-refusal controls run
in disposable PostgreSQL 17; each type, position, and lexer guard was removed
in turn and its exact regression failed.

The following exact-head review found that the write-time hook accepted a local
assignment whose expression merely started with `auth.uid()`, allowing a
trailing operator to replace the trusted identity. Declaration initializers and
later assignments must now end immediately after the exact `auth.uid()` call;
both forged forms are pinned, bringing the focused suite to 440 assertions.

A later bounded security review found two more exact bypasses. Executable SQL
could hide `ALTER FUNCTION/PROCEDURE/ROUTINE ... SECURITY DEFINER` inside a
string and elevate an existing unreadable actor mutator after the lexer masked
the statement. A migration could also create a shadow `uuid` domain, place its
schema ahead of `pg_catalog`, and overload equality so a bare-`uuid` actor or
legacy local appeared to match `auth.uid()`. The lexer now preserves both
routine creation and security-elevating ALTER DDL at dynamic execution
boundaries. Bare `uuid` is no longer trusted when the migration creates a
same-named type/domain or explicitly searches another schema before
`pg_catalog`. An explicit `pg_catalog.uuid` remains reviewable only when the
routine's runtime path also keeps catalog operators first; otherwise a
user-schema `=(pg_catalog.uuid, pg_catalog.uuid)` operator can lie about the
comparison too. Five regressions cover the dynamic elevation, shadowed actor
parameter, shadowed local, explicit-catalog operator impersonation, and the safe
implicit-catalog-first control. Each load-bearing defense was removed in turn
and its exact regression failed; the restored focused suite now passes 445
assertions.

The next exact-head review found that `GET STACKED DIAGNOSTICS` could overwrite
an otherwise trusted `auth.uid()` local without using the assignment forms the
reader tracked. A caught exception could therefore copy caller-controlled text
into the actor local before the refusal and make a forged actor appear equal.
Diagnostics targets, including block-qualified and opaque Unicode spellings,
now invalidate the trusted local binding. The reviewer-supplied laundering flow
is covered directly; the focused suite now passes 446 assertions.

A further exact-head review found that pre-refusal analysis blanked quoted
callable names before checking actor forwarding. A routine could call
`pg_catalog."set_config"` with a caller-supplied actor, replace the JWT subject,
and then make the canonical `auth.uid()` refusal pass. Quoted identifiers now
remain visible to callable analysis while staying blanked only for control-flow
keyword parsing. Both live actor-forgery predicates now recognize quoted
callable identities before a financial-audit refusal. The exact flow executes
successfully in disposable PostgreSQL 17 and is then detected by both
predicates; the focused hook suite now passes 447 assertions.

Windows verification exposed a line-ending mismatch in the one-use producer: function-source text was
compared with an LF-normalized generated guard before its own CRLF bytes were normalized. Both producer
anchors and their assertions now use the same normalized representation, keeping the reviewed output
blob stable across Windows and POSIX checkouts.

