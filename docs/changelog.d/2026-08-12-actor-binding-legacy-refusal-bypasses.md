## 2026-08-12 — Actor-binding exact-head review closes legacy-refusal bypasses

The first fresh exact-head review of `8331ca4b` found two HIGH variants in the
legacy refusal compatibility path: PostgreSQL resolves bare `v_actor`, quoted
`"v_actor"`, and Unicode-escaped equivalents to the same local variable, but the
stability scan recognized only the bare assignment target; and null-unsafe `<>`
or `!=` comparisons could be skipped when either actor was null. Both reviewer
probes were reproduced against the real hook before repair. Stable local bindings
now recognize quoted writes, fail closed on opaque Unicode assignment targets,
and accept only the null-safe `IS DISTINCT FROM` mismatch operator. Four focused
regressions cover the two identifier spellings and both rejected operators.

