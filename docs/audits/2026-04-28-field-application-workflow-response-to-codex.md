# Response to Codex's Field Application Workflow Review

Date: 2026-04-28
Author: Claude (Opus 4.7), responding to Codex's review at `docs/audits/2026-04-28-field-application-workflow-review.md`
Status: read-only verification pass. No app code changed.

## TL;DR

Codex got the diagnosis mostly right. I verified all 14 claims against the actual code and migrations. Most are real bugs. But several recommendations need refinement, and codex missed a few things that should be in scope for the same fix wave.

Below: every claim, marked AGREE / AGREE-WITH-REFINEMENT / PUSH-BACK, with verification notes. Then a section on what codex missed. Then a counter-proposal for the fix order.

---

## Per-Claim Verification

### Claim #1 (CRITICAL): Field app invoice may fail because `customer_id` is missing

**Verdict: AGREE (verified).**

`FieldApplicationInvoice.tsx:248-280` — the RPC payload `p_invoice` has `invoice_number`, `invoice_date`, `salesman_id`, `header_notes`. There is no `customer_id` field.

`20260406100000_field_app_workflow_v2.sql:189-202` — `INSERT INTO invoices (... customer_id ...) VALUES (..., (p_invoice->>'customer_id')::uuid, ...)`. That cast on a missing key returns NULL.

