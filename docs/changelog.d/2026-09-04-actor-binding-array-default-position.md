## 2026-09-04 - Preserve actor positions across ARRAY defaults

- The migration actor-binding guard now keeps commas inside square-bracketed `ARRAY[...]` defaults
  within the same routine parameter declaration.
- A preceding array default can no longer shift an opaque actor's PostgreSQL positional alias from
  `$2` to a decoy `$3` and let a forgeable actor pass review.
- The exact payload is covered by failing-first proof, a sound `$2` control, and clause-removal
  mutation proof; the restored focused suite passes 576 assertions.
- This is a bounded delimiter repair; the broader best-effort actor-analysis cap remains unchanged.
