# Field Application Workflow — Phase 1–6 Follow-ups

**Status as of 2026-04-30:** All six phases of the codex audit response shipped (commits `b9f6a98` → `e53f8cb`). 5 migrations applied to live Supabase project `rhyzpcqhnizqbxphqdkr`. 1,841 unit tests passing in 128 files; build clean; lint clean.

This doc captures what's deliberately deferred so the next pass picks up cleanly.

---

## 1. Validate the new E2E spec end-to-end ⚠ HIGHEST VALUE

**File:** [`tests/e2e/workflow-field-app-multi-customer.spec.ts`](../../tests/e2e/workflow-field-app-multi-customer.spec.ts)

**Status:** Committed (in `b9f6a98`) but **never run against a live browser**. The shape was authored from documentation and the migration source — first real run will likely surface 1–2 fidelity issues.

### How to run it

```bash
# From the repo root, with the dev server NOT already running
# (playwright.config will spin one up at localhost:5173)
npx playwright test workflow-field-app-multi-customer.spec.ts --project=chromium --reporter=line
```

The spec runs against the **live** Supabase project and uses the shared `[E2E] Farm Alpha` / `[E2E] Farm Beta` fixtures from `tests/e2e/fixtures/setup-fixtures.ts`. It creates its own `[E2E]`-prefixed application service and split field in `beforeAll`, then cleans them up in `afterAll`.

### Pre-flight

- **`E2E_TEST_PASSWORD` is now hardcoded as fallback** in `tests/e2e/utils/auth.ts` (matches `setup-fixtures.ts`). No env var required for local runs.
- Make sure the dev server isn't already running on port 5173 — playwright will reuse it if found, but a stale build can mask issues.
- Confirm Mason's account `mason@croprxsolutions.com` is still active (the fixture loader uses it).

### What to expect on first run

The spec has **7 tests** covering:

1. `derive_customer_shares_from_fields` returns the true 60/40 split
2. `preview_field_app_invoice_split` returns 2 customers with grand_total = sum
3. `save_field_app_invoice` creates 2 invoices with shared `invoice_group_id`; locations live at group level
4. Idempotency replay returns identical `{ invoice_ids, invoice_group_id }`
5. `post_invoice_group` posts every member atomically
6. Edit attempt on posted-group member is rejected
7. UI smoke for `/invoices/field-app/new` Phase 1 wiring

### Likely first-run failure modes

- **Selector for `field_app_location_shares` row fetch** — test 3 has a chained `location_id=in.(...)` lookup that builds the IN clause from `(l as unknown as { id: string }).id`. The query result type doesn't actually expose `id` on those rows, so this assertion may need a separate fetch step.
- **PostgREST RLS gates on freshly-created data** — if Mason's account doesn't have admin role on the live project, the field/billing-default writes in `beforeAll` could fail. Check the role first if setup throws.
- **`[E2E]` cleanup race** — `afterAll` deletes invoices/items/shares/locations explicitly. If teardown errors out partway through, the next run's `beforeAll` may collide on the unique RUN suffix (which embeds Date.now().toString(36), so collisions are unlikely but possible).
- **The split-field cleanup may FK-violate** — `field_billing_defaults` references `fields(id)` and is deleted before `fields`. The order in `afterAll` should already handle this, but if there's a hold or other reference, the delete could fail silently and leak rows.

### If a test fails

The first failure usually points at either (a) an RLS gap (real DB rejects the operation), or (b) a query-shape mismatch (RPC returns slightly different keys than the test asserts). Fix in this order:

1. Read the actual error from the playwright output
2. Hit the RPC manually via the Supabase SQL editor with the same args to see the real return shape
3. Reconcile the test's expectations with reality
4. Re-run

---

## 2. Adopt `compute_application_service_fee` in existing RPCs (Phase 4 cleanup)

**File:** the helper lives at `supabase/migrations/20260430170000_field_app_workflow_phase4.sql`. Inline fee blocks remain in:
- `save_field_app_invoice` (`20260429140635_field_app_workflow_phase1.sql`)
- `create_invoice_from_blend_ticket` (same migration)

**Why:** Three flows currently compute the fee three slightly different ways. Phase 4 introduced the helper as the single source of truth, but didn't refactor existing callers — that would have changed observable behavior, which we wanted to avoid in the same migration that introduced the helper.

**The risk profile is now low** because:
- The helper's logic *exactly mirrors* the inline blocks (customer override → service default → 0)
- 0 `customer_application_rates` rows in production today, so the override branch is currently inert
- The helper has been live for several days under audit before any caller adopts it

