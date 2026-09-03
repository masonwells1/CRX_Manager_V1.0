## 2026-09-02 — close four Codex findings on the actor-forgery sweep rewrite

The exact-SHA `gpt-5.6-sol` high-effort proof on `c1beab619` returned **BLOCKERS**, not clean. Four
findings, all real, all fixed here. Recorded because two of them were defects *introduced by the
rewrite itself* — the kind that a green board and a passing suite both missed.

### HIGH — a guard that cannot fire was being credited

The first draft accepted `<>` / `!=` refusals unconditionally. `IF p_actor <> auth.uid() THEN RAISE`
evaluates to **NULL** when the actor argument is NULL, so the `IF` never fires and the refusal never
raises. The predicate credited that as a valid guard.

This is the same defect class as the `actor_selfbound_declare_init_forward` canary already in the
suite — a guard that looks correct and cannot refuse — and it was introduced by the widening, not
inherited. `<>` / `!=` are now accepted **only** behind an explicit `<actor> IS NOT NULL AND` guard;
`IS DISTINCT FROM` stays acceptable alone because `NULL IS DISTINCT FROM <uuid>` is TRUE.

Measured read-only against live: **zero** routines use a bare inequality without a null guard, and
the 3 that use the inequality spelling all pair it with one. Costs no live coverage.

### HIGH — a poisoned local satisfied the ordering check

Ordering alone (binding before refusal) admits:

```sql
v_actor := auth.uid();
v_actor := p_target_id;                       -- poisons the check
IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE …
```

The refusal reads a caller-controlled local and proves nothing. The credit now also requires **no
re-assignment of `v_actor` between the binding and the refusal**. The `.*?` bridge this replaced had
the same blind spot, so it is fixed rather than carried forward.

### HIGH — dynamic audit writes evaded the financial predicate

`EXECUTE 'INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1)' USING p_performed_by;`
lives entirely inside a string literal, which the lexer masks, so `financial_audit_log` vanishes from
the analysed source and the actor arrives via `USING` rather than inside a call — no arm fired. The
base predicate on `main` reports it; that coverage was lost when the lexer arrived in PR #449.

Restored as a raw-source correlation, **scoped** to the case it is for: sink present in raw source
and absent from the lexed body. The first attempt was unscoped and reported
`actor_safe_refusal_forward`, which legitimately stamps its actor parameter after a credited
refusal — a fresh false positive introduced while closing a false negative.

### MEDIUM — the regression suite was wired into nothing

`actor-forgery-predicates.test.mjs` was in no npm script, and Vitest only collects
`src/**/*.test.{ts,tsx}`. Three DENY canaries that nothing executes are documentation, not coverage.

- `npm run proof:actor-forgery` runs the Docker proof, matching the `proof:save-field-actor`
  convention for container tests.
- New `actor-forgery-predicates-static.test.mjs` is wired into `test:correction-guards` (CI, no
  Docker). It pins every load-bearing arm of both predicates, forbids regressing the operator arms to
  the set-returning `regexp_matches` form, requires all ten fixtures by name, and asserts that
  `actor_dynamic_audit_sink_only` stays **isolated** — the pre-existing
  `actor_dynamic_audit_sink_forward` carries an unrelated `forward_actor()` call that satisfies the
  callable arm, which is exactly how the dynamic-sink hole survived earlier review.

### Proof

Two new DENY canaries (`actor_bare_inequality_forward`, `actor_poisoned_local_before_refusal`) and
two new ledger fixtures (`actor_dynamic_audit_sink_only`, `actor_text_cast_audit_forward`), plus an
ALLOW control (`actor_text_grouping_mode`). **Every fix mutation-tested**: disabling each one turns
its own canary red and nothing else. The static guard was mutation-tested too — adding a forwarding
call to the isolated fixture fails it with the reason stated.

Live count unchanged at 18 reported rows.
