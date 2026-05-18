# Audit Sprint 2026-05-09 — Phase 2 + Phase 3 Closure

**Date:** 2026-05-12
**Branch:** `fix/audit-2026-05-09`
**Mode:** Autonomous single-session execution, paused only at genuine decision points
**Prior tracking:** `2026-05-09-execution-summary.md` (sprint 1 + 2), `2026-05-11-phase0-verification.md` (38-finding verdicts)

## What landed this session

### Phase 1 finalization (1 live apply)

Phase 1.4 (`profile role-lock trigger`) and Phase 1.D (`apply_prepay_to_invoice` hardening) were already live (verified via pg_proc inspection on session start). The **vendor_bill positive-total guard** from commit `5b9b05c` had only landed on `create_vendor_bill` — `update_vendor_bill` was still missing the `v_new_total_cents <= 0` recheck after applying `p_adjustment_cents`. Re-applied `20260511030000_vendor_bill_positive_total_guard.sql` via Supabase MCP. Both functions now have the recheck.

### Phase 2 — money/inventory (9 items, all closed)

| # | Finding | Fix |
|---|---|---|
| **#14** | `checkMutationResult` misses `data: null` | `src/lib/db.ts` now throws when `data === null` or `undefined` (the silent RLS denial case for `.select()` chains). Test updated in `src/lib/db.test.ts` to assert new behavior + new test for `undefined`. |
| **#25** | `useGuardrails` fails open | `src/hooks/useGuardrails.ts` — both `useCreditLimitCheck` + `useOverloadedDriverCheck` now `Sentry.captureException` and return `false` (block) on caught errors. Caller gets an explicit "could not verify" warning instead of silent pass-through. |
| **#29** | `offlineSync` no Sentry | `src/lib/offlineSync.ts` wraps the per-action catch with `Sentry.captureException` (level=error on permanent fail, warning on retry). Tags: `source: offlineSync, operation, actionId, retryCount`. |
| **#20** | `parseCents` loose-input edges | `src/lib/parseCents.ts` rejects scientific notation (`"1e5"` was parsing as $15) and multi-dot input (`"1.2.3"` was parsing as $1.20). `1.999` → 199 (truncation) preserved per existing test. New regression tests for both edges. |
| **#8 + #15** | Quick Delivery client price override + audit-log gap | Migration `20260512000000` — `create_quick_delivery` always uses server tier price; both QD and `convert_quote_to_order` write `financial_audit_log`. `financial_audit_log_operation_type_check` extended with `order_created`, `delivery_created`, `quote_converted`. |
| **#24** | No immutability triggers on ledger tables | Migration `20260512010000` — `inventory_transactions` blocks UPDATE+DELETE (zero callers existed). `prepay_applications` blocks UPDATE only (`void_invoice` still DELETEs rows; audit-log preserves evidence). Bypass: `SET LOCAL app.bypass_ledger_immutability = 'true'`. |
| **#23** | `payments.order_id ON DELETE CASCADE` | Migration `20260512020000` — switched to `ON DELETE RESTRICT`. Verified safe (zero raw `DELETE FROM orders` callers). |

### Phase 3 — RLS + deps (4 items, all addressed)

| # | Finding | Outcome |
|---|---|---|
| **#9c** | `blend_ticket_fields_select USING (true)` | Migration `20260512030000` — matches INSERT/UPDATE EXISTS predicate (uploader/admin/sales_rep via parent `blend_tickets`). |
| **#9d** | `field_crop_history` permissive `USING (true)` policy | Migration `20260512030000` — dropped `"Authenticated users can read crop history"`, replaced with `field_crop_history_select USING (is_admin() OR is_sales_rep() OR is_applicator())`. Applicators retained for field-app workflow needs. |
| **#30** | `_is_admin_override` GUC bypass (theoretical) | **CLOSED.** Three RPCs use `SET LOCAL app.admin_override = 'true'` — all literal values, no user input flows in. `pgrst.db_pre_request` not configured. No PostgREST injection vector. |
| **#38** | Abandoned packages (`shapefile`, `@mapbox/togeojson`) | **Deferred with documentation.** `src/lib/fieldImportParser.ts` has a SECURITY block noting the deferral, replacement candidates (`shpjs`, `@tmcw/togeojson`), and the bounded risk surface (admin-gated route, 500-feature cap, client-side only). Tracked as future dependency-maintenance PR. |

### NOT-VERIFIED findings — triage report

Subagent investigation of the 10 originally-NOT-VERIFIED items:

| # | Verdict | Evidence |
|---|---|---|
| #6 — Commission math drift | STILL VALID | Migration `20260217210000_commission_payments.sql:143–150` vs `src/pages/CommissionPayments.tsx:49–50` — no integrity validation across paths |
| #7 — `::bigint` truncation | STILL VALID | `src/lib/reconciliation.ts:14` explicitly tolerates ±1 cent drift, indicating known precision loss |
| #10 — NewDelivery non-atomic | STILL VALID | `src/pages/NewDelivery.tsx:367–402` — delivery insert + items insert in separate calls, no transaction |
| #19 — Negative balance credit memos | STILL VALID | `src/pages/AccountsPayable.tsx:31–65` reduces aging buckets with no negative-prevention |
| #28 — Edge Functions Sentry | PARTIAL | `_shared/sentry.ts` returns `false` on DSN-parse failure, suppressing alerts silently; `send-email` does have Sentry capture |
| #31 — Bulk imports non-atomic | STILL VALID | `BulkOrderImport.tsx:304–381` — loop inserts orders, then items, separately, no transaction |
| #32 — Product price + cost history | STILL VALID | `cost_history` logs OLD/NEW but no transaction linkage to orders that used the price |
| #33 — Rebate claim race | STILL VALID | `rebate_claims` lacks UNIQUE on claim_number, no `SELECT FOR UPDATE` locking |
| #34 — BlendRecipes destructive edit | STILL VALID | `src/pages/BlendRecipes.tsx:222–239` — DELETE items then INSERT fresh, no transaction wrapper |
| #35 — AP churn warning | STILL VALID | `AccountsPayable.tsx:31–54` re-fetches entire summary + aging on every state change |

