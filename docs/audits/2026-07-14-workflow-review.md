# Workflow & Business-Logic Review — 2026-07-14

## Verdict

**NEEDS-WORK ON LIVE UNTIL MIGRATED; FIXED LOCALLY.** The audited foundation is broadly coherent and all deterministic application checks plus all 15 original linked-production invariant predicates passed, but one dormant authorization gap existed live during the audit: a deactivated admin with an unexpired token could still use role-only commission payout RLS policies. No inactive admin profiles existed live at the time, so this was not a current incident. After reconciling with PR #127, source now preserves the no-direct-table-write hardening from `20260714180000_harden_commission_payment_creation.sql`; this branch's follow-up migration only re-emits the two remaining read policies with the active-aware, schema-qualified, single-evaluation `public.is_admin()` form and adds deterministic regression coverage. Production still needs the queued migrations applied before live has the reviewed final state.

Claude reviewed only the five retained issues, as requested. Two official wrapper attempts were blocked when Claude Opus exhausted its turn limit without returning a result; a direct structured Claude Opus recovery then confirmed all five as real with no false positives and downgraded the quote-map issue from MED to LOW. Terra and Luna performed independent internal lanes, and Sol reconciled the final implementation review.

## Scope

Routes: 92 · Navigation links: 49 · Distinct mapped RPC calls: 212 · Public tables: 122 · Lifecycles checked: 10

Method: clean `origin/main` at `a6de093f` + regenerated workflow map + direct source inspection + linked-production SELECT-only catalog and invariant queries + internal Terra/Luna review + Sol adversarial reconciliation. Every retained finding is cited.

Execution states:

- Repo freshness: **VERIFIED** — `HEAD == origin/main`, `0 behind / 0 ahead`.
- Graph, navigation, and literal frontend RPC wiring: **VERIFIED** — all 206 unique literal frontend RPC names exist live.
- Route permission and lifecycle domains/triggers: **VERIFIED**.
- RLS structure: **VERIFIED** — all 122 public tables have RLS and a policy.
- Live DB invariant sweep: **VERIFIED** — 15/15 predicates executed through the linked read-only path with zero unallowlisted violations.
- Local gates: **VERIFIED** — typecheck, lint, build, full tests, docs drift, and agent-workflow guard tests passed.
- Mutating lifecycle smoke: **UNVERIFIED BY DESIGN** — the audit was read-only and did not mutate production records.
- `db-sweeps --strict` runner path: **BLOCKED** because this worktree has no `SUPABASE_DB_URL`/`psql`; the required predicates were instead executed individually through the linked read-only Supabase CLI path.

## Findings

### BLOCKER (0)

None.

### HIGH (1)

- **Deactivated admins retain live commission payout policy access until the queued hardening is applied.** At audit time, five live INSERT/SELECT/UPDATE policies on `commission_payments` and `commission_payment_items` checked only `profiles.role = 'admin'`; the authenticated role also had corresponding table privileges. The historical disk source was `supabase/migrations/20260511050000_perf_auth_rls_initplan.sql:200-253`. This conflicted with the database-level deactivation contract and the canonical `is_admin()` helper, which requires `is_active = true` at `supabase/migrations/20260209200000_tier1_audit_fixes.sql:53-66`. Live evidence showed `inactive_admin_profiles = 0`, so the gap was dormant. After this branch merged PR #127, source-level direct table writes remain closed by `20260714180000_harden_commission_payment_creation.sql`; the remaining PR #128 remediation is the read-policy InitPlan/schema-qualified `public.is_admin()` rewrite plus a linked-live regression predicate that fails if active-profile enforcement is omitted or direct external write policies are reintroduced. Confidence: high.

### MED (1)

- **The checked-in live-RPC snapshot was ten functions behind production and its test was self-consistency-only.** `src/lib/rpcFixtureLiveDiff.test.ts` recorded 364 public function names while the refreshed live query returned 374. The ten additions were `_enforce_field_billing_defaults_sum_100`, `_guard_offline_action_receipt_insert`, `get_offline_action_review_queue`, `get_offline_action_status`, `process_offline_action`, `resolve_offline_action`, `reverse_application_record`, `run_weekly_db_backup`, `stage_offline_action`, and `stamp_job_printed`. **Fixed locally:** the snapshot is refreshed and an AST-based test now requires every literal production RPC call to exist in the checked-in live catalog.

### LOW (3)

- **The quote lifecycle diagram omitted two valid terminal states.** The SVG omitted `closed_by_application` and `closed_short`, while runtime sources agree on all nine states. Runtime behavior was correct; only the review artifact was stale. **Fixed locally:** both terminal nodes and transitions are rendered, and the generator now fails if an exact `QuoteStatus` text node is missing.

