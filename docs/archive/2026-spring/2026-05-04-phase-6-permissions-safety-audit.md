# Phase 6 — Permissions, Safety, and Roles Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. Three-layer agreement check between (a) `ProtectedRoute` route guards, (b) UI button visibility, and (c) Postgres RLS — for each role: `admin`, `sales_rep`, `driver`, `applicator`. Plus Edge-Function auth, destructive-action safety, settings access, and activity-log coverage on admin-only paths.

---

## Plain-English Summary

The good news up front: CRX Manager has the strongest permission scaffolding I would expect on a single-owner build. Every page has an explicit `allowedRoles` route guard (`src/App.tsx:166`–`src/App.tsx:234`); every database table has RLS enabled; the four sensitive Edge Functions check JWT, role, and per-resource ownership; the `idempotency_keys` table is locked to `USING (false)` so client code cannot peek; `financial_audit_log` is admin-read, append-only, and can no longer be forged by unprivileged users; and the recent Sprint F#1/F#2 hardening on `send-email` and `process-blend-ticket` is real (rate-limit, recipient lock to `customers.email`, applicator-can-only-process-own-uploads).

Where the audit found friction is mostly in the **UI layer being more permissive than RLS**, not the other way around. Examples:
- `DispatchBoard` shows the "assign applicator" dropdown to applicators themselves (`src/pages/DispatchBoard.tsx:341`–`352`). RLS will silently block their attempted assignment because `jobs_update` was tightened to admin/sales_rep only in Phase 5 (`supabase/migrations/20260430180000_field_app_workflow_phase5.sql:28`–`32`). The data layer holds, but the applicator sees a control they cannot use.
- `OrderDetail.tsx` correctly hides "Change Status" and "Void Order" from non-admins (good), but `canEdit` (`src/pages/OrderDetail.tsx:117`) lets sales_rep enter edit mode, then `orders` UPDATE is admin-only (`fix_security_and_performance_issues.sql:469`). A sales_rep can edit items in the form and hit Save — `checkMutationResult` will surface the silent RLS denial as a generic error toast. This is **safe** (no data corruption) but is a **dead-control footgun**.
- `InvoiceDetail.tsx` correctly gates Post / Void / Record Payment / Write Off on `isAdmin` (`src/pages/InvoiceDetail.tsx:747`, `:762`, `:773`, `:795`), but **none of those admin actions log to `activity_feed` from the UI layer** — they rely on the RPC writing to `financial_audit_log`. Defensible (the audit log is the money source of truth), but it does mean the team timeline misses Post/Void/Payment events.
- Two payment paths are intentional but undocumented: `/payments` (admin + sales_rep — `App.tsx:198`) and `InvoiceDetail` Record Payment (admin-only — `:773`). Sales reps CAN therefore record a payment via `/payments` calling `allocate_payment` RPC, which makes the CLAUDE.md note "Record Payment is admin-only" misleading.

