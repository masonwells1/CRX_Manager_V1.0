## 2026-09-03 — Actor-binding guard covers `VALUES … INTO` overwrites

Exact-SHA review reproduced a post-refusal actor-forgery path through valid
PL/pgSQL `VALUES (…) INTO` assignment. The write-time guard now treats targets
in that already-structured form like its existing `SELECT`, `RETURNING`,
`FETCH`, and dynamic `EXECUTE` `INTO` targets. This applies to guarded actor
parameters, positional aliases, and trusted UUID locals initialized from
`auth.uid()`; actor values used only as sources remain compatible.

Regression coverage was added before the repair and failed on the trusted-local
exploit. Direct, non-first, positional, and trusted-local overwrites are now
denied, while an untouched actor control remains allowed. Removing only the new
`VALUES` matcher makes the exploit suite fail again; the restored focused suite
passes 526 assertions. This remains a target-only extension and does not add
general SQL parsing, source-to-target taint propagation, or cross-routine
analysis.
