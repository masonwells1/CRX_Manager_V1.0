# CRX Live Foundation Gauntlet - Sections 2-15

Run time: 2026-06-17 CDT  
Mode: Read-only audit of current repo code plus live Supabase database structure/state checks  
Skipped: Section 1, per Mason's request

## Verdict

SOLID-WITH-FOLLOWUPS. I found no BLOCKER or HIGH issue in sections 2-15. The app's main money, inventory, lifecycle, commission, AP, Edge Function, frontend, and deterministic test gates are broadly clean. The remaining work is guardrail freshness, one idempotency-contract gap, known inventory data cleanup, and a compliance-PDF test gap.

Counts: BLOCKER 0, HIGH 0, MED 5, LOW 3.

No production deploy, push, live migration, live data edit, or data deletion was performed.

## Repo And Live Baseline

- Current branch: `codex/Gauntlett_Pass_x3`.
- Current `HEAD`: `a3ba49c0f4a81975d3264e7e7958866ff914c395`.
- `origin/main...HEAD`: `0 0`, so this branch is even with `origin/main` for the final report baseline.
- Local latest migration file: `20260617171500_strict_actor_blend_ticket_order_link_rpcs.sql`.
- Live Supabase migration ledger: `561` rows, latest `20260617182051`.
- Schema registry high-water: `.claude/schema-registry.json` reports `20260617164803`.

## Findings

### MED-1 - Schema guardrails are behind the current live database

Sections: 5, 14, 15

Evidence:

- `.claude/schema-registry.json` high-water is `20260617164803`.
- Local disk has a newer migration, `20260617171500_strict_actor_blend_ticket_order_link_rpcs.sql`.
- Live Supabase `supabase_migrations.schema_migrations` reports latest version `20260617182051`.
- `npm run agent-health` passed but warned that the schema registry is behind disk migrations.
- `npm run check:docs` passed for local doc claims, but the live DB count is explicitly outside that check.

Plain-English risk:

The app can still work, but developer guardrails that depend on the schema registry may be looking at yesterday's shape of the database. That means a future code edit could miss a status value, generated column, or constraint that exists live.

Recommended next step:

Run the CRX `/regen-schema-registry` workflow from the live Supabase database after deciding that the live `20260617182051` baseline is correct, then rerun `npm run agent-health` and `npm run check:docs`.

### MED-2 - Strict live sweep and security advisor commands are not fully self-contained on this workstation

Sections: 5, 12, 14

Evidence:

- `npm run db-sweeps:strict` failed because the strict runner did not have `SUPABASE_DB_URL` or `psql` available.
- I reran the same predicate files through `supabase db query --linked --output json`; all unallowlisted results were clean.
- `supabase db advisors --linked --type performance --level warn --fail-on none` passed with "No issues found".
- `supabase db advisors --linked --type security --level warn --fail-on none` failed on temporary role password authentication and requested `SUPABASE_DB_PASSWORD`.

Plain-English risk:

The fallback live checks were clean, but the one-command strict path is not fully dependable yet. That is a process risk: future audits may stop early or require manual fallback.

Recommended next step:

Install/configure the missing strict sweep path (`psql` plus `SUPABASE_DB_URL`, or the repo-approved equivalent) and set the Supabase CLI credential path needed for security advisors.

### MED-3 - Inventory still has 17 negative available-quantity rows

Sections: 3, 4

Evidence from live read-only query:

- `inventory_rows`: `112`.
- `negative_quantity_available`: `17`.
- `negative_prebooked`: `0`.
- `negative_on_order`: `0`.
- `expired_active_holds`: `0`.
- `negative_hold_quantities`: `0`.

Plain-English risk:

The inventory logic and hold math did not show a new code blocker, but these 17 rows are still bad operating data. They can make "what is free to sell" look worse than reality and should be cleaned with owner-approved physical-count adjustments.

Recommended next step:

Have Mason/operations approve the specific inventory corrections, then make them through the normal inventory adjustment workflow, not a direct database edit.

### MED-4 - `create_invoice_from_delivery` declares an idempotency key but does not use the idempotency helper

