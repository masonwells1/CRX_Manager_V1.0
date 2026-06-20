# Overnight Bug Hunt — Phase Plan & Subsystem Queue

Each cycle runs 1–3 subsystem keys (keeps the Codex gates focused). Mark a key `drained`
once two consecutive cycles on it surface no NEW confirmed findings. Move to Phase 2 only
when every Phase-1 key is drained.

## Phase 1 — Billing engine (Mason's priority — where ~80% of the last 20 days' bugs lived)

| Key | Subsystem | Status |
|---|---|---|
| `invoices-core` | post/create/void invoice, save_field_app_invoice, delete_invoices, finance charges | hunted ×3 (c1/c2/c6) — c6 surfaced only re-confirms here + 1 new shared with jobs; new-rate dropping (c1 many → c2 3 → c6 ~1). NOT drained, 1 more re-run likely dry |
| `jobs-to-billing` | transfer_job_to_invoice, job-mix calculator, recipe pricing, per-acre machine fee | hunted ×3 (c1/c2/c6) — c6 was 6/7 re-confirms of 3 parked transfer_job_to_invoice items + 1 new (header≠sum(lines), LOW). New-rate dropping. NOT drained, 1 more re-run likely dry |
| `field-app-invoices` | FieldApplicationInvoice + save_field_app_invoice + field/acre split + override-grower shares | hunted ×1 (c3) — DRY (0 new; 1 re-confirm of cycle-1 generic-editor-bypass, kept parked-coordinate). Needs 1 more dry cycle to mark drained, but signal looks exhausted (the open defect is parked pending feat/as-applied-invoices) |
| `commissions` | commission_split, per-order records, recompute-on-edit, commission_payments batch | **OPEN — HIGH unresolved** (re-opened after c8; re-hunted c9). c9 fresh pass RE-CONFIRMED the HIGH and found a 3rd affected cancel path (`cancel_delivery` alongside cancel_order/void_order). The HIGH is parked (migration). NOT drained — stays open until Mason's fix lands or a clean confirming pass with the fix in place |
| `deliveries-billing` | confirm/complete/quick/cancel/void delivery + inventory txn types | **DRAINED** (c4 + c7) — c7 confirming pass surfaced 0 new (re-confirm of the 2 delivery audit-log items + re-scoped the partial-rebill-cost item MED→LOW) |
| `prepay-blend` | prepay apply/earmark + blend-ticket invoice/payment-status/actor | hunted ×2 (c5/c9) — c5: 3 new (prepay batch double-spend HIGH; prepay status-not-paid MED; blend grouped-ticket double-unbill HIGH) + 2 refuted. c9: 1 NEW (apply_prepay_to_invoice cross-customer misapplication — Codex HIGH/verifier MED). NOT drained (c9 still surfaced a new item); 1 more confirming pass |
| `splits-shares-allocation` | order_item_field_allocations, create_split_invoices_from_order, dormant shares subsystems, allocate_payment, write-offs | hunted ×1 (c5) — 2 new (update_allocation_set no-sum-validation LOW/dead; field-app acre-rounding LOW) + 2 refuted. NOT drained, needs 1 more cycle |

## Phase 2 — Broad whole-app sweep (after Phase 1 drains)

| Key | Subsystem | Status |
|---|---|---|
| `rls-security` | RLS coverage, NEW anon-exec SECDEF mutators, search_path, actor-forgery | queued |
| `migration-drift` | overload collisions, CHECK regressions, column drift, updated_at violations | queued |
| `types-drift` | src/types/index.ts vs live schema | queued |
| `frontend-safety` | checkMutationResult / assertRpcResult / confirm()/alert() / Sentry / service_role / logActivity | queued |
| `lifecycle-invariants` | status vs live CHECK, unenforced transitions, delivery two-step, Net-Free | queued |
| `edge-and-pdf` | 6 edge fns (CORS/JWT/admin/idempotency/drift) + customer PDFs | queued |
| `docs-deps-tests` | doc-drift counts, npm audit, test-coverage gaps | queued |

## Suggested cycle ordering (Phase 1)

1. `invoices-core` + `jobs-to-billing` — the hottest cluster
2. `field-app-invoices` — the single biggest source of the last 2 days' churn
3. `commissions` + `deliveries-billing`
4. `prepay-blend` + `splits-shares-allocation`
5. re-run any Phase-1 key that surfaced findings (verify the fixes didn't open new holes)
6. → Phase 2
