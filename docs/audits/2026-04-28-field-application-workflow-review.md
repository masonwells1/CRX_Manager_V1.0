# Field Application Workflow Review

Date: 2026-04-28

Status: read-only review. No app code was changed for this review.

Audience: Mason Wells and follow-on coding agents.

## Executive Summary

The field/application workflow is not ready to trust for billing yet.

The biggest risks are business workflow problems, not code style. The app has several ways to create application-related invoices, but they do not all calculate customer splits, service fees, customer pricing tiers, inventory movement, and application records the same way.

In plain English: a field application can be recorded or billed from a direct field app invoice, a job, or a blend ticket. Those paths should all agree on who gets billed, what acres were applied, what products moved out of inventory, and what the invoice total should be. Today, those paths are inconsistent.

The highest priority is to make the billing math happen in PostgreSQL RPCs, not in the browser, and to settle one clear workflow for:

1. Field setup and billing splits.
2. Job or blend ticket creation.
3. Application completion.
4. Application record creation.
5. Inventory movement.
6. Customer split billing.
7. Invoice posting.

## Scope Reviewed

Primary files and areas reviewed:

- `AGENTS.md`
- `CLAUDE.md`
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
- `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`
- `docs/workflows/QUOTE_TO_DELIVERY.md`
- `docs/workflows/INVENTORY_RULES.md`
- `docs/workflows/RLS_SECURITY_GUIDE.md`
- `docs/workflows/UI_PATTERNS.md`
- `docs/reference/database-schema.md`
- `docs/reference/rpc-functions.md`
- `docs/reference/migration-history.md`
- `docs/reference/pages-routes.md`
- `docs/reference/code-patterns.md`
- `docs/reference/qa-testing.md`
- `docs/plans/2026-04-06-field-app-workflow-v2-design.md`
- `docs/plans/2026-03-29-field-management-v2-design.md`
- `docs/plans/2026-03-31-field-management-v3-design.md`
- `docs/plans/2026-03-23-blend-ticket-system-full-plan.md`
- `docs/plans/2026-03-29-blend-ticket-phase1-implementation.md`
- `docs/plans/2026-03-31-workflow-gaps-remediation-design.md`
- `docs/plans/2026-04-04-blend-ticket-enhancements-design.md`
- `src/pages/Fields.tsx`
- `src/pages/FieldSetup.tsx`
- `src/pages/FieldDashboard.tsx`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/Jobs.tsx`
- `src/pages/JobDetail.tsx`
- `src/pages/DispatchBoard.tsx`
- `src/pages/ApplicationServices.tsx`
- `src/pages/ApplicationServiceDetail.tsx`
- `src/pages/ApplicationRecords.tsx`
- `src/pages/BlendTickets.tsx`
- `src/pages/BlendTicketDetail.tsx`
- `src/components/field-app/`
- `src/components/fields/`
- `src/components/map/`
- Related Supabase migrations and tests.

Existing uncommitted changes seen before this report was created:

- `M .claude/settings.json`
- `M src/pages/NewDelivery.tsx`
- `?? AGENTS.md`
- `?? src/pages/NewDelivery.driver-guardrail.test.tsx`

Those files were not modified by this review.

## Key Terms

- RPC: a database function the app calls directly. In this project, important billing, inventory, and workflow logic should live in RPCs instead of React pages.
- RLS: row level security. This controls what each logged-in user can read or change in Supabase.
- Customer split: a billing split for one field, such as 60 percent tenant and 40 percent landlord.
- Posted invoice: an accounting invoice that should be locked. Amounts should not be edited after posting; changes should usually be handled by voiding/reissuing or adjustment workflows.

## Top Risks by Severity

### Critical

#### 1. Field app invoices may fail to create

What is wrong:

The field app invoice page calls `save_field_app_invoice` without sending a `customer_id`. The database `invoices.customer_id` column is required. The RPC tries to set the invoice customer after inserting the invoice, but the insert can fail before that happens.

Why it matters:

Mason could select fields and chemicals, click save, and the invoice may fail before billing starts. This blocks the direct field application invoice workflow.

Where:

- `src/pages/FieldApplicationInvoice.tsx:248`
- `src/pages/FieldApplicationInvoice.tsx:250`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:189`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:195`
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql:45`

