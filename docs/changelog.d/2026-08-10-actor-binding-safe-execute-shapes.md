## 2026-08-10 — Actor-binding SQL reader recognizes safe EXECUTE shapes without reopening delayed SQL

Continued the parked actor-binding guard hardening on an isolated branch,
originally rebased onto `origin/main` at `0b85b5e4` and later refreshed through
current main `8dcb82fb`. The SQL reader now distinguishes declarative
`CREATE [EVENT] TRIGGER ... EXECUTE FUNCTION ...` syntax from runtime dynamic
SQL, and accepts a PL/pgSQL `EXECUTE` command only when the command itself is one
direct string literal with optional `INTO [STRICT]` followed by optional
`USING`. Variable, concatenated, `format(...)`-built, malformed clause-order,
trailing-syntax, and second-`EXECUTE` shapes remain fail-closed.

The first exact-SHA review of that continuation found a real high-severity
boundary error: the runtime-SQL classifier recognized only unquoted
`cron.schedule(...)`, even though quoted identifiers and pg_cron's
`schedule_in_database(...)` and `alter_job(...)` APIs can also store executable
command text. The reader now recognizes any direct call in the `cron` schema,
including quoted identifiers, but still ignores cron-looking text inside data
strings and comments. This is deliberately future-proof and fail-closed: an
ordinary cron call remains allowed, while any cron API receiving a literal that
contains `CREATE FUNCTION` requires the explicit exemption/manual-review path.

The next exact-SHA review found a remaining high-severity boundary error:
`SET search_path = cron, public; SELECT schedule(...)` resolved the API through
the search path and bypassed the qualified-call classifier. A real snapshot
probe proved the approved base denied this input while the candidate allowed it.
The reader now recognizes pg_cron's current command-bearing APIs when called
unqualified or through quoted unqualified identifiers; ordinary calls without
function DDL and pg_cron-looking text inside data strings remain allowed.

The following exact-SHA review found the table-level equivalent: direct writes
to `cron.job.command` can replace or create delayed executable commands without
calling a pg_cron function. The reader now treats direct `UPDATE` and `INSERT`
writes to that sink as runtime-SQL boundaries, including quoted identifiers,
`ONLY`/alias and tuple-assignment UPDATEs, and search-path-resolved `job` INSERTs.
Harmless cron commands and ordinary non-cron documentation writes remain allowed.

The next exact-SHA review found three legal SQL variants around that table/API
boundary: a CTE can prefix `UPDATE cron.job`, `MERGE INTO cron.job` can replace
the command, and PostgreSQL Unicode identifiers such as `U&"\\0063ron"` decode
before name resolution. The reader now finds cron command-table writes after a
CTE, treats `MERGE` as the same executable sink, and conservatively routes
executable calls or writes containing Unicode identifiers through the runtime
SQL boundary. Unicode-looking text inside comments or data literals remains
ignored.

The exact-SHA review of that tree found one more high-severity data-flow bypass:
unsafe function DDL could first be stored as ordinary data, then supplied to
`cron.schedule(...)` or `cron.job.command` through a subquery or variable. The
reader now requires command-bearing pg_cron APIs and table writes to receive the
complete command as one directly inspectable plain or dollar-quoted literal.
Subqueries, variables, `DEFAULT`, concatenation, `INSERT ... SELECT`, opaque
upserts, and opaque MERGE/tuple assignments fail closed into the existing
exemption/manual-review path. Named direct literals remain allowed,
`cron.unschedule` remains recognized as non-command-bearing, and `COPY` into
`cron.job` conservatively requires manual review.

The following exact-SHA review found the matching Unicode data-flow gap:
unqualified Unicode-escaped API names and Unicode-escaped `command` argument
names reached the broad sink detector but not the command-input extractor. The
extractor now conservatively registers every Unicode call recognized by the
sink detector, including custom `UESCAPE` syntax. Direct safe literals remain
allowed; opaque Unicode API or argument forms require manual review.

The next exact-SHA review found a mixed-branch MERGE gap: a safe direct command
in `WHEN MATCHED ... UPDATE` made the statement appear inspectable even when
`WHEN NOT MATCHED ... INSERT` stored an opaque staged command. Any pg_cron job
MERGE with an INSERT branch now requires the manual-review path; update-only
MERGE remains allowed when every command assignment is directly inspectable.

The next exact-SHA review identified CRX's legacy
`public.execute_sql_readonly(text)` as another delayed execution boundary. It
accepts SELECT/WITH text and dynamically executes it as the function owner, so
a nested `cron.schedule(...)` literal could otherwise be masked as ordinary
data. The reader now recursively inspects direct function-bearing SQL supplied
to that exact executor and refuses staged/opaque executor expressions. Direct
harmless queries and unrelated callables receiving documentation remain allowed.

The following exact-SHA review found that the actor scanner's function-name
grammar still accepted only unquoted names. A direct EXECUTE could therefore
create a valid quoted qualified function without reaching actor inspection.
Both the recursive function-header detector and final actor scanner now share a
qualified-identifier grammar covering quoted, doubled-quote, whitespace-around-
dot, and Unicode/UESCAPE forms. A bound quoted function remains allowed.

CodeRabbit's publication review then found that a CTE-prefixed `UPDATE cron.job`
scanned its assignment tail from the regex-match length instead of the match's
actual source offset. That conservative mistake could make an unrelated CTE
`command` assignment impersonate the outer cron update. The tail now starts
after the matched cron target, and a safe CTE control proves the false positive
closed. The same follow-up makes raw/masked argument alignment explicit and uses
valid quote forms for both single-quoted and dollar-quoted test fixtures.

