# Overnight Bug Hunt — FIX PLAN (build handoff for a fresh session)

> **Mason approved (2026-06-20): "Build ALL of them, then approve in batches."** Build every parked-finding
> fix as a migration/change on `claude/overnight-bug-hunt`, validate each rolled-back against live (zero
> footprint), commit to the branch — **but DO NOT apply anything to the live database.** Mason approves the
> live applies in batches AFTER everything is built. Nothing is pushed to `main` either.

## BUILD PROGRESS — 2026-06-20 (update as you go)
**HIGHs — all 5 BUILT (Mason 2026-06-20: "fix the 2x high issue, need guards on" → both flagged HIGHs now have guards built):**
- ✅ prepay cross-customer (`apply_prepay_to_invoice`) — BUILT prior (`9df55ac`, migration `20260620120000`).
- ✅ commission resurrection — BUILT (`33901d13`, migration `20260620130000_commission_batch_freeze_guard.sql`): hard-block cancel_order/void_order/cancel_delivery when an order's pending commission is in a non-voided payout batch + pending-only & exact-row-count guard in post_commission_payment. Rolled-back validated (plpgsql_check clean + line-diff: only guards added).
- ✅ blend over-reset HIGH + delete_invoices orphan MED + update_blend_ticket_billing_status forgeable-actor LOW — BUILT (`3d161382`, migration `20260620140000_blend_payment_status_overreset_orphan_guards.sql`). Rolled-back validated.
- ✅ **prepay double-spend (`apply_remaining_prepayments`/`batch_apply_all_prepayments`) — BUILT as a HARD-BLOCK guard** (migration `20260620200000_prepay_bulk_apply_block_guard.sql`). Both bulk RPCs now `RAISE 'PREPAY_BULK_APPLY_DISABLED'` as the first statement of each verbatim-reproduced body → removes the double-spend entirely WITHOUT reopening the SHELVED reserved-pool redesign (the proper FIFO-ledger fix). Per-invoice `apply_prepay_to_invoice` is the correct, UNAFFECTED path. Unblock later = delete the RAISE block. Validated rolled-back: plpgsql_check 0/0; line-diff = ONLY guard lines added, nothing removed. rls-security + migration-drift reviewers both 0-BLOCKER. Folds the MED `prepay:...:status-not-paid` (MOOTED while blocked). NOT applied. (UX: PrepaymentManager already try/catch→toast, so a blocked click degrades gracefully — raw code shown, not the friendly DETAIL; optional polish at apply time.)
- ✅ **field-app segregation HIGH — BUILT a TYPE-LOCK TRIGGER** (migration `20260620210000_field_app_invoice_type_lock_trigger.sql`), NOT a `save_invoice` body rewrite. New `BEFORE UPDATE OF invoice_type` trigger hard-blocks ANY update crossing the `field_application` boundary (XOR, NULL-safe), RPC-agnostic. WHY A TRIGGER: `feat/as-applied-invoices` REWRITES `save_invoice` (commits `ce8cde64`/`4dfdf7ed`, migration `20260619160000`) — a competing `save_invoice` CREATE OR REPLACE here would COLLIDE on merge; a trigger is a separate object → no collision + a permanent DB invariant behind feat's app-layer guard. Live-confirmed `save_invoice` is the ONLY fn that UPDATEs `invoice_type` (all others INSERT). Validated rolled-back: plpgsql_check 0; smoke T1 block non-field→field PASS · T2 same-type allowed PASS · T3 benign edit allowed PASS · T4 block field→non-field PASS. **SCOPE:** closes the type-flip (highest-impact harm = segregation/AR-reporting leak). The deeper item/`invoice_shares` desync when an ENGINE-built (`blend_ticket_id IS NULL`) field-app invoice is edited via the generic editor is STILL deferred to `feat/as-applied-invoices` (its `save_invoice` rewrite + `FieldInvoices.tsx` reroute) — land that to fully close. Reviewers 0-BLOCKER. NOT applied.

**MEDs/LOWs — BUILT this session (all rolled-back validated, NOT applied):**
- ✅ jobs cancel-from-any-status MED — `2b500521`, `20260620150000_job_cancel_gate.sql`.
- ✅ void_payment partial-void status MED — `20260620160000_void_payment_partial_void_status.sql`.
- ✅ finance-charge preview/generate overdue-set MED — `20260620170000_finance_charge_preview_match_generate.sql`.
- ✅ order_item_field_allocations edit-lock LOW — `20260620180000_oifa_post_invoice_edit_lock.sql`.
- ✅ create_invoice_for_unbilled_delivery invoice_created MED + create_invoice_from_order total_cost_cents LOW — `20260620190000_invoice_creator_provenance_totals.sql`.

**MEDs/LOWs — REMAINING (next session; all surgical, build the same proven way):**
- ✅ **complete_delivery cluster** — BUILT (`20260620220000_complete_delivery_audit_and_partial_cost.sql`): invoice_created audit row (MED) in the auto-invoice block + total_cost_cents recompute (LOW) in the partial-rebill branch. Verbatim body + 2 deltas; rolled-back validated (plpgsql_check 0, line-diff only-additive). NOT applied.
- ✅ **create_quick_delivery** duplicate-line aggregate — BUILT (`20260620230000_quick_delivery_aggregate_dup_lines.sql`): validation loop now aggregates by product_id (SUM qty) before the net-available check; loop yields a jsonb object so the body is byte-identical. Rolled-back validated vs the file's exact text (plpgsql_check 0, REMOVED=(none), aggregation sums dup lines). NOT applied.
- ✅ **create_invoice_from_blend_ticket** prepaid-rebill-gap — BUILT (`20260620240000_blend_invoice_rebill_guard_unbilled_only.sql`): widened the re-bill guard from `payment_status='billed'` to `IS DISTINCT FROM 'unbilled'` (blocks prepaid/no_charge/NULL; re-bill-after-void still works). Verbatim 16.7KB body + 2-line guard change; rolled-back validated vs file's exact text (plpgsql_check 0, REMOVED = the 2 old guard lines, ADDED = only the new guard). NOT applied.
- ⬜ **update_allocation_set DROP** (LOW) — DEFERRED-tier: dead RPC (0 app callers; only generated types + rpcFixtureLiveDiff.test.ts). DROP needs the migration + remove from the fixture test + regenerate supabase types — multi-file churn, do via a deliberate pass, not a lone migration.
- ⬜ **checkMutationResult proximity-scan test** (frontend) — DEFERRED-tier: fragile CI meta-tooling; author deliberately via /ship (the equality mirror is wrong; needs an AST/proximity scan). NOT a quick fix.
- ⬜ **doc-count drift** (trigger 47->49, callable-RPC 227->226) — DEFERRED-tier: cosmetic, run /update-docs (spans CLAUDE.md + rpc-functions.md + AGENTS regen).

**DEFERRED to feat/as-applied-invoices (would collide — that branch reworks these fns):**
- transfer_job_to_invoice cluster (actor MED + invoice_created LOW + invoice_shares penny LOW + save_job header LOW) — feat has the parked actor/machine-fee/conversion fixes (20260618220000 / 20260619140000).
- save_invoice total_cost_cents LOW — feat's 20260619160000 DELTA-E already syncs it.
- load_recipe_into_job job-totals LOW — feat recipe-pricing rework (20260618230000 / 20260619150000).

**DROP from list (not a real bug):** derive_customer_shares_from_fields acre-rounding.

**Proven pipeline reminder:** read live body via read-only Supabase MCP → write migration (verbatim + surgical delta, header MUST NOT contain the literal `pg_get_functiondef(` or the sql-safety hook blocks the Write) → validate rolled-back in ONE execute_sql ending in `RAISE` (capture old def to temp → CREATE OR REPLACE the FILE's exact body → plpgsql_check + Postgres-normalized line-diff `regexp_replace(btrim(line),'\s+',' ','g')` → RAISE the report) → commit migration + LEDGER edit (mark `status: built-pending-apply`). Validate using the FILE's EXACT body text (a re-typed/compacted paste diffs against live formatting and gives noise). DO NOT apply live; Mason batch-approves; reviewers+Codex+apply-guard gate the apply.

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

## Severity (post-Codex-review): 5 HIGH (all 5 built; field-app HIGH partial — type-lock done, deeper desync deferred to feat) · 9 MED · 16 LOW actionable. All LATENT (billing engine operationally empty → nothing corrupting live data; fix before the billing loop goes live).