Suggested fix:

Derive the primary bill-to customer before inserting the invoice, or intentionally create grouped/split invoices. Do not insert an invoice with a null `customer_id` while the schema requires it.

Needs database migration:

Yes. Rewrite `save_field_app_invoice`.

Tests:

- RPC test: new field app invoice with one selected field succeeds.
- RPC test: selected fields with multiple billing customers produce correct invoice customer/shares.
- E2E test: create invoice from `/invoices/field-app/new`, save, reload, and verify locations/items/shares.

#### 2. Field app billing can charge wrong customer amounts

What is wrong:

The direct field app invoice flow calculates chemical line totals in the browser. Product selection defaults to tier 1 pricing, and customer shares are simple percentages of the total invoice. This ignores each customer's pricing tier and field price overrides.

Why it matters:

A landlord and tenant can have different pricing terms. If the app uses one tier 1 price and then splits the total, one customer can be overcharged and another undercharged.

Where:

- `src/components/field-app/FieldAppChemicalEntry.tsx:136`
- `src/components/field-app/FieldAppChemicalEntry.tsx:143`
- `src/components/field-app/CustomerSharesTable.tsx:27`
- `src/components/field-app/CustomerSharesTable.tsx:28`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:246`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:256`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:292`

Suggested fix:

Move price calculation into the RPC. The RPC should calculate product price per customer/share using:

- Customer assigned tier.
- Field billing split.
- Field price override, if set.
- Product quantity and applied acres.

The browser can preview amounts, but the database should be the source of truth.

Needs database migration:

Yes. Rewrite field app billing RPC logic.

Tests:

- Split field with tier 1 and tier 3 customers.
- Field with price override.
- Browser-supplied price does not override server-calculated price unless an authorized manual override exists.

#### 3. Blend ticket direct invoices lost split billing

What is wrong:

An earlier migration added field billing split helpers. A later "smart pricing" migration rewrote `create_invoice_from_blend_ticket` and creates one invoice for the blend ticket header customer. It uses that customer's tier and does not create split invoices or invoice shares.

Why it matters:

A blend ticket can represent fields for multiple customers. The current direct invoice path can bill the whole load to the wrong single customer.

Where:

- `supabase/migrations/20260335200000_workflow_gaps_phase3_field_billing_splits.sql:62`
- `supabase/migrations/20260335200000_workflow_gaps_phase3_field_billing_splits.sql:76`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:62`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:66`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:97`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:133`

Suggested fix:

Merge the smart-pricing logic with field split billing. The function should either:

- Create grouped split invoices per customer, or
- Create one invoice with accurate `invoice_shares`, depending on Mason's preferred business process.

Needs database migration:

Yes. Rewrite `create_invoice_from_blend_ticket`.

Tests:

- Approved blend ticket with two fields and two customers.
- Product prices respect each customer's tier or field override.
- Application service fee is split correctly.
- Blend ticket is marked billed only after invoices/shares are created successfully.

### High

#### 4. Job lifecycle is missing "Start Job"

What is wrong:

`complete_job()` requires a job to be `in_progress`. The error says to use `start_job()`, but no real `start_job()` function or visible UI action was found.

Why it matters:

Jobs can get stuck at `scheduled`. If they cannot move to `in_progress`, they cannot be completed, which means no application record, inventory movement, or invoice.

Where:

- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:67`
- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:69`
- `src/pages/JobDetail.tsx:527`
- `src/pages/JobDetail.tsx:528`
- `src/pages/DispatchBoard.tsx:136`

Suggested fix:

Add a real scheduled -> in_progress transition using an RPC, or allow safe completion directly from scheduled if that better matches real operations.

Needs database migration:

Yes, if adding `start_job()` or rewriting `complete_job()`.

Tests:

- E2E: create job -> start job -> complete job -> application record exists.
- RPC test: scheduled job cannot be invoiced before completion.
- RPC test: duplicate start/complete attempts are idempotent.

#### 5. Multi-customer jobs are half-built

What is wrong:

Migration `20260406100000_field_app_workflow_v2.sql` makes `jobs.customer_id` nullable for multi-customer jobs. But `JobDetail.tsx` still requires a customer and filters fields to that customer's fields. TypeScript also says `Job.customer_id` is always a string.

Why it matters:

The database says multi-customer jobs are allowed, but the page and types still behave like every job has exactly one customer. This creates confusing workflows and broken edge cases.

Where:

- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:5`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:6`
- `src/pages/JobDetail.tsx:297`
- `src/pages/JobDetail.tsx:313`
- `src/pages/JobDetail.tsx:320`
- `src/types/index.ts:1655`

Suggested fix:

Decide one clear path:

- Option A: keep jobs single-customer and use direct field app invoice / blend ticket flows for multi-customer work.
- Option B: finish multi-customer jobs by using `field_app_locations`, deriving customers from selected fields, and updating job completion/invoicing.

Needs database migration:

Yes if Option B is chosen. Possibly yes if reverting nullable job customers.

Tests:

- Multi-customer job with two fields.
- Single-customer job remains unchanged.
- Job list shows useful customer/share summary instead of "Unknown".

#### 6. Application records lose multi-field detail

What is wrong:

Completing a job creates one application record and uses only the first job field.

Why it matters:

If a job treated three fields, only one field's dashboard/history may show the application. That can cause bad field history, bad customer reporting, and confusion when checking what was applied.

Where:

- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:156`
- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:168`
- `src/pages/ApplicationRecords.tsx:67`
- `src/pages/FieldDashboard.tsx:65`
- `src/pages/FieldDashboard.tsx:108`

Suggested fix:

Create one application record per field, or add a join table that links one application record to many fields. For field history, each treated field must be queryable.

Needs database migration:

Yes.

Tests:

- Complete a job with two fields.
- Both fields show application history.
- Application Records page can filter by either customer/field correctly.

#### 7. Inventory completion can block real work and move prebooked stock incorrectly

What is wrong:

`complete_job()` refuses completion if inventory is short. It also subtracts applied quantity from `quantity_prebooked` without proving the job was tied to that prebooked quantity.

Why it matters:

If field work already happened, the system should not hide the application record just because inventory is negative. Also, reducing prebooked quantity can steal holds from another customer's order.

Where:

- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:72`
- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:84`
- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:189`
- `supabase/migrations/20260325100000_sprint1_fix_critical_overloads.sql:191`

