## 2026-09-03 — Actor guard closes runtime search-path ordering gaps

Exact-SHA review reproduced two forged-actor paths that changed operator lookup
after the static routine attributes were read: a pre-refusal
`pg_catalog.set_config(...)` call inside PL/pgSQL, and a delayed pg_cron ALTER
whose unsafe search path runs after a textually later safe top-level ALTER.

The guard now treats direct built-in `set_config` calls before the refusal as a
configuration mutation and classifies ALTER routine search-path text as
security-relevant dynamic DDL. Deferred/scheduled search-path alterations
therefore fail closed instead of participating in lexical last-write order.

Both exact payloads failed before repair and failed again when their respective
detectors were disabled. The restored focused suite passes 552 assertions.
The broader actor-analysis cap remains unchanged.
