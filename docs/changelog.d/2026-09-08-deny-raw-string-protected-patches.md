## 2026-09-08 - deny raw-string protected patches

The Codex production-action guard now routes a freeform `apply_patch` payload
through its existing patch-destination checks. Direct evaluator and JSON/stdin
checks reproduced the prior raw protected patch being allowed. The repaired
guard suite then observed both paths deny it at the production/review harness boundary.
It also observed that a documentation patch which only mentions that protected
path remains allowed. Removing the new routing line made the new denial
assertion fail; restoring it returned the focused suite to green.