Suggested fix:

Define the business rule:

- If the chemical was actually applied, allow completion and create an inventory exception/negative stock audit.
- Only reduce `quantity_prebooked` when the job is linked to a specific reservation/order hold.

Needs database migration:

Yes.

Tests:

- Completing with insufficient inventory creates a controlled exception or fails with a deliberate business message.
- Unrelated prebooked stock does not change.
- Inventory transaction is created exactly once.

#### 8. Application service fees are inconsistent

What is wrong:

Application services and customer rate overrides exist, but the direct field app invoice and job editor do not carry `application_service_id`. Blend ticket invoicing uses application services; job and direct invoice flows do not.

Why it matters:

Application service fees such as airplane, Hagie, or Y-drop charges can be missed depending on which workflow Mason uses.

Where:

- `supabase/migrations/20260405000000_application_services.sql:11`
- `supabase/migrations/20260405000000_application_services.sql:57`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:18`
- `supabase/migrations/20260405200000_smart_pricing_flow.sql:133`
- `src/pages/FieldApplicationInvoice.tsx:266`
- `src/pages/JobDetail.tsx:319`

Suggested fix:

Add application service selection to all field application entry points, then calculate service fees in the RPC using customer-specific overrides and field shares.

Needs database migration:

Yes.

Tests:

- Direct field app invoice with application service default rate.
- Customer-specific application rate override.
- Multi-customer service fee split.

#### 9. Posted field app invoices can be rewritten

What is wrong:

`save_field_app_invoice()` updates an existing invoice by deleting and recreating locations, invoice items, and shares. It does not check whether the invoice is posted.

Why it matters:

Posted invoices should be locked for accounting. Rewriting line items after posting can change AR balances and financial history.

Where:

- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:206`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:213`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:214`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:215`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:216`
- `src/pages/FieldApplicationInvoice.tsx:301`
- `src/pages/FieldApplicationInvoice.tsx:304`

