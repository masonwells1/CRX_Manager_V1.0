## 2026-09-02 — flag a null actor falling through to another caller-controlled parameter

Round 4 of the exact-SHA `gpt-5.6-sol` proof. One finding, and it is the correction of a
**wrong call made in round 3**.

### HIGH — `coalesce(<actor>, <other parameter>)` after a null-tolerant guard

The null-tolerant refusal is the house pattern and this change credits it:

```sql
IF p_actor_source IS NOT NULL AND p_actor_source IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```

Crediting it truncates the body at that point, which is sound only while a NULL actor is harmless.
It is not harmless when the null is backfilled from something the caller also controls:

```sql
INSERT INTO public.financial_audit_log(actor_user_id)
VALUES (coalesce(p_actor_source, p_target_id));
```

Pass `p_actor_source => NULL` and the guard passes without proving anything; the identity written to
the ledger is `p_target_id`, chosen by the caller. That is forgery, not an attribution gap.

**Round 3 declined this, on the reasoning that such a fallback "would be its own candidate row." That
reasoning was wrong.** The candidate region is the name pattern `^p_\w*by$|^p_actor|^p_user`, and
`p_target_id` does not match it — so the fallback parameter is invisible to the predicate and nothing
else reports the routine. The finding is fixed here rather than re-argued.

The arm is deliberately narrow: it fires on a fallback to another **parameter**, scanned over the
whole body rather than the pre-refusal prefix (the danger sits *after* the guard).
`coalesce(p_performed_by, auth.uid())` — the safe house pattern, four live routines — stays clear.

The round-3 disposition of the broader ask stands: a null-tolerant guard remains a truncation point.
Refusing to credit it entirely would return the sweep from 21 rows to ~31 and undo the change's
purpose. This closes the concrete exploitable shape without that cost.

### Proof

One DENY canary (`actor_null_fallback_to_other_param`) and one ALLOW control
(`actor_null_fallback_to_auth_uid`), added to both predicates. Mutation-tested: neutering the arm in
both files turns the DENY canary red and leaves every other fixture — including the ALLOW control —
unchanged. Container suite green, static guard green.

Measured read-only against the live catalog: **zero** authenticated-executable `SECURITY DEFINER`
routines coalesce an actor-shaped parameter with another parameter, so the live count is unchanged at
21. The arm costs nothing today and exists to catch the shape if it is ever written.
