# Security and Permissions Audit Findings

Date: 2026-04-30
Scope: roles, route guards, page deny lists, RLS policies, elevated SQL functions, Edge Functions, and security test coverage.
Mode: Read-only audit. No app code or database code was changed.

## Executive Summary

This audit found a broader version of the same pattern from the money/inventory audit: the screen-level role checks are usually present, but some database and Edge Function paths are still too trusting once a user is logged in.

The most important issue is that several elevated database functions can create or change invoices without proving the caller is admin or sales. One normal invoice function can also create an invoice with no order or blend ticket, which directly conflicts with the repo's business rule.

The second major issue is that two field-application tables allow any authenticated user to read, insert, update, and delete rows directly. These tables hold field/application billing location and customer split data, so they should not have open CRUD policies.

The security test suite has useful guardrails, but it is incomplete. It does not cover the applicator role, jobs/application-records tables, field-application tables, or the newest field-app invoice RPCs.

## What I Checked

- Route protection in `src/App.tsx`
- Per-user page deny-list rules in `src/lib/pagePermissions.ts`
- Runtime route blocking in `src/components/auth/ProtectedRoute.tsx`
- RLS intent tests in `src/lib/rlsContracts.test.ts`
- Current RLS policy migrations for invoices, purchase orders, jobs, application records, and field-app tables
- Current `SECURITY DEFINER` function definitions for invoice, payment, purchase, delivery, inventory, job, and field-app workflows
- Edge Functions using service-role access
- Frontend service-role exposure risk

Focused tests run:
- `npm run test -- src/lib/pagePermissions.test.ts src/lib/rlsContracts.test.ts src/components/auth/ProtectedRoute.test.tsx src/components/layout/Sidebar.test.tsx src/lib/emailService.test.ts`
- Result: 5 files passed, 234 tests passed.

Not run in this pass:
- Live Supabase security advisors.
- Full E2E role testing as admin, sales_rep, driver, and applicator.
- Live database policy introspection against production.

## Findings

### P1 - Normal invoice save can create standalone invoices and lacks a role gate

Business impact: any authenticated role may be able to call the RPC directly and create or edit draft invoices without being admin/sales. The same function can insert an invoice without `order_id` or `blend_ticket_id`, which violates the repo's hard rule that invoices must link to an order or blend ticket.

Evidence:
- Repo rule: invoices must link to an order or blend ticket at `CLAUDE.md:70-75`.
- `save_invoice` is `SECURITY DEFINER` and uses only `SET search_path = public` at `supabase/migrations/20260317200000_security_audit_auth_uid_enforcement.sql:1450-1459`.
- The insert writes `customer_id`, `invoice_type`, totals, and `created_by = auth.uid()` but does not insert `order_id` or `blend_ticket_id` at `supabase/migrations/20260317200000_security_audit_auth_uid_enforcement.sql:1473-1493`.
- The function has no admin/sales role check before mutation in the audited block.
- It is granted to authenticated users at `supabase/migrations/20260317200000_security_audit_auth_uid_enforcement.sql:1584`.

Recommended fix:
- Add `auth.uid()` required, admin/sales role required, and reject any invoice payload that has neither `order_id` nor `blend_ticket_id`.
- If standalone invoices are still needed for true misc charges, make that an explicit, admin-only path with a documented source type.

### P1 - Create-invoice-from-order lacks a caller authorization gate

Business impact: direct RPC calls may create draft invoices from orders without proving the caller is admin/sales. Because the function is elevated, RLS does not protect the table mutations inside the function.

Evidence:
- `create_invoice_from_order` is `SECURITY DEFINER` at `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1062-1072`.
- The function performs idempotency and fetches the order, but no caller role check appears before invoice creation at `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1080-1102`.
- It writes `financial_audit_log` using the role for `auth.uid()`, but that is audit attribution, not authorization, at `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1130-1144`.
- It is granted to authenticated users at `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1165`.

Recommended fix:
- Add the same admin/sales actor gate used by `post_invoice`.
- Consider preventing duplicate active invoices for the same order at this layer too.

### P1 - Field-application location/split tables are open to every logged-in user

Business impact: any authenticated user can directly read and change field-application location rows and per-customer split rows. That can alter billing split evidence outside the intended invoice RPCs.

Evidence:
- `field_app_locations` policies allow all authenticated users to select, insert, update, and delete with `USING (true)` / `WITH CHECK (true)` at `supabase/migrations/20260406100000_field_app_workflow_v2.sql:28-40`.
- `field_app_location_shares` policies do the same at `supabase/migrations/20260406100000_field_app_workflow_v2.sql:55-67`.

Recommended fix:
- Restrict direct table writes to admin/sales or remove direct writes entirely and require `save_field_app_invoice`.
- Restrict reads by the parent invoice/job ownership model.
- Add RLS tests for these two tables.

