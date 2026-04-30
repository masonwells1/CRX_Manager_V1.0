# Field Application Workflow - Phase 1 Final Plan

Date: 2026-04-28
Author: Claude (Opus 4.7), final round after codex's rebuttal
Status: implementation-ready plan. NO code changes yet.

Predecessor docs:
- `docs/audits/2026-04-28-field-application-workflow-review.md` (codex's original review)
- `docs/audits/2026-04-28-field-application-workflow-response-to-codex.md` (Claude's first response)
- (codex's rebuttal — Mason summarized inline)

---

## 1. Mind change: Grouped split invoices, NOT shares-only

I changed my mind. Codex was right on #3. My shares-only argument was wrong because I drew the wrong conclusion from "AR is centralized through `invoices.balance_cents`." The correct reading is: BECAUSE AR is keyed off `invoices.customer_id`, shares-only would force rewriting every AR consumer.

### Verified evidence

- `supabase/migrations/20260404040200_get_customer_summary_rpc.sql:32-36` — canonical AR balance query:
  ```sql
  SELECT COALESCE(sum(balance_cents), 0)
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue');
  ```
- 33 frontend files reference `balance_cents` / `finance_charge` / customer-keyed AR, including:
  - `src/pages/ARaging.tsx`
  - `src/pages/CustomerDetail.tsx`
  - `src/pages/PaymentAllocation.tsx`
  - `src/components/customers/CustomerSummaryBar.tsx`
  - `src/lib/statementPdf.ts`
  - `src/components/invoices/FinanceChargePreviewModal.tsx`
  - `src/lib/financeChargeCalc.test.ts`
  - `src/lib/reconciliation.ts`
  - `src/pages/PrepaymentManager.tsx`
- `src/types/index.ts:969` already declares `invoice_group_id: string | null`
- `src/pages/InvoiceDetail.tsx:715` already renders a "Split group" link

### The pattern already exists

`supabase/migrations/20260335200000_workflow_gaps_phase3_field_billing_splits.sql` introduced:

- `invoices.invoice_group_id uuid` column (line 21-22) with index (line 24-25)
- `get_field_billing_splits_for_order()` (line 34-56)
- `get_field_billing_splits_for_blend_ticket()` (line 62-92)
- `create_split_invoices_from_order()` (line 100-238) — canonical implementation of grouped split invoices for the order-to-invoice path

The field application path was supposed to follow this pattern and didn't. We don't need to invent anything; we need to make the field app and blend ticket flows mirror what already exists for orders.

### Practical consequences

- Each customer in a multi-customer field application gets their own invoice with their own `customer_id`, `total_amount_cents`, and `balance_cents`.
- Existing AR/statement/finance-charge code keeps working unchanged.
- Statements naturally print per-customer.
- Finance charges accrue per-customer naturally.
- Audit trail (which field contributed which dollars to which customer's invoice) lives in `field_app_location_shares` keyed by `location_id`.

### Where shares apply

`invoice_shares` becomes unnecessary for new field app/blend ticket invoices. Plan:
- Stop populating it from `save_field_app_invoice` and `create_invoice_from_blend_ticket` going forward.
- Leave existing rows in place.
- Mark for eventual deprecation in `database-schema.md` once Phase 1 ships.

`field_app_location_shares` (per-location-per-customer audit) remains and IS the audit source.

---

## 2. Final Phase 1 Architecture

### 2.1 Customer derivation flow

```
selected fields
  -> for each field: read field_billing_defaults
    -> if no rows: fall back to fields.customer_id at 100%
  -> group by customer_id
  -> produce: [{ customer_id, customer_share_pct, fields_acres_by_field }]
  -> if 1 customer: create single invoice
  -> if 2+ customers: create one invoice per customer, all sharing invoice_group_id
```

### 2.2 Per-customer pricing (smart-pricing pattern)

For every (invoice, product) pair:

1. Did the client send a manual override flag with `unit_price_cents`?
   → store as `price_source = 'manual'`, use the client value
2. Else, is there a quote section linked (via `fields.quote_section_id` or `quote_sections.field_id`) with this product?
   → store as `price_source = 'quoted'`, use `quote_items.price_per_unit`
3. Else fall back to `customer.assigned_tier`:
   → 1 → `product.tier1_price`
   → 2 → `product.tier2_price`
   → 3 → `product.tier3_price`
   → store as `price_source = 'tier'`

Mirrors `create_invoice_from_blend_ticket` lines 80-108. The `price_source` CHECK constraint (`'quoted','tier','manual'`) was added in `20260405200000_smart_pricing_flow.sql:11-15`.

**Important:** the customer used at step 3 is the CURRENT customer in the loop. Customer A's invoice gets Customer A's tier; Customer B's invoice gets Customer B's tier.

### 2.3 Per-customer line item math

```
for each chemical line (per customer):
  unit_price = pricing_for(customer, product, field)
  customer_quantity = sum_over_fields(field_acres × rate × this_customer_split_pct_for_field)
  extended_cents = round(unit_price × customer_quantity)
```

For each application service fee (#8):

```
for each customer:
  fee_rate = customer_application_rates.rate_per_acre_cents
              ?? application_services.default_rate_per_acre_cents
  customer_acres = sum_over_fields(field_applied_acres × this_customer_split_pct_for_field)
  fee_extended = round(fee_rate × customer_acres)
  insert invoice_items with is_application_fee = true, price_source = 'tier'
```

Mirrors smart-pricing lines 133-158.

### 2.4 Locations and audit trail

`field_app_locations` rows are written per-invoice (one set per invoice in the group). Same field appears in every customer's invoice in the group, with `applied_acres` for that customer (`total_field_acres × this_customer_split_pct`).

`field_app_location_shares` rows are 1:1 with `field_app_locations` rows in the multi-customer case (each location belongs to exactly one customer's invoice and is 100% theirs).

Phase 1 stays per-invoice. Single-set-of-locations-per-group is a Phase 4+ refactor if Mason ever wants it.

### 2.5 Posted-invoice edit lock (#9)

RPC (top of UPDATE branch in `save_field_app_invoice`):

```sql
IF p_invoice_id IS NOT NULL THEN
  SELECT status INTO v_status FROM invoices WHERE id = p_invoice_id;
  IF v_status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot edit field app invoice with status %. Use void/reissue.', v_status;
  END IF;
END IF;
```

Frontend mirror in `FieldApplicationInvoice.tsx`:

```ts
const canEdit = isNew || (status === 'draft' || status === 'unposted');
const canDelete = canEdit;
```

For grouped invoices: posting any invoice in the group posts all of them together (recommended — see D5).

### 2.6 Idempotency result shape (M1)

All field-app-related RPCs return:

```
{ "invoice_ids": ["uuid1", "uuid2", ...] }
```

Single-invoice cases: array has one element. Grouped cases: N elements. Replay returns the same shape every time.

`create_invoice_from_blend_ticket` currently returns `uuid`. **Signature change required** — breaking change for one caller (`src/pages/BlendTicketDetail.tsx`).

### 2.7 Single-customer happy path stays simple

For "one customer, one or more fields, all owned by that customer", the resulting `invoice_ids` array has exactly one element, no `invoice_group_id`, indistinguishable from today except pricing now respects `customer.assigned_tier` (M2).

Existing E2E for single-customer field app should pass with new pricing.

---

## 3. Files Touched

### 3.1 New migration

**File:** `supabase/migrations/20260428100000_field_app_workflow_phase1.sql`

(Latest existing is `20260416100000`; today is 2026-04-28; pick `20260428100000` to leave room.)

**Pre-flight checks (in the migration's leading comment block):**

```sql
-- Run BEFORE writing this migration:
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc
--   WHERE proname IN (
--     'save_field_app_invoice',
--     'create_invoice_from_blend_ticket',
--     'derive_customer_shares_from_fields'
--   );
-- Expect EXACTLY ONE overload per function. If not, DROP all overloads first.
```

**Contents:**

1. `DROP FUNCTION IF EXISTS public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, text);`
2. `DROP FUNCTION IF EXISTS public.create_invoice_from_blend_ticket(uuid, uuid, text);`
3. `DROP FUNCTION IF EXISTS public.derive_customer_shares_from_fields(uuid[], jsonb);`
4. Recreate `derive_customer_shares_from_fields` with the no-billing-defaults fallback (CTE union per #11).
5. Recreate `save_field_app_invoice` with:
   - posted-status guard at top of UPDATE branch
   - customer derivation via updated `derive_customer_shares_from_fields`
   - per-customer invoice creation (single or grouped via `invoice_group_id`)
   - per-customer tier/quoted/manual pricing per chemical line
   - per-customer application service fee using `customer_application_rates` override → service default
   - per-invoice `field_app_locations` insert (with `applied_acres` scaled to that customer's share)
   - per-location `field_app_location_shares` insert (one row per location, 100% to that invoice's customer)
   - stop populating `invoice_shares`
   - return `jsonb_build_object('invoice_ids', jsonb_build_array(...))`
6. Recreate `create_invoice_from_blend_ticket` with:
   - same per-customer split logic via `get_field_billing_splits_for_blend_ticket`
   - same tier/quoted/manual pricing per chemical (preserve existing logic)
   - same per-customer application service fee (preserve, just split per customer)
   - return type changes from `uuid` to `jsonb` — `jsonb_build_object('invoice_ids', ...)`
   - idempotency result shape matches new shape (replace `to_jsonb(v_invoice_id)` with `to_jsonb(v_result)`)
7. Verification block at the END (mirrors `20260325100000:1012-1032` pattern):
   ```sql
   DO $$
   DECLARE func_name TEXT; overload_count INT;
     func_names TEXT[] := ARRAY['save_field_app_invoice','create_invoice_from_blend_ticket','derive_customer_shares_from_fields'];
   BEGIN
     FOREACH func_name IN ARRAY func_names LOOP
       SELECT count(*) INTO overload_count
       FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = func_name;
       IF overload_count != 1 THEN
         RAISE EXCEPTION 'VERIFICATION FAILED: % has % overloads', func_name, overload_count;
       END IF;
     END LOOP;
   END $$;
   ```
8. `GRANT EXECUTE` on each new signature to `authenticated`.

### 3.2 Frontend — modified

**`src/pages/FieldApplicationInvoice.tsx`**
- Read RPC result as `{ invoice_ids: string[] }` not `{ invoice_id: string }`
- After save: single result → `/invoices/field-app/${invoice_ids[0]}`; multiple → per D1
- Compute `canEdit = isNew || ['draft','unposted'].includes(status)`. Wire to Save and Delete buttons
- When loading existing invoice with `invoice_group_id`, fetch siblings and surface group banner
- Lines: 248-280 (RPC payload), 282-292 (result destructuring), 301-309 (delete handler), header ~327+ (banner)

**`src/components/field-app/FieldAppChemicalEntry.tsx`**
- Line 143: stop hardcoding `tier1_price`; use derived primary customer's assigned tier (component needs primary customer passed in via props)
- Add `pricing_mode` toggle on each line: `'auto'` (server decides) vs `'manual'` (user types, sent with manual flag)
- Display calculated price preview marked "preview — final amounts computed server-side"

**`src/components/field-app/CustomerSharesTable.tsx`**
- Stop computing `amount = invoiceTotalCents × split_pct / 100` (line 28) — wrong with tier differences
- Show "Final amount calculated on save" until/unless we add `preview_field_app_invoice_split` RPC (D2)

**`src/pages/BlendTicketDetail.tsx`**
- Update RPC return-type handling: `create_invoice_from_blend_ticket` now returns `{ invoice_ids: string[] }`
- Same grouped-banner handling as FieldApplicationInvoice

**`src/pages/InvoiceDetail.tsx`** (line 715 already partially handles this)
- For grouped field-app invoices: group-aware delete and post buttons; block individual post; offer "post all in group"

**`src/types/index.ts`**
- Verify `Invoice.invoice_group_id` at line 969 (it does exist)
- Add: `interface SaveFieldAppInvoiceResult { invoice_ids: string[]; invoice_group_id?: string | null; }`
- Update return-type assertions where `assertRpcResult<{invoice_id: string}>` is used today

### 3.3 Tests

**New unit tests:**
- `src/tests/save_field_app_invoice.split.test.ts` — RPC contract:
  - Single customer, single field → 1 invoice, no group_id
  - Single customer, two fields → 1 invoice
  - Two customers (50/50), one field → 2 invoices, same `invoice_group_id`, totals add to source
  - Two customers, one field with `field_billing_defaults` missing for one → fallback to `fields.customer_id`
  - Posted invoice in UPDATE branch → raises
  - Idempotent replay → same `invoice_ids`
- `src/tests/create_invoice_from_blend_ticket.split.test.ts` — same matrix against blend tickets
- `src/tests/idempotency-shape.test.ts` — both RPCs return `{ invoice_ids: string[] }` shape

**Updated unit tests:**
- `src/tests/workflow-gaps-safety.test.ts:38-42` — broaden to assert grouped field-app invoices share `invoice_group_id`

**E2E (Playwright) — new:**
- `tests/e2e/workflow-field-app-multi-customer.spec.ts`
  - Setup: `[E2E] Farm Alpha` (tier 1) + `[E2E] Farm Beta` (tier 3), one shared field with 60/40 split, one product with different tier prices
  - Action: create direct field app invoice; verify two invoices with correct per-customer totals; verify shared `invoice_group_id`
  - Action: attempt edit on a posted invoice → see denial
  - Cleanup via globalTeardown `[E2E]` prefix protocol

**E2E — updated:**
- `tests/e2e/mega-workflow.spec.ts` — verify single-customer field app step still passes with tier-aware pricing and new return shape

### 3.4 Docs

- `docs/reference/database-schema.md` — `invoice_shares` deprecation note; `field_app_location_shares` as canonical audit; `field_app_locations` per-invoice clarification
- `docs/reference/rpc-functions.md` — updated signatures and return shapes; `derive_customer_shares_from_fields` fallback documented
- `docs/reference/migration-history.md` — entry for `20260428100000_field_app_workflow_phase1.sql`
- `docs/workflows/QUOTE_TO_DELIVERY.md` — multi-customer field app section; posted invoice lock
- `docs/CHANGELOG.md` — sprint entry summarizing Phase 1 scope
- `CLAUDE.md` — migration count → 247; doc-drift sync (table at bottom still says 196); business-logic addition

---

## 4. What Codex Changed Its Mind On — Whether I Agree

| Codex's mind change | My take |
|---|---|
| #4 `start_job()` is Critical, not High | AGREE. Phase 2 territory. |
| #13 `field_app_location_shares` is High, not Medium | AGREE. Folded into Phase 1. |
| #5 jobs stay single-customer; nullable was a mistake | AGREE. Phase 2 reverts the NOT NULL drop. |
| #2 reuse smart-pricing pattern, don't reinvent | AGREE. This plan does exactly that. |
| M1-M7 confirmed (qualified on M1) | AGREE. M1 qualification addressed by accepting the breaking change for blend ticket return type. |

**Where I changed MY mind:**
- #3 grouped split invoices (NOT shares-only). Documented in §1 with evidence.
- M1 qualification: I now recommend changing `create_invoice_from_blend_ticket` return type from `uuid` to `jsonb`. One-call-site breaking change. Worth it.

---

## 5. Open Decisions for Mason

### D1. UI for navigating between grouped invoices

When a user finishes a multi-customer save, where do we land them?
- **(a)** First invoice in the group at `/invoices/field-app/{first_id}` with banner showing siblings. Simple.
- **(b)** New combined view at `/invoices/field-app/group/{group_id}` side-by-side. More work.
- **(c)** `/invoices?group={group_id}` filter on existing list view. Cheap.

**Recommend (a) for Phase 1.** (b) can be a follow-up.

### D2. Pre-save pricing preview

Once pricing moves to the server, the user can't see per-customer amounts until save.
- **(a)** Live preview RPC: `preview_field_app_invoice_split(p_locations, p_chemicals)` called on every change. Gold-plated.
- **(b)** "Preview" button calling the RPC on demand.
- **(c)** No preview — "Final amounts on save" placeholder.

**Recommend (b) for Phase 1.**

### D3. Field-level price overrides

Codex referenced "field price override" in the original review. I did **not** verify this column exists on `fields` (could be `fields.price_override`, a separate table, or aspirational).

- If exists today: pricing logic in §2.2 needs step 1.5 (field override) between manual and quoted.
- If not: skip; Phase 1.5 if Mason needs it.

**Mason: confirm whether per-field price overrides exist today. Point to column/table if so.**

### D4. `invoice_shares` deprecation

Codex's plan keeps it populated for backward compat. I argue stop populating because:
- Not read by anything in AR/statement path (just by the field app invoice page itself, which we're rewriting).
- Keeping it in sync with `field_app_location_shares` doubles write logic and creates drift risk.
- Existing rows preserved; only new invoices skip it.

**Mason: confirm OK to stop populating `invoice_shares` for new invoices. (Existing rows untouched.)**

### D5. Posted-group lock semantics

When ONE invoice in a group is posted, what happens to siblings?
- **(a)** Block — admin must explicitly post each one (most defensive).
- **(b)** Auto-cascade — posting one posts all (matches "they're one logical event").
- **(c)** Allow independent posting — each customer's invoice has its own lifecycle.

**Recommend (b)**. But if Mason closes month-end periods at different times for different customers, this is wrong and (a) is correct. **Confirm.**

---

## 6. Phase 1 Acceptance Criteria

Phase 1 is done only when:

- [ ] Single-customer field app invoice: 1 invoice, customer's tier respected, `field_app_location_shares` populated, returns `{invoice_ids:[...]}` shape
- [ ] Multi-customer (2+): N invoices with shared `invoice_group_id`, each with that customer's tier price, totals add to source × split_pct
- [ ] Field with no `field_billing_defaults` falls back to `fields.customer_id` at 100%
- [ ] Manual override → `price_source = 'manual'`
- [ ] Quote-section linked → `price_source = 'quoted'`
- [ ] Application service fee per-customer using `customer_application_rates` override fallback to service default
- [ ] `is_application_fee = true` set on fee items (M3)
- [ ] Posted invoice cannot be edited via RPC (raises) or via UI (button disabled)
- [ ] `create_invoice_from_blend_ticket` returns `{invoice_ids:[...]}` matching shape
- [ ] Idempotent replay returns identical `invoice_ids`
- [ ] All three RPCs have exactly one overload (verified by post-migration `DO $$` block)
- [ ] E2E: multi-customer save → two invoices with shared group; post one → all post (per D5); edit posted → blocked
- [ ] E2E: existing single-customer mega-workflow still passes
- [ ] Doc updates landed: schema, RPCs, migration history, CHANGELOG, CLAUDE.md counts

---

## 7. Out of Scope for Phase 1

- Multi-field application records (#6) → Phase 2
- `start_job()` and job lifecycle repair (#4) → Phase 2
- `jobs.customer_id` revert to NOT NULL (#5) → Phase 2
- Inventory completion behavior (#7) → Phase 3
- Application services on `jobs` (the field-app-invoice and blend-ticket parts ARE in Phase 1; the jobs part waits for Phase 2)
- RLS hardening (#10) → Phase 5
- Field picker map UX (#12) → Phase 6
- Doc count drift (M6) — sync at end of Phase 1 commit

---

## 8. Implementation Order Within Phase 1

Suggested commit sequence (each commit individually green per pre-commit hook):

1. **Migration draft** + types update + idempotency shape unification (compiles, tests fail)
2. **Backend RPC implementation** — full smart pricing + grouped split + posted lock + fee fold-in (RPC contract tests pass)
3. **Frontend RPC adaptation** — accept new shape, navigation handling, posted-invoice gates (existing E2Es pass)
4. **New multi-customer E2E** — covers happy path and posted-edit denial
5. **Doc updates** + CLAUDE.md sync + reference doc updates

Total scope: 1 migration, ~6 frontend files, ~3 new tests, ~5 doc files. One focused PR.

---

## 9. Bottom Line

This plan:
- Adopts codex's grouped-split-invoice approach (I changed my mind, with evidence).
- Reuses the existing `create_split_invoices_from_order` pattern from `20260335200000` instead of inventing anything.
- Bundles fixes for #1, #2, #3, #9, #11, #13, M1, M2, M3 into a single migration.
- Keeps the single-customer happy path simple and backward-compatible (only pricing math changes — same shape).
- Has five Mason-decisions in §5 to answer before the migration is written.

Once Mason answers D1-D5, the next agent can write the migration in one focused session, with the verification block protecting against overload drift.

---

## 10. Verification Run (Session End)

Verification commands run at end of planning session (no code changes made):
- `npm run typecheck` → 0 errors
- `npm run build` → clean (built in 26.59s, 143 PWA precache entries)
- `npm run lint` → 0 errors, 2 pre-existing a11y warnings in `FieldAppChemicalEntry.tsx:178,204` (those lines slated for rewrite in Phase 1 anyway)

Codebase state at session end matches session start. No regressions introduced.