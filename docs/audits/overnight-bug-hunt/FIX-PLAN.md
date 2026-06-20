# Overnight Bug Hunt — FIX PLAN (build handoff for a fresh session)

> **Mason approved (2026-06-20): "Build ALL of them, then approve in batches."** Build every parked-finding
> fix as a migration/change on `claude/overnight-bug-hunt`, validate each rolled-back against live (zero
> footprint), commit to the branch — **but DO NOT apply anything to the live database.** Mason approves the
> live applies in batches AFTER everything is built. Nothing is pushed to `main` either.

## Where state lives (read these first)
- `docs/audits/overnight-bug-hunt/LEDGER.json` — all 31 parked findings with full evidence + the exact FIX for each, + `stats.codexHolisticReview` (Codex's consolidated re-review + fix refinements).
- `docs/audits/overnight-bug-hunt/REPORT.md` — Mason's plain-English summary (final summary + Codex review section at top).
- Branch `claude/overnight-bug-hunt` (24+ commits ahead of origin/main, NOT pushed). Confirm you're on it.

## The pipeline per fix (PROVEN this session)
1. **Read the LIVE function body** verbatim via the read-only Supabase MCP: tool `mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql`, project `rhyzpcqhnizqbxphqdkr`. `SELECT pg_get_functiondef('public.fn(args)'::regprocedure);`
2. **Write the migration** = verbatim reproduction of the live body + ONLY the surgical delta. Preserve `SECURITY DEFINER` + `SET search_path`. Check for overloads (must stay 1). Migration files: `supabase/migrations/2026062012NNNN_*.sql` (bump the time).
3. **Validate rolled-back** (zero footprint — CONFIRMED this works on the read-only server): `BEGIN; <CREATE OR REPLACE the new fn>; SELECT count(*) FROM plpgsql_check_function('public.fn(args)') WHERE plpgsql_check_function LIKE 'error:%'; -- expect 0; <behavioral smoke if feasible>; ROLLBACK;`
4. **Commit to branch** with the validation evidence. (The PostToolUse migration hook fires; for guard-only changes with no schema/column change, no `src/types/index.ts` update is needed.)
5. **Before APPLY (Mason's approval phase, later):** dispatch `rls-security-reviewer` + `migration-drift-reviewer` subagents on each migration, run a Codex fix-gate (`node scripts/overnight-codex-gate.mjs <prompt-file>`), write the apply-guard proof, THEN `apply_migration` ONE batch at a time with Mason's explicit OK, then `node scripts/db-invariant-sweeps/run-sweeps.mjs`.

## Codex fix-ORDER (do HIGHs in this order) + fix REFINEMENTS (from stats.codexHolisticReview — apply these!)
1. **prepay double-spend** `prepay:apply_remaining_prepayments:no-ledger-double-spend` (HIGH) — ⚠️ CAVEAT: routing bulk apply through the prepay_applications FIFO+lock ledger touches the **SHELVED earmark/reserved-pool redesign** ([[project_earmark-engine-shelved-2026-06-14]] — Mechanism A vs legacy aggregate B collide). ASSESS CAREFULLY; may need a scoped fix or a flag-to-Mason rather than re-opening shelved territory. Also folds the MED `prepay:apply_remaining_prepayments:status-not-paid` (flip status to 'paid' when balance hits 0, mirror apply_prepay_to_invoice's CASE).
2. **prepay cross-customer** `money:apply_prepay_to_invoice:cross-customer-misapplication` (HIGH) — ✅ **DONE** (commit `9df55ac`, migration `20260620120000`, validated; same-customer guard).
3. **commission resurrection** `commissions:cancel_void_order:batched-commission-resurrected-paid` (HIGH) — add the batch-freeze NOT-EXISTS guard to **cancel_order + void_order + cancel_delivery** (mirror update_order_items' Codex-P1 guard) AND add a **pending-only exact-row-count guard** to post_commission_payment.
4. **blend double-billing** `blend:sync_blend_ticket_payment_status:multi-invoice-over-reset` (HIGH) — sync trigger must only reset to 'unbilled' when **NOT EXISTS a sibling invoice with status NOT IN ('voided','cancelled') AND deleted_at IS NULL**. Fold the MED `blend:delete_invoices:payment-status-orphan` (delete_invoices must reset the ticket on soft-delete) + LOW `blend:create_invoice_from_blend_ticket:prepaid-rebill-gap` + LOW `db-security:update_blend_ticket_billing_status:forgeable-actor`.
5. **field-app segregation** `segregation:field_application:invoicedetail-save-desync` (HIGH, frontend+migration) — Codex: guard must block **BOTH existing AND incoming** invoice_type='field_application' in save_invoice **AND** route the UI (Invoices.tsx:682 + InvoiceDetail) to save_field_app_invoice. Fold MED `concurrency:save_field_app_invoice:no-row-lock` + LOW `audit-log:save_field_app_invoice:orphan-cancel-no-audit`.

## Remaining groups (MED + LOW; build after the HIGHs)
- **void_payment** partial-void status (MED) · **finance charges** preview/generate shared overdue-set (MED) · **jobs cancel-from-any-status** (MED) · **audit-log invoice_created** rows on create_invoice_for_unbilled_delivery + complete_delivery (MED×2, one migration).
- **transfer_job_to_invoice cluster** (1 migration): forgeable-actor (now MED) + missing invoice_created audit row + invoice_shares penny-drift + header-vs-lines. ⚠️ Coordinate with the PARKED strict-actor fix on `feat/as-applied-invoices` (commit 97836e8 / migration 20260619140000) — don't double-fix.
- **derived totals** (total_cost_cents): save_invoice + create_invoice_from_order + complete_delivery partial-rebill-cost + load_recipe_into_job (1 migration).
- **create_quick_delivery** duplicate-line aggregate (LOW) · **order_item_field_allocations** post-invoice edit-lock trigger (LOW) · **update_allocation_set** → RETIRE/DROP (dead RPC, 0 callers) (LOW).
- **frontend/test/docs:** `checkMutationResult:no-coverage-gate` → a PROXIMITY-scan ratchet test (NOT the equality mirror — 79 checks != 52 captures; Codex agreed) · `docs:rpc-functions-md:trigger-count` → run `/update-docs` (trigger 47→49 + callable-RPC 227→226 in CLAUDE.md + rpc-functions.md + regen AGENTS.md).
- **DROP from the list:** `money:derive_customer_shares_from_fields:acre-share-rounding` — Claude-verifier + Codex-holistic agree it's NOT a real bug (cosmetic acre tie-out). Don't fix.

## Severity (post-Codex-review): 5 HIGH (1 done) · 9 MED · 16 LOW actionable. All LATENT (billing engine operationally empty → nothing corrupting live data; fix before the billing loop goes live).
