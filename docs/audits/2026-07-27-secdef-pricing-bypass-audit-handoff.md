# Handoff — SECURITY DEFINER pricing-bypass audit (2026-07-27)

Audit and remediation COMPLETE. Fixed live 2026-07-28 by migration
`20260728182141_secdef_pricing_reads_office_only` after Mason's explicit approval.
Postflight catalog proof confirmed both in-body office-role guards and the intended
`anon`/`authenticated`/`service_role` execute grants.
The standing `pricing-secdef-role-gate` predicate returned zero rows against production
on 2026-07-28; classifier fixtures separately proved the pre-fix body is detected.

## Verdict

The premise that "20 SECDEF functions bypass the office-only restriction" is **wrong in our favor**.
18 of the 20 are already guarded. **Exactly 2 leak.**

## Verified facts (all confirmed live this session — re-verify cheaply, don't re-derive)

- Migration `20260727231652_quote_and_rate_reads_office_only` is LIVE. Confirmed via
  `supabase_migrations.schema_migrations`. `pg_policies` confirms SELECT on `quote_items`,
  `quote_versions`, `customer_application_rates`, `rebate_programs` is now
  `is_admin() OR is_sales_rep()`. `quote_sections` remains `is_active_profile()` — deliberate, leave alone.
- Exactly **20** SECURITY DEFINER functions reference those 4 tables AND have EXECUTE to `authenticated`.
  Mason's count is right.
- **18 are already guarded** with an in-body `role IN ('admin','sales_rep') AND is_active` check
  (or `require_admin_or_sales_rep()` / `is_admin() OR is_sales_rep()`).
  NOTE: a regex scan over function bodies gives WRONG answers here — three functions
  (`get_booking_settlement`, `get_open_booking_rollover`, `get_inventory_position`) use inline
  profile lookups or a helper the regex missed. **Read the bodies.**
- `enforce_quote_accepted_fully_drawn` is a **trigger** function (returns trigger), not callable as an
  RPC. It is the only one in the set with EXECUTE granted to `anon` — untidy and inconsistent with
  `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql`, but not exploitable. Optional cleanup.

## The 2 closed leaks (as found)

### 1. `compute_application_service_fee(p_service_id, p_customer_id, p_acres, p_season)` — HIGH, PROVEN
- **No role check of any kind.**
- PROVEN LIVE: impersonated a real active `driver` via
  `set_config('request.jwt.claims', json_build_object('sub', <driver_id>, 'role','authenticated')::text, true)`
  → returned `rate_per_acre_cents: 800`, `total_fee_cents: 80000`, plus `cost_per_acre_cents`
  and `total_cost_cents`. **Price AND internal cost in one response ⇒ margin is one subtraction away.**
- CONTROL (validates the method): same impersonation against `get_booking_settlement` raised
  `INSUFFICIENT_ROLE`. So the leak is real, not a test artifact.
- **No frontend caller** (`grep` across `src/` found types/tests only). Reachable only via the
  PostgREST endpoint using the field user's own JWT. The React route guard is the ONLY thing in the way.
- Reads `customer_application_rates` on the customer-override path — dormant today (table empty),
  activates the moment a per-customer rate is entered.

### 2. `get_program_completion(p_season)` — MEDIUM, latent
- **No role check.** Returns per customer: farm name, quote numbers, planned vs completed acres,
  and `invoiced_amount_cents`.
- Returns 0 rows today ONLY because the single planned quote has `season = NULL`. That is a data
  accident, not a control.
- Frontend callers: `src/pages/OfficeCockpit.tsx:599`, `src/pages/ProgramTracker.tsx:53`.
  Both routes gated `allowedRoles={['admin','sales_rep']}` in `src/App.tsx:267,274` and
  `src/lib/pagePermissions.ts`. Those 4 files verified IDENTICAL to `origin/main`.

## Live data context (why severity is what it is)

- `customer_application_rates`: **0 rows**. `rebate_programs`: **0 rows**.
  Yesterday's migration is correct forward-looking hardening but guards no actual data today.
- `application_services`: 4 rows, **0 with `cost_per_acre_cents > 0`** (margin leak latent, price leak live).
- `quote_items`: 20 rows. `quote_versions`: 3 rows.
- Active roles: admin 4, driver 2, applicator 1, **entity_recipient 2**, sales_rep 1 (+1 inactive).
  `entity_recipient` is customer-facing — exposure is 5 active non-office accounts, not just field staff.

## Applied fix

One migration, both functions:

1. **Both**: add in-body office-only guard matching the existing house pattern used by the other 18.
   Justification: these are SECURITY DEFINER by design (they legitimately read across customers), so
   RLS is bypassed on purpose and cannot be the fix. One pattern across the whole surface.
2. **`compute_application_service_fee` additionally**: `REVOKE EXECUTE ... FROM authenticated`.
   Nothing in the UI calls it, so this costs nothing and kills the direct-API route even if the grant
   is re-added later. Precedent: `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql`.

**Regression risk checked and cleared:** the only real server-side caller of
`compute_application_service_fee` is `transfer_job_to_invoice`, which already requires
admin/sales_rep itself. It is SECURITY DEFINER owned by `postgres`, so it keeps working after the
REVOKE. The applied migration's frozen comment also names `save_job`, but that is a historical
comment-only reference, not a callsite; the applied SQL remains immutable.
`get_program_completion` has **no** server-side callers.

Current ACL on both: `postgres=X | authenticated=X | service_role=X`. Owner `postgres`. Both `STABLE`.

Use `CREATE OR REPLACE` reproducing the existing body EXACTLY from `pg_get_functiondef`, inserting only
the guard — do not retype the body from memory.

## Historical pre-apply constraints (satisfied)

- The original handoff allowed a PR only. Mason later explicitly approved the separate live apply;
  the governed reviewer and proof gates passed before migration `20260728182141` was applied.
- Migration version must sort AFTER `20260727231652`.

## Branch hygiene (important)

- Primary checkout `C:\CRX_Manager` is on `claude/schema-baseline-refresh-20260727`, 10 ahead / 4 behind `origin/main`.
- Two stray files are **STAGED** (`RM` in `git status`) and are NOT ours:
  `.claude/workflows/gauntlet-sections-loop.js` and `.claude/workflows/gauntlet-sections-loop.test.mjs`
  — 370 deletions vs `origin/main`; stale pre-#252 bodies. Committing them would silently revert the
  #252/#255 fixes on main. **Branch fresh off `origin/main`** and commit with
  `git commit --only <explicit paths>`. Do not `git add -A`.
- `origin/main` head at handoff: `d787b7e0`.

## Gotchas

- `scripts/write-codex-push-proof.mjs` defaults to a 540s cap that dies on a multi-file diff
  ("timed out after 540s — no proof written"). Re-run with `--timeout 1500` before concluding Codex is down.
- The PR merge gate now scans EVERY worktree's proof dir (PR #255), so a proof minted in a linked
  worktree is discoverable. Proof validity rules unchanged (codex_ran, verdict, exact head_sha/base_sha, 30-min window).