**To do:** Write `20260YYYYMMDDhhmmss_field_app_phase4_adopt_helper.sql` that:
1. `CREATE OR REPLACE FUNCTION save_field_app_invoice(...)` replacing the inline fee block (lines ~534–566 of the Phase 1 migration) with `SELECT * FROM compute_application_service_fee(...)`
2. Same for `create_invoice_from_blend_ticket` (lines ~952–982)
3. Verify each result `total_fee_cents` matches what the inline block would have produced for a known input (DO block self-test)

**Acceptance:** the existing E2E + unit tests still pass without modification — this is a refactor, not a behavior change.

---

## 3. Remove the `start_job` skip in the lifecycle E2E (#14)

**Status:** mechanical, deferred until the codepath is exercised.

**Where:** `tests/e2e/golive/` — find the spec that tests the job lifecycle. It currently skips on completion failures because `start_job()` didn't exist when the spec was written. Now that Phase 2 added the RPC, the skip can come out and the test should pass straightforwardly.

**Steps:**
1. `grep -rn "test.skip\|test.fixme" tests/e2e/golive/ tests/e2e/ | grep -i job` to find the offending skip
2. Read the surrounding context to understand what it was guarding against
3. Replace the skip with the real assertion: status transitions `scheduled → in_progress → completed`, application record created with the right `record_number` and `field_count`
4. Re-run that spec to confirm it passes

---

## 4. Run the broader regression sweep before any production push

**Why:** five migrations and one significant frontend change all landed in a single day. Standard `/audit` should catch any drift that wasn't covered by the per-phase verification.

```bash
# Full regression
npm run lint
npm run typecheck
npm run build
npm run test
bash scripts/validate-sql-migrations.sh
npx playwright test --project=chromium --reporter=line
```

Then check the Supabase advisors for anything new:
- `mcp__supabase_get_advisors(project_id=rhyzpcqhnizqbxphqdkr, type='security')`
- `mcp__supabase_get_advisors(project_id=rhyzpcqhnizqbxphqdkr, type='performance')`

We confirmed 0 ERROR-level lints and ~10 WARN-level `anon_security_definer_function_executable` (matching the existing repo-wide baseline) immediately after applying Phase 1. After Phases 2–5 we did NOT re-run the full advisor scan — recommend doing it once before declaring this work complete.

---

## 5. Pre-existing uncommitted work that wasn't touched

The session deliberately left these alone:

```
M  .claude/settings.json
M  src/components/deliveries/QuickDeliveryModal.tsx
M  src/components/purchase-orders/BulkPOImport.tsx
M  src/components/ui/CommissionSplitEditor.tsx
M  src/components/ui/UnsavedChangesModal.tsx
M  src/pages/NewDelivery.tsx
M  src/pages/NewPurchaseOrder.tsx
M  src/pages/PurchaseOrderDetail.tsx
M  src/pages/QuickReceive.tsx
M  src/pages/QuoteBuilder.tsx
?? src/pages/NewDelivery.driver-guardrail.test.tsx
?? AGENTS.md
?? .claude/hooks/
?? docs/audits/2026-04-28-phase1-final-plan.md.txt
?? docs/audits/2026-04-29-field-mapping-sprayer-map-upgrade-plan.md
?? docs/audits/_hook-test-delete-me.md
```

These look like in-flight work from before this session — they were NOT part of the Phase 1–6 scope. Recommend reviewing each before either committing or stashing.

---

## Commit chain for reference

| Phase | Commit | Migration | Test count after |
|---|---|---|---|
| 1 Step 4 (tests only) | `b9f6a98` | — | 1,830 |
| 2 (job lifecycle) | `11f248c` | `20260430150000_field_app_workflow_phase2.sql` | 1,836 |
| 3 (inventory) | `cc67b89` | `20260430160000_field_app_workflow_phase3.sql` | 1,836 |
| 4 (service fees) | `d230c3e` | `20260430170000_field_app_workflow_phase4.sql` | 1,841 |
| 5 (RLS) | `84ad5bf` | `20260430180000_field_app_workflow_phase5.sql` | 1,841 |
| 6 (UI cleanup) | `e53f8cb` | — | 1,841 |

Each commit is independently revertable. Phases 1–5 were applied to the live DB via the Supabase MCP `apply_migration` (each ran its own `DO` block self-test before returning).