Suggested fix:

Block edits/deletes unless invoice status is draft or unposted. Posted invoices should use void/reissue or approved adjustment workflows.

Needs database migration:

Yes, for server-side enforcement.

Tests:

- Posted field app invoice cannot be edited through RPC.
- Posted field app invoice cannot be soft-deleted through UI or direct client call.
- Draft/unposted invoice can still be edited.

#### 10. RLS lets too much field/job data be changed

What is wrong:

Assigned applicators can update the whole `jobs` row. Any applicator can insert/update `job_applied_info`. That is broader than the real workflow needs.

Why it matters:

Applicators should be able to record field completion information, not change customer, price, applicator, or other billing-sensitive job fields.

Where:

- `supabase/migrations/20260215200000_job_scheduling_tables.sql:137`
- `supabase/migrations/20260215200000_job_scheduling_tables.sql:140`
- `supabase/migrations/20260215200000_job_scheduling_tables.sql:205`
- `supabase/migrations/20260215200000_job_scheduling_tables.sql:213`

Suggested fix:

Restrict direct table updates and use RPCs for assigned applicator actions such as start job, complete job, and applied info.

Needs database migration:

Yes.

Tests:

- Assigned applicator can complete assigned job.
- Assigned applicator cannot change price/customer/applicator by direct table update.
- Unassigned applicator cannot insert applied info for another job.

### Medium

#### 11. Fields without billing defaults produce no shares

What is wrong:

`derive_customer_shares_from_fields()` only joins `field_billing_defaults`. If a field has no billing default row, it returns no share for that field.

Why it matters:

A normal field without custom split rules should probably bill 100 percent to the field's main customer. Instead, the invoice may have no shares or fail to find a primary customer.

Where:

- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:83`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:95`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:107`

Suggested fix:

Add fallback logic: if no billing defaults exist for a field, use `fields.customer_id` at 100 percent.

Needs database migration:

Yes.

Tests:

- Field with no billing defaults returns one 100 percent share.
- Mixed invoice with one split field and one non-split field calculates total shares correctly.

#### 12. Field picker map is misleading

What is wrong:

The location picker map only draws selected fields, not all available fields. So the map does not really help choose fields. The row and checkbox both toggle the field, so checkbox clicks may double-toggle.

Why it matters:

Mason expects a map-based workflow for selecting fields. The current UI can be confusing and may make selected fields appear not to select.

Where:

- `src/components/field-app/SelectLocationsModal.tsx:145`
- `src/components/field-app/SelectLocationsModal.tsx:146`
- `src/components/field-app/SelectLocationsModal.tsx:224`
- `src/components/field-app/SelectLocationsModal.tsx:228`
- `src/components/field-app/SelectLocationsModal.tsx:234`

Suggested fix:

Draw all filtered fields on the map, highlight selected fields, support map click selection, and stop checkbox click propagation.

Needs database migration:

No.

Tests:

- Component test: clicking checkbox selects once.
- Component or E2E test: selected fields remain selected after map/table interactions.

#### 13. Field app location shares table is unused

What is wrong:

`field_app_location_shares` exists, but no source-code or RPC inserts were found for it. `save_field_app_invoice()` inserts `invoice_shares`, not per-location shares.

Why it matters:

The design says per-location customer splits are preserved. In reality, the app appears to save only aggregated invoice shares. That makes it harder to audit how each field contributed to each customer's bill.

Where:

- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:43`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:57`
- `supabase/migrations/20260406100000_field_app_workflow_v2.sql:282`

Suggested fix:

Either populate `field_app_location_shares` from field billing defaults during save, or remove it from the intended workflow and docs. The better business choice is likely to populate it.

Needs database migration:

Maybe. It depends whether the existing table is kept and populated.

Tests:

- Save direct field app invoice.
- Verify per-location shares exist for each selected field.
- Verify invoice shares match the sum of location shares.

### Low

#### 14. Job lifecycle E2E can hide completion failures

What is wrong:

The E2E test can skip when `complete_job` fails from insufficient inventory.

Why it matters:

That makes the exact workflow break easier to miss in automated testing.

Where:

- `tests/e2e/workflow-job-lifecycle.spec.ts:357`
- `tests/e2e/workflow-job-lifecycle.spec.ts:363`

Suggested fix:

Seed known inventory and make the test fail when the job lifecycle breaks.

Needs database migration:

No.

Tests:

- Update the existing E2E fixture so the test is deterministic.

## Workflow Map

This is how the field application workflow should work.

```text
Field Setup
  -> Create field boundary, acres, crop, customer
  -> Configure billing splits and optional price overrides

