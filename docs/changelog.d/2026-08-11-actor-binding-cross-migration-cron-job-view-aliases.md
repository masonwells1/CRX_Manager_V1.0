## 2026-08-11 — Close executable cross-migration cron.job view aliases

Hardened the actor-binding SQL reader against persistent updatable aliases that
are created through a direct `EXECUTE` literal. The alias lifecycle scan now
retains executable SQL inside procedural containers, single-quoted commands,
dollar-quoted commands, and parenthesized direct `EXECUTE` forms while keeping
ordinary data strings masked. Dollar-quote delimiters are blanked before
relation parsing so their legal `$` characters cannot become part of a source
identifier. Persistent aliases remain tracked across later migrations and
through schema movement or rename; temporary aliases do not leak across files.
Unsafe function-bearing commands written through any tracked alias are denied,
while harmless commands and dynamically created non-`cron.job` views remain
allowed.

The final fresh-cycle review found one more asynchronous boundary: pg_cron can
schedule the view creation itself, so masking its direct command literal made a
later migration forget the persistent alias. Historical discovery now decodes
and recursively scans direct command literals supplied through positional,
named, and mixed-notation `schedule`, `schedule_in_database`, and `alter_job`
calls. Nested scheduled commands and delayed rename/schema movement retain the
alias, including when the pg_cron call is inside executable procedural SQL;
delayed temporary views do not persist, and non-cron lookalikes remain ordinary
data. If a command builds a possible `cron.job` view lifecycle from fragments
that cannot be inspected as one literal, including fragments nested inside a
procedural container, the history records a wildcard/manual-review identity
instead of allowing an unknown future target.

The focused real-hook suite now has 287 passing assertions, including real
two-migration dynamic and scheduled-alias process tests plus unsafe/harmless
lifecycle controls. Sixteen load-bearing behaviors were mutation-proven: the
original executable-literal retention, dollar-tag blanking, parenthesized
`EXECUTE`, parameter-specific current-main actor-refusal compatibility path,
unreadable historical alias fallback, and regex-safe quoted actor parameters;
plus delayed-command discovery, TEMP exclusion, named-command extraction,
mixed positional `alter_job`, positional `schedule_in_database`, opaque-command
wildcarding, split-literal lifecycle reconstruction, executable-container call
discovery, opaque procedural-call discovery, and nested-payload reconstruction.
Direct real-hook probes returned
`DENY` for the unsafe staged command and `ALLOW` for the harmless control, and
all 24 current August migrations pass. The compatibility path accepts
`<actual actor parameter> does not match authenticated user` in addition to the
canonical `ACTOR_MISMATCH` token, but still rejects comments and a refusal that
names a different actor parameter.

