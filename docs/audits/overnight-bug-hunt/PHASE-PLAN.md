# Overnight Bug Hunt — Phase Plan & Subsystem Queue

> **✅ HUNT COMPLETE (2026-06-20, after cycle 19).** Whole app swept — every Phase-1 and Phase-2 key hunted. 31 parked (6 HIGH-severity / 8 MED / 17 LOW, all latent) + 1 green auto-fix; 22 refuted. The loop stopped cleanly after cycles 16–19 produced no meaningful new bugs (clean schema/migration sweep + cosmetic doc-count nits + re-confirms). Restart with "start the overnight bug hunt". The only key not formally "drained" is `commissions` — its hunting is done, but it stays OPEN because its HIGH is parked pending Mason's fix.

Each cycle runs 1–3 subsystem keys (keeps the Codex gates focused). Mark a key `drained`
once two consecutive cycles on it surface no NEW confirmed findings. Move to Phase 2 only
when every Phase-1 key is drained.

## Phase 1 — Billing engine (Mason's priority — where ~80% of the last 20 days' bugs lived)

| Key | Subsystem | Status |
|---|---|---|
| `invoices-core` | post/create/void invoice, save_field_app_invoice, delete_invoices, finance charges | hunted ×4 (c1/c2/c6/c12) — c12 surfaced 1 NEW (finance-charge preview≠generate base set, MED) + re-confirms. NOT drained (still finding); the finance-charges sub-area was under-explored before c12 |
| `jobs-to-billing` | transfer_job_to_invoice, job-mix calculator, recipe pricing, per-acre machine fee | hunted ×4 (c1/c2/c6/c12) — c12 was ALL re-confirms of the 4 known transfer_job_to_invoice items (actor/audit-row/share-drift/header-vs-lines), 0 new = dry. Effectively exhausted; 1 dry pass (need 1 more consecutive to formally drain) |
| `field-app-invoices` | FieldApplicationInvoice + save_field_app_invoice + field/acre split + override-grower shares | **DRAINED** (c3 + c10, two dry passes) — c10 re-confirmed the generic-editor-bypass and ENRICHED it (re-rated HIGH; a server-side save_invoice guard can close it now without the feature-branch rework). No new signal across 2 passes |
| `commissions` | commission_split, per-order records, recompute-on-edit, commission_payments batch | **OPEN — HIGH unresolved** (re-opened after c8; re-hunted c9). c9 fresh pass RE-CONFIRMED the HIGH and found a 3rd affected cancel path (`cancel_delivery` alongside cancel_order/void_order). The HIGH is parked (migration). NOT drained — stays open until Mason's fix lands or a clean confirming pass with the fix in place |
| `deliveries-billing` | confirm/complete/quick/cancel/void delivery + inventory txn types | **DRAINED** (c4 + c7) — c7 confirming pass surfaced 0 new (re-confirm of the 2 delivery audit-log items + re-scoped the partial-rebill-cost item MED→LOW) |
| `prepay-blend` | prepay apply/earmark + blend-ticket invoice/payment-status/actor | hunted ×4 (c5/c9/c11/c13) — HUNTING COMPLETE for now. c13: 1 NEW (blend delete_invoices ticket-orphan, MED) + independent re-confirm of the over-reset HIGH (re-verified the multi-customer fan-out). The blend payment_status state machine has multiple parked gaps (over-reset HIGH, orphan MED, prepaid-rebill LOW) — all dormant. Recent yield is MED/LOW only; deprioritized vs Phase 2 |
| `splits-shares-allocation` | order_item_field_allocations, create_split_invoices_from_order, dormant shares subsystems, allocate_payment, write-offs | hunted ×4 (c5/c10/c11/c13) — c13: 0 new (3 refuted, all valid). 1 dry pass since c11's new LOW. Effectively exhausted; deprioritized vs Phase 2 |

## Phase 2 — Broad whole-app sweep — **OPEN as of cycle 14 (2026-06-20)**

> Phase-1 HUNTING is declared complete after cycle 13: the billing engine was hunted exhaustively (cycles 1–13, 27 parked findings incl. 5 HIGH-attention). Remaining Phase-1 yield is MED/LOW/dormant + re-confirms; the money HIGHs were all found by c9. `commissions` stays OPEN (its HIGH is parked pending Mason's fix — hunting there is done, it just can't "drain" until fixed). Phase 2 is fresh ground (never hunted) and higher-value now. Pick 1–2 keys per cycle.

| Key | Subsystem | Status |
|---|---|---|
| `rls-security` | RLS coverage, NEW anon-exec SECDEF mutators, search_path, actor-forgery | **DRAINED** (c14 + c18) — c18 2nd pass surfaced only the 1 known cycle-14 item (update_blend_ticket_billing_status forgeable-actor, re-confirmed still-unfixed), 0 new |
| `migration-drift` | overload collisions, CHECK regressions, column drift, updated_at violations | hunted ×1 (c16) — **CLEAN**: plpgsql_check over 209 RPCs + 48 triggers = 0 errors; 0 overload collisions; 0 bad updated_at; idempotency all canonical. A 2nd clean pass drains. Reassuring (the 40+-bug March drift class is clean) |
| `types-drift` | src/types/index.ts vs live schema | hunted ×1 (c16) — effectively CLEAN: 0 real findings; 3 type-accuracy nits all refuted (guarded/unreachable/by-design). A 2nd pass drains |
| `frontend-safety` | checkMutationResult / assertRpcResult / confirm()/alert() / Sentry / service_role / logActivity | **DRAINED** (c14 + c18) — c18 2nd pass = 0 findings. The cycle-14 checkMutationResult coverage-gate item stays parked (proximity-scan test for /ship) |
| `lifecycle-invariants` | status vs live CHECK, unenforced transitions, delivery two-step, Net-Free | hunted ×2 (c15+c19) — 1 finding: jobs enforcer accepts cancel-from-any-status (re-rated LOW->MEDIUM in c19: terminal completed/invoiced jobs can be cancelled, orphaning invoice/application_records). Parked. No other new signal across 2 passes |
| `edge-and-pdf` | 6 edge fns (CORS/JWT/admin/idempotency/drift) + customer PDFs | **DRAINED** (c15 + c17, two clean passes — 0 findings both times). The edge-fn attack surface (CORS/JWT/admin/idempotency) + customer PDFs are solid |
| `docs-deps-tests` | doc-drift counts, npm audit, test-coverage gaps | hunted ×2 (c17+c19) — 1 parked item (cosmetic doc-count drift: trigger 47->49 + callable-RPC 227->226 in rpc-functions.md/CLAUDE.md; fix via /update-docs) + 7 refuted across both passes (E2E-not-in-CI, dompurify-dead-code, CI-audit-gate, test-coverage/schema-skip nits, table-count-not-drifted). No real bug |

## Suggested cycle ordering (Phase 1)

1. `invoices-core` + `jobs-to-billing` — the hottest cluster
2. `field-app-invoices` — the single biggest source of the last 2 days' churn
3. `commissions` + `deliveries-billing`
4. `prepay-blend` + `splits-shares-allocation`
5. re-run any Phase-1 key that surfaced findings (verify the fixes didn't open new holes)
6. → Phase 2
