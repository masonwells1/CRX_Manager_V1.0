## 2026-09-04 - Track top-level set_config before FROM CURRENT

- The migration actor-binding guard now includes a top-level
  `set_config('search_path', ...)` call when resolving the session state captured by a later
  `ALTER FUNCTION ... SET search_path FROM CURRENT`.
- A dynamic configuration name fails closed because it could resolve to `search_path`; a statically
  unrelated GUC remains allowed, and a later explicit safe `SET search_path` repairs the state.
- The exact malicious-operator payload is covered by failing-first and clause-removal mutation proof.
- This is bounded session-order tracking for `FROM CURRENT`; the broader best-effort actor-analysis
  cap remains unchanged.