Section: 6

Evidence:

- Live function signature: `create_invoice_from_delivery(p_delivery_id uuid, p_performed_by uuid, p_idempotency_key text)`.
- Live body contains the `p_idempotency_key` parameter but does not call the standard idempotency helper/replay pattern.
- The function does have a natural duplicate guard by checking whether an invoice already exists for the delivery.
- The function is executable by `authenticated`, `postgres`, and `service_role`.

Plain-English risk:

This is not a proven double-invoice bug, because the function checks for an existing delivery invoice. The gap is retry behavior: if the user double-clicks or the network retries, the second call may not replay the same success result the way CRX's mutating RPC standard expects.

Recommended next step:

Rewrite the function in a new migration so it uses the same operation-scoped idempotency pattern as the newer mutating RPCs, preserving the existing duplicate-invoice safety.

### MED-5 - WPS notice PDF has no dedicated output regression test

Section: 11

Evidence:

- WPS generator exists at `src/lib/wpsNoticePdf.ts` and prints compliance-sensitive fields including WPS notice text, EPA registration number, signal word, rate, REI, and PHI.
- `Test-Path src/lib/wpsNoticePdf.test.ts` returned `False`.
- The only WPS-specific test hit was `src/lib/jobSaveHelpers.test.ts`, which checks whether generation is blocked while the job form is dirty; it does not validate the PDF output.
- Other PDF generators do have dedicated tests, including invoice, delivery, quote, statement, receiving, load sheet, order pick list, order summary, report, and year-end summary PDFs.

Plain-English risk:

No bad WPS PDF output was proven. The risk is that a compliance document could regress later without a test catching missing label fields or required notice language.

Recommended next step:

Add `src/lib/wpsNoticePdf.test.ts` with a fixture that verifies required WPS fields and label-driven values are included.

### LOW-1 - `generate_rup_sales_records` keeps an unused idempotency parameter

Sections: 6, 11

Evidence:

- Live function signature: `generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text)`.
- Live body does not use the idempotency helper.
- It is only granted to `postgres` and `service_role`, not `authenticated`.
- It naturally de-duplicates by invoice/product before inserting RUP records.

Plain-English risk:

This is low risk because normal app users cannot call it directly and the body has a natural duplicate guard. It is still contract drift and can confuse future reviewers.

Recommended next step:

Either wire the idempotency helper or remove the parameter in a reviewed migration if no caller needs it.

### LOW-2 - Frontend validator warnings need triage

Section: 14

Evidence:

- `scripts/validate-frontend.sh --all` passed with `0` violations and `31` warnings.
- The warnings were primarily `.toFixed(2)` display/money checks and `.update()`/`.delete()` callsites where the validator could not prove `checkMutationResult()` coverage.

Plain-English risk:

These are not confirmed bugs, but noisy warnings train agents to skim past the validator. That weakens the guardrail.

Recommended next step:

Triage each warning as real or false positive, then either fix the callsite or improve the validator pattern.

### LOW-3 - DB sweep README still documents older results

Sections: 14, 15

Evidence:

- `scripts/db-invariant-sweeps/README.md` still shows an older `generate_rup_sales_records` auth-bound-role finding.
- Current live checks show no unallowlisted `auth-bound-role-ungated` rows.
- Live grants for `generate_rup_sales_records` are service-role/postgres only.

Plain-English risk:

This is documentation drift, not app behavior. It can mislead the next agent into chasing an already-closed issue.

Recommended next step:

Refresh the sweep README after the schema registry refresh so the docs match the current live sweep output.

## Section Results

### Section 2 - Money, invoices, payments, AR, statements, credits, write-offs, finance charges

Result: Clean, with no blocker found.

Live evidence:

- `invoices_total`: `4`, all `draft`.
- `payments_total`: `0`.
- `positive_open_invoice_balance`: `4`.
- `negative_invoice_balance`: `0`.
- `payments_without_customer`: `0`.
- `write_offs_total`: `0`.
- `finance_charges_total`: `0`.
- Financial invariant sweeps returned `0` rows for invoice balance identity, AR statement balance, allocations boundedness, prepay balance, quote override survival, and commission split sum.

