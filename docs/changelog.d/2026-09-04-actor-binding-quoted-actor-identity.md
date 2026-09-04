## 2026-09-04 - Preserve quoted actor parameter identity

- The migration actor-binding guard now follows PostgreSQL's quoted/unquoted name rules when
  correlating actor inputs, refusals, trusted locals, assignments, and callable forwarding.
- A lowercase `p_actor` refusal can no longer clear a distinct quoted `"P_ACTOR"` parameter.
- Failing-first, exact quoted-name, trusted-local collision, and mutation controls keep the repair
  bounded; Unicode-escaped and non-ASCII quoted actor inputs remain positional-only.
- The broader best-effort actor-analysis cap remains unchanged.
