## 2026-09-02 — stop narrowing the actor-forgery candidacy gate; restore base coverage for dynamic SQL

Round 2 of the exact-SHA `gpt-5.6-sol` proof, on `39a3d817f`, returned **BLOCKERS** with three more
HIGH false negatives. All three were coverage the rewrite had lost relative to `main`. Fixed.

### The pattern, named — because it is the real lesson

Two separate drafts tried to narrow candidacy by parameter type so that `p_group_by` (a text
grouping mode) would stop appearing as noise. Both were rejected as HIGH:

1. Draft 1 kept only `uuid` and user-defined types → a `p_user_id text` cast `p_user_id::uuid` into
   an attribution column left scope entirely.
2. Draft 2 added "…or the body casts it to uuid or compares it to `auth.uid()`" → still missed
   `CAST(p_user_id AS uuid)`, a text actor forwarded to a text-accepting helper, a cast performed
   inside dynamic SQL, and a plain `role … p_user_id` lookup.

Each patch looked locally reasonable and each reopened somewhere else. **This is the blocklist
failure mode already recorded in this repo: a gate built by ENUMERATING the spellings of a concept
reopens on the next spelling.** The gate is now gone. Candidacy is the region `main` defined — the
name pattern — and a static CI assertion fails if anyone reintroduces a type gate.

Cost, stated plainly: `get_profitability_report.p_group_by`, `get_sales_summary_report.p_group_by`
and `complete_delivery.p_signed_by` come back as reported rows. **Live count 18 → 21.** They are NOT
allowlisted; Mason's call was to fix the checker rather than add exceptions, and three rows of
honest noise beat a blind spot in a security control.

### HIGH — a benign visible reference switched dynamic detection off

The round-1 dynamic-sink arm required `financial_audit_log` to be absent from the *entire* lexed
body. Any unrelated visible mention re-opened the hole:

```sql
PERFORM public.financial_audit_log_probe();
EXECUTE 'INSERT INTO financial_audit_log(actor_user_id) VALUES ($1)' USING p_actor_source;
```

Global absence was the wrong question. The arm is now gated on **no credited refusal**
(`pre_refusal_src IS NOT DISTINCT FROM executable_src`), which is what actually makes the raw
correlation safe, holds regardless of how many benign references exist, and still exempts a routine
whose refusal was credited.

### HIGH — the general predicate had no raw-source fallback at all

```sql
EXECUTE 'SELECT role FROM public.profiles WHERE id = $1' INTO v_role USING p_actor_source;
```

The lexer masks the string, so `role` and the actor both vanish and no lexed arm fires — a
`SECURITY DEFINER` routine authorizing from a forgeable actor, unreported. `main` reports it.

Added a raw-source arm gated on no-credited-refusal, anchored on `USING` and bounded to 120
characters. Anchoring on `EXECUTE` instead needs a span wide enough to clear the dynamic string, and
**PostgreSQL rejects a bounded repetition above 255** — `{0,800}` fails outright with "invalid
repetition count(s)". The bound is not optional either: four unbounded raw arms timed the sweep out
against the live catalog, where `save_job` carries 69KB of raw source. Zero live rows added.

### Proof

Three new fixtures, each pinning one finding: `actor_text_role_lookup` (text actor, role lookup, no
cast anywhere), `actor_visible_probe_plus_dynamic_write` (benign visible reference beside a masked
write), `actor_dynamic_role_authorization` (authorization through dynamic SQL). Container suite
green; static CI guard updated and green; live re-measured at 21 rows.
