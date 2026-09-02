## 2026-08-08 — Actor-binding guard hardened SQL reader

Ported the proven fail-closed SQL reader from `idempotency-body-check.mjs` into
`actor-binding-check.mjs`. The write-time actor-forgery guard now masks comments
and quoted data length-preservingly, counts nested PostgreSQL block comments,
handles dollar-quoted defaults, scans function structure on the mask while
recovering real parameter/body text, and denies unreadable parameter lists or
function bodies instead of silently skipping them.

Runtime-built `CREATE FUNCTION` statements are now accepted only when the whole
definition is one readable string literal. Split/concatenated definitions,
`format(...)` wrappers, `:=` and `=` variable assembly, and `SELECT ... INTO`
assembly fail closed with an explanation and the existing
`-- actor-binding-check: exempt` human-review escape hatch. The actor-binding
suite grew from 24 to 115 assertions, including comment-hidden headers, nested
comments, dollar-quoted defaults, explicit parse failures, dynamic DDL, and
quoted actor parameters. Fifty-four individual clause-removal mutations were run;
each made the real suite fail before the clause was restored. The reference
idempotency suite remained green at 86 assertions.

The first exact-SHA Codex push-proof review blocked the implementation on two
additional fail-open cases. A one-literal `format()` template could substitute
the actor parameter name from a variable at runtime, and the main scanner
skipped a complete dynamic definition nested inside an outer function body.
The guard now accepts a single literal only when it is the entire direct
`EXECUTE`, assignment, or `SELECT ... INTO` expression, and it continues
scanning readable nested definitions. Three new clause-removal mutations pin
those fixes.

The second exact-SHA Codex review found four more legal PL/pgSQL builders the
candidate had weakened versus the base: declaration initializers using `:=`,
`=`, or `DEFAULT`, plus `VALUES (...) INTO`. These forms now enter the same
fail-closed dynamic-DDL path. A complete function-bearing literal anywhere in
a procedural `DO` or function body is also kept visible, because it can be
stored and executed later even when the guard cannot trace that data flow.
Regression coverage pins both single- and dollar-quoted storage while confirming
that a normal top-level `UPDATE` remains data. The two builder classifiers and
both procedural-literal clauses each fail their test when removed alone.

The third exact-SHA Codex review found that comments could still hide the actor
parameter or mutation after structural parsing, and that function DDL fragments
could be assigned in separate statements before an indirect `EXECUTE`. Actor
parameter names, mutation keywords, and the binding marker now use comment-safe
views. Indirect execution is allowed only when the same variable has exactly one
earlier supported write containing one complete function-bearing literal; the
guard never reassembles fragments or guesses through aliases. Seven more
clause-removal mutations pin these decisions and the accepted direct-literal
assignment/`SELECT ... INTO` cases.

The fourth exact-SHA Codex review found a base-to-candidate regression: masking
single-quoted strings also hid an actor-stamping `UPDATE` or `INSERT` executed
through a literal or `format(...)`. An actor-bearing `SECURITY DEFINER` function
now treats every `EXECUTE` as potentially mutating unless it performs the required
actor binding. This intentionally refuses opaque dynamic reads too; the exemption
marker remains the human-review path. Removing that fail-closed clause makes the
reproduced single-quoted `UPDATE` probe fail its regression test.

The fifth exact-SHA Codex review found that PostgreSQL's optional `LANGUAGE`
clause and single-quoted code string could hide a `DO` body. The shared container
reader now recognizes `DO [LANGUAGE name]` for dollar- and single-quoted code,
recurses into both, and fails closed on `E'...'` bodies whose backslash decoding
cannot be kept index-safe. Unsafe probes reach the named actor violation, while a
correctly bound function inside the single-quoted form remains allowed. Five
retained parser decisions are mutation-proven; two initially added quote-handling
branches stayed green when removed and were deleted as non-load-bearing.

The sixth exact-SHA Codex review found one more legal PostgreSQL lexical form:
ordinary string literals separated by a newline are concatenated automatically.
Splitting a single-quoted `DO` body that way let the first token establish the
container while the later token holding dynamic actor DDL was masked as data.
The reader now refuses multi-token procedural bodies instead of reassembling
them. The same boundary now recognizes and refuses `U&'...'`/`N'...'` procedural
bodies whose decoding cannot remain index-safe. Removing either recognition
clause alone makes its focused regression turn red.