### Section 3 - Inventory, holds, prebooks, Net Free, deliveries, receiving

Result: Logic checks clean; owner data cleanup remains.

Live evidence:

- `inventory_rows`: `112`.
- `negative_quantity_available`: `17`.
- `negative_prebooked`: `0`.
- `negative_on_order`: `0`.
- `active_holds`: `9`.
- `expired_active_holds`: `0`.
- `negative_hold_quantities`: `0`.
- `inventory_transactions`: `681`.
- Delivery statuses: `cancelled 22`, `completed 64`, `in_progress 4`, `scheduled 7`, `voided 3`.
- Receiving records: `130`.

### Section 4 - Quote to order to delivery to invoice to payment lifecycle wiring

Result: Clean.

Live evidence:

- Orders: `cancelled 2`, `confirmed 17`, `fulfilled 32`, `partially_fulfilled 7`.
- Quotes: `cancelled 1`, `draft 1`.
- Deliveries: `cancelled 22`, `completed 64`, `in_progress 4`, `scheduled 7`, `voided 3`.
- Invoices: `draft 4`.
- Purchase orders: `cancelled 5`, `fully_received 19`, `partially_received 7`, `submitted 3`.
- Returns: `requested 1`.
- Live `order_items` has trigger `after_order_items_change` running `trg_recalc_order_totals()`.
- Live `update_order_items` recomputes pending commission rows after item updates and excludes commissions already attached to non-voided payment batches.

### Section 5 - Database drift, constraints, overloads, generated columns, search_path

Result: No live structure blocker found; registry/live freshness follow-up required.

Live evidence:

- SECURITY DEFINER search path sweep: `0` unallowlisted rows.
- Business overload sweep: `0` rows.
- Status literal sweep: `0` rows.
- Generated-column update guard remains covered by the project hook family.
- Current actionable drift is the schema registry and docs baseline lagging live, not a proven bad function body.

### Section 6 - Idempotency and double-submit safety

Result: Mostly clean; one medium RPC contract gap and one low service-role-only drift item.

Live evidence:

- Broad mutating RPC review found no systemic missing-key pattern.
- `create_invoice_from_delivery` has `p_idempotency_key` but does not use the standard helper.
- `generate_rup_sales_records` has `p_idempotency_key` but is service-role/postgres only and naturally de-duplicates rows.

### Section 7 - Commissions, splits, entity recipients, payout batches, cancellations

Result: Clean.

Live evidence:

- `commissions_total`: `34`.
- Commission statuses: `cancelled 2`, `pending 32`.
- `negative_commission_amounts`: `0`.
- `commission_payments_total`: `8`, all `unposted`.
- `commission_payment_items`: `0`.
- `pending_commissions_without_order`: `0`.
- Commission split invariant sweep: `0` rows.

### Section 8 - Returns and credit memos

Result: Clean.

Live evidence:

- `returns_total`: `1`, status `requested`.
- `return_items_total`: `1`.
- `credit_memos_total`: `0`.
- `unapplied_credit_memos`: `0`.
- `returns_without_items`: `0`.

### Section 9 - Purchase orders, receiving, vendor bills, vendor payments, AP safety

Result: Clean.

Live evidence:

- `purchase_orders_total`: `34`.
- PO statuses: `cancelled 5`, `fully_received 19`, `partially_received 7`, `submitted 3`.
- `po_items_total`: `194`.
- `receiving_records_total`: `130`.
- `vendor_bills_total`: `6`.
- Vendor bill statuses: `paid 1`, `unpaid 2`, `voided 3`.
- `vendor_payments_total`: `2`.
- `negative_vendor_bill_balance`: `0`.

### Section 10 - Blend tickets, OCR/review/payment/order link/Edge handoff

Result: Clean for current live data and current link/unlink actor fix.

Live evidence:

- `blend_tickets_total`: `0`.
- `blend_products_total`: `0`.
- `blend_order_links_total`: `0`.
- Live `link_blend_ticket_to_order` and `unlink_blend_ticket_from_order` now bind the actor to `auth.uid()` and include an `ACTOR_MISMATCH` guard.
- `create_order_from_blend_ticket` is still transitive-gated/allowlisted by the live sweep because it calls the gated link path.

### Section 11 - PDFs and compliance documents

Result: No broken PDF behavior proven; WPS test coverage gap remains.

Evidence:

- Full unit test suite passed and includes dedicated tests for invoice, delivery, quote, statement, receiving, load sheet, order pick list, order summary, report, and year-end summary PDFs.
- `src/lib/wpsNoticePdf.ts` has no dedicated `src/lib/wpsNoticePdf.test.ts`.
- `src/pages/JobDetail.tsx` blocks WPS generation while the job has unsaved edits and blocks missing label data before printing.

### Section 12 - Edge Functions

Result: Clean.

Live evidence:

- Live functions: `create-user`, `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document`, `send-email`, `reset-user-password`.
- All six live functions are `ACTIVE` and `verify_jwt=true`.
- `seed-admin` is not present live.
- Local function directories match the expected active set plus `_shared`.

### Section 13 - Frontend wiring

Result: Clean.

Evidence:

- `npm run generate-map` passed.
- Generated workflow map found `73` routes, `44` nav links, `175` distinct RPC calls, `103` graph nodes, `181` graph edges, and `0` auto-detected problems.
- The full unit test run includes the page-permissions coverage tests.

### Section 14 - Testing and prevention gaps

Result: Guardrails mostly strong; strict live runner setup and warning hygiene need cleanup.

Evidence:

- `npm run test:agent-workflows` passed.
- `npm run verify-deps` passed.
- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run test -- --run` passed.
- Live invariant fallback sweep returned `0` unallowlisted rows.
- Gaps: strict sweep direct path unavailable, security advisors auth failure, frontend validator warning noise, WPS PDF output test missing.

### Section 15 - Documentation drift

Result: Local docs check passes; live baseline docs need refresh.

Evidence:

- `npm run check:docs` passed.
- Local docs still need reconciliation with live migration high-water `20260617182051` and schema registry high-water `20260617164803`.
- Sweep README has stale historical output for a now-closed `generate_rup_sales_records` grant finding.

## Verification Commands

Passed:

- `git fetch origin main`
- `git rev-list --left-right --count origin/main...HEAD`
- `npm run generate-map`
- `C:\Program Files\Git\bin\bash.exe scripts/validate-sql-migrations.sh --changed-only --base=origin/main`
- `C:\Program Files\Git\bin\bash.exe scripts/validate-frontend.sh --all`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test -- --run`
- `npm run check:docs`
- `npm run verify-deps`
- `npm run test:agent-workflows`
- `npm run agent-health` (passed with schema-registry warning)
- `supabase db advisors --linked --type performance --level warn --fail-on none`
- Live fallback invariant sweep through `supabase db query --linked --output json`

Expected/known non-pass:

- `C:\Program Files\Git\bin\bash.exe scripts/validate-sql-migrations.sh` full historical scan: failed on legacy old migrations, while changed-only passed.
- `npm run db-sweeps:strict`: failed because `SUPABASE_DB_URL`/`psql` was not available.
- `supabase db advisors --linked --type security --level warn --fail-on none`: failed on Supabase CLI temporary-role password auth and requested `SUPABASE_DB_PASSWORD`.

Not run:

- `npm run test:e2e`. The E2E suite can create/delete `[E2E]` data and may target a live-linked environment, so it needs explicit Mason approval before running under the current hard rules.

## Recommended Next Step

Ask Claude to do this single follow-up batch:

1. Regenerate `.claude/schema-registry.json` from live Supabase and refresh the sweep README.
2. Add a `wpsNoticePdf.test.ts` regression test.
3. Fix `create_invoice_from_delivery` to use the standard idempotency helper.
4. Prepare an owner-approved list of the 17 negative inventory rows for normal adjustment, without direct data edits.
