# CRX Manager — Audit Fix Implementation Plan

**Date:** 2026-05-09
**Source audit:** [`2026-05-09-combined-audit.html`](2026-05-09-combined-audit.html)
**Total findings to address:** 51 (1 already resolved — password rotation)
**Total estimated work:** ~42-55 hours across 26 PRs
**Recommended pace:** 4-6 weeks at 8-12 hours/week

---

## How to read this plan

Each PR is sized to be reviewable in one sitting (most under 2 hours, a few up to 5-7). Every PR specifies:

- **Why** — the user-visible problem it fixes
- **Findings addressed** — references to the audit doc
- **Approach** — implementation outline
- **Files** — specific paths
- **Tests** — what to add and run
- **Rollback** — how to undo if it goes wrong
- **Depends on** — other PRs that must merge first
- **Risk** — Low / Medium / High
- **gotchas.md update** — whether this PR adds new entries

PRs with the same Phase number can ship in any order unless dependencies say otherwise. PRs across different phases should generally ship in order, but P3 cleanups can interleave with P2 work if you're rolling.

---

## Pre-flight checklist (before PR #1)

Mason should confirm these are true before starting any PR:

- [ ] Production password rotated (already confirmed)
- [ ] Working in a feature branch off `main`, not committing directly
- [ ] `npm install` runs clean
- [ ] `npm run lint && npm run typecheck && npm run build && npm run test` passes
- [ ] Supabase MCP is connected (`/list-tables` returns data)
- [ ] `node scripts/regenerate-schema-registry.mjs` runs cleanly so PreToolUse hooks have current schema

---

## Dependency graph

```
Phase 1 (urgent, parallel-able)
  PR-01 (delivery_date fix) ──────┐
  PR-02 (idempotency replay) ─────┤
  PR-03 (send-email fix)   ───────┤
  PR-04 (AP RPC trio + structural)┤
  PR-05 (E2E hardening)    ───────┘
                                  │
Phase 2 (after Phase 1 lands) ────┤
  PR-06 (credit limit soft warn) ─┤      depends on nothing
  PR-07 (RLS tightening)         ─┤      depends on nothing
  PR-08 (Invoice Detail unify)   ─┼─►── DEPENDS on PR-02 (record_invoice_payment must be fixed first)
  PR-09 (write_off formula)      ─┤      depends on nothing
  PR-10 (bulk idempotency)       ─┼─►── DEPENDS on PR-02 (canonical pattern established)
  PR-11 (PAGE_PERMISSIONS)       ─┤      depends on nothing
  PR-12 (pg_temp fixes)          ─┘      depends on nothing

Phase 2.5 (AP completeness)
  PR-13 (void_vendor_payment)    ─┼─►── DEPENDS on PR-04 (balance_cents GENERATED, void columns added)
  PR-14 (update_vendor_bill)     ─┼─►── DEPENDS on PR-04
  PR-15 (parseDollarsToCents)    ─┘      depends on nothing

Phase 3 (cleanups, can interleave)
  PR-16 to PR-22                   independent of each other

Phase 3.5 (AP polish)
  PR-23 (AP polish bundle)       ─►──── DEPENDS on PR-04, PR-13, PR-14

Phase 4 (infrastructure)
  PR-24 (staging Supabase)       independent
  PR-25 (vendor master-data UI)  ─►──── DEPENDS on PR-07 (vendor RLS gate)
  PR-26 (docs update)            ─►──── LAST — captures everything learned
```

---

# PHASE 1 — Critical fixes (Week 1, ~12 hours)

These five PRs close the active production risks. Ship them in any order; none depend on each other. Aim to land all five within one week.

---

## PR-01 — Fix `delivery_date` column references

**Phase 1 / P0 / 1 hour total / Risk: Low**

**Why:** Drivers cannot complete or void deliveries that fall in a closed accounting period. The active `complete_delivery` and `void_delivery` RPCs reference `v_delivery.delivery_date` but the table column is `scheduled_date`. Any delivery completion/void that triggers the closed-period warning crashes.

**Findings addressed:** P0 #2 (complete_delivery), P0 #3 (void_delivery)

**Approach:**
1. Create migration `20260510010000_fix_delivery_date_column_refs.sql`
2. Rewrite `complete_delivery` body — replace 3 instances of `v_delivery.delivery_date` with `v_delivery.scheduled_date` (lines 99, 109, 125 of the May 7 source)
3. Rewrite `void_delivery` body — same fix at 3 locations (lines 371, 381, 398)
4. Both functions otherwise unchanged
5. Re-run `node scripts/regenerate-schema-registry.mjs`

**Files:**
- `supabase/migrations/20260510010000_fix_delivery_date_column_refs.sql` (new)
- `.claude/schema-registry.json` (regenerated)

**Tests:**
- New unit test: walk a delivery through `scheduled → in_progress → completed` and assert no error (no closed period)
- New unit test: same flow with delivery date inside a closed accounting period — assert WARN-only behavior, no exception
- New unit test: complete then void a delivery, verify inventory restored
- Run full test suite: `npm run test`

**Rollback:** Drop the migration's CREATE OR REPLACE; re-deploy the May 7 versions. (Don't actually do this — they're broken — but the option exists.)

**Depends on:** None.