The seventh exact-SHA Codex review found two more parser-state bypasses. The
comment blanker preserved string data by intent but did not actually skip over
quoted text, so `/*` inside a legal parameter default erased the following actor
parameter. It now copies single-, double-, and dollar-quoted spans before
blanking real nested comments. Separately, a runtime-DDL variable marked safe
could be overwritten through `SELECT ... INTO STRICT` or `EXECUTE ... INTO`
without invalidating that proof. The provenance tracker now records every
simple target of `SELECT`, `VALUES`, or `EXECUTE INTO`, including `STRICT`, and
multiple targets are never treated as one safe direct source. Removing the
ordinary-quote skip, dollar-quote skip, or expanded target classifier alone
turns its exact regression red.

The eighth exact-SHA Codex review proved that the provenance allow-list itself
was the wrong abstraction: PL/pgSQL values can also be overwritten through
`RETURNING INTO`, conditional assignments, `FETCH INTO`, and `CALL INOUT`, with
more writers always possible. The tracker was removed. `EXECUTE` is now accepted
only when its complete SQL is one direct string literal; every variable,
`format()`, concatenation, function call, or other expression fails closed and
uses the existing exemption path for human review. Exact regressions cover all
four reproduced overwrite families plus a harmless-looking `format()` call.
Removing the single direct-literal gate alone turns the suite red.

The ninth exact-SHA Codex review found that recursively scanning the raw payload
of an executable standard SQL string could misread doubled quotes as two
delimiters. An inner string such as `''-- harmless literal''` could therefore
become a fake comment in the mask and hide a later mutation. Executable
single-quoted payloads containing doubled quotes now fail closed and use the
existing exemption/human-review path instead of attempting lossy decoding. The
exact comment-hiding probe is covered, and removing this refusal alone turns
that regression red.

The tenth exact-SHA Codex review found that executable SQL passed to APIs other
than `EXECUTE`, including the repository's `cron.schedule` command strings,
could be hidden by full string masking. Mutation keywords are now checked in a
second, comment-only mask that preserves string contents. This deliberately
fails closed on mutation text anywhere outside comments in a definer body with
a forgeable actor parameter. The exact scheduled actor-forgery probe is covered,
and removing this second scan alone turns the regression red.

The eleventh exact-SHA Codex review found a fail-closed false positive: ordinary
PostgreSQL `GRANT EXECUTE` and `REVOKE EXECUTE` privilege statements were being
treated as procedural runtime SQL. The guard now recognizes only those narrow
function-privilege statement heads, and only when no
second `EXECUTE` token exists. Exact regressions cover both privilege statements,
a complete bound `SECURITY DEFINER` migration with fixed `search_path` and
deliberate grants, and an indirect procedural `EXECUTE` that must remain denied.
Removing only the privilege distinction turns the allow regressions red.

The twelfth exact-SHA Codex review found that PostgreSQL also permits function
attributes after the closing body delimiter. Because the reader inspected only
the pre-body attributes, a mutating actor-bearing function with post-body
`SECURITY DEFINER` was allowed. The reader now includes post-body attributes
through the function statement's real terminating semicolon and fails closed
when that terminator is missing. Regressions cover an unsafe post-body definer,
a semicolon hidden in a trailing comment, a correctly bound post-body definer,
the missing-terminator denial, and statement-boundary isolation.
Removing the post-body attribute slice, the missing-terminator refusal, or the
statement-bounded slice alone makes its exact regression turn red.

The thirteenth exact-SHA Codex review found that top-level
`SELECT cron.schedule(...)` stores its command string for later execution, but
the rewritten mask treated that string as ordinary data. A scheduled actor
function could therefore be created after migration-time catalog sweeps. The
runtime-SQL classifier now treats `cron.schedule` as an execution context and
refuses function-bearing scheduled commands unless the migration uses the
explicit exemption/manual-review path. Normal scheduled calls without function
DDL remain allowed. Removing only the scheduling context makes the reproduced
unsafe scheduled function regression turn red.