**Cluster observation:** #10, #31, #34 all share the same fix pattern: wrap the multi-step UI logic into a SECURITY DEFINER RPC for atomicity. Worth grouping into one follow-up PR.

**Highest residual risk:** #33 (concurrent rebate-claim approval can race past eligibility check). Recommend prioritizing.

## Live verification (Supabase MCP)

All confirmed against `rhyzpcqhnizqbxphqdkr`:

- ✅ `_guard_profile_role_lock` exists; `trg_guard_profile_role_lock` active on `profiles`
- ✅ `apply_prepay_to_invoice` signature: `(uuid, uuid, bigint, uuid, text)`, single overload
- ✅ `update_vendor_bill` body contains `bill total must be positive` (post-adjustment guard)
- ✅ `create_quick_delivery` body no longer matches `NULLIF\(\(v_item->>''price_cents''\)`
- ✅ `create_quick_delivery` writes `'order_created'` + `'delivery_created'`
- ✅ `convert_quote_to_order` writes `'quote_converted'`
- ✅ `financial_audit_log_operation_type_check` includes the three new tokens
- ✅ `trg_guard_inventory_transactions_immutable` active (UPDATE OR DELETE)
- ✅ `trg_guard_prepay_applications_immutable` active (UPDATE only)
- ✅ `payments_order_id_fkey` `ON DELETE RESTRICT`
- ✅ `blend_ticket_fields_select.qual` is the EXISTS predicate (not `true`)
- ✅ Old `"Authenticated users can read crop history"` policy dropped; new `field_crop_history_select` policy exists

## Build state

- `npm run lint` — 0 errors
- `npm run typecheck` — 0 errors
- `npm run build` — clean (13.98s, 552 KB main bundle)
- `npm run test` — 1,894 passing / 70 skipped / 0 failing (added 6 new tests this session: 4 parseCents edges + 2 db.test changes)
- Branch: 65 commits ahead of `main`
- Schema registry regenerated (`generated_at = 2026-05-12`)

## Remaining work

### Pending Mason input

- ~~**Decision-B (#9a/#9b)**~~ — **CLOSED 2026-05-12.** Mason chose Option C (`is_admin() OR is_sales_rep() OR is_applicator()`). Migration `20260512040000` applied live.
- ~~**#5 (`prepay_credits.balance_cents`)**~~ — **CLOSED 2026-05-12.** Mason approved Option A (trigger-maintained cache). Migration `20260512050000` applied live. Drift check on session start showed 0 mismatches in 0 rows — clean install with no baseline reconciliation needed.

### Phase 4 (operational, needs human)

- **#12** — verify Supabase managed backups configuration in dashboard
- **#13** — restore drill (spin up fresh project, replay migrations, restore dump)

### Phase 5 / next sprint

The 8 confirmed-STILL-VALID NOT-VERIFIED findings, plus:

- **#11** commission TS-side `logActivity` (DB side already writes `financial_audit_log`)
- **#18** inventory `net_position` naming/UX
- **#27** TS-side prepay `logActivity`
- **#38** actual abandoned-package swap (separate from this session's deferral note)

### Blocked

- **PR-23** (E2E staging Supabase) — still blocked on Mason creating `crx-manager-staging` project

## Files touched

**Migrations (4 new + 1 re-applied):**
- `supabase/migrations/20260511030000_vendor_bill_positive_total_guard.sql` (re-applied; previously half-applied)
- `supabase/migrations/20260512000000_quick_delivery_server_pricing_and_audit_log.sql`
- `supabase/migrations/20260512010000_immutability_triggers_ledger_tables.sql`
- `supabase/migrations/20260512020000_payments_order_fk_restrict.sql`
- `supabase/migrations/20260512030000_tighten_blend_ticket_field_crop_history_rls.sql`

**Frontend (5 files):**
- `src/lib/db.ts` — tightened `checkMutationResult` null guard
- `src/lib/db.test.ts` — updated tests for new behavior + new `undefined` case
- `src/hooks/useGuardrails.ts` — fail-closed on errors + Sentry capture
- `src/lib/offlineSync.ts` — Sentry capture for failed action sync
- `src/lib/parseCents.ts` — reject scientific notation + multi-dot
- `src/lib/__tests__/parseCents.test.ts` — new regression tests
- `src/lib/fieldImportParser.ts` — security note on abandoned packages deferral

**Docs:**
- `CLAUDE.md` — current state (counts, advisor state, audit sprint status)
- `docs/CHANGELOG.md` — 2026-05-12 entry
- `docs/reference/migration-history.md` — migrations 309–312 + note on 302 re-apply
- `docs/audits/2026-05-12-execution-summary.md` — this doc

## Why these were safe to land autonomously

Each fix has one of:
- **Live verification** that the new behavior is correct (DO-blocks in migrations + pg_proc inspection post-apply)
- **Test coverage** that asserts the new behavior (parseCents edges, checkMutationResult null, db.test updates)
- **Build + lint + typecheck** clean across the full repo

The audit's Phase 0 verification doc explicitly mapped each finding to STILL VALID + an evidence-backed scope, so the work was specification-driven rather than judgment-driven. Decision-B and Phase 4 items are the points where judgment is required and were correctly deferred to Mason.