- **Prepay batch authorization differs from the documented route contract.** `/prepay-workspace` is admin-only at `src/App.tsx:285-288` and `docs/reference/pages-routes.md:45-46`, but `batch_apply_prepayments` is granted to `authenticated` at `supabase/migrations/20260506180000_guard_prepay_with_period_check.sql:156-225` and delegates to a child that intentionally accepts active admins or sales reps at `supabase/migrations/20260622040000_apply_prepay_remove_double_decrement.sql:47-56`. The child still enforces actor, active-role, same-customer, row-lock, amount, and period checks; this is therefore contract drift, not an ungated money mutator. The same carryover was previously adjudicated LOW in `docs/CHANGELOG.md:289`. **Recommendation:** either add an admin-only wrapper gate or explicitly approve and document sales-rep access.
- **The workflow map still calls a retired RPC optional cleanup.** `docs/app-workflow-map.html:373-375` mentions `create_invoice_from_delivery()`, but it was dropped by `supabase/migrations/20260617210000_drop_dead_create_invoice_from_delivery.sql:25`; `docs/reference/rpc-functions.md:70` already records the retirement. **Recommendation:** remove the obsolete prose from the map source/template.

## Local remediation status

- `20260714185129_fix_commission_admin_policies.sql` preserves PR #127's no-direct-table-write posture, re-emits only the two commission payout read policies with active-aware `public.is_admin()` InitPlan checks, and self-verifies that direct external write policies were not reintroduced. The new `commission-admin-active.sql` live predicate flags role-only or otherwise inactive-blind read policies plus any direct external write policy, and returned zero after applying the migration to a disposable clone.
- `20260714185130_gate_batch_prepay_admin.sql` enforces active-admin authorization before replay or mutation, preserves the function identity and money/idempotency behavior, and converges grants to authenticated/service-role with no anonymous access. Disposable proof: active admin succeeded; active sales rep and inactive admin were rejected with SQLSTATE `42501`.
- `20260714185631_harden_is_admin_search_path.sql` re-emits `is_admin()` with `SET search_path = public, pg_temp` and a qualified `public.profiles` reference. Read-only live proof before apply showed production already has `search_path=public, pg_temp`; the normalized live body length is 158 with MD5 `4d8dd82e752bab77bb07f98529a39b98`, matching the expected active-admin body shape before qualification.
- The quote map, stale retired-RPC prose, live-RPC snapshot, production-call coverage, and reference docs are repaired locally.
- **No production migration, deploy, push, or live data mutation was performed.**

### Separate MCP-stamped ledger follow-up corrected during remediation

Production contains `offline_action_receipts`, its staging guard, and the offline-action RPC names. A follow-up read-only check matched `supabase_migrations.schema_migrations` by `name` instead of filename prefix: this branch's two checked-in offline-action migrations are recorded as `20260714024811_offline_action_receipts` under live version `20260714171331` and `20260714070000_offline_action_receipt_stage_limits` under `20260714171800`. The live ledger also records sibling review-resolution migration name `20260714122626_offline_action_review_resolution` under `20260714172135`; that source is outside this branch. Reference docs now warn not to infer application state from filename prefixes alone; MCP applies can preserve the original filename in `name` while stamping the apply-time value in `version`.

**Tracked follow-up:** land the sibling branch that owns `20260714122626_offline_action_review_resolution` (`codex/offline-receipt-activation-guards`) so `main` can rebuild production from source without this live-only migration gap.

## Lifecycle reconciliation table

| Entity | Live CHECK | Type/schema source | Map SVG | RPC transitions | Agree? |
|---|---|---|---|---|---|
| Quote | Verified | Verified | Missing 2 terminal states | Verified | **No — map only** |
| Order | Verified | Verified | Verified | Verified | Yes |
| Delivery | Verified | Verified | Verified | Verified | Yes |
| Invoice | Verified | Verified | Verified | Verified | Yes |
| Job | Verified | Verified | Verified | Verified | Yes |
| Purchase order | Verified | Verified | Verified | Verified | Yes |
| Return | Verified | Verified | Verified | Verified | Yes |
| Rebate claim | Verified | Verified | Verified | Verified | Yes |
| Commission payment | Verified | Verified | Verified | Verified | Yes |
| Blend ticket status axes | Verified | Verified | Verified | Verified | Yes |

## Cross-entity flow status

The Quote → Order → Delivery → Invoice → Payment path and the adjacent Commission, Purchase Order, Return, Blend, and Applied Record paths had no newly confirmed runtime stall or money-identity failure in the read-only audit. Live sweeps verified actor binding, anonymous SECURITY DEFINER exposure, role gating, search paths, overloads, PL/pgSQL validity, status literals, allocation bounds, AR statement balance, commission split totals, invoice balance identity, prepay balance, and quote override survival. Mutating end-to-end transitions were not executed against production.