The next governed exact-SHA review found an executor-identity bypass: a migration
could rename `execute_sql_readonly`, call the alias with scheduled actor-forgery
SQL, and restore the old name. The reader now fails closed when function-bearing
SQL is passed to any unproven callable and blocks renames or schema moves of the
known owner-executing SQL function. Plain table storage remains ordinary data;
callable sinks, unknown aliases, and rename-call-restore sequences require the
exemption/manual-review path.

The following exact-SHA review found that the first version of this callable
boundary inspected only a direct first argument. The reader now walks every
enclosing callable around function-bearing SQL, so later positional/named
arguments and cast/parenthesis wrappers cannot hide an executor. Direct
`EXECUTE format(...)` remains on its existing reviewed builder path; unproven
wrappers such as `dblink_exec(connection, sql)` require manual review.

The final mixed-notation repair closes the same gap in `cron.alter_job`: a
positional command in argument three is now inspected even when later optional
arguments use PostgreSQL's named notation. Staged or indirect function-bearing
commands remain denied, while direct harmless commands and existing pure-named
calls retain their prior behavior.

Fresh exact-head review then found the same harmless mixed-notation false denial
in `cron.schedule_in_database`, plus a remaining executor bypass where an
unproven callable assembled `CREATE FUNCTION` from individually harmless string
fragments. Positional command three is now inspected before later named options
for both pg_cron APIs, and function headers are reconstructed across the literal
fragments enclosed by an unproven callable before the reader decides the text is
ordinary data.

The next exact-head round found two more fail-open variants and two false-denial
edges. Every `cron.job` INSERT in a multi-CTE statement is now validated instead
of trusting the first safe insert; Unicode-escaped string SQL is decoded for
function-header detection at unproven callable boundaries; named-only
`alter_job` options no longer impersonate positional command three; and Edit
payloads are reconstructed against the current file so the guard inspects the
result rather than an isolated replacement fragment.

The final capped review reproduced a quoted-identifier exemption collision:
PostgreSQL preserves the spelling of `cron."UnScHeDuLe"`, but the reader lowered
it to the safe built-in `unschedule`. Quoted API names now preserve their decoded
case, so custom mixed-case sinks remain unknown and fail closed while exact
quoted and case-folded unquoted calls to the real built-in remain allowed.

The fresh repair review then found that an unallowlisted SQL-text callable such
as `query_to_xml(...)` could receive a function-bearing query assembled from
individually harmless string fragments. The reader now fails closed only at
callables whose names indicate an `exec`, `execute`, `query`, or `sql` text sink
when a string-bearing argument is not one directly inspectable literal. This
narrow boundary denies the obscured query and quoted mixed-case lookalikes of
trusted executors while preserving direct harmless literals and ordinary
PL/pgSQL `RETURN QUERY` syntax. A full historical migration scan found zero new
denials from the narrowed rule.

The final fresh-cycle review found that PostgreSQL's updatable views could
rename the `cron.job` write target: a migration could declare a view over that
table and then store unsafe function DDL through the view's `command` column.
The reader now tracks views declared over `cron.job`, including quoted,
schema-qualified, search-path-resolved, and transitive view aliases, and applies
the existing direct/opaque command inspection to their UPDATEs. A direct
harmless command remains allowed, staged commands remain fail-closed, and views
over explicitly non-cron relations remain ordinary data.

The next exact-head review found that this tracking stopped at the current
migration, even though persistent PostgreSQL views remain updatable by later
migrations. The hook now loads earlier migration files on demand, carries a
monotonic set of persistent `cron.job` view aliases across them, and preserves
that sink identity through unqualified-to-qualified references, view/table
renames, schema movement, and conservative drop/name reuse. Temporary views do
not leak into later files. If migration history cannot be read, an unknown
command target is treated as a possible cron alias instead of being allowed.
Multi-file real-process regressions deny direct and staged unsafe commands
through an earlier view while allowing direct harmless commands.

The following fresh exact-head review found that a CTE could pass a previously
stored SQL column to an unproven executor such as `dblink_exec` without any
literal remaining in the executor statement. Unproven SQL-text sinks now accept
only complete direct string literals plus obvious non-string scalar options;
columns, variables, subqueries, builders, casts, and Unicode forms require the
existing exemption/manual-review path even when their current staged value looks
harmless.

The next exact-head review found that PostgreSQL Unicode identifier syntax could
hide `cron.job` as a view source, causing the alias collector to discard the
relation before the existing Unicode write guard ran. Any unnormalizable view
source now conservatively makes that view a delayed-SQL alias. Opaque Unicode
view names and rename targets carry a fail-closed wildcard across later
migrations, while harmless direct commands through the tracked alias remain
allowed.

The focused actor-binding suite grew from 115 to 247 assertions while the
idempotency reference suite remained at 86. Seventy-eight continuation decisions
were weakened or removed one at a time; every mutation made the real hook-process
suite fail before restoration. Separate real-process probes allowed ordinary
trigger/event-trigger declarations, direct-literal `USING`/`INTO`, and harmless
quoted cron calls, while denying variable, concatenated, formatted,
second-`EXECUTE`, quoted scheduled-DDL, cross-database scheduled-DDL, cron
command-replacement, unqualified search-path scheduling, and direct
`cron.job.command` actor-DDL controls, including CTE, `MERGE`, and Unicode-escaped
forms. They also denied staged SQL delivered through schedule/update/insert/MERGE
expressions while preserving direct safe command literals. The exact-SHA independent review remains an
external governed proof and must match the final branch HEAD before publication;
this entry does not self-certify it.
