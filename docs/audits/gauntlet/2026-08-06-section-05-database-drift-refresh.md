# Section 5 — Database Drift Refresh

**Audit date:** 2026-08-06  
**Audit checkout:** `18b00e517e2f3183ad2d4382f6a5c22b12008ea8` (clean current `origin/main` at capture)  
**Live evidence captured:** 2026-08-06 04:54:48 UTC  
**Scope:** migrations on disk versus live migration ledger, schema registry versus live catalog, CHECK constraints, generated columns, overloads, and `SECURITY DEFINER` search paths  
**Mode:** read-only; no repository code, live schema, or live data changed

## Verdict

**0 BLOCKER / 0 HIGH / 0 MED / 1 LOW**

Disk, live migration history, the generated schema registry, and the live catalog aligned through migration `20260806023048`. The only finding is a prevention gap in the overload sweep: its ownership filter can hide an application function that shares a name with an extension-owned function. The live mixed-ownership probe returned zero rows, so this is latent coverage risk rather than observed drift.

## Publication refresh — 2026-08-07

This report preserves the dated August 6 audit snapshot. Before publication, `origin/main` had advanced to `b34b5ddb1968173af169eca36e7fc0496388ef86` with migrations `20260807215532_profile_role_lock_covers_insert.sql` and `20260807220323_log_customer_fact_rpc.sql`. Those migrations are outside the August 6 live packet and are not silently folded into its counts. Current-source contract checks were rerun at publication; the report remains a historical audit of the stated snapshot, not a claim that the August 6 packet proves the later schema.

## Finding

### LOW — Overload detector can suppress an application collision with an extension-owned function

`scripts/db-invariant-sweeps/predicates/overloads.sql:13-30` filters extension-owned functions out before grouping by schema and function name. If an application-owned function and an extension-owned function share a name, the extension row disappears before the group is formed, so the query may see only one remaining overload and report nothing.

The fresh live mixed-ownership probe returned **0 rows**. No present collision was found; the defect is that the standing guard would not reliably catch one later.

**Recommended fix:** group all overloads first, retain ownership metadata per member, and exclude only groups that are wholly extension-owned. Add a fixture containing one extension-owned and one application-owned overload with the same name.

## Evidence

- Migration files, the live migration ledger, and `.claude/schema-registry.json` shared the same high-water mark: `20260806023048`.
- Live migration ledger count: **943**.
- Enumerated types: **38**; no disk/registry/live mismatch found.
- Generated columns: **11**. The source scan examined **392** mutation shapes and found **0** attempted writes to generated columns.
- CHECK constraints: **300** live constraints reviewed; **113** were directly registry-parseable and **187** were complex/skipped by the registry parser. No conflicting or unvalidated CHECK constraint was found.
- `SECURITY DEFINER` functions: **458**. Accepted search paths were **445** `public, pg_temp`, **12** `public, extensions, pg_temp`, and the deliberately fully-qualified `check_period_open` exception with an empty search path. No mutable or unexpected path remained.
- `plpgsql_check` returned **0** function errors.
- No live overload collision or mixed extension/application ownership collision was found.

## Proof run

- `npm run test:schema-baseline` — passed.
- `npm run test:drift` — **235 passed / 78 skipped**; live predicates were executed separately against the captured read-only packet.
- Gauntlet loop deterministic test — passed.
- Generated-column source scan — **392 shapes / 11 generated columns / 0 writes**.
- Documentation and link checks — passed before publication.

## Limits

The official Section 5 workflow settlement tool was unavailable in this session, so the section was adjudicated manually from the current source, current generated artifacts, and a fresh read-only live packet. No claim is made that an automated settlement runner executed. The August 7 migrations noted above landed after the captured packet.

## Next section

Section 6 — idempotency and double-submit safety.
