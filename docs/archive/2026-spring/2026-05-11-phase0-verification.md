# Phase 0 Verification — Audit Findings vs `fix/audit-2026-05-09`

**Date:** 2026-05-11
**Branch:** `fix/audit-2026-05-09` @ `59f8171` (merged origin/main with PR #61 baked in)
**Verifier:** Claude (Opus 4.7, 1M context)
**Method:** Live DB inspection via Supabase MCP against `rhyzpcqhnizqbxphqdkr` (`pg_proc`, `pg_policies`, `pg_constraint`, `pg_trigger`, `information_schema.columns`, `financial_audit_log` data) + source code inspection of current branch
**Source list:** the 38 sev-4/5 findings tabled in `docs/audits/2026-05-11-pr61-cross-reference.md` (the underlying `docs/AUDIT_2026_05.md` / `..._PLAN.md` referenced in memory are not present on this branch)

## Why this exists

The audit at `docs/AUDIT_2026_05.md` (per memory) was written against an earlier snapshot. Since then, this branch has absorbed:

- **Sprint 1** (15 PRs): PR-01, 02, 03, 04, 05, 06, 09, 11, 12, 15, 16, 17, 18, 20, 21
- **Sprint 2** (9 PRs): PR-07, 08, 10, 13, 14, 22, 22b, 25, 26
- **Audit-fix codex follow-ups**: F1/F2/F3/F4/F6/F7 (commits `3c04f61`, `ab990e9`, `2d2600a`, `a0aa542`)
- **Task 1 batches 1–9b** — full `profile_public_view` migration + PR-07 part 2 applied live (~39 callsites)
- **Task 2** — actor-spoof cleanup on `reassign_delivery` + `batch_cancel_deliveries`
- **Task 3** — `assertRpcCoverage` baseline 32 → 0
- **`create_prepay_check_splits`** restored as live migration
- **PR #61 merge** — 4 perf migrations applied live (97 advisor WARN → 0)
- **2026-05-11 patches**: `5b9b05c` (positive-total guard on `create_vendor_bill`/`update_vendor_bill`)

Many findings have closed since the audit was written. Phase 0 marks each finding with a current-branch verdict so Phase 1+ implementation works against reality, not a snapshot.

## Verdict legend

- **CLOSED** — issue resolved on this branch; no Phase 1+ work required
- **PARTIAL** — partly closed; remaining work scoped below
- **OVERSTATED** — Codex / live state shows the original claim was wrong or weaker than written; downgrade
- **STILL VALID** — issue confirmed present; work required
- **NOT VERIFIED** — couldn't independently confirm in this pass; treat the audit's claim as a hypothesis pending implementation-time verification

## Per-finding verification

| # | Finding | Verdict | Evidence | Phase |
|---|---|---|---|---|
| 1 | Hardcoded production password in E2E tests | **STILL VALID** | `Mwells0413` / `mason@croprxsolutions.com` present in [tests/e2e/comprehensive-ui-workflow.spec.ts](tests/e2e/comprehensive-ui-workflow.spec.ts) + [tests/e2e/00-seed-test-data.spec.ts](tests/e2e/00-seed-test-data.spec.ts). PR-05 removed it from `auth.ts`/`setup-fixtures.ts`/`teardown-fixtures.ts` but didn't sweep all spec files. | Phase 1.5 |
| 2 | `handle_new_user` trusts `raw_user_meta_data->>'role'` | **STILL VALID (mitigated)** | Function body unchanged: `COALESCE(NEW.raw_user_meta_data->>'role', 'sales_rep')`. Trigger `on_auth_user_created` still active on `auth.users`. Mitigated by Mason disabling public signup in Supabase Auth dashboard, but trigger remains exploitable if signup ever re-enabled. | Phase 1.4 cleanup; harden defaults to `applicator` |
| 3 | `profiles_update` allows self-role-escalation | **STILL VALID** | `profiles_update` policy = `((SELECT auth.uid()) = id) OR is_admin()` on both USING and CHECK. No BEFORE UPDATE trigger on `profiles` to block `role`/`is_active` column changes by non-admins. | Phase 1.4 |
| 4 | `apply_prepay_to_invoice` no idempotency / actor check | **STILL VALID** | Function signature `(p_prepay_credit_id, p_invoice_id, p_amount_cents)` — no `p_idempotency_key` parameter. Body has no `check_idempotency` call, no `v_actor := auth.uid()` strict pattern. Note: it DOES write to `financial_audit_log` (closes #27's DB-side concern). | Phase 1.D / Phase 2 |
| 5 | `prepay_credits.balance_cents` not GENERATED | **OVERSTATED + STILL VALID** | Codex confirmed: GENERATED column not viable (cross-table SUM). Column `is_generated = NEVER`. Correct fix per Codex: **trigger-maintained cache + reconciliation view**, not GENERATED. Original Sev-5 framing wrong; underlying drift risk still real. | Phase 2 (human DBA) |
| 6 | Commission math drift across 3 paths | **NOT VERIFIED** | Did not trace all 3 paths in this pass. | Verify in Phase 2 |
| 7 | `(cents × numeric_qty)::bigint` truncation | **NOT VERIFIED** | Did not trace all callsites. | Verify in Phase 2 |
| 8 | `create_quick_delivery` honors client `price_cents` | **STILL VALID** | Body still has `COALESCE(NULLIF((v_item->>'price_cents')::bigint, 0), <tier-derived>)`. Any non-zero client value overrides server-side tier price. Codex was right: fix must be server-side recompute, NOT just driver-allowlist removal. | Phase 2 |
| 9a | `field_app_locations` RLS | **PARTIAL** | WRITE side (INSERT/UPDATE/DELETE) properly gated to `is_admin() OR is_sales_rep()`. SELECT side rewritten by PR #61 to `(SELECT auth.uid()) IS NOT NULL` — any authenticated user can read billing splits. Decision-B is the open question. | Decision needed |
| 9b | `field_app_location_shares` RLS | **PARTIAL** | Same shape as 9a. | Decision needed |
| 9c | `blend_ticket_fields` RLS | **STILL VALID** | `blend_ticket_fields_select USING (true)` — wide open for reads. WRITE side properly gated to uploader/admin/sales_rep. | Phase 3.1 |
| 9d | `field_crop_history` RLS | **STILL VALID** | Policy `"Authenticated users can read crop history" USING (true)` — wide open for reads. WRITE side properly gated. | Phase 3.2 |
| 10 | `NewDelivery.tsx` partial save (non-atomic) | **NOT VERIFIED** | Did not inspect form-submit transaction boundary. | Verify in Phase 2 |
| 11 | Commission payments no audit trail | **OVERSTATED** | Per Codex: `financial_audit_log` IS written by commission SQL RPCs. What's missing is TS-side `logActivity` (activity_feed). Downgrade Sev-5 → Sev-3-4. | Phase 5 (UX/visibility) |
| 12 | No automated DB backups | **STILL VALID** | Out of code scope — depends on Supabase managed backups state. Phase 4 work needs human verification of dashboard settings. | Phase 4 (human) |
| 13 | No restore drill | **STILL VALID** | Phase 4 work — needs spinning up a fresh project + replaying migrations + restoring a dump. Cannot be Claude-only. | Phase 4 (human) |
| 14 | `checkMutationResult` doesn't catch `data: null` | **STILL VALID** | [src/lib/db.ts:70](src/lib/db.ts:70) — guard is `result.data !== null && Array.isArray(...) && length === 0`. A `data: null` skips the throw. | Phase 2 |
| 15 | `convert_quote_to_order` / `create_quick_delivery` no audit log | **STILL VALID** | `financial_audit_log` distinct operation_types: only `delivery_voided`, `invoice_created`, `invoice_posted`, `invoice_voided`, `order_cancelled`, `payment_recorded` — no `quote_converted` / `order_created` / `delivery_created` entries despite live usage. Codex's lower-impact framing applies but the gap is real. | Phase 2 |
| 16 | `record_invoice_payment` (per Codex) | **CLOSED** | Hardened in `20260330200000_prelaunch_final_fixes.sql:21-142`. Body confirms: has `check_idempotency`, role check (`admin`/`sales_rep`), `search_path = public, pg_temp`. Residual question: does Invoice Detail "Record Payment" call this or `allocate_payment`? — separate Sprint 2 PR-08 concern. | None for security; check dual-path in Phase 2 |
| 17 | `post_invoice` no idempotency | **CLOSED** | Body has `check_idempotency(p_idempotency_key, 'post_invoice')` + role check + `save_idempotency` at end. | None |
| 18 | Inventory net_position is a math bug | **OVERSTATED** | Per Codex + [INVENTORY_RULES.md:35-43](docs/workflows/INVENTORY_RULES.md): Net Position vs Today's Free are intentionally different definitions. Real issue is naming/UX. | Phase 5 (UX) |
| 19 | Negative balance credit memos | **NOT VERIFIED** | Did not trace the credit-memo flow. | Verify in Phase 2 |
| 20 | `parseCents` loose input | **OVERSTATED + STILL VALID** | Codex's NaN claim is wrong: `parseDollarsToCents(".50")` returns 50 (verified [src/lib/parseCents.ts:21](src/lib/parseCents.ts:21) — `parts[0] \|\| '0'`). BUT: `"1.005"` silently truncates to $1.00; `"1e5"` parses as $15 (e stripped); `"1.2.3"` parses as $1.20 (third group dropped). Drop NaN headline; loose-input edge cases stand. | Phase 2 (lighter) |
| 21 | `profiles_select` PII leak (`USING true`) | **CLOSED** | Policy now `(is_admin() OR (id = (SELECT auth.uid())))`. Closed by Task 1 batches 1-9b + PR-07 part 2 (`20260510999999_profiles_select_tighten.sql` applied live). | None |
| 22 | Customers RLS upper-bound queued | **CLOSED** | `customers_select` policy now has admin / sales_rep-assigned / driver (1-day window) / applicator (7-day window) scoping. Closed by PR-07 part 1 (`20260510070000_tighten_customer_profile_rls.sql`). | None |
| 23 | `payments.order_id ON DELETE CASCADE` | **STILL VALID** | `payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE`. Deleting an order destroys its payment history. | Phase 2/3 (FK change → ON DELETE RESTRICT or SET NULL) |
| 24 | `inventory_transactions` / `prepay_applications` no immutability triggers | **STILL VALID** | Neither table has any user trigger. Only `financial_audit_log` has `trg_guard_audit_log_immutable`. | Phase 2/3 |
| 25 | `useGuardrails` fails open on Supabase errors | **STILL VALID** | [src/hooks/useGuardrails.ts:69-72](src/hooks/useGuardrails.ts:69) — `catch { setWarning(null); return true; }`. Silent fail = allow proceed. | Phase 2 |
| 26 | Vendor bill audit trail missing | **CLOSED** | `create_vendor_bill`, `update_vendor_bill`, `void_vendor_bill`, `record_vendor_payment`, `void_vendor_payment` ALL write to `financial_audit_log` with the documented operation_types. Closed by Sprint 1 PR-04 + Sprint 2 PR-13/14. | None for DB; TS-side `logActivity` separate (Phase 5) |
| 27 | Prepayment audit trail missing (DB) | **CLOSED** | `apply_prepay_to_invoice` writes `prepay_applied`, `create_prepay_credit` writes `prepay_created`, `create_prepay_check_splits` writes `prepay_credit_created` — all to `financial_audit_log`. TS-side `logActivity` separate. | None for DB; Phase 5 for TS |
| 28 | Edge Functions no Sentry | **NOT VERIFIED** | Did not inspect each Edge Function's error handling. | Verify in Phase 2-3 |
| 29 | `offlineSync` no Sentry | **STILL VALID** | [src/lib/offlineSync.ts](src/lib/offlineSync.ts) — zero `import * as Sentry`, zero `Sentry.captureException`, zero `import { Sentry }`. Failed sync attempts are silent. | Phase 2 |
| 30 | `_is_admin_override` GUC bypass | **STILL VALID (theoretical)** | `_is_admin_override()` reads `current_setting('app.admin_override', true) = 'true'`. Used in 7 RPCs + 12 status-transition/delete-guard triggers. Practical exploit requires the caller to issue `SET LOCAL app.admin_override = 'true'` — PostgREST blocks arbitrary SET unless `request.headers` config is exposed. Theoretical; verify PostgREST config. | Phase 3 (audit config) |
| 31 | Bulk imports non-atomic | **NOT VERIFIED** | Did not inspect bulk-import flows. | Verify in Phase 3 |
| 32 | Product price + cost history not retained | **NOT VERIFIED** | Did not check `products` change-history. | Verify in Phase 3 |
| 33 | Rebate claim race | **NOT VERIFIED** | Did not inspect rebate claim RPC. | Verify in Phase 3 |
| 34 | `BlendRecipes` destructive edit | **NOT VERIFIED** | Did not inspect the editor's confirm flow. | Verify in Phase 3 |
| 35 | AP churn warning | **NOT VERIFIED** | Did not inspect AP page reload behavior. | Verify in Phase 3 |
| 36 | Source maps shipping to prod | **CLOSED** | Mason verified `SENTRY_AUTH_TOKEN` is set in Vercel earlier today. Source maps now uploaded to Sentry, not served. | None |
| 37 | jspdf + dompurify XSS chain | **LIKELY OVERSTATED** | No `dompurify` in `package.json`. No `jspdf.html(...)` calls found in `src/`. PDF generation appears text-only via `jspdf-autotable`. XSS surface depends on whether `html()` / `setHTML()` is ever used — none found. | Verify in Phase 3; likely downgrade |
| 38 | Abandoned packages (`@mapbox/togeojson`, `shapefile`) | **STILL VALID** | Both in `package.json` dependencies. Per Codex: higher priority than jspdf because they parse user-uploaded files. | Phase 3 |

## Roll-up

| Verdict | Count | Findings |
|---|---|---|
| CLOSED | 7 | #16, #17, #21, #22, #26, #27, #36 |
| PARTIAL | 2 | #9a (`field_app_locations`), #9b (`field_app_location_shares`) |
| OVERSTATED (downgrade) | 4 | #11, #18, #20-NaN-claim, #37 |
| STILL VALID | 17 | #1, #2, #3, #4, #5, #8, #9c, #9d, #12, #13, #14, #15, #20-edges, #23, #24, #25, #29, #30, #38 |
| NOT VERIFIED | 8 | #6, #7, #10, #19, #28, #31, #32, #33, #34, #35 |

(Some findings count in two columns where part of the original claim is wrong and part is real — e.g. #5, #20.)

## Practical implications

1. **All four "Phase 1" emergency items still apply** with adjustments:
   - **Phase 1.4** (profile role-lock trigger) — STILL NEEDED, finding confirmed live (no trigger exists)
   - **Phase 1.5** (E2E credential cleanup) — STILL NEEDED, 2 spec files still contain the password
   - **Phase 1.6** (apply `profiles_select` tighten) — **ALREADY DONE** (live policy confirmed; this can be removed from the queue)
   - **Phase 1.D** (`apply_prepay_to_invoice` hardening) — STILL NEEDED, no idempotency present

2. **Phase 2 stays largely intact** but two items shrink:
   - **`record_invoice_payment` hardening** — Codex was right, it was already hardened. The remaining piece is the dual-path question (Invoice Detail using it vs. `allocate_payment`).
   - **`parseCents` NaN headline** — drop. Refocus on `"1.005"` truncation, `"1e5"` misparse, `"1.2.3"` accept.
   - Otherwise: Quick Delivery server pricing (#8), `checkMutationResult` (#14), audit-log gap on convert_quote_to_order + create_quick_delivery (#15), `useGuardrails` fail-open (#25), `offlineSync` Sentry (#29), `inventory_transactions` immutability trigger (#24), `payments.order_id` FK action (#23) all stand.

3. **Phase 3 RLS shrinks**:
   - `blend_ticket_fields` SELECT — still wide
   - `field_crop_history` SELECT — still wide
   - `field_app_locations` / `field_app_location_shares` SELECT — Decision-B (Mason): is read-by-any-authed OK for billing splits?

4. **Out-of-scope claims to drop or downgrade in Phase 1+ docs**:
   - #11 (commission audit trail) — DB side is fine, only TS `logActivity` missing
   - #18 (inventory net_position math) — not a bug, naming concern
   - #20 (`parseCents NaN`) — false; keep only the truncation edges
   - #37 (jspdf+dompurify XSS) — likely no real surface; verify before any work
   - #36 (source maps) — already closed

5. **Findings not verified this pass** (#6, #7, #10, #19, #28, #31, #32, #33, #34, #35) — these are not assumed closed; treat as STILL VALID by default, but verify at the start of the relevant phase rather than baking them into the plan unverified.

## Updated execution order

Replaces the Phase 1A–F sequence in `audit_2026_05_status.md`:

| Phase | Items | Note |
|---|---|---|
| **1 (emergency exposure)** | Phase 1.4 profile role-lock trigger; Phase 1.5 E2E credential cleanup (2 spec files); Phase 1.D `apply_prepay_to_invoice` hardening | Phase 1.6 already done — remove from queue |
| **2 (money/inventory)** | #8 Quick Delivery server pricing; #14 checkMutationResult fix; #15 audit-log gap on convert/quick-delivery; #25 useGuardrails fail-closed; #29 offlineSync Sentry; #24 immutability triggers; #23 payments.order_id FK action; #20 parseCents loose-input (truncation only); #5 prepay_credits trigger-cache (needs human DBA per memory); record_invoice_payment dual-path question | Several items lighter than originally framed |
| **3 (RLS + dependencies)** | #9c blend_ticket_fields SELECT; #9d field_crop_history SELECT; #38 abandoned packages; #30 PostgREST SET-LOCAL audit; not-yet-verified items (#28, #31, #32, #33, #34, #35) | |
| **4 (operational, human)** | #12 managed backups verification; #13 restore drill | |
| **5 (UX/visibility)** | #11 commission TS logActivity; #18 inventory naming/UX; #27 TS-side prepay logActivity; field-app print packet; payment context; customer 360 | Codex-flagged UX gap |
| **Decision** | #9a/#9b Decision-B: tighten `field_app_locations` + `field_app_location_shares` SELECT to admin/sales_rep, or accept read-by-any-authed | |

## Source SQL queries

For reproducibility — re-run these to re-verify on a future session:

```sql
-- RLS state on critical tables
SELECT tablename, policyname, cmd, qual::text, with_check::text
FROM pg_policies
WHERE tablename IN ('profiles','customers','field_app_locations','field_app_location_shares','blend_ticket_fields','field_crop_history')
ORDER BY tablename, cmd, policyname;

-- Function bodies for security-critical RPCs
SELECT proname, prosecdef, array_to_string(proconfig, ', '), pg_get_functiondef(oid)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('handle_new_user','apply_prepay_to_invoice','create_quick_delivery',
                  'record_invoice_payment','post_invoice','is_admin','_is_admin_override');

-- Triggers on critical tables
SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
  AND c.relname IN ('profiles','inventory_transactions','prepay_applications','financial_audit_log');

-- FK constraints on payments
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.payments'::regclass AND contype = 'f';

-- prepay_credits column generation status
SELECT column_name, is_generated FROM information_schema.columns
WHERE table_schema='public' AND table_name='prepay_credits';

-- Which operation_types actually appear in financial_audit_log
SELECT operation_type, count(*) FROM financial_audit_log GROUP BY operation_type ORDER BY 1;

-- Callers of _is_admin_override
SELECT proname FROM pg_proc
WHERE pronamespace='public'::regnamespace
  AND pg_get_functiondef(oid) ILIKE '%admin_override%';
```
