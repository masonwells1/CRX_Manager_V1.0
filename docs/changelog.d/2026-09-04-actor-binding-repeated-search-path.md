## 2026-09-04 — Actor guard uses the final repeated CREATE search path

Exact-SHA review reproduced a forged-actor path using two legal CREATE routine
`SET search_path` options. PostgreSQL applies the later option, while the guard
could trust an earlier explicit `pg_catalog` and ignore the unsafe final value.

CREATE-level search-path inspection now records every option in source order
and evaluates the effective final setting. Top-level migration scanning remains
conservative across every statement. A safe-then-unsafe exploit is denied, and
the inverse unsafe-then-safe control remains allowed.

The exploit failed before repair and failed again when the parser was mutated
to select the first option. The restored focused suite passes 555 assertions.
The broader actor-analysis cap remains unchanged.