## Verified safe (leads checked, found correct)

- The five generated orphan-page flags are intentional bookmark-compatible redirects: `/receiving/quick`, `/integrity-report`, `/integrity-cleanup`, `/prepayments`, and `/prepay-workspace` (`src/App.tsx:219-236,280-288`; alias coverage at `src/lib/pagePermissions.test.ts:72-81`).
- `batch_apply_prepayments` does not have the previously alleged actor-forgery hole. Its child binds `auth.uid()`, requires an active allowed role, checks same-customer ownership, and locks both credit and invoice rows (`supabase/migrations/20260622040000_apply_prepay_remove_double_decrement.sql:47-85`).
- The apparent invoice balance mismatch was a bad probe that omitted the newer type-aware `credit_applied_cents` term; the generated formula is correct at `supabase/migrations/20260711021000_credit_apply_balance_lever.sql:41-45`.
- The prior `save_job_applied_record` duplicate-submit gap is closed by strict actor/request-fingerprint replay protection at `supabase/migrations/20260712120000_save_job_applied_record_payload_conflict_guard.sql:72-183`, with frontend key retention at `src/components/jobs/AppliedRecordsManager.tsx:117-121,291-307`.
- Eighteen negative-inventory rows are allowed warn/reconcile state under `docs/workflows/INVENTORY_RULES.md`, not proof of a broken invariant.
- `stamp_job_printed` exists live; its apparent absence came only from the stale snapshot finding above.

## Checks run

- `npm run generate-map` — 92 routes, 49 nav links, 212 distinct RPC calls, 113 nodes, 201 edges, 5 heuristic flags.
- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm run build` — pass.
- `npm run test -- --run` — 241 files passed; 3,419 tests passed; 117 skipped.
- `npm run check:docs` — pass; live migration count intentionally skipped by the local-only script.
- `npm run test:agent-workflows` — pass.
- Terra focused suites — 8 files / 164 tests, lifecycle/schema 3 files / 80 tests, snapshot/permissions/print 3 files / 49 tests; all pass.
- Luna contract/idempotency suite — 92/92 pass; idempotency hook assertions 19/19 pass.
- Linked-production invariant sweeps — 15/15 executed, zero unallowlisted violations.
- Linked-production RLS/catalog probes — 122/122 public tables protected; one retained inactive-admin policy finding above.

Remediation verification:

- Claude Opus issue-only structured review — all five retained findings confirmed; no false positives; quote-map severity downgraded MED→LOW.
- Changed-only SQL migration audit — 3 files, 0 violations, 0 warnings.
- Disposable Supabase clone — all three migrations compiled against a live-shaped policy set including the two pre-existing bare `is_admin()` DELETE policies; the commission predicate returned exactly five role-only violations before migration, 0 rows after migration, and then caught an intentionally bad direct-`anon` `is_admin() OR true` permissive policy; one prepay overload remained `SECURITY DEFINER` with `search_path=public, pg_temp`, authenticated/service-role access, and no anonymous access.
- Disposable authorization proof — active admin returned a successful empty batch; active sales rep and inactive admin were rejected with SQLSTATE `42501`.
- Live-vs-disk money-function proof — after removing comments and whitespace, live `batch_apply_prepayments` and the latest source body both measured 1,236 characters with MD5 `183fd1092bbf54f633aba7a2e2edd673`; the queued rewrite adds only the reviewed admin gate.
- Live-vs-source admin-helper proof — linked production returned `is_admin()` `proconfig = {search_path=public, pg_temp}`, normalized body length 158, MD5 `4d8dd82e752bab77bb07f98529a39b98`; the queued migration preserves the active-admin body and qualifies `public.profiles`.
- Fresh linked-production RPC query — 374 distinct public function names; all ten snapshot additions verified live.
- Hardened RPC snapshot test — 9/9 pass; 206 literal production RPC calls covered through TypeScript AST parsing.
- Workflow-map regeneration — all nine exact `QuoteStatus` nodes covered; second generation produced an identical SHA-256.
- Full local gates after fixes — typecheck, lint, build, docs drift, agent workflows, and 241 test files / 3,420 tests passed (117 skipped).

## Before you add features — prioritized punch list

1. Apply the queued commission payout hardening so live matches source: no direct external table-write policies, active-aware `public.is_admin()` read policies, and the standing live policy regression predicate.
2. Refresh and harden the live-RPC snapshot so literal frontend calls are checked against a trusted catalog rather than a self-copied constant.
3. Generate the quote lifecycle diagram from shared status metadata, then remove the retired `create_invoice_from_delivery()` note.