Job / Blend Ticket / Direct Field App Invoice
  -> Select one or more fields
  -> Select chemicals and rates
  -> Select application service
  -> Assign applicator and vehicle

Application Work
  -> Start job or approve blend ticket
  -> Capture actual acres, weather, products, and notes
  -> Complete application

Application Records
  -> Record what was applied
  -> Record where it was applied
  -> Record when and by whom
  -> Make every treated field visible in field history

Inventory
  -> Move applied products out of available stock
  -> Create inventory transaction audit rows
  -> Handle low-stock exceptions clearly

Billing
  -> Calculate product charges in the database
  -> Apply customer tiers
  -> Apply field price overrides
  -> Apply application service fees
  -> Apply customer billing splits

Invoice
  -> Create draft/unposted invoice or grouped split invoices
  -> Store invoice items and invoice shares
  -> Allow review before posting

Posting
  -> Check accounting period is open
  -> Lock posted invoice amounts
  -> AR source of truth is invoices.balance_cents
```

Current breaks in that map:

- Job start is missing.
- Multi-customer jobs are incomplete.
- Direct field app invoice creation may fail.
- Direct field app invoice billing is browser-calculated and tier-unsafe.
- Blend ticket direct invoice bypasses split billing.
- Application records do not represent every treated field.
- Application service fees are not consistently included.
- Inventory completion can block real field work or reduce unrelated prebooked holds.

## Stale or Conflicting Docs

### `docs/plans/2026-04-06-field-app-workflow-v2-design.md`

Stale/conflicting items:

- Says multi-customer jobs use nullable `jobs.customer_id`, but `JobDetail.tsx` still requires one customer.
- Says `save_field_app_invoice` auto-calculates line totals per customer tier, but actual pricing is mostly browser-supplied and percentage-split.
- Says `save_field_app_job` exists, but no implementation was found.
- Says `SelectLocationsModal` is shared for jobs and invoices, but current job editor still uses its own single-customer field rows.

### `docs/reference/database-schema.md`

Stale/conflicting items:

- Lists `invoice_items.line_total_cents`, but actual TypeScript and current invoice code use `extended_cents`.
- Documents `field_app_locations` and `field_app_location_shares` with all-authenticated RLS. That may be accurate as documentation, but it is a security risk and should be flagged as not the desired target state.

### `docs/workflows/QUOTE_TO_DELIVERY.md`

Stale/conflicting items:

- Uses stale `line_total_cents` wording.
- Correctly says posted invoices are locked, but `save_field_app_invoice` does not enforce that.

### `docs/reference/rpc-functions.md`

Stale/conflicting items:

- Lists `create_split_invoices_from_order`, but does not warn that blend ticket direct invoicing currently bypasses that split-invoice approach.
- Lists field app invoice RPC, but does not document the current limitation around customer ID, tier pricing, and location-share persistence.

### `CLAUDE.md`

Stale/conflicting items:

- Top summary says 63 pages and 246 migrations.
- Later reference table still says `docs/reference/migration-history.md` has 196 migration entries and `pages-routes.md` has 56 pages.

### `docs/workflows/SAFE_DEVELOPMENT_RULES.md` and `docs/workflows/UI_PATTERNS.md`

Stale/conflicting items:

- Still mention 57 pages, while current project guidance says 63 lazy-loaded pages.

## Recommended Fix Order

### Phase 1: Make direct field app invoices safe

Goal:

Make `/invoices/field-app/new` reliable enough that it cannot create wrong or broken invoices.

Work:

- Fix required customer handling in `save_field_app_invoice`.
- Add server-side guards so posted invoices cannot be rewritten.
- Add fallback share logic for fields with no billing defaults.
- Stop trusting browser-supplied totals as the source of truth.

Database migration:

Yes.

Tests:

- RPC tests for create/update.
- E2E for direct field app invoice save.
- Posted invoice edit/delete denial tests.

### Phase 2: Unify billing math

Goal:

One billing model for all field application paths.

Work:

- Calculate product pricing in RPCs.
- Apply customer tiers.
- Apply field price overrides.
- Apply application service fees.
- Calculate invoice shares from location-level shares.
- Decide whether multi-customer billing should use grouped split invoices or one invoice with `invoice_shares`.

Database migration:

Yes.

Tests:

- Tier pricing.
- Price override.
- Multi-customer shares.
- Application service fee default and customer override.

### Phase 3: Repair job lifecycle

Goal:

Make jobs move cleanly from scheduled to completed to invoiced.

Work:

- Add or restore `start_job()`.
- Update UI to start jobs.
- Make `complete_job()` idempotent and multi-field aware.
- Create application records for every treated field or add a record-field join table.
- Decide whether jobs support multi-customer fields.

Database migration:

Yes.

Tests:

- E2E create -> start -> complete -> invoice.
- Multi-field application records.
- Retry/idempotency tests.

### Phase 4: Fix inventory behavior for application completion

Goal:

Application completion should record real work and move inventory correctly.

Work:

- Decide how low-stock completion should behave.
- Avoid reducing unrelated `quantity_prebooked`.
- Add clear audit rows for exceptions.

Database migration:

Yes.

Tests:

- Low stock scenario.
- Unrelated prebooked stock remains unchanged.
- Inventory transaction created once.

### Phase 5: Tighten permissions

Goal:

Applicators should only perform field-work actions they are allowed to perform.

Work:

- Restrict direct `jobs` updates.
- Restrict `job_applied_info` insert/update to assigned job or RPC-only.
- Keep admin/sales workflows intact.

Database migration:

Yes.

Tests:

- Assigned applicator allowed actions.
- Unassigned applicator blocked.
- Applicator cannot change billing-sensitive fields.

### Phase 6: Clean up UI and docs

Goal:

Make the workflow easier to use and easier for future agents to maintain.

Work:

- Fix field picker map/list behavior.
- Update stale docs.
- Update TypeScript types for nullable job customer if multi-customer jobs stay.
- Harden E2E fixtures so failures do not get skipped.

Database migration:

Maybe, depending on type/schema decisions.

Tests:

- Field picker component tests.
- Updated workflow E2Es.
- Typecheck and build.

## Suggested Agent Instructions Before Any Fix Phase

Before implementing a phase, the next agent should:

1. Re-read `AGENTS.md`, `CLAUDE.md`, and the relevant workflow docs.
2. Check `git status` and preserve all unrelated changes.
3. Re-open the latest versions of the RPCs being changed.
4. Check function overloads before writing a migration.
5. Write new migrations only; do not edit old migrations.
6. Add tests for the exact business risk being fixed.
7. Update docs that describe changed behavior.

## Suggested First Phase Acceptance Criteria

Phase 1 is done only when:

- A new direct field app invoice can be created from selected fields.
- The invoice has a valid bill-to customer.
- Invoice shares exist and add up to 100 percent.
- A field with no billing defaults falls back to the field customer.
- A posted invoice cannot be edited or deleted through the field app invoice page/RPC.
- Tests cover those cases.
- Docs mention the actual behavior.