**gotchas.md update?** Yes — strengthen line 28 entry to flag that this bug has now been re-introduced, and reference the schema-aware hook that should catch it (`status-enum-check.mjs` doesn't currently check column names; consider extending or adding a new hook).

---

## PR-02 — Fix broken idempotency replay in 5 mutating RPCs

**Phase 1 / P0 / 2-3 hours total / Risk: Medium**

**Why:** Five mutating RPCs use a broken idempotency replay check that never fires. Network retries silently re-execute the mutation. Affects payments, prepay credits, order edits, PO receives, and quick deliveries.

**Findings addressed:** P0 #4 (the consolidated finding covering 5 RPCs)

**Approach:**
1. Create migration `20260510020000_fix_idempotency_replay_canonical.sql`
2. Rewrite each function with the canonical pattern:
   ```sql
   IF p_idempotency_key IS NOT NULL THEN
     v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');
     IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
   END IF;
   -- ... mutation ...
   IF p_idempotency_key IS NOT NULL THEN
     PERFORM save_idempotency(p_idempotency_key, '<rpc_name>', v_result);
   END IF;
   ```
3. Apply to: `create_quick_delivery`, `record_invoice_payment`, `create_prepay_check_splits`, `update_order_items`, `receive_po_items`
4. For RPCs that return UUID instead of jsonb (e.g., `record_invoice_payment` returns `uuid`), wrap the cached result extraction: `IF v_existing IS NOT NULL THEN RETURN (v_existing->>'payment_id')::uuid; END IF;` and save with `jsonb_build_object('payment_id', v_id)`. **Verify return shape per function before writing.**
5. Add file-level marker `-- idempotency-body-check: exempt` if the helper indirection trips the hook.

**Files:**
- `supabase/migrations/20260510020000_fix_idempotency_replay_canonical.sql` (new)

**Tests:**
- Five new unit tests, one per RPC: call twice with the same `p_idempotency_key`, assert the mutation happened exactly once.
  - For `record_invoice_payment`: assert `payments` table has 1 row, `invoices.paid_amount_cents` increased once.
  - For `create_quick_delivery`: assert 1 order, 1 delivery, 1 invoice.
  - For `create_prepay_check_splits`: assert 1 prepay credit row.
  - For `update_order_items`: assert order_items diff is the same after the second call.
  - For `receive_po_items`: assert inventory_transactions has 1 'received' row.
- Run all existing RPC tests to verify no regression.

**Rollback:** Migration replaces functions; rollback by re-creating prior versions from git history. Low risk because the prior versions were broken — rollback is "revert to older broken behavior."

**Depends on:** None.

**Risk note:** Each RPC has slightly different return shape (jsonb vs uuid vs void). Read each carefully before rewriting. Test each in isolation before bundling.

**gotchas.md update?** Yes — add a new section: "Canonical idempotency pattern" with the correct SQL block, explicitly call out that `check_idempotency` returns the BARE result (not `{status, result}`), and link to this PR as the reference fix.

---

## PR-03 — Fix `send-email` Edge Function customers column

**Phase 1 / P1 / 30 min total / Risk: Low**

**Why:** Email sending tied to a `customer_id` is likely failing silently in production because `send-email` SELECTs a column that doesn't exist (`customers.name` — should be `farm_name`). PostgREST returns 42703, the function trips its 404 path.

**Findings addressed:** P1 #8 (send-email customers.name)

**Approach:**
1. Edit `supabase/functions/send-email/index.ts:154-158`
2. Change selector from `id, email, name` to `id, email, farm_name`
3. Update any downstream usage of `customerRow.name` to `customerRow.farm_name`
4. Add explicit error logging on the customers query so future schema drifts surface immediately (currently silent)
5. Deploy via Supabase MCP

**Files:**
- `supabase/functions/send-email/index.ts`

**Tests:**
- Live test: call `send-email` with a real `customer_id` and `to: 'mason+test@croprxsolutions.com'`. Verify email sends. Check Edge Function logs for the customers query.
- Live test: call with a non-existent customer_id, verify 404 with explicit error message.

**Rollback:** Revert the file edit, redeploy.

**Depends on:** None.

**gotchas.md update?** Yes — add entry: "`customers.farm_name` (NOT `name`) — Edge Functions must select the right column or PostgREST returns 42703".

---

## PR-04 — AP RPC trio + structural fixes (LARGE)

**Phase 1 / P0 + 4 P1 / 5-7 hours total / Risk: High**

**Why:** The entire AP system has structural gaps: missing idempotency, no closed-period guard on bill creation, no audit log integration (the CHECK constraint doesn't even allow vendor entity types), mutable `balance_cents`, no UNIQUE constraints, RLS too permissive on `vendors`, and `void_vendor_bill` allows orphaning payments. This is the biggest fix in the plan because it's actually 7 fixes in one coherent migration.

**Findings addressed:** P0 #5 (AP RPC trio idempotency), P1 (closed-period AP), P1 (financial_audit_log AP), P1 (vendors_select RLS), P1 (vendor_bills.balance_cents not GENERATED), P1 (vendor_bills no UNIQUE on bill_number), P1 (void_vendor_bill allows paid bills), P2 (search_path on AP RPCs), P2 (vendor not soft-deleted check)

**Approach:**

This PR ships as **one migration with 7 sub-blocks** but should be reviewed section-by-section.

1. Create migration `20260510030000_ap_structural_fixes.sql`
2. **Block 1 — Schema migrations (run first, transactional):**
   - Add `voided_at`, `voided_by`, `void_reason` columns to `vendor_bills`
   - Add same columns to `vendor_payments` (pre-prep for PR-13)
   - Convert `vendor_bills.balance_cents` to GENERATED ALWAYS:
     ```sql
     ALTER TABLE vendor_bills DROP COLUMN balance_cents;
     ALTER TABLE vendor_bills ADD COLUMN balance_cents bigint
       GENERATED ALWAYS AS (total_cents - paid_cents) STORED;
     ```
   - Add UNIQUE partial index: `CREATE UNIQUE INDEX ... ON vendor_bills(vendor_id, bill_number) WHERE deleted_at IS NULL AND status <> 'voided';`
   - Expand `financial_audit_log.entity_type` CHECK to include `'vendor_bill'`, `'vendor_payment'`, `'purchase_order'`. Same for `operation_type`: `'vendor_bill_created'`, `'vendor_bill_voided'`, `'vendor_payment_recorded'`.
3. **Block 2 — `vendors_select` RLS tightening:**
   ```sql
   DROP POLICY vendors_select ON vendors;
   CREATE POLICY vendors_select ON vendors FOR SELECT USING (
     deleted_at IS NULL
     AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales_rep')
   );
   ```
4. **Block 3 — Rewrite `create_vendor_bill`:**
   - Add `SET search_path = public, pg_temp`
   - Add canonical idempotency block (check at top, save before return)
   - Add `check_period_open(p_bill_date::date)` after the role check
   - Add vendor active check: `IF NOT EXISTS (SELECT 1 FROM vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'VENDOR_NOT_FOUND'; END IF;`
   - Add `INSERT INTO financial_audit_log(...)` with `operation_type = 'vendor_bill_created'`
5. **Block 4 — Rewrite `record_vendor_payment`:**
   - Same `SET search_path`
   - Same idempotency block
   - Same audit log INSERT (`operation_type = 'vendor_payment_recorded'`)
   - Note: skip `check_period_open` here per Q8 Phase 2 finding (period gating is on posting, not raw payment recording — bill creation is the posting equivalent)
6. **Block 5 — Rewrite `void_vendor_bill`:**
   - Same `SET search_path`
   - Same idempotency block
   - Add the paid-bill guard (Q11 decision):
     ```sql
     IF v_bill.status = 'paid' AND EXISTS (
       SELECT 1 FROM vendor_payments WHERE vendor_bill_id = p_bill_id AND voided_at IS NULL
     ) THEN
       RAISE EXCEPTION 'BILL_HAS_ACTIVE_PAYMENTS: void each payment first';
     END IF;
     ```
   - Populate the new `voided_at`, `voided_by`, `void_reason` columns instead of stuffing reason into `notes`
   - Add audit log INSERT
7. **Block 6 — Verification block:** assert each of the 3 RPCs has exactly one overload, and the schema changes landed.
8. Re-run `node scripts/regenerate-schema-registry.mjs`

**Files:**
- `supabase/migrations/20260510030000_ap_structural_fixes.sql` (new — large migration)
- `.claude/schema-registry.json` (regenerated)
- `src/types/index.ts` — update VendorBill / VendorPayment types to add new void columns
- `src/pages/VendorBillDetail.tsx` — confirm no breakage; the `loading={paying}` flag and idempotency hook should now work end-to-end

**Tests:**
- E2E test (new): `tests/e2e/vendor-payments.spec.ts`
  - Create `[E2E] Test Vendor` bill, record payment, attempt same-key replay, assert exactly one `vendor_payments` row + one `idempotency_keys` row
  - Try to void the paid bill, assert error
  - Verify `financial_audit_log` has one entry per RPC call
- Unit test (new): `vendor_bills.balance_cents` GENERATED works correctly across UPDATE attempts
- Unit test (new): drivers and applicators get RLS-blocked from `SELECT * FROM vendors`
- Run all existing tests

**Rollback:** This migration is the riskiest of the plan because it changes a column type (balance_cents → GENERATED). Rollback steps:
1. Drop migration (keeps the new column shape)
2. Re-run with the column converted back to plain `bigint` and value re-populated from the formula
3. Re-deploy old RPC versions
Practical advice: **test this migration on a Supabase preview branch first** before merging.

**Depends on:** None (but should land before PR-13, PR-14).

**Risk note:** This is a HIGH-risk PR because:
- It changes a table column type (balance_cents)
- It changes RLS (could lock people out if the role check is wrong)
- It expands a CHECK constraint (must include all old + new values)
- It rewrites 3 RPCs in one migration

**Mitigation:** Strongly consider splitting into PR-04a, PR-04b, PR-04c if review feels heavy. The split:
- PR-04a: Schema changes only (columns, GENERATED, UNIQUE, CHECK constraint expansion, RLS)
- PR-04b: `create_vendor_bill` rewrite
- PR-04c: `record_vendor_payment` + `void_vendor_bill` rewrites

**gotchas.md update?** Yes — major additions:
- "AP RPCs use `SET search_path = public, pg_temp`" — same as AR going forward
- "`vendor_bills.balance_cents` is GENERATED" — same as `invoices.balance_cents`
- "`financial_audit_log.entity_type` allows: invoice, payment, vendor_bill, vendor_payment, purchase_order, write_off" — list the canonical entity types
- Update line 28 to include `vendor_bills.bill_date (NOT bill_created_at)` if relevant
- Remove `vendor_payments` from "Tables WITHOUT updated_at" if we add the void columns

---

## PR-05 — E2E hardening Phase 1

**Phase 1 / P0 (resolved with cleanup) / 1 hour total / Risk: Low**

**Why:** The hard-coded password fallback was rotated, but the literal string is still in the file and there's no guard preventing future fallbacks. Need to make the test setup fail-closed if env vars aren't set or if pointed at production without explicit acknowledgment.

**Findings addressed:** Cleanup of P0 #1 (resolved finding); operational hardening for Q10 Phase 1

**Approach:**
1. Edit `tests/e2e/utils/auth.ts`:
   ```typescript
   export const TEST_USER = {
     email: process.env.E2E_TEST_EMAIL ?? throwIfMissing('E2E_TEST_EMAIL'),
     password: process.env.E2E_TEST_PASSWORD ?? throwIfMissing('E2E_TEST_PASSWORD'),
   };
   function throwIfMissing(name: string): never {
     throw new Error(`E2E env var ${name} is required. See docs/CONTRIBUTING.md.`);
   }
   ```
2. Edit `tests/e2e/fixtures/setup-fixtures.ts` — remove the hard-coded prod URL fallback. Same pattern.
3. Add a new file `tests/e2e/utils/safety-guards.ts`:
   ```typescript
   export function assertNotProductionWithoutOverride() {
     const url = process.env.VITE_SUPABASE_URL ?? '';
     const isProd = url.includes('rhyzpcqhnizqbxphqdkr');
     const allowed = process.env.E2E_ALLOW_PROD === 'true';
     if (isProd && !allowed) {
       throw new Error(
         'E2E is pointed at PRODUCTION Supabase. Set E2E_ALLOW_PROD=true to acknowledge.'
       );
     }
   }
   ```
4. Call `assertNotProductionWithoutOverride()` at the top of `playwright.config.ts` global setup.
5. Add `[E2E]` prefix smoke test in global setup that fails if any non-prefixed test entity exists at startup.
6. Update `docs/CONTRIBUTING.md` (or create) with E2E env var requirements.

**Files:**
- `tests/e2e/utils/auth.ts`
- `tests/e2e/fixtures/setup-fixtures.ts`
- `tests/e2e/fixtures/teardown-fixtures.ts`
- `tests/e2e/utils/safety-guards.ts` (new)
- `playwright.config.ts`
- `docs/CONTRIBUTING.md` (new or updated)

**Tests:**
- Run E2E once with `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` set → should pass
- Run E2E without env vars → should fail with clear error
- Run E2E pointed at prod URL without `E2E_ALLOW_PROD=true` → should fail
- Run E2E pointed at prod URL with `E2E_ALLOW_PROD=true` → should pass

**Rollback:** Revert the test file edits. The password is rotated, so even if rolled back the worst case is the same as today.

**Depends on:** None.

**gotchas.md update?** Yes — add: "E2E tests require `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD` env vars; pointing at prod requires `E2E_ALLOW_PROD=true`."

---

# PHASE 2 — Decided bugs (Weeks 2-3, ~14 hours)

These all have business decisions baked in. Most are independent of each other. PR-08 and PR-10 depend on PR-02 from Phase 1.

---

## PR-06 — Quick-delivery credit limit soft warn

**Phase 2 / P1 / 1.5 hours / Risk: Low**

**Why:** When a customer is over their credit limit, the quick delivery RPC currently raises an exception, blocking the delivery. Mason chose Option C (Q4): allow the delivery but notify admins.

**Findings addressed:** P1 #6 (quick delivery credit limit)

**Approach:**
1. Create migration `20260510040000_credit_limit_soft_warn.sql`
2. Rewrite the credit limit block in `create_quick_delivery`:
   - Calculate AR balance including `'posted'`, `'overdue'`, `'draft'` invoices
   - Add the new delivery's projected total to the calculation
   - Replace `RAISE EXCEPTION` with admin notification + activity_feed entry
   - Use the same notification pattern as the closed-period warnings (loop over admin profiles, INSERT into notifications)
3. Function otherwise unchanged.

**Files:**
- `supabase/migrations/20260510040000_credit_limit_soft_warn.sql` (new)

**Tests:**
- Unit test: customer over limit, attempt quick delivery, assert success + admin notification fired
- Unit test: customer under limit, attempt quick delivery, assert success + NO notification
- Unit test: customer at exactly the limit with new delivery pushing over, assert success + notification

**Rollback:** Migration only changes the credit-limit logic block. Revert by re-creating prior version.

**Depends on:** None.

**gotchas.md update?** Yes — add: "Quick delivery credit limit is soft warn (notification + activity_feed), not hard block. Includes draft + overdue + projected total."

---

## PR-07 — Customer + profile RLS tightening

**Phase 2 / P1 (x2) / 2 hours / Risk: Medium**

**Why:** Drivers and applicators can read all customers and all profiles via direct Supabase query. Mason chose Option B for Q2 (today's route + assigned customers) and the safer default for Q3 (admins + self full PII).

**Findings addressed:** P1 #7 (customers RLS), P1 (profiles RLS — peer)

**Approach:**
1. Create migration `20260510050000_tighten_customer_profile_rls.sql`
2. **Customers policy:**
   ```sql
   DROP POLICY customers_select ON customers;
   CREATE POLICY customers_select ON customers FOR SELECT USING (
     deleted_at IS NULL AND (
       -- Admins and sales reps see all
       (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales_rep')
       -- Drivers see customers on assigned deliveries (today + 1 day window)
       OR EXISTS (
         SELECT 1 FROM deliveries d
         WHERE d.customer_id = customers.id
           AND d.assigned_driver = auth.uid()
           AND d.scheduled_date >= CURRENT_DATE - INTERVAL '1 day'
       )
       -- Applicators see customers on assigned jobs (7-day window)
       OR EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.customer_id = customers.id
           AND j.applicator_id = auth.uid()
           AND j.scheduled_date >= CURRENT_DATE - INTERVAL '7 days'
       )
     )
   );
   ```
3. **Profiles policy:** Two policies — public columns visible to all, sensitive PII admin-only:
   - Easier path: create a `profile_public_view` view with id, full_name, role, is_active. Revoke direct table SELECT for non-admins. Frontend reads from the view for assignment dropdowns.
   - Direct table SELECT now scoped to `(SELECT role FROM profiles WHERE id = auth.uid()) = 'admin' OR id = auth.uid()` (admin sees all; user sees self).

**Files:**
- `supabase/migrations/20260510050000_tighten_customer_profile_rls.sql` (new)
- `src/types/index.ts` — add `ProfilePublic` type if introducing the view
- Frontend assignment dropdowns (Drivers picker, Sales rep picker) may need to switch from `profiles` to `profile_public_view`

**Tests:**
- RLS test as a driver: SELECT customers — only assigned ones returned
- RLS test as an applicator: same shape with jobs
- RLS test as a sales rep: all customers returned
- RLS test as a driver: cannot SELECT another user's `applicator_license_number`
- Verify driver app still works end-to-end (assignment UI loads, customer details show)

**Rollback:** Revert the migration; old policies restored from git. Tested behavior should still work.

**Depends on:** None.

**Risk note:** RLS changes are notoriously easy to get wrong. Test on a preview branch with multiple role accounts before merging.

**gotchas.md update?** Yes — add: "Drivers see customers tied to assigned deliveries within 1-day window; applicators see customers tied to assigned jobs within 7-day window. PII (license, FAA cert) is admin + self only."

---

## PR-08 — Unify Invoice Detail payment with Payment History

**Phase 2 / P2 / 2-3 hours / Risk: Medium**

**Why:** Two parallel ledgers exist: invoice-detail's "Record Payment" writes to `payments`, Payment History reads from `allocation_sets`. Mason chose Option B (Q5): keep the inline modal but rewrite to call `allocate_payment`.

**Findings addressed:** P2 #9 (Invoice Detail bypass)

**Approach:**
1. Edit `src/pages/InvoiceDetail.tsx:493`:
   - Remove call to `record_invoice_payment` RPC
   - Replace with `allocate_payment` call shaped as a single-invoice allocation:
     ```typescript
     const { data, error } = await supabase.rpc('allocate_payment', {
       p_payment_method: ...,
       p_total_cents: ...,
       p_reference_number: ...,
       p_notes: ...,
       p_allocations: [{ invoice_id: invoice.id, amount_cents: ... }],
       p_idempotency_key: paymentIdem.key,
     });
     ```
   - Wrap with `assertRpcResult`
2. Verify `allocate_payment` handles the single-invoice case correctly (pre-existing function, but verify edge cases: prepay credit, tax, write-offs)
3. Mark `record_invoice_payment` as deprecated in a follow-up migration (don't drop yet — keep for 2 sprints in case we missed a caller)
4. Add a test that confirms a payment recorded from invoice detail appears in Payment History

**Files:**
- `src/pages/InvoiceDetail.tsx`
- (Optional) `supabase/migrations/2026XXXX_deprecate_record_invoice_payment.sql` — adds a comment, no behavior change

**Tests:**
- E2E test: from `[E2E]` invoice, record payment, navigate to Payment History, assert payment appears
- E2E test: void the payment from Payment History, assert invoice balance restores
- Unit test: `allocate_payment` with single-invoice case behaves identically to `record_invoice_payment` for the simple case

**Rollback:** Revert `InvoiceDetail.tsx`. The deprecated RPC still exists.

**Depends on:** PR-02 (which fixes idempotency on `record_invoice_payment`). Even though we're moving away from it, PR-02 makes the migration cleaner — no half-broken RPCs hanging around.

**Risk note:** `allocate_payment` is more complex than `record_invoice_payment`. Verify the single-invoice path doesn't have surprises with prepay credit, tax handling, or write-offs.

**gotchas.md update?** Yes — add: "Invoice payments must go through `allocate_payment` (writes to `allocation_sets`). `record_invoice_payment` is deprecated. Payment History reads from `allocation_sets` only."

---

## PR-09 — Integrity report write_off formula

**Phase 2 / P2 / 30 min / Risk: Low**

**Why:** The IntegrityReport page flags every written-off invoice as a balance discrepancy because the frontend formula is missing `- write_off_cents`. The DB-generated `balance_cents` correctly includes it.

**Findings addressed:** P2 #10 (integrity write_off)

**Approach:**
1. Edit `src/lib/reconciliation.ts:297`:
   - Update the formula to: `total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents`
2. Edit the `SELECT` query at line 692 to include `write_off_cents` in the column list

**Files:**
- `src/lib/reconciliation.ts`

**Tests:**
- Unit test: invoice with $50 write-off, integrity report shows zero discrepancy
- Visual: load IntegrityReport page in dev, click refresh, verify clean

**Rollback:** Revert the file edit.

**Depends on:** None.

**gotchas.md update?** No (already has line 31 for invoices.balance_cents).

---

## PR-10 — Bulk idempotency wiring on 14 RPCs

**Phase 2 / P2 / 2-3 hours / Risk: Medium**

**Why:** 14 RPCs accept `p_idempotency_key` but never use it. Network retries return false errors ("already posted") even though the first call succeeded.

**Findings addressed:** P2 #12 (consolidated finding covering 14 RPCs)

**Approach:**
1. Create migration `20260510060000_bulk_idempotency_wiring.sql`
2. For each RPC, add the canonical idempotency block (same pattern as PR-02). Group into logical sub-blocks for review:
   - Block A — Invoice state transitions: `post_invoice`, `void_invoice`, `save_invoice`
   - Block B — Customer + commission: `save_customer`, `increment_customer_prepay`, `convert_quote_to_order`
   - Block C — Vendor: `record_vendor_payment` (already done in PR-04 — skip), `create_vendor_bill` (PR-04), `void_vendor_bill` (PR-04)
   - Block D — Delivery + PO: `reassign_delivery`, `batch_cancel_deliveries`, `delete_purchase_order`
   - Block E — Blend tickets: `link_blend_ticket_to_order`, `unlink_blend_ticket_from_order`
   - Block F — Period: `close_accounting_period`
3. Each function gets the canonical pattern AND `SET search_path = public, pg_temp` if not already set.
4. Verify function signatures unchanged (callers don't break).

**Files:**
- `supabase/migrations/20260510060000_bulk_idempotency_wiring.sql` (new — large)

**Tests:**
- One unit test per RPC: same-key retry doesn't duplicate the audit/notification/state transition
- Run all existing tests
- Verify the schema-aware `idempotency-body-check.mjs` hook now passes for all flagged functions

**Rollback:** Migration replaces functions; revert by re-creating prior versions.

**Depends on:** PR-02 (canonical pattern established and verified). PR-04 covers the AP trio so this PR skips them.

**Risk note:** 11 RPCs in one migration is a lot. Strongly consider sub-block PRs if review feels heavy.

**gotchas.md update?** Yes — note: "Every mutating RPC accepting `p_idempotency_key` must call `check_idempotency` and `save_idempotency` in body. The `idempotency-body-check.mjs` hook enforces this."

---

## PR-11 — PAGE_PERMISSIONS holes + fail-closed test

**Phase 2 / P2 / 1 hour / Risk: Low**

**Why:** Five routes are not in `PAGE_PERMISSIONS`, meaning the per-user deny-list silently does nothing for them. Mason uses the feature; needs patching.

**Findings addressed:** P2 #13 (PAGE_PERMISSIONS)

**Approach:**
1. Edit `src/lib/pagePermissions.ts:15-64`:
   - Add entries for `dispatch`, `program-tracker`, `application-services`, `prepay-workspace`, `getting-started`
   - Use the same shape as existing entries
2. Edit `src/components/ProtectedRoute.tsx`:
   - When `getPageKeyFromPath()` returns null AND the route is wrapped in ProtectedRoute, log a console.error and redirect to dashboard. (Currently silent passthrough.)
3. Add unit test `src/lib/pagePermissions.test.ts`:
   - Walk every `<Route path="...">` first segment in `App.tsx`
   - Assert each has a `PAGE_PERMISSIONS` entry
   - This is the fail-closed test that prevents future drift

**Files:**
- `src/lib/pagePermissions.ts`
- `src/components/ProtectedRoute.tsx`
- `src/lib/pagePermissions.test.ts` (new)

**Tests:**
- Unit test (the new one above)
- Manual: deny `/application-services` for a test user, log in as that user, verify redirect to dashboard

**Rollback:** Revert the file edits.

**Depends on:** None.

**gotchas.md update?** Yes — add: "Every protected route must have a corresponding entry in `PAGE_PERMISSIONS`; `pagePermissions.test.ts` enforces this."

---

## PR-12 — Add `pg_temp` to SECURITY DEFINER violators

**Phase 2 / P2 / 30 min / Risk: Low**

**Why:** 4 SECURITY DEFINER functions are missing `pg_temp` in their search_path. (PR-04 fixed the 3 AP RPCs; this finishes the remaining 4.)

**Findings addressed:** P2 #11 (SECURITY DEFINER pg_temp)

**Approach:**
1. Create migration `20260510070000_pg_temp_security_definer_fixes.sql`
2. Rewrite these 4 functions with `SET search_path = public, pg_temp`:
   - `release_holds_on_quote_status_change` (currently `''`)
   - `auto_expire_quotes` (currently `''`)
   - `record_invoice_payment` (already getting search_path fix in PR-02 — verify and skip if redundant)
   - `close_accounting_period` (currently `''`)

**Files:**
- `supabase/migrations/20260510070000_pg_temp_security_definer_fixes.sql` (new)

**Tests:**
- Run schemaIntegrity test — should now pass for these 4 functions
- Run smoke test of each: quote status change, expired quote auto-expire, invoice payment, period close

**Rollback:** Revert migration.

**Depends on:** PR-02 (which already touches `record_invoice_payment`). Verify no double-rewrite.

**gotchas.md update?** Strengthen line 25 to be a hard rule: "Every SECURITY DEFINER function MUST have `SET search_path = public, pg_temp`."

---

# PHASE 2.5 — AP completeness (Week 3, ~6 hours)

These build on PR-04. Don't ship until PR-04 is merged and verified in production.

---

## PR-13 — `void_vendor_payment` + paid-bill guard

**Phase 2.5 / P1 / 3-4 hours / Risk: Medium**

**Why:** No way to reverse a wrong vendor payment today. Plus the paid-bill void is broken (Q11 chosen: hard-block).

**Findings addressed:** P1 (no void_vendor_payment), P1 (vendor_payments no soft-delete columns), P1 (void_vendor_bill allows paid bills)

**Approach:**
1. Note: PR-04 already added `voided_at`, `voided_by`, `void_reason` columns to `vendor_payments`. If not, add here.
2. Create migration `20260510080000_void_vendor_payment.sql`
3. Add `void_vendor_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL)` RPC:
   - SECURITY DEFINER, `SET search_path = public, pg_temp`
   - Admin role check
   - Canonical idempotency block
   - `FOR UPDATE` lock on payment row, then on bill
   - Validate payment isn't already voided
   - Decrement `vendor_bills.paid_cents` by payment amount
   - Recalculate bill status: paid → partially_paid (if balance > 0) or unpaid (if all payments voided)
   - Set `voided_at = now()`, `voided_by = auth.uid()`, `void_reason = p_reason` on the payment row
   - INSERT into `financial_audit_log` with `operation_type = 'vendor_payment_voided'`
4. Update `void_vendor_bill` (already touched in PR-04, but if not done, add the paid-bill guard here):
   - `IF v_bill.status = 'paid' AND EXISTS (...active payments...) THEN RAISE EXCEPTION 'BILL_HAS_ACTIVE_PAYMENTS'`
5. Frontend: Add Void button per payment row in `VendorBillDetail.tsx`:
   - Click opens `ConfirmModal` with reason textarea
   - Calls `void_vendor_payment` RPC with idempotency key
   - On success, refreshes bill detail
6. Bill-level Void button: if bill has active payments, show toast "Void each payment first" with focus to the payment list.

**Files:**
- `supabase/migrations/20260510080000_void_vendor_payment.sql` (new)
- `src/pages/VendorBillDetail.tsx`
- `src/components/vendor/VoidPaymentModal.tsx` (new)
- `src/types/index.ts` — add types

**Tests:**
- Unit test: void a payment, verify bill paid_cents decremented, status updated, payment row marked voided
- Unit test: try to void already-voided payment, assert error
- Unit test: try to void paid bill with active payments, assert error
- E2E test: full flow — record payment, void payment, verify Payment History reflects void, then void bill (now succeeds)

**Rollback:** Migration adds new RPC + columns. Revert by dropping RPC; columns can stay if they're nullable.

**Depends on:** PR-04 (balance_cents GENERATED, void columns).

**gotchas.md update?** Yes — add: "AP voids are hard-blocked when active payments exist. Use `void_vendor_payment` per payment, then `void_vendor_bill`."

---

## PR-14 — `update_vendor_bill` RPC + Edit button

**Phase 2.5 / P2 / 1.5 hours / Risk: Low**

**Why:** Currently a typo in vendor bill amount means void + recreate. Add an Edit capability when no payments exist and status = 'unpaid'.

**Findings addressed:** P2 (bill not editable post-creation)

**Approach:**
1. Create migration `20260510090000_update_vendor_bill.sql`
2. Add `update_vendor_bill(p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint, p_bill_date date, p_due_date date, p_notes text, p_idempotency_key text DEFAULT NULL)` RPC:
   - SECURITY DEFINER, search_path
   - Admin role check
   - Canonical idempotency
   - Guard: bill must be `status = 'unpaid'` AND no active payments
   - Guard: re-check `check_period_open(p_bill_date::date)` since bill date may change
   - UPDATE vendor_bills with new values
   - Audit log INSERT with operation_type = 'vendor_bill_updated' (need to expand CHECK constraint if PR-04 didn't include this)
3. Frontend: Edit button in `VendorBillDetail.tsx` when `status = 'unpaid'` and `payments.length === 0`. Opens form with current values pre-filled.

**Files:**
- `supabase/migrations/20260510090000_update_vendor_bill.sql` (new)
- `src/pages/VendorBillDetail.tsx`
- `src/pages/EditVendorBill.tsx` (new — could reuse NewVendorBill component shape)

**Tests:**
- Unit test: edit unpaid bill, verify changes persisted
- Unit test: try to edit paid bill, assert error
- Unit test: try to edit bill with active payments, assert error

**Rollback:** Drop migration; remove Edit button.

**Depends on:** PR-04.

**gotchas.md update?** Yes — add: "Vendor bills are editable only when `status = 'unpaid'` AND no active payments exist."

---

## PR-15 — `parseDollarsToCents` negative sign fix

**Phase 2.5 / P1 / 1 hour / Risk: Low**

**Why:** The parser strips negative signs while the UI explicitly invites negative input for discount fields. A user typing `-50` for a $50 discount produces a +5000 cent ADD instead.

**Findings addressed:** P1 (parseDollarsToCents strips negatives)

**Approach:**
1. Edit `src/lib/parseCents.ts:8`:
   - Change regex to preserve a leading minus sign
   - Add explicit negative handling
2. Audit other callers via Grep — confirm none rely on the stripping behavior. Likely candidates: any field labeled "discount", "adjustment", "credit".
3. If any caller DOES want positive-only, add a separate `parseDollarsToCentsPositive` helper.

**Files:**
- `src/lib/parseCents.ts`
- `src/lib/parseCents.test.ts`
- (Possibly) other callers if they need to switch to positive-only

**Tests:**
- Unit test: `parseDollarsToCents('-50')` returns -5000
- Unit test: `parseDollarsToCents('50')` returns 5000
- Unit test: `parseDollarsToCents('$-50.00')` returns -5000
- Unit test: `parseDollarsToCents('-50.5')` returns -5050
- Manual: enter `-50` adjustment on NewVendorBill, verify total decreases by $50

**Rollback:** Revert file edit.

**Depends on:** None.

**gotchas.md update?** Yes — add: "`parseDollarsToCents` preserves leading minus signs (used for discounts/credits). Use `parseDollarsToCentsPositive` if positive-only is required."

---

# PHASE 3 — Cleanups (Week 4, ~5 hours)

These are mostly independent. Can interleave with Phase 2 or 2.5 work.

---

## PR-16 — Edge function CORS defaults

**Phase 3 / P2 / 30 min / Risk: Low**

**Why:** All Edge Functions default `Access-Control-Allow-Origin` to the prod URL when `ALLOWED_ORIGIN` is unset. Defense-in-depth gap.

**Approach:**
1. For each of: `create-user`, `seed-admin`, `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document`, `send-email`:
   - Replace fallback `'https://croprxsolutions.app'` with throwing if env var unset
2. Update Supabase Edge Function secrets to ensure `ALLOWED_ORIGIN` is set in all environments

**Files:**
- 6 Edge Function `index.ts` files

**Tests:**
- Live test: deploy each Edge Function and verify it works with env var set
- Live test: test what happens if env var is unset (should fail clearly)

**Rollback:** Revert; restore prod URL fallback.

**Depends on:** None.

---

## PR-17 — Tighten `team_note_tags` RLS

**Phase 3 / P2 / 30 min / Risk: Low**

**Why:** `USING (true)` for read+write+delete on team-board notes. Inconsistent with the rest of the codebase.

**Approach:**
1. Migration `20260510100000_team_note_tags_rls.sql`
2. Replace policies with role-gated versions: admin + sales_rep can read+write+delete; drivers/applicators only if they're a tagged participant.

**Files:**
- New migration

**Tests:** RLS test as each role.

**Rollback:** Revert migration.

**Depends on:** None.

---

## PR-18 — `validate-frontend.sh --all` mode

**Phase 3 / P2 / 20 min / Risk: Low**

**Why:** The script only scans staged files; misleading for audits.

**Approach:**
1. Edit `scripts/validate-frontend.sh`:
   - Add `--all` flag handling
   - When set, scan every TS/TSX file under `src/` instead of using `git diff --cached`
2. Update CI / audit calls to use `--all`.

**Files:**
- `scripts/validate-frontend.sh`

**Tests:** Run with `--all` and without; verify behavior.

**Rollback:** Revert script.

**Depends on:** None.

---

## PR-19 — Tighten `assertRpcCoverage.test.ts` + `schemaIntegrity.test.ts`

**Phase 3 / P3 (x2) / 2 hours / Risk: Low**

**Why:** Both tests are performative — they don't actually verify what they claim to. `assertRpcCoverage` is file-level not call-site-level; `schemaIntegrity` is list-only and doesn't check function bodies.

**Approach:**

**assertRpcCoverage:**
1. Use TypeScript AST (e.g., `@typescript-eslint/parser`) to count `supabase.rpc(...)` calls per file
2. Count `assertRpcResult(...)` calls per file
3. Fail the test if counts differ per file

**schemaIntegrity:**
1. Add a real DB check: for each function in `MUTATING_RPCS_WITH_IDEMPOTENCY`, query `pg_proc.prosrc` and assert it contains `check_idempotency` (or has the exempt marker comment)
2. Same for `SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP` — assert each has `SET search_path = public, pg_temp`
3. Add a network-skip flag so the test runs only when a Supabase URL is available

**Files:**
- `src/lib/assertRpcCoverage.test.ts`
- `src/lib/schemaIntegrity.test.ts`

**Tests:** The improved tests themselves test the system.

**Rollback:** Revert the tests to list-only checks.

**Depends on:** None (but more useful after Phase 1 + Phase 2 land — fewer false alarms).

---

## PR-20 — `logActivity` empty-string fallback cleanup

**Phase 3 / P3 / 1 hour / Risk: Low**

**Why:** 8+ files use `profile?.id || ''` as the `performedBy` value. If `profile` is briefly null, the activity log gets an empty string.

**Approach:**
1. For each callsite, replace the fallback with an early return + toast: "Cannot record activity — profile not loaded."
2. Files to update: `InvoiceDetail.tsx:529, 666`; `MonthEndClose.tsx:175, 198`; `Deliveries.tsx:433, 582, 660`; `QuoteBuilder.tsx:252`; `WriteOffModal.tsx:72`; `FinanceChargePreviewModal.tsx:118`

**Files:** Listed above.

**Tests:** Unit test: when `profile` is null, action is blocked with toast.

**Rollback:** Revert file edits.

**Depends on:** None.

---

## PR-21 — Misc cleanup bundle

**Phase 3 / P3 (x4) / 45 min / Risk: Low**

**Why:** Four small fixes that share no overlap and don't merit individual PRs.

**Approach:**
1. **Lint config** (`eslint.config.js`): add `.claude/worktrees`, `coverage`, Playwright artifact folders to `ignores`
2. **IntegrityReport stale dep** (`src/pages/IntegrityReport.tsx:25-27`): wrap `fetchReport` in `useCallback`, add to deps array
3. **`/payment-history` sidebar link** (`src/components/AppLayout.tsx`): add link under Finance section for admin + sales_rep
4. **Delete dead Edge Function**: `supabase/functions/setup-blend-tickets-storage/` — delete folder; remove from `supabase/config.toml`
5. **Fix doc counts**: `docs/reference/qa-testing.md:109` (81→94), `docs/workflows/UI_PATTERNS.md:43` (57→65). Add `scripts/check-doc-counts.mjs` for CI.

**Files:** Multiple small files.

**Tests:** Run lint, build, smoke test.

**Rollback:** Revert each commit individually.

**Depends on:** None.

---

# PHASE 3.5 — AP polish (Week 4-5, ~2 hours)

One consolidated PR for the smaller AP cleanups. Sequenced after PR-04, PR-13, PR-14.

---

## PR-22 — AP polish bundle

**Phase 3.5 / P2 (x2) + P3 (x4) / 2-3 hours / Risk: Low**

**Why:** Six small AP fixes that share migrations or related code.

**Approach:**

Migration `20260510110000_ap_polish.sql`:

1. **PO cancel/delete: check linked bills.** Pre-checks in `cancel_purchase_order` and `delete_purchase_order` that raise clear errors if linked active vendor bills exist.
2. **PO-to-bill amount soft warn.** In `create_vendor_bill`: if `p_purchase_order_id` is set and bill total is >5% off PO total, INSERT notification for admins.
3. **PO-to-bill vendor consistency.** In `create_vendor_bill`: if `p_purchase_order_id` is set, verify the PO's vendor matches `p_vendor_id`. Raise on mismatch.
4. **CHECK + UNIQUE constraints.** `vendor_bills`: `CHECK (total_cents = subtotal_cents + COALESCE(adjustment_cents, 0))`. `vendor_payments`: `UNIQUE (vendor_bill_id, payment_method, reference_number) WHERE reference_number IS NOT NULL`.
5. **Drop `p_idempotency_key` from `get_ap_aging`.** Read RPC, parameter pointless.
6. **Subtotal > 0 validation in `create_vendor_bill`.** `IF p_subtotal_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'`.

**Files:**
- New migration

**Tests:** One unit test per behavior.

**Rollback:** Revert migration.

**Depends on:** PR-04 (touches all the AP RPCs).

---

# PHASE 4 — Infrastructure (When you have time, ~10 hours)

These are bigger, less urgent. Don't block on these.

---

## PR-23 — E2E staging Supabase environment

**Phase 4 / Cleanup of Q10 / 4-5 hours / Risk: Medium**

**Why:** Long-term safety. E2E should never touch prod.

**Approach:**
1. Create new Supabase project (free tier) named `crx-manager-staging`
2. Run all 285+ migrations against staging
3. Add staging credentials to GitHub Actions secrets
4. Update `playwright.config.ts` to default to staging
5. Update `.env.test.example` with staging URLs
6. Add CI workflow that runs staging migrations on every PR
7. Update CONTRIBUTING.md with the new flow

**Files:**
- `.github/workflows/staging-migrations.yml` (new)
- `.github/workflows/e2e.yml` — update Supabase URL
- `.env.test.example`
- `playwright.config.ts`
- `docs/CONTRIBUTING.md`

**Tests:** Run E2E against staging.

**Rollback:** Revert workflow changes; tests fall back to local Supabase or skip.

**Depends on:** PR-05 (env var requirements).

---

## PR-24 — Vendor master-data UI

**Phase 4 / Out-of-scope of audit, but discovered during it / 3-4 hours / Risk: Low**

**Why:** No way to add/edit vendors through the app. Currently relies on TEXT backfill from PO entries.

**Approach:**
1. New page `src/pages/Vendors.tsx` (admin-only)
2. New page `src/pages/VendorDetail.tsx` (admin-only)
3. Add `/vendors` route to `App.tsx`
4. Add nav link to AppLayout
5. RPCs: `save_vendor`, `delete_vendor` (soft delete)
6. Add to `PAGE_PERMISSIONS`

**Files:**
- 2 new pages
- App.tsx route
- AppLayout nav
- New migration for the RPCs

**Tests:** Standard CRUD coverage.

**Rollback:** Revert pages + route.

**Depends on:** PR-07 (vendor RLS gate must be in place first).

**gotchas.md update?** Yes — note: "Vendors managed via `/vendors` page (admin only). `purchase_orders.vendor` TEXT field is legacy — new code should reference `vendors.id`."

---

## PR-25 — Update gotchas.md + CLAUDE.md (FINAL)

**Phase 4 / Documentation / 1-1.5 hours / Risk: Low**

**Why:** Capture everything learned during the audit + implementation cycles. Make future agents/contractors land on accurate docs.

**Approach:**
1. Consolidate all `gotchas.md update?` notes from previous PRs into one final pass
2. Add a new section to gotchas.md: **"Accounts Payable quirks"** — covers the AP/AR asymmetry, the new void flow, the GENERATED `balance_cents`, etc.
3. Update CLAUDE.md:
   - Update Current State counts (page count, migration count, RPC count, test counts)
   - Update Business Logic Lifecycles section to add vendor_bills lifecycle
   - Add a new section "AP integration patterns" referencing the AP-completeness work
   - Update the canonical patterns section if any new patterns emerged
4. Run `node scripts/regenerate-agents-md.mjs`
5. Update `docs/CHANGELOG.md` with a 2026-05 entry summarizing the audit + fix sprint

**Files:**
- `docs/reference/gotchas.md`
- `CLAUDE.md`
- `AGENTS.md`
- `docs/CHANGELOG.md`

**Tests:** None (documentation).

**Rollback:** Revert.

**Depends on:** All prior PRs.

---

# Risk register

| Risk | PRs affected | Mitigation |
|---|---|---|
| RLS change locks legitimate users out | PR-04, PR-07 | Test with all roles on a Supabase preview branch before merging |
| Column type change (balance_cents) corrupts data | PR-04 | Run migration on a backup of prod schema first; verify formula matches |
| Idempotency rewrites have subtle return-shape bugs | PR-02, PR-10 | Test each RPC individually before bundling |
| `allocate_payment` single-invoice case has hidden edge cases | PR-08 | Compare invoice line-item totals before/after to a known-good run |
| Migration ordering matters across PRs | PR-13, PR-14, PR-22 | Strict dependency check; don't ship out-of-order |
| Schema-aware hooks regenerate stale | All migration PRs | Always run `regenerate-schema-registry.mjs` after merging migrations |

---

# Sequencing recommendations

## Sprint 1 (Week 1) — close the bleeding

Ship PR-01, PR-02, PR-03, PR-05 in any order. Hold PR-04 until you can review the large migration carefully.

After Sprint 1 verifies clean: ship PR-04 (the large AP one). This is the natural pause point to test thoroughly.

## Sprint 2 (Week 2) — Phase 2 decisions

PR-09 is trivial; do it first as a warmup. Then PR-06, PR-07, PR-11, PR-12 in parallel (all independent). Hold PR-08 and PR-10 until PR-02 confirmed stable in prod.

End of Sprint 2: ship PR-08 + PR-10 together (related to idempotency canonicalization).

## Sprint 3 (Week 3) — AP completeness

PR-13, PR-14, PR-15 in order. PR-13 first (depends only on PR-04). PR-15 can be done in parallel.

## Sprint 4 (Week 4) — cleanups

PR-16 through PR-22 in any order. Most are 30-min jobs.

## Sprint 5+ (When time allows) — infrastructure

PR-23, PR-24, PR-25.

---

# Success criteria (when is this done?)

- [ ] All 51 outstanding findings resolved (P0 + P1 + P2 + P3)
- [ ] `npm run lint` returns 0 warnings (after PR-21 lint config fix)
- [ ] `scripts/validate-sql-migrations.sh` returns 0 errors
- [ ] `npm run test` continues to pass with new tests added per PR
- [ ] All E2E tests pass against staging Supabase
- [ ] Gotchas.md documents every quirk discovered during the audit
- [ ] CLAUDE.md current state counts are accurate
- [ ] Schema-aware hooks pass on every file
- [ ] No new findings of the same class (idempotency, search_path, etc.) appear in next quarterly audit

---

# What's NOT in this plan (deferred)

These came up during the audit but are explicitly out of scope:

- **GL / chart of accounts** — major architectural addition. Separate epic.
- **Bank reconciliation** — depends on GL. Separate epic.
- **1099 tracking** — annual aggregation work. Separate epic.
- **FIFO / weighted-average inventory costing** — replaces single `unit_cost`. Separate epic.
- **AP line items** — would mirror `invoice_items` for vendor bills. Separate epic.
- **`purchase_orders.vendor_id` FK migration** — replaces TEXT field. Separate epic.
- **Tote number backfill May 1-7** — Mason chose to skip (Q9).

---

# Final notes

Each PR should:
- Have a clear title following the conventional commit pattern: `fix(domain): description` or `refactor(domain): description`
- Reference this plan in the PR description (`Implements PR-XX of 2026-05-09-implementation-plan.md`)
- Reference the audit doc for findings (`Closes finding P0 #X from 2026-05-09-combined-audit.html`)
- Use `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` if I help write commits
- Be reviewed against this checklist before merging:
  - [ ] All tests pass locally
  - [ ] Schema registry regenerated if migrations changed
  - [ ] gotchas.md updated if PR notes called for it
  - [ ] No new ESLint/TypeScript errors
  - [ ] Pre-commit hooks pass

The audit doc and this implementation plan together form the complete spec. Future you (or a contractor, or me in a new session) can read both cold and execute without re-litigating any decisions.