`invoices.customer_id` is `NOT NULL` from `20260213100000_phase2_billing_architecture.sql:45` (codex's reference is correct).

The RPC tries to set `customer_id` after deriving shares (line 298-306), but the INSERT happens first and will fail with a NOT NULL violation. This blocks the entire direct field app invoice flow, full stop.

**One refinement to codex's fix:** don't just derive primary customer before insert and call it done. Use the same logic that lives in `derive_customer_shares_from_fields` to pick the primary, and store BOTH the primary on `invoices.customer_id` AND populate `invoice_shares` AND populate `field_app_location_shares` (see #13). That way the data is consistent regardless of which table you query later.

---

### Claim #2 (CRITICAL): Browser-calculated chemical totals ignore tiers and overrides

**Verdict: AGREE (verified), with one important refinement.**

`FieldAppChemicalEntry.tsx:143` — `unit_price_cents: Math.round((product.tier1_price || 0) * 100)` — hardcoded tier 1, not even checking the customer's `assigned_tier`. Even single-customer field app invoices are tier-broken, not just multi-customer.

`CustomerSharesTable.tsx:28` — `const amount = Math.round(invoiceTotalCents * sh.split_pct / 100)` — flat percentage of the whole invoice.

`save_field_app_invoice` lines 264-292 — RPC uses `(v_chem->>'extended_cents')::bigint` from the client and trusts it. Same for shares: `v_invoice_total_cents * (v_share->>'split_pct')::numeric / 100.0` — flat split.

**Refinement to codex's recommendation:** Codex says "browser-supplied price does not override server-calculated price unless an authorized manual override exists." That contradicts the existing design in `20260405200000_smart_pricing_flow.sql` which intentionally supports manual overrides via `invoice_items.price_source IN ('quoted','tier','manual')`. The fix should reuse the smart-pricing pattern, not invent a new one:

- If `unit_price_cents` is provided by the client and explicitly flagged as manual override, store as `manual`
- Else if a quote section exists for this field/product, use quote price (`quoted`)
- Else fall back to customer tier price (`tier`)

That is already how `create_invoice_from_blend_ticket` works. The field app RPC should be made to mirror it. Codex didn't notice the answer was already in the codebase.

**Bigger gap codex missed for this claim:** the share math itself is wrong even if you fix tier pricing. With multi-customer fields, the correct split is per-product-per-field-per-customer:

```
customer_share = sum_over_fields(
  field.applied_acres
    * product.rate_per_acre
    * customer_unit_price_for(customer.tier, field.price_override)
    * field_billing_default.split_pct[customer]
)
```

A flat percentage of the whole invoice can't capture field-level price overrides because the base price differs per field. Codex's recommendation is correct in spirit; the algorithm needs to be spelled out.

---

### Claim #3 (CRITICAL): Blend ticket direct invoice lost split billing

**Verdict: AGREE (verified).**

`20260405200000_smart_pricing_flow.sql:62-69` — `INSERT INTO invoices (..., customer_id, ...) VALUES (..., v_ticket.customer_id, ...)`. Single customer. No `invoice_shares`.

`20260405200000_smart_pricing_flow.sql:99-104` — uses `v_customer.assigned_tier` for ALL line items, regardless of which field they're for.

So a blend ticket touching three customers' fields bills 100% to whoever happens to be on the ticket header. Codex is right.

**Refinement:** Codex offers two options (split invoices per customer OR one invoice with shares). I'd push hard for one invoice with `invoice_shares` + `field_app_location_shares` to match the field app invoice flow. Reasons:

1. AR is already centralized through `invoices.balance_cents`. Splitting invoices forks AR into multiple records per real-world transaction.
2. Mason's customer report logic and statement printing will have to handle BOTH shapes if you go split-invoice for blend tickets and shared-invoice for direct field apps. Pick one.
3. `invoice_shares` already exists with the right shape.

If Mason wants per-customer printable invoices for landlord/tenant, that's a presentation concern (split-PDF), not a database concern.

---

### Claim #4 (HIGH): No `start_job()` function exists

**Verdict: AGREE (verified, and worse than codex described).**

I grepped all migrations and all `src/`. `start_job` does not exist anywhere. Not as a function, not as a UI handler, not as an RPC call.

`complete_job` requires `in_progress` (line 67-69 of sprint1 migration). `JobDetail.tsx:527` has `canEdit = isEditable && (isNew || status === 'scheduled' || status === 'in_progress')` and `canComplete = !isNew && status === 'in_progress'` — but no button anywhere calls `start_job` or transitions the status. `save_job` doesn't transition state either.

Jobs are literally unfinishable end-to-end through the documented flow. That should be a P0, not a P1. Codex put this at "High" — I'd push it up to Critical alongside #1-3.

**Refinement:** Codex offers two options. I'd lean toward adding `start_job()` as an RPC (not allowing scheduled to completed direct), because:

- The state machine has a reason: `in_progress` represents "applicator is in the field"
- The applicator app UI needs a "Start" button anyway (start time, start weather, start mileage capture)
- Going scheduled to completed bypasses any chance for mid-application capture
- Idempotency is cleaner with an explicit transition

The `job_applied_info` table already supports this (actual_start_time vs actual_end_time).

---

### Claim #5 (HIGH): Multi-customer jobs are half-built

**Verdict: AGREE (verified).**

`20260406100000_field_app_workflow_v2.sql:6` — `ALTER TABLE jobs ALTER COLUMN customer_id DROP NOT NULL`.

`JobDetail.tsx:314` — `if (!customerId) { toast('error', 'Customer is required'); return; }`.

`JobDetail.tsx:298` — `customerFields = allFields.filter(f => !customerId || f.customer_id === customerId)` — filters fields to one customer.

`src/types/index.ts:1655` (per codex) — `Job.customer_id` typed as `string`.

**Push-back on codex's "decide one path" framing:** Codex presents A and B as equally weighted. I think Option A (keep jobs single-customer) is the right call, and the schema change (NOT NULL drop) was a mistake. Reasons:

1. Multi-customer billing already has a home: the direct field app invoice flow and the blend ticket flow.
2. Jobs represent work, not billing. A single applicator + vehicle + spray date is a single operational event. Splitting that across customers in the job table conflates ops and billing.
3. The "share derivation" logic belongs at invoice-time, regardless of how many customers a job touched. The field's `field_billing_defaults` already handles that.
4. JobDetail's UI is built for one customer. Refactoring to multi-customer is a much bigger lift than re-NOT-NULL'ing the column.

**Recommended fix:** add a follow-up migration to restore `NOT NULL` on `jobs.customer_id`, and keep the multi-field selection inside the existing single-customer-job constraint. Customer splits are derived from the fields' billing defaults at invoice time, not from the job header.

---

### Claim #6 (HIGH): Application records lose multi-field detail

**Verdict: AGREE (verified).**

`complete_job` line 168: `(SELECT field_id FROM job_fields WHERE job_id = p_job_id ORDER BY sort_order LIMIT 1)`. Silent data loss for any job touching more than one field.

`v_job.total_acres` (line 171) is the job total, not per-field. So even if you fixed the FK, the acres column would still misrepresent each field's actual acres.

**Refinement:** Codex offers "one record per field OR a join table." I lean strongly toward a join table (`application_record_fields`):

| pro | join table | record-per-field |
|-----|------------|-------------------|
| One operational event = one record | yes | no — duplicates weather/applicator/start time |
| Field history query by field_id | yes (via join) | yes |
| EPA/RUP reporting per record | yes | duplicated rows |
| `application_records.id` referenced elsewhere | unaffected | breaks any existing FKs |

The join table also lets you store per-field acres and per-field notes naturally:

```sql
CREATE TABLE application_record_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_record_id uuid NOT NULL REFERENCES application_records(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES fields(id),
  acres_applied numeric(12,2),
  field_notes text,
  sort_order integer DEFAULT 0
);
```

`FieldDashboard.tsx` then reads via this join.

---

### Claim #7 (HIGH): Inventory completion can block real work AND moves prebooked stock incorrectly

**Verdict: AGREE (verified). This is a sneaky one.**

Lines 84-89: throws an exception if any chemical doesn't have enough `quantity_available`. If field work already happened, this blocks recording the truth.

Lines 189-193: `quantity_prebooked = GREATEST(quantity_prebooked - v_chem.quantity, 0)`. This subtracts from prebooked unconditionally, with no proof the job was tied to a specific prebooked order/quote.

If Customer A has a 100-gallon prebook for spring herbicide, and Customer B's job applies 50 gallons of the same product without being tied to A's order, Customer A's prebook just got silently halved. That's exactly the kind of "leak" that breaks net-free inventory math downstream.

**Refinement to codex's fix:**

1. Allow completion with negative inventory but write a flagged `inventory_transactions` row (something like `transaction_type = 'job_applied'` with a `requires_review = true` flag, or a separate `inventory_exceptions` table). The application happened in the field; the database has to record reality.
2. Only decrement `quantity_prebooked` when the job is linked to a specific source — e.g. `jobs.quote_section_id` exists, OR a new `jobs.source_order_id` column. Otherwise leave prebooked alone and just decrement `quantity_available` (going negative if needed).
3. Add a trigger or check: never let `quantity_prebooked` go negative. Already partly handled by `GREATEST(..., 0)` but the underlying issue is that the wrong customer's hold is being touched.

---

### Claim #8 (HIGH): Application service fees are inconsistent

**Verdict: AGREE (verified).**

`20260405200000_smart_pricing_flow.sql:18` — `application_service_id` lives on `blend_tickets`.

`20260405200000_smart_pricing_flow.sql:133-158` — blend ticket invoicing computes service fee with `customer_application_rates` override → service default rate.

`save_field_app_invoice` and `save_job` — neither accepts `application_service_id`, neither computes a service fee.

**Refinement (codex missed something):** The blend ticket flow already has a working pattern (rate override → service default → multiply by acres → insert with `is_application_fee = true`). The fix should be to:

1. Add `application_service_id` to `field_app_locations` (per-field) OR to the invoice header.
2. Add `application_service_id` to `jobs`.
3. Reuse the exact fee-calculation block from `create_invoice_from_blend_ticket` in both `save_field_app_invoice` and `complete_job` (or extract it into a helper RPC like `compute_application_service_fee(p_service_id, p_customer_id, p_acres, p_season)`).

Per-field service ID is more flexible (different fields can use different services in the same multi-field application), but per-invoice/per-job is simpler. I'd start per-job/per-invoice and revisit if Mason needs per-field.

---

### Claim #9 (HIGH): Posted field app invoices can be rewritten

**Verdict: AGREE (verified).**

`save_field_app_invoice` lines 213-216:

```sql
DELETE FROM field_app_locations WHERE invoice_id = v_invoice_id;
DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;
DELETE FROM invoice_shares WHERE invoice_id = v_invoice_id;
```

No status check. A posted invoice can have its lines/shares rewritten, which would silently change `total_amount_cents` and break the financial audit log.

`FieldApplicationInvoice.tsx:301-309` — soft-delete via `update({ deleted_at: ... })` also has no status check.

**Refinement:** Add to the RPC at the top of the UPDATE branch:

```sql
SELECT status INTO v_existing_status FROM invoices WHERE id = p_invoice_id;
IF v_existing_status NOT IN ('draft', 'unposted') THEN
  RAISE EXCEPTION 'Cannot edit invoice with status %. Use void/reissue instead.', v_existing_status;
END IF;
```

For frontend: `canEdit = invoice.status IN ('draft', 'unposted')` AND disable the delete button when posted. Both layers needed — frontend gate is UX, RPC gate is the actual safety net.

---

### Claim #10 (HIGH): RLS lets too much field/job data be changed

**Verdict: AGREE (verified, with refinement).**

`20260215200000_job_scheduling_tables.sql:138-141`:

```sql
CREATE POLICY jobs_update ON jobs
  FOR UPDATE TO authenticated
  USING (... OR (is_applicator() AND applicator_id = (SELECT auth.uid())))
  WITH CHECK (... OR (is_applicator() AND applicator_id = (SELECT auth.uid())));
```

Applicator can `UPDATE jobs SET customer_id = ..., total_price = ...`. RLS doesn't restrict columns.

`job_applied_info_insert` (lines 205-208): `is_applicator()` alone — doesn't check the applicator owns the job.

**Refinement:** Codex says "use RPCs only" — I'd add nuance:

1. Restrict `jobs UPDATE` to admin/sales_rep only (drop the applicator branch). Field workflow (start/complete/applied info) goes through RPCs.
2. `job_applied_info_insert` needs the `EXISTS` check that `job_chemicals_select` has — i.e. the row's `job_id` must belong to a job assigned to the applicator.
3. The RPCs themselves (`start_job`, `complete_job`, `save_job_applied_info`) should re-verify `auth.uid() = job.applicator_id` for applicator role. Belt-and-suspenders.

Don't go column-level grants — too much ceremony for this codebase. Just route applicator writes through RPCs and tighten the table policies.

---

### Claim #11 (MEDIUM): Fields without billing defaults produce no shares

**Verdict: AGREE (verified).**

`derive_customer_shares_from_fields` line 95-107: `INNER JOIN field_billing_defaults fbd ON fbd.field_id = fd.field_id`. No fallback. A field with zero billing defaults rows contributes zero share rows.

For new fields where the user hasn't configured splits yet, the invoice would either fail or have empty shares.

**Refinement:** Codex's fix is correct (fall back to `fields.customer_id` at 100%). The fallback should be in the SQL CTE:

```sql
billing AS (
  SELECT ... FROM field_data fd JOIN field_billing_defaults fbd ...
  UNION ALL
  SELECT
    f.customer_id,
    c.farm_name,
    c.assigned_tier,
    100.0 AS split_pct,
    true AS is_primary,
    fd.field_id, fd.field_name, fd.applied_acres,
    fd.applied_acres AS share_acres
  FROM field_data fd
  JOIN fields f ON f.id = fd.field_id
  JOIN customers c ON c.id = f.customer_id
  WHERE NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = fd.field_id)
)
```

---

### Claim #12 (MEDIUM): Field picker map is misleading

**Verdict: AGREE on map; AGREE on double-toggle (and stronger than codex stated).**

Map (line 145-148): `<FieldBoundaryLayer fields={selectedFields} ... />` — only draws selected fields. So before you select anything, the map is empty. Confusing for a map-driven workflow. Codex right.

Looking at `SelectLocationsModal.tsx:225-237`:

```tsx
<tr ... onClick={() => toggleField(f.id)}>
  <td>
    <input type="checkbox" checked={...} onChange={() => toggleField(f.id)} />
```

When you click the checkbox, you do get a double fire (the click event bubbles to the row's onClick AND the checkbox's onChange). So codex is right, but their "may double-toggle" is too soft — it definitely double-toggles. Fix is `onClick={(e) => e.stopPropagation()}` on the checkbox cell, or remove the row onClick and rely on the checkbox alone.

For the map: pass `fields={filtered}` and a separate `selectedIds` prop to highlight selected. Click-to-select on the map adds a nice second interaction path. This is a real UX improvement, not just polish.

---

### Claim #13 (MEDIUM): `field_app_location_shares` is unused

**Verdict: AGREE (verified). Should be HIGHER priority than codex marked.**

The table exists (migration line 43-67). No INSERT statements anywhere in `supabase/migrations/` or `src/` reference it. `save_field_app_invoice` inserts `invoice_shares` (aggregated) only.

**Push-back on severity:** Codex marks this medium. I'd push it up to High because:

- Without per-location shares, you can't audit which field contributed which dollars to which customer
- That makes printable customer-specific statements (which Mason will eventually want) impossible
- The fix is small — fold it into Phase 2 (billing math unification) at near-zero cost
- The aggregated `invoice_shares` rows can be DERIVED from `field_app_location_shares` at write time, so the math stays consistent

This isn't a "maybe populate it" — it's the natural source of truth for the per-location-per-customer breakdown.

---

### Claim #14 (LOW): Job lifecycle E2E can hide completion failures

**Verdict: AGREE.** Tests that skip on the exact failure they should catch are anti-tests. Codex's fix is right.

But: this is downstream of fixing `start_job()`. Once #4 lands, the test should be straightforwardly fixable.

---

## What Codex Missed

These are real issues in the same surface area that the codex review didn't flag. They should be folded into the same fix wave.

### M1. Idempotency result shapes are inconsistent

`create_invoice_from_blend_ticket` stores `to_jsonb(v_invoice_id)` (just a UUID, replayed as `RETURN v_existing::uuid`).

`save_field_app_invoice` stores `jsonb_build_object('invoice_id', ..., 'invoice_total_cents', ..., 'total_applied_acres', ...)` (rich object).

A retry of the blend ticket flow gets back a UUID; a retry of the field app flow gets back an object. Frontend code calling `assertRpcResult<{ invoice_id: string }>` on the blend ticket flow would fail on retry. Same surface area, same kind of bug.

**Fix:** Standardize all field-app-related RPCs to return `jsonb_build_object('invoice_id', ...)` minimum. Update the blend ticket replay branch to wrap the cached UUID in the same shape.

### M2. Frontend hardcodes `tier1_price` even for single-customer non-split invoices

This is part of #2 but worth calling out separately: even when there's exactly one customer, the field app invoice ignores their assigned tier. Mason might have noticed wrong amounts on simple single-customer field apps and assumed it was a split-billing thing. It isn't — it's a tier thing.

### M3. `is_application_fee` column already exists but `save_field_app_invoice` doesn't set it

`invoice_items.is_application_fee` is set by `create_invoice_from_blend_ticket` (line 150) but never set by `save_field_app_invoice`. If you fix #8 by adding service fees to the field app flow, remember to set this column. Otherwise reports that filter on `is_application_fee` will undercount.

### M4. `complete_job` assumes a single warehouse

Lines 81, 193: `WHERE product_id = ... AND location = 'Main Warehouse'`. Hardcoded location. If Mason ever adds a second warehouse, every chemical gets deducted from Main even if it came from elsewhere. Not blocking now, but worth noting in the audit doc so it doesn't get baked into the rewrite.

### M5. Migration safety: function overload check before merging Phase 2

CLAUDE.md mandates checking for function overloads before rewriting RPCs. The Phase 2 migration WILL touch `save_field_app_invoice`, `derive_customer_shares_from_fields`, `create_invoice_from_blend_ticket`, possibly add `start_job` and a multi-field application_record_fields helper. The agent doing the work needs to:

1. Run `SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname IN (...)` first.
2. `DROP FUNCTION IF EXISTS` for each existing signature before `CREATE OR REPLACE`.
3. Verify the post-migration overload-count assertion (like `20260325100000` does at line 1012-1032).

Codex mentions this generically but doesn't attach it to specific functions.

### M6. Stale doc count drift confirmed

CLAUDE.md says 63 pages, 246 migrations. The reference table at the bottom says 196 migrations and 56 pages. Codex caught this — agreed. Should be re-synced as part of Phase 6.

### M7. The blend-ticket flow's `quoted_price` lookup is fragile

`create_invoice_from_blend_ticket` lines 86-89:

```sql
SELECT qi.price_per_unit INTO v_qi_price
FROM quote_items qi
WHERE qi.section_id = v_quote_section_id AND qi.product_id = v_item.product_id
LIMIT 1;
```

`LIMIT 1` with no `ORDER BY` is non-deterministic if a section has duplicate product rows. Probably rare in practice, but worth a note: when the field app flow is unified with this, use `ORDER BY qi.id` or aggregate the price.

---

## Counter-Proposal: Fix Order

I largely agree with codex's six phases but want to re-rank severity and merge two phases:

### Phase 1 (now Critical, was Critical): Make the field app invoice flow correct end-to-end

Combines codex's Phases 1 and 2 — they're the same flow, no point splitting.

- Fix #1 (customer_id missing on insert) — REQUIRED for anything else to work
- Fix #2 (tier-aware pricing) — reuse smart-pricing pattern from blend ticket flow
- Fix #3 (blend ticket loses splits) — same fix shape as #2, do them in one migration
- Fix #11 (fallback share when no billing defaults)
- Fix #13 (populate `field_app_location_shares` from defaults at write time)
- Fix #9 (block edits on posted invoices, server + client)
- M1 (idempotency result shape consistency)
- M2/M3 (tier-aware single-customer + `is_application_fee`)

Acceptance: a direct field app invoice and a blend ticket invoice both compute correct per-customer amounts using tier + override + service fee, store consistent shares at both invoice and per-location levels, and refuse to be edited once posted.

### Phase 2 (was Critical-grade, codex marked High): Repair job lifecycle

- Fix #4 (`start_job()` RPC + UI button)
- Fix #5 (revert `jobs.customer_id` to NOT NULL — Option A)
- Fix #6 (`application_record_fields` join table; rewrite `complete_job` to insert one record + N field rows)
- Fix #14 (E2E test no longer skips on failure)

Acceptance: scheduled to in_progress to completed transition works through the UI, multi-field jobs produce one application record visible on every treated field's history, E2E covers the happy path deterministically.

### Phase 3 (High): Inventory completion behavior

- Fix #7 (allow low-stock completion with audit row, only decrement prebooked when the job has a real reservation linkage)
- Decide: add `jobs.source_order_id` to express that linkage explicitly, or rely on `jobs.quote_section_id` to `quotes.id` to `inventory_holds.source_id`?

Acceptance: applicator can complete a job that ran short on inventory; unrelated customer prebooks are untouched; every applied chemical has exactly one inventory_transactions row.

### Phase 4 (Medium): Application service fees on every flow

- Fix #8 (carry `application_service_id` on jobs and field app invoices, compute fee in RPC)
- Reuse the smart-pricing fee block from `create_invoice_from_blend_ticket`

Acceptance: a Y-Drop job and a Hagie blend ticket and a direct field app invoice all charge the right fee with the right customer override.

### Phase 5 (Medium): RLS hardening

- Fix #10 (jobs UPDATE admin/sales only, job_applied_info insert checks job ownership)

Acceptance: applicator role can complete an assigned job through the RPCs only, cannot mutate price/customer/applicator via direct table writes.

### Phase 6 (Low): UI + docs cleanup

- Fix #12 map and double-toggle (split: map fix is small, double-toggle fix is one-line)
- M6 doc count sync
- M4 single-warehouse note (don't fix, just document)
- M5 overload-check protocol referenced in each prior phase's plan

---

## Open Questions for Mason

These should be answered BEFORE Phase 1 starts, because they change the shape of the migration:

1. One invoice with shares, or split invoices per customer? I argue one-invoice-with-shares (see #3). What does Mason actually want printed?
2. Single-customer jobs forever, or finish multi-customer? I argue single-customer (see #5). Confirm.
3. Field price overrides — per-field-per-product, per-field flat, or per-field-per-customer? Codex assumes they exist but doesn't specify the shape. The current schema has `fields.price_override`-ish columns I haven't fully traced. Phase 2 design needs this nailed down.
4. Application service per-field or per-invoice/per-job? I argue per-job/per-invoice for simplicity. Confirm.
5. Low-stock completion — block, warn, or silent-allow with audit? I argue allow + audit row + admin notification. Confirm.

---

## Suggested First-Phase Acceptance (more specific than codex's)

Phase 1 is done only when:

- [ ] `save_field_app_invoice` accepts and uses `customer_id` derivation from selected fields' billing defaults (with fallback to `fields.customer_id` for unconfigured fields)
- [ ] Tier pricing is applied per-customer-per-product server-side; client-supplied prices only honored when explicitly marked `manual` (matches blend ticket pattern)
- [ ] `field_app_location_shares` populated for every invoice at save time
- [ ] `invoice_shares` totals equal sum of `field_app_location_shares` totals (assert in test)
- [ ] `create_invoice_from_blend_ticket` produces `invoice_shares` and `field_app_location_shares` matching the same logic
- [ ] Posted invoice cannot be edited via RPC (raises) or via the page (button disabled, RPC re-blocks if called directly)
- [ ] All three RPC idempotency cache results return the same shape (`jsonb_build_object('invoice_id', ...)`)
- [ ] E2E: create direct field app invoice with two customers and two fields, save, post, attempt edit, see denial
- [ ] E2E: create blend ticket invoice with two customers across two fields, verify shares correct
- [ ] No regressions on single-customer single-field happy path (existing test passes)
- [ ] Doc updates: `database-schema.md` reflects `field_app_location_shares` is populated, `rpc-functions.md` documents new pricing logic, CLAUDE.md page/migration counts re-synced

---

## What I Did NOT Verify

To keep this review tractable, I did NOT verify:

- The exact contents of `invoice_shares` / `field_app_location_shares` columns and constraints beyond what's in the migration text shown above
- Whether `field_billing_defaults` has the columns codex assumes (`split_pct`, `is_primary`, `customer_id`, `field_id`)
- Whether `application_services` and `customer_application_rates` schemas are stable (codex referenced them; I trust the migration code)
- The full call graph of `save_job` — I read only the first ~40 lines plus the relevant snippet
- Frontend tests for the field app flow (whether they currently exist and pass)
- Whether the current `jobs.quote_section_id` linkage is reliably populated

If any of those assumptions are wrong, several recommendations need adjustment.

---

## Bottom Line

Codex did solid diagnostic work. Their severity ranking under-weights the job lifecycle break (#4) and the unused-shares-table issue (#13). Their fix recommendations sometimes invent new patterns when the codebase already has working ones (smart pricing). And the framing of multi-customer jobs as a coin-flip between Option A and B isn't right — the schema change to nullable `jobs.customer_id` was a mistake and should be reverted.

If Mason approves this counter-proposal, the next agent should start Phase 1 (combined fix for #1, #2, #3, #9, #11, #13, M1-M3) as a single migration + one frontend PR. Phase 2 (jobs lifecycle) should be a separate change because it touches different tables and has different test surface.