There is no critical security finding (no role can do something dangerous it shouldn't). The gaps are about UX honesty, audit-trail completeness, and matrix-vs-code drift. I have written 9 findings (P6-1 through P6-9), ordered so the highest-impact fix (activity-log coverage on admin financial actions) comes first.

---

## Evidence Reviewed

| File | Why |
|---|---|
| `CLAUDE.md` | Hard red lines + the "Record Payment is admin-only" claim |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory rules — confirm/alert ban, checkMutationResult, role testing |
| `docs/workflows/RLS_SECURITY_GUIDE.md` | Three-role + applicator model and the full RLS matrix |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | Baseline; flagged dual payment paths and dispatch/applicator |
| `src/App.tsx` (full, 253 ll) | Every route's `allowedRoles=` |
| `src/components/auth/ProtectedRoute.tsx` (full) | Guard contract — session, profile, is_active, allowedRoles, deniedPages |
| `src/contexts/AuthContext.tsx` (full) | Profile fetch + Sentry user context + token-refresh handling |
| `src/lib/pagePermissions.ts` (full) | Per-user deny-list + canonical permission catalog |
| `src/components/layout/Sidebar.tsx` (582 ll) | Role-aware sidebar `roles` arrays |
| `src/pages/InvoiceDetail.tsx` (header + admin gates + handlers) | Post / Void / Record Payment / Write Off / Reverse Write Off |
| `src/pages/OrderDetail.tsx` (header + admin gates + Record Payment) | Change Status, Void Order, edit items |
| `src/pages/DeliveryDetail.tsx` (role/cap block) | isDriver / isAdminOrRep / canEdit / canCancel / canVoid |
| `src/pages/PaymentAllocation.tsx` (header + role refs) | One of two payment paths; calls `allocate_payment` |
| `src/pages/MonthEndClose.tsx` (header + activity log) | Admin-only; logs `close_accounting_period` and `reopen_accounting_period` |
| `src/pages/CommissionPayments.tsx` (role refs) | Admin-only; conditional admin column |
| `src/pages/SettingsPage.tsx` (UserPermissionsPanel) | Per-user deny-list editor — uses `pagePermissions.ts` |
| `src/pages/DispatchBoard.tsx` (full, 360 ll) | Applicator-accessible route; assignment dropdown visibility |
| `src/pages/NewDelivery.driver-guardrail.test.tsx` (full) | What's actually pinned: re-firing `checkDriverLoad` once async drivers list resolves — NOT an RBAC test. The "guardrail" name is about overload checks, not roles. |
| `supabase/functions/send-email/index.ts` (full) | JWT, role allowlist, customer-email match, driver per-resource auth, attachment caps, rate limit, idempotency |
| `supabase/functions/process-blend-ticket/index.ts` (full) | JWT, role allowlist (admin/sales_rep/applicator), per-resource auth (applicator only own uploads) |
| `supabase/migrations/20260213100000_phase2_billing_architecture.sql` (RLS section) | invoices + financial_audit_log policies |
| `supabase/migrations/20260311000003_audit_rls_fixes.sql` (full) | Closed `WITH CHECK (true)` on financial_audit_log; added 12 admin-only DELETE policies |
| `supabase/migrations/20260206174345_fix_security_and_performance_issues.sql` (orders/inventory/PO/deliveries blocks) | The "current" master RLS layout |
| `supabase/migrations/20260209040325_fix_payment_rls_policies.sql` (full) | payments: SELECT/INSERT = admin or sales_rep; UPDATE/DELETE = admin only |
| `supabase/migrations/20260210_fix_rls_critical_issues.sql` (full) | Sales-rep INSERT capabilities + universal profiles SELECT |
| `supabase/migrations/20260228320000_medium_priority_fixes.sql` (idempotency_keys block) | Locked to `USING (false)` |
| `supabase/migrations/20260215200000_job_scheduling_tables.sql` (jobs RLS) | Applicator can SELECT only assigned jobs |
| `supabase/migrations/20260430180000_field_app_workflow_phase5.sql` (full) | Phase 5: applicator UPDATE on `jobs` removed — must use `start_job`/`complete_job` RPC |

---

## Recommended Role × Action Matrix

This is the matrix I'd recommend **after** Phase 6 fixes. Where the current code disagrees, the cell shows `current → recommended`.

| Action | admin | sales_rep | driver | applicator |
|---|---|---|---|---|
| Sign in & see dashboard, notifications, team board | yes | yes | yes | yes |
| /products, /customers, /quotes, /orders, /invoices | yes | yes | no | no |
| Create / edit own quote | yes | yes | no | no |
| Convert quote to order | yes | yes | no | no |
| Edit order line items (status = confirmed) | yes | **yes (UI) → no (UI), match RLS** | no | no |
| Change order status | yes | no | no | no |
| Void order (fulfilled → voided) | yes | no | no | no |
| Cancel order | yes | no | no | no |
| Create delivery | yes | yes | no | no |
| Edit delivery (status = scheduled) | yes | yes | assigned only (RLS) — UI hides | no |
| Confirm delivery (scheduled → in_progress) | yes | yes | assigned only | no |
| Complete delivery | yes | yes | assigned only | no |
| Cancel delivery | yes | yes | no | no |
| Void delivery | yes | no | no | no |
| /payments (allocate_payment RPC) | yes | yes | no | no |
| InvoiceDetail "Record Payment" button | yes | **no (current) — keep no, but let sales_rep deep-link to /payments?invoice=…** | no | no |
| Post invoice | yes | no | no | no |
| Void invoice | yes | no | no | no |
| Write off invoice | yes | no | no | no |
| Reverse write-off | yes | no | no | no |
| Email invoice | yes | yes (per `send-email` allowlist) | yes for `delivery_completed` only | no |
| Month-End close / reopen | yes | no | no | no |
| Commission Payments | yes | no | no | no |
| Settings (incl. user mgmt + per-user deny list) | yes | no | no | no |
| Cycle Counts | yes | no | no | no |
| Accounts Payable / Vendor Bills | yes | no | no | no |
| Rebates / Integrity Report / Integrity Cleanup | yes | no | no | no |
| /jobs, /jobs/:id (read) | yes | yes | no | assigned only (jobs RLS) |
| /jobs (start/complete via RPC) | yes | yes | no | assigned only (start_job, complete_job) |
| /dispatch (read) | yes | yes | no | yes |
| /dispatch (assign applicator dropdown) | yes | yes | no | **visible (current) → hidden** (P6-3) |
| /application-records | yes | yes | no | yes |
| /deliveries list | yes | yes | yes (own) | no |
| Upload + OCR blend ticket | yes | yes | no | own uploads only |

The current code already enforces the data-layer cells correctly via RLS / RPCs. The cells in **bold** are the UI-layer corrections this audit recommends.

---

## Findings

### P6-1 — Admin financial actions don't write to `activity_feed` from UI

**Title:** Post / Void / Record Payment / Write Off don't appear in the team activity timeline.

**Business risk:** If a posted invoice is later disputed, "who posted it and when" lives in `financial_audit_log` (admin-only) and Sentry breadcrumbs — not in the team-visible activity feed. Mason has to dig into the audit log to answer "did Brian post that invoice last Tuesday?". For a 4-person team this is workable; it gets painful as soon as a sales_rep needs context about a customer's account history.

**Evidence (file:line):**
- `src/pages/InvoiceDetail.tsx:436`–`456` posts the invoice via `post_invoice` / `post_invoice_group` RPC; no `logActivity()` call. Grep for `logActivity` in `InvoiceDetail.tsx` returns only `write_off_reversed` (`:529`) and `invoice_emailed` (`:666`). Post / Void / Record Payment have no entries.
- `src/pages/PaymentAllocation.tsx` — grep returns zero `logActivity` calls; the allocate flow logs nothing to the activity feed.
- Compare `src/pages/MonthEndClose.tsx:175` (`close_accounting_period`) and `:198` (`reopen_accounting_period`) — those DO call `logActivity`. The pattern is established and used inconsistently.

**Fix direction:** Add `logActivity({ event: 'invoice_posted'|'invoice_voided'|'payment_recorded'|'invoice_written_off', performedBy: profile.id, entityType: 'invoice'|'payment', entityId, customerId })` calls right after each successful RPC return in `InvoiceDetail.tsx` (Post handler ~`:446`, Void handler ~`:466`, Pay handler ~`:493`, Write Off handler in `WriteOffModal`) and in `PaymentAllocation.tsx` after `allocate_payment` succeeds (~`:287`).

**Likely files:** `src/pages/InvoiceDetail.tsx`, `src/pages/PaymentAllocation.tsx`, `src/components/invoice/WriteOffModal.tsx` (if separate). `src/lib/activityLogger.ts` already exposes the helper.

---

### P6-2 — Two payment paths with different role rules, no in-UI signpost

**Title:** Sales reps can record a payment at `/payments` but the InvoiceDetail page hides the same action from them.

**Business risk:** A sales rep opens an invoice, sees no "Record Payment" button (it's gated by `isAdmin` on `InvoiceDetail.tsx:773`), and concludes they cannot record payments — when in fact `/payments` is open to them (`App.tsx:198`) and `allocate_payment` RPC works for both admin and sales_rep (`payments_insert` policy: `is_admin() OR is_sales_rep()`, `20260209040325_fix_payment_rls_policies.sql:29`–`32`). This is a UX trap, not a security hole. CLAUDE.md propagates the trap by stating Record Payment is admin-only.

**Evidence (file:line):**
- `src/App.tsx:198` — `path: 'payments'` allows `['admin', 'sales_rep']`.
- `src/pages/PaymentAllocation.tsx:78` + `:274` — `allocate_payment` RPC is the only mutation; no role gating in the page (relies on RLS).
- `src/pages/InvoiceDetail.tsx:72` — `const isAdmin = profile?.role === 'admin'`.
- `src/pages/InvoiceDetail.tsx:773`–`794` — Record Payment + Write Off rendered only when `!isNew && invoice.status === 'posted' && isAdmin`.
- `src/pages/OrderDetail.tsx:992` — Record Payment button on order navigates to `/payments` (no in-page modal). Good — the same pattern should apply on InvoiceDetail.

**Fix direction:** Pick one of the two:
1. **(Recommended)** Make `InvoiceDetail`'s Record Payment button render for sales_rep too, but instead of opening the in-page modal, navigate to `/payments?invoice=<id>` with the invoice pre-selected. This matches `OrderDetail` and unifies "where do I record a payment" to one screen.
2. Tighten `payments_insert` RLS to admin-only and update `/payments` route guard to admin-only. Riskier — sales reps lose a workflow they currently have.

**Likely files:** `src/pages/InvoiceDetail.tsx` (button conditional and onClick), `src/pages/PaymentAllocation.tsx` (parse `?invoice=` query param and pre-select), `CLAUDE.md` (correct the "admin-only" comment).

---

### P6-3 — DispatchBoard exposes assignment dropdown to applicators

**Title:** Applicators see and can click the "assign applicator" dropdown on every job card.

**Business risk:** An applicator opens `/dispatch`, sees a dropdown next to every job, picks themselves (or another applicator), and the UI calls `handleAssign()` (`DispatchBoard.tsx:136`). The Supabase `.update()` on `jobs.applicator_id` then hits `jobs_update` RLS, which since Phase 5 (`field_app_workflow_phase5.sql:28`–`32`) is `is_admin() OR is_sales_rep()` — the update is silently denied, but `checkMutationResult` throws "Assign applicator failed: no rows were affected. You may not have permission." The applicator sees a generic error toast and is confused.

This is the textbook "UI more permissive than RLS" symptom Mason flagged in the prompt. Not a security hole — the data layer holds. But the UI is misleading.

**Evidence (file:line):**
- `src/App.tsx:219` — `/dispatch` is `['admin', 'sales_rep', 'applicator']`.
- `src/pages/DispatchBoard.tsx:341`–`352` — applicator dropdown rendered for every job card; no role check around it.
- `src/pages/DispatchBoard.tsx:282`–`291` — applicator filter dropdown (top-of-list filter) similarly unconditional.
- `src/pages/DispatchBoard.tsx:136`–`157` — `handleAssign` updates `jobs` directly; no role check.
- RLS contract: `supabase/migrations/20260430180000_field_app_workflow_phase5.sql:28`–`32` makes `jobs_update` admin/sales_rep only.

**Fix direction:** Add `const isAdminOrRep = profile?.role === 'admin' || profile?.role === 'sales_rep';` near `:38`, then wrap the assignment dropdown (`:339`–`:352`) and the filter `select` (`:282`–`:291`) with `{isAdminOrRep && (...)}`. For applicators, render the assigned applicator name as plain text instead.

**Likely files:** `src/pages/DispatchBoard.tsx`.

---

### P6-4 — OrderDetail edit mode opens for sales_rep but `orders` UPDATE is admin-only

**Title:** Sales reps can enter "Edit Order" mode and try to save; the save silently fails at the RLS layer.

**Business risk:** Same UX-trap class as P6-3, but for orders. `canEdit` allows admin and sales_rep (`OrderDetail.tsx:117`); `orders_update` RLS is admin-only (`fix_security_and_performance_issues.sql:469`–`470`). A sales_rep edits an order, hits Save, sees a generic error toast, and either escalates or retries fruitlessly.

**Evidence (file:line):**
- `src/pages/OrderDetail.tsx:116`–`117` — `isAdmin = role === 'admin'`; `canEdit = (role === 'admin' || role === 'sales_rep') && order?.status not in (fulfilled, cancelled, partially_fulfilled)`.
- `supabase/migrations/20260206174345_fix_security_and_performance_issues.sql:469`–`470` — `orders_update` policy is `is_admin()` only.
- `supabase/migrations/20260206174345_fix_security_and_performance_issues.sql:482`–`483` — `oitems_update` is also admin-only.

**Fix direction:** Restrict `canEdit` to `role === 'admin'` and let sales_rep see read-only. If sales_rep editing of orders is desired, broaden `orders_update` AND `oitems_update` RLS to include sales_rep with `created_by = auth.uid()` ownership — but that's a real product decision, not a fix. Pick one and document.

**Likely files:** `src/pages/OrderDetail.tsx` (one line change). If broadening RLS, a new migration is required.

---

### P6-5 — `pagePermissions.ts` deny-list catalog is incomplete

**Title:** The per-user "denied pages" feature in Settings cannot restrict every page that has a route guard.

**Business risk:** Mason's per-user deny-list silently does nothing for omitted pages. The feature looks complete in Settings but cannot deny pages that aren't in the catalog.

**Evidence (file:line):**
- `src/lib/pagePermissions.ts:15`–`64` — the catalog lists 33 entries.
- `src/components/auth/ProtectedRoute.tsx:43`–`46` — `if (pageKey && !hasPageAccess(...))` short-circuits when the path doesn't match a catalog entry, meaning omitted pages skip the deny-list check entirely.
- `src/App.tsx` lazy imports vs catalog cross-check shows the following routes are NOT in the catalog (so cannot be denied for non-admins):
  - `/dispatch` — guarded for `admin/sales_rep/applicator` at `App.tsx:219` but no catalog entry. Sidebar even surfaces it (`Sidebar.tsx:151`).
  - `/prepay-workspace` — admin-only at `App.tsx:229`; not catalogued.
  - `/getting-started`, `/team-board`, `/notifications` — intentionally excluded per the comment in `pagePermissions.ts:11`–`13`. OK.
  - `/inventory` IS catalogued ✓; `/recipes` IS catalogued ✓ on second pass.
  - Sub-routes like `/accounts-payable/bills*` are correctly handled because `getPageKeyFromPath` (`pagePermissions.ts:71`–`79`) strips after the first segment, but `/dispatch` and `/prepay-workspace` are first-segment routes that still don't appear.

**Fix direction:** Audit `App.tsx` lazy imports against `PAGE_PERMISSIONS` and add entries for any route the deny-list should cover. At minimum: `dispatch` (admin+sales_rep+applicator) and `prepay-workspace` (admin). Better: drive `pagePermissions.ts` from the same data structure as `App.tsx` — declare each route once with `{ path, allowedRoles, deniable }` and have both files consume it. That refactor is a Phase 6.5/8 task.

**Likely files:** `src/lib/pagePermissions.ts` (immediate fix), possibly a new `src/lib/routes.ts` shared declaration consumed by both `App.tsx` and `pagePermissions.ts` (longer-term refactor).

---

### P6-6 — `NewDelivery.driver-guardrail.test.tsx` is mis-named — not a role guard

**Title:** The "driver-guardrail" test pins `useEffect` deps for an overload-load check; it does NOT test driver RBAC for delivery creation.

**Business risk:** Low risk; this is a documentation/expectation issue. Mason or a future agent will read the file name, expect it to pin "drivers cannot create deliveries", and move on. The actual test pins the deps array for `checkDriverLoad`. Drivers being unable to access `/deliveries/new` is enforced ONLY by `App.tsx:213` (`['admin', 'sales_rep']`); there is no regression test pinning that route guard for any role.

**Evidence (file:line):**
- `src/pages/NewDelivery.driver-guardrail.test.tsx:1`–`104` — full file. Three test cases verify `checkDriverLoad` re-fires once an async drivers list resolves; no role-related assertions.
- `src/App.tsx:213` — `'deliveries/new'` is `['admin', 'sales_rep']`. Drivers and applicators are blocked at the route layer only.

**Fix direction:** Add `src/components/auth/ProtectedRoute.test.tsx` that mounts the guard with each role mock and asserts the redirect for blocked roles + render for allowed roles, for one representative page per role-bucket. Rename `driver-guardrail` to `driver-load-check` (or move the file to `src/components/deliveries/`) so the name reflects what it actually pins.

**Likely files:** `src/pages/NewDelivery.driver-guardrail.test.tsx` (rename + maybe move) + new `src/components/auth/ProtectedRoute.test.tsx`.

---

### P6-7 — `process-blend-ticket` allows applicator OCR; UI doesn't surface it

**Title:** The Edge Function lets applicators OCR their own blend tickets, but the `/blend-tickets` page is admin/sales_rep only.

**Business risk:** Inconsistency. Today this is benign because applicators have no UI button. But an applicator with a JWT can call `process-blend-ticket` directly. If Mason later locks blend tickets to admin/sales_rep at the data layer, he must remember to update the Edge Function too.

**Evidence (file:line):**
- `supabase/functions/process-blend-ticket/index.ts:798`–`803` — role check allows `admin, sales_rep, applicator`.
- `supabase/functions/process-blend-ticket/index.ts:832`–`843` — applicator additionally gated to `uploaded_by = caller.id`.
- `src/App.tsx:184`–`185` — `/blend-tickets` and `/blend-tickets/:id` are `['admin', 'sales_rep']`.
- `src/components/layout/Sidebar.tsx:156` — Blend Tickets entry is `['admin', 'sales_rep']`.

**Fix direction:** Decide whether applicators should EVER trigger OCR. If yes, give them a route or upload entry point and update the sidebar. If no, tighten the Edge Function role allowlist to `admin, sales_rep` and remove the per-resource fallback for applicators. Document the decision in CLAUDE.md.

**Likely files:** `supabase/functions/process-blend-ticket/index.ts`, possibly `src/App.tsx` and Sidebar if granting applicator access.

---

### P6-8 — `idempotency_keys` SELECT is fully blocked — admins can't debug duplicate-submit issues

**Title:** The lockdown is correct but means even an admin cannot read the table from the SQL editor or the app to investigate "why didn't this idempotency key dedupe?"

**Business risk:** Low (debugging friction only). All RPC writes use `SECURITY DEFINER` and bypass RLS, so production behaviour is fine. But when Mason asks Claude to debug "the same payment was recorded twice", the answer "look at idempotency_keys" requires a service-role key or temporarily relaxing RLS. Worth a small admin SELECT policy.

**Evidence (file:line):**
- `supabase/migrations/20260228320000_medium_priority_fixes.sql:412`–`416` — `USING (false) WITH CHECK (false)` for ALL operations.
- `supabase/migrations/20260210000000_tier3_idempotency_and_triggers.sql:27`–`28` — table indexed on `idempotency_key` and `expires_at`, ready for queries.

**Fix direction:** Add a new migration with `CREATE POLICY idempotency_keys_admin_select ON idempotency_keys FOR SELECT TO authenticated USING (is_admin());`. Keep deny-all on INSERT/UPDATE/DELETE (only RPCs should write). Document in `RLS_SECURITY_GUIDE.md`.

**Likely files:** new migration `supabase/migrations/<date>_idempotency_keys_admin_select.sql`, plus a sentence in `docs/workflows/RLS_SECURITY_GUIDE.md`.

---

### P6-9 — `invoices_select` RLS is stricter than the doc says

**Title:** Sales reps see only their own invoices (created_by or salesman_id), not all invoices as documented.

**Business risk:** Moderate — risk runs the **opposite** direction from what one expects. The reference doc (`RLS_SECURITY_GUIDE.md:169`) tells Mason that sales reps see all invoices. In reality (`20260213100000_phase2_billing_architecture.sql:256`–`261`) they see only their own. A future "sales rep dashboard" page will appear empty under one rep's session and Mason will hunt for the wrong bug.

**Evidence (file:line):**
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql:256`–`261` — `invoices_select` is `is_admin() OR created_by = auth.uid() OR salesman_id = auth.uid()`.
- `docs/workflows/RLS_SECURITY_GUIDE.md:169` — "invoices: SELECT: Admin / Sales Rep" with no qualifier.
- `docs/workflows/RLS_SECURITY_GUIDE.md:151` — `quotes` correctly documented with ownership; invoices should mirror that.
- `invoice_items_select` (`:276`–`:283`) inherits the parent invoice rule via `EXISTS`. Consistent.

**Fix direction:** Update `RLS_SECURITY_GUIDE.md` and `docs/reference/database-schema.md` to read: "Admin / Sales Rep (own — created_by or salesman_id)". No code change. Doc-only fix; do alongside `/update-docs`.

**Likely files:** `docs/workflows/RLS_SECURITY_GUIDE.md`, `docs/reference/database-schema.md`.

---

## What's Already Working — Do Not Undo

These patterns are strong and should be preserved through Phases 6–8.

1. **`ProtectedRoute` is the single source of truth for route guards.** `src/components/auth/ProtectedRoute.tsx:24`–`46` checks session → profile → `is_active` → role → per-user deny list, in that order. Every routed page wraps its element in this guard. Loading state (`:16`–`:22`) prevents brief flashes of restricted content.

2. **`AuthContext` correctly retries profile fetch and handles token-refresh without re-mounting pages.** `src/contexts/AuthContext.tsx:38`–`58` retries 3× with backoff; `:73`–`:101` distinguishes `TOKEN_REFRESHED` (no loading state) from `SIGNED_IN`/`SIGNED_OUT`. Without that, a user mid-form would lose unsaved data on every silent refresh. Excellent.

3. **`is_active = false` blocks login.** `ProtectedRoute.tsx:34`–`36` redirects deactivated users to `/login` even with valid JWT. JWTs don't auto-revoke, but the gate catches it on next request.

4. **Sidebar role-gating uses the same `pagePermissions.ts` helpers as the route guard.** `src/components/layout/Sidebar.tsx:216`–`229` calls `hasNavAccess` which delegates to `hasPageAccess`. So when a deny-listed page is removed from the sidebar, it's also unreachable via the route. Two layers, one decision.

5. **`financial_audit_log` is admin-read, append-only, and the `WITH CHECK (true)` hole was closed in March 2026.** `20260311000003_audit_rls_fixes.sql:25`–`31`. Combined with the absence of UPDATE/DELETE policies, the audit trail is genuinely tamper-evident.

6. **`idempotency_keys` is locked at `USING (false)`** (`20260228320000_medium_priority_fixes.sql:412`–`416`). Only `SECURITY DEFINER` RPCs touch it; clients have zero direct access. (See P6-8 for the small admin-read addition I'd recommend.)

7. **`send-email` Sprint F#1 lockdown is real.** `supabase/functions/send-email/index.ts:46`–`78` (allowlists), `:104`–`:115` (role lookup), `:153`–`:174` (recipient must equal `customers.email`), `:176`–`:205` (driver per-resource auth: assigned to delivery + delivery customer matches), `:207`–`:231` (5 file / 10 MB cap), `:232`–`:248` (50 emails per rolling hour per user), `:250`–`:266` (idempotency replay). This is the model other Edge Functions should copy.

8. **`process-blend-ticket` Sprint F#2 per-resource auth is enforced before any service-role mutation** (`:820`–`:843`). The function refuses to even queue a ticket the caller cannot touch.

9. **`jobs_update` Phase 5 hardening is in place.** `20260430180000_field_app_workflow_phase5.sql:28`–`32` removed the privilege escalation that let an assigned applicator change `total_price_cents` or reassign the job to themselves. The function-style flow (`start_job`, `complete_job`) is the only path now.

10. **Every destructive action in OrderDetail / InvoiceDetail / DeliveryDetail uses `<Modal>` confirmation, not `confirm()`.** Pre-commit hook + ESLint blocks `window.confirm()` and `confirm()` per `CLAUDE.md` lines 134–141. Grep of `src/pages/` for `confirm(` returned no matches in the relevant pages. The void/cancel/reverse flows always go through a labelled modal with reason capture. `OrderDetail.tsx:1444`–`1469` is a representative example (red banner + reason textarea).

11. **Critical mutating RPCs use `useIdempotencyKey`** — `InvoiceDetail.tsx:73`–`77` declares 5 keys (save_invoice, post_invoice, void_invoice, record_invoice_payment, reverse_write_off). Same pattern in PaymentAllocation, DeliveryDetail, OrderDetail.

12. **MonthEnd and Commissions are admin-only at three layers:** route (`App.tsx:223` and `:226`), sidebar (`Sidebar.tsx:174`–`:176`), and RLS (`20260217210000_commission_payments.sql:26`–`36`). Plus `MonthEndClose.tsx:175,198` writes activity-feed entries. Three-layer agreement is exactly what we want — and it's the model P6-1 recommends extending to InvoiceDetail.

13. **`profiles` SELECT is universal but UPDATE is own-or-admin.** `20260210_fix_rls_critical_issues.sql:57`–`59` (universal SELECT for showing names in the UI) + the older policy stack scoping UPDATE. Names are not sensitive in a 4-person CRM; restricting SELECT would break "show me who created this quote".

---

## Open Questions for Mason

These are decisions only Mason can make. The recommended matrix above is my best read; please confirm or correct:

1. **Should sales reps be able to record payments?** Today: yes via `/payments`, no via InvoiceDetail. Recommendation: yes via `/payments` only, and InvoiceDetail's button (for sales reps) deep-links there. (P6-2)
2. **Should sales reps edit orders?** Today: UI says yes, RLS says no — silent-fail trap. Recommendation: pick one. UI-only restrict (cheap fix) OR open up `orders_update` RLS to sales reps with `created_by` ownership (real change). (P6-4)
3. **Should applicators see the assignment dropdown on the dispatch board?** Today: yes (visible, RLS-blocked). Recommendation: hide it. (P6-3)
4. **Should applicators ever trigger OCR on a blend ticket?** Edge function permits it; UI does not. Recommendation: decide, then make Edge Function and UI agree. (P6-7)
5. **Are commissions visible to the recipient sales rep?** RLS allows it (`commissions` SELECT: `is_admin() OR (is_sales_rep() AND recipient_id = auth.uid())` — confirmed in RLS guide line 163). Sidebar hides Commission Pay from non-admins. Confirm whether a page exists to surface "my commissions" to a sales rep, or whether that's intentional gap.
6. **Per-user deny list scope:** should `/dispatch` and `/prepay-workspace` be deniable to specific users, or are they always allowed by role? (P6-5)

---

## Recommended Fix Order

If Phase 6 work happens in a single sprint, do them in this order:

1. **P6-1** (activity logging on Post / Void / Record Payment / Write Off) — pure addition, no behaviour change, immediately useful.
2. **P6-3** (DispatchBoard — hide applicator-side controls) — one-file change, fixes a confusing dead control.
3. **P6-4** (OrderDetail edit gate) — one-line UI change pending Mason's answer to Q2.
4. **P6-2** (unify payment paths) — moderate change; adds `?invoice=` to PaymentAllocation, swaps the InvoiceDetail button. Update CLAUDE.md.
5. **P6-9** (RLS doc fix for invoices) — doc only; do alongside `/update-docs`.
6. **P6-6** (rename driver-guardrail test, add real route-guard test) — test hygiene.
7. **P6-7** (decide applicator OCR policy) — pending Mason's answer to Q4. May need migration + Edge Function redeploy.
8. **P6-8** (admin SELECT on `idempotency_keys`) — new tiny migration; only do if debugging friction is real.
9. **P6-5** (route catalog refactor) — biggest change; consider deferring to Phase 8 (Mobile/Performance) when route declarations are likely to be touched anyway.

After all fixes:
- Re-run `/audit` to confirm doc counts and lint/build/test stay green.
- Add the regression test in P6-6 that mounts each role against `<ProtectedRoute>` for one representative page per role-bucket (admin-only `/month-end`; admin+sales_rep `/orders`; admin+sales_rep+driver `/deliveries`; admin+sales_rep+applicator `/jobs`). One file pins the whole role × route contract going forward.

---

*End of Phase 6.*
