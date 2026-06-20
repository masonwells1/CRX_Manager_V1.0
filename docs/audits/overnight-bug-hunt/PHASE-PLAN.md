# Overnight Bug Hunt — Phase Plan & Subsystem Queue

Each cycle runs 1–3 subsystem keys (keeps the Codex gates focused). Mark a key `drained`
once two consecutive cycles on it surface no NEW confirmed findings. Move to Phase 2 only
when every Phase-1 key is drained.

## Phase 1 — Billing engine (Mason's priority — where ~80% of the last 20 days' bugs lived)

| Key | Subsystem | Status |
|---|---|---|
| `invoices-core` | post/create/void invoice, save_field_app_invoice, delete_invoices, finance charges | hunted ×2 (c1 broad + c2 focused) — still finding (3 new c2); NOT drained, needs 1 dry cycle |
| `jobs-to-billing` | transfer_job_to_invoice, job-mix calculator, recipe pricing, per-acre machine fee | hunted ×2 (c1 broad + c2 focused) — still finding (1 new c2 + reconfirms); NOT drained, needs 1 dry cycle |
| `field-app-invoices` | FieldApplicationInvoice + save_field_app_invoice + field/acre split + override-grower shares | hunted ×1 (c3) — DRY (0 new; 1 re-confirm of cycle-1 generic-editor-bypass, kept parked-coordinate). Needs 1 more dry cycle to mark drained, but signal looks exhausted (the open defect is parked pending feat/as-applied-invoices) |
| `commissions` | commission_split, per-order records, recompute-on-edit, commission_payments batch | hunted ×1 (c4) — 1 new (edit-recompute rounding doesn't reconcile, LOW) + 1 refuted. NOT drained, needs 1 more cycle |
| `deliveries-billing` | confirm/complete/quick/cancel/void delivery + inventory txn types | hunted ×1 (c4) — 1 new (complete_delivery partial re-bill leaves cost stale, MED) + 1 re-confirm (quick-delivery dup oversell). NOT drained, needs 1 more cycle |
| `prepay-blend` | prepay apply/earmark + blend-ticket invoice/payment-status/actor | hunted ×1 (c5) — 3 new (prepay batch double-spend escalated to HIGH; prepay status-not-paid MED; blend grouped-ticket double-unbill HIGH) + 2 refuted. NOT drained, needs 1 more cycle |
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