### P1 - Field-app and blend-ticket invoice RPCs still lack auth gates

Business impact: direct RPC calls may create, rebuild, cancel, or mark billed field-application invoices without proving the caller is authorized.

Evidence:
- `save_field_app_invoice` is elevated at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:27-40` and performs edit/rebuild work before any auth gate at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:90-130`.
- It inserts invoices using `p_performed_by` at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:224-242`.
- `create_invoice_from_blend_ticket` is elevated at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:682-690`.
- It validates ticket status but not caller role before billing state changes at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:737-750`.
- It marks the blend ticket billed at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1018` and is granted to authenticated users at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1041`.

Recommended fix:
- Add `auth.uid()` actor matching and admin/sales role checks to both RPCs before any read/write state changes.

### P1 - Actor spoofing pattern remains in critical RPCs

Business impact: several elevated functions authorize based on a user id passed from the browser instead of first deriving the caller from the JWT. A lower-privilege user could potentially pass an admin or sales user's UUID into direct RPC calls.

Evidence:
- Correct rule: every mutating `SECURITY DEFINER` RPC should prove the actor and use safe search path/idempotency, per `CLAUDE.md:96-103`.
- Weak examples found:
  - `allocate_payment` authorizes `COALESCE(p_performed_by, auth.uid())` at `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:749-762`.
  - `save_purchase_order` checks role using `p_performed_by` directly at `supabase/migrations/20260331200001_fix_po_edit_partially_received.sql:39-44`.
  - `receive_po_items` uses `COALESCE(p_performed_by, auth.uid())` at `supabase/migrations/20260332500000_fix_receive_po_and_audit_constraints.sql:58-63`.
  - `confirm_delivery` uses `COALESCE(p_performed_by, auth.uid())` at `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:25-58`.
  - `complete_delivery` uses `COALESCE(p_performed_by, auth.uid())` at `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:43-48`.
  - `void_commission_payment` uses `COALESCE(p_performed_by, auth.uid())` at `supabase/migrations/20260332600000_fix_commission_functions_updated_at.sql:160-164`.

Recommended fix:
- Standardize all mutating RPCs on:
  - `v_actor := auth.uid();`
  - reject null actor
  - reject supplied actor mismatch
  - authorize by `v_actor`

### P1/P2 - Purchase order visibility conflicts with the security contract

Business impact: purchase orders include supplier/vendor and cost data. The UI and current RLS allow sales reps to view purchase orders, but the RLS contract test says purchase orders are admin-only because they contain supplier pricing. If sales reps should not see supplier cost, this is a data exposure issue. If they should see it, the contract test is stale and misleading.

Evidence:
- Current route guards allow sales reps into purchase orders at `src/App.tsx:189-191`.
- Current page permissions allow sales reps into Supplier POs at `src/lib/pagePermissions.ts:43`.
- Current RLS adds sales-rep select policies at `supabase/migrations/20260226200000_receiving_system_enhancements.sql:104-112`.
- Purchase order UI selects and displays `unit_cost` and `total_cost` at `src/pages/PurchaseOrders.tsx:95-135` and `src/pages/PurchaseOrders.tsx:226-229`.
- RLS contract says sales reps should have no access because POs contain supplier pricing at `src/lib/rlsContracts.test.ts:188-194` and `src/lib/rlsContracts.test.ts:626-637`.

Recommended fix:
- Decide the business rule:
  - If supplier cost is admin-only, remove sales from routes/page permissions and drop sales select policies.
  - If sales reps need PO visibility, update the contract and hide cost fields from sales.

### P2 - Applicator access is not covered by RLS contract tests

Business impact: the app now has an applicator role with real job/application permissions, but the main RLS contract test only models admin, sales_rep, and driver. This means future changes can accidentally expose job, field, chemical, or application-record data to applicators without the contract tests catching it.

Evidence:
- Docs list an applicator role at `docs/workflows/RLS_SECURITY_GUIDE.md:23-24`.
- App routes allow applicators into application records/jobs/dispatch at `src/App.tsx:205` and nearby job routes.
- The RLS contract role type only contains admin, sales_rep, and driver at `src/lib/rlsContracts.test.ts:44-48`.
- `ALL_ROLES` also excludes applicator at `src/lib/rlsContracts.test.ts:332-334`.
- The critical-table list excludes jobs, job fields, job chemicals, job applied info, application records, field-app location tables, and invoice shares at `src/lib/rlsContracts.test.ts:411-424`.

Recommended fix:
- Add applicator to the contract matrix.
- Add job/application/field-app tables to the critical table list.

### P2 - Application records are visible to every applicator, not just assigned work

Business impact: applicators can read all application records. The role description says applicators should access their own assigned jobs. Application records can include customer, field, chemical/application, weather, and compliance details.

Evidence:
- Application record select policy allows `is_applicator()` without checking `applicator_id = auth.uid()` at `supabase/migrations/20260214220000_application_records_table.sql:61-65`.
- Jobs and job detail tables use a better assigned-applicator pattern at `supabase/migrations/20260215200000_job_scheduling_tables.sql:123-130` and `supabase/migrations/20260215200000_job_scheduling_tables.sql:148-179`.

Recommended fix:
- Scope applicator reads on `application_records` to `applicator_id = (select auth.uid())`, unless there is a documented reason all applicators should see all records.

### P2 - Edge Functions using service-role need tighter per-resource checks

Business impact: Edge Functions correctly validate JWTs, but some allow broad role access while using service-role writes underneath.

Evidence:
- `process-blend-ticket` allows any admin, sales_rep, or applicator role at `supabase/functions/process-blend-ticket/index.ts:790-802`, then updates the requested blend ticket id with service-role access at `supabase/functions/process-blend-ticket/index.ts:837-847`.
- I did not find a check that an applicator owns or is assigned to that specific blend ticket before processing it.
- `send-email` allows admin, sales_rep, or driver at `supabase/functions/send-email/index.ts:51-61`, accepts arbitrary `to`, `subject`, `html`, and `email_type` at `supabase/functions/send-email/index.ts:63-75`, and sends that content through Resend at `supabase/functions/send-email/index.ts:96-128`.

Recommended fix:
- For `process-blend-ticket`, check the specific ticket relationship before service-role updates.
- For `send-email`, restrict drivers to delivery-specific email templates/recipients or remove driver access if not required.

### P2 - Many current SECURITY DEFINER functions still miss the required `public, pg_temp` search path

Business impact: this violates the repo's security rule and increases the chance of search-path bugs in elevated functions. Some of the affected functions are high-impact money/inventory functions.

Evidence:
- Repo rule requires `SET search_path = public, pg_temp` at `CLAUDE.md:96-103`.
- Safe development docs repeat that requirement at `docs/workflows/SAFE_DEVELOPMENT_RULES.md:98-107`.
- Representative current functions still missing `pg_temp`:
  - `adjust_inventory` uses `SET search_path = public` at `supabase/migrations/20260317200000_security_audit_auth_uid_enforcement.sql:879-889`.
  - `save_invoice` uses `SET search_path = public` at `supabase/migrations/20260317200000_security_audit_auth_uid_enforcement.sql:1450-1459`.
  - `create_invoice_from_order` uses `SET search_path = public, extensions` at `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1062-1072`.

Recommended fix:
- Add a migration that explicitly rewrites or `ALTER FUNCTION ... SET search_path = public, pg_temp` for active elevated functions.
- Do this after checking overloads so the fix applies to the active signatures.

## Positive Controls Confirmed

- `ProtectedRoute` blocks unauthenticated users, missing profiles, inactive profiles, wrong route roles, and denied pages at `src/components/auth/ProtectedRoute.tsx`.
- Page permission helpers fail closed for unknown page keys and admin bypass is explicit in `src/lib/pagePermissions.ts`.
- Job RLS was recently tightened so applicators cannot directly update job rows, and applied-info insert/update is scoped to assigned jobs at `supabase/migrations/20260430180000_field_app_workflow_phase5.sql:25-103`.
- `seed-admin` has production blocking and a secret header at `supabase/functions/seed-admin/index.ts:26-44`.
- `create-user` and password reset functions validate caller JWTs and check admin role before using service-role access.
- I did not find a service-role key in frontend source. The local `.env` is not tracked by Git in this workspace.

## Recommended Fix Phases

Phase 1 - Critical invoice and field-app lock-down:
- Add auth/role gates to `save_invoice`, `create_invoice_from_order`, `save_field_app_invoice`, and `create_invoice_from_blend_ticket`.
- Add invoice source validation so normal invoices cannot be created without an order or blend ticket.
- Replace open field-app table CRUD policies.

Phase 2 - Actor spoofing sweep:
- Standardize every mutating elevated RPC on JWT-derived actor checks.
- Start with payment, purchase order, receiving, delivery, commission payment, and quick delivery functions.

Phase 3 - Role contract repair:
- Decide purchase-order visibility for sales reps.
- Add applicator to RLS contract tests.
- Add jobs, job fields, job chemicals, job applied info, application records, field-app location tables, and invoice shares to the critical matrix.

Phase 4 - Edge Function resource scoping:
- Restrict service-role functions by specific resource ownership or assignment.
- Tighten driver email sending.

Phase 5 - Search path and live advisor sweep:
- Correct active `SECURITY DEFINER` search paths.
- Run live Supabase security/performance advisors and production policy introspection.

## Current Bottom Line

The next fix should not be UI polish. It should be a focused security hardening migration that closes invoice creation, field-app table RLS, and actor spoofing. Those are the paths most likely to let a logged-in but wrong-role user change billing, inventory, or audit-sensitive records.
