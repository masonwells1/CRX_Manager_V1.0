# Overnight Bug Hunt — Phase Plan & Subsystem Queue

> **✅ HUNT COMPLETE (2026-06-20, after cycle 19).** Whole app swept — every Phase-1 and Phase-2 key hunted. 31 parked (6 HIGH-severity / 8 MED / 17 LOW, all latent) + 1 green auto-fix; 22 refuted. The loop stopped cleanly after cycles 16–19 produced no meaningful new bugs (clean schema/migration sweep + cosmetic doc-count nits + re-confirms). Restart with "start the overnight bug hunt".
>
> **✅ FIX BUILD PHASE COMPLETE (2026-06-20).** All surgical fixes are now BUILT + rolled-back-validated + committed (13 migrations, `20260620120000`–`20260620240000`, NOT applied/pushed) — including the commissions HIGH (`20260620130000`) and both formerly-deferred HIGHs as guards (prepay bulk-apply block `20260620200000`; field-app invoice_type lock trigger `20260620210000`). So every "not drained / pending Mason's fix" note in the rows below is **mid-hunt bookkeeping, now historical** — the hunt did NOT use the literal two-dry-pass drain rule to stop; it stopped on clean-completion at cycle 19. The remaining work is Mason's batched **apply** approval, not more hunting or fixing. (Codex 2026-06-20 LOW: this wording reconciliation.)

Each cycle ran 1–3 subsystem keys (kept the Codex gates focused). The original `drained`
rule was: a key drains once two consecutive cycles on it surface no NEW confirmed findings,
and Phase 2 opens only when every Phase-1 key is drained. In practice the loop reached
effective completion (clean sweeps + only cosmetic nits) before every key hit the literal
two-pass bar, so it stopped on that basis — see the FIX BUILD note above.

## Phase 1 — Billing engine (Mason's priority — where ~80% of the last 20 days' bugs lived)

| Key | Subsystem | Status |
|---|---|---|
| `invoices-core` | post/create/void invoice, save_field_app_invoice, delete_invoices, finance charges | hunted ×4 (c1/c2/c6/c12) — c12 surfaced 1 NEW (finance-charge preview≠generate base set, MED) + re-confirms. NOT drained (still finding); the finance-charges sub-area was under-explored before c12 |
| `jobs-to-billing` | transfer_job_to_invoice, job-mix calculator, recipe pricing, per-acre machine fee | **DRAINED** (c12 + 2026-07-15 restart c20, two dry passes) — c20 refreshed the Graphify map and re-checked the current `JobDetail`/`Jobs`/recipe/notification surface. Every surviving lead was already recorded, intentionally accepted, or inside the active invoice/inventory remediation exclusion; 0 new non-overlapping findings. |
| `field-app-invoices` | FieldApplicationInvoice + save_field_app_invoice + field/acre split + override-grower shares | **DRAINED** (c3 + c10, two dry passes) — c10 re-confirmed the generic-editor-bypass and ENRICHED it (re-rated HIGH; a server-side save_invoice guard can close it now without the feature-branch rework). No new signal across 2 passes |
| `commissions` | commission_split, per-order records, recompute-on-edit, commission_payments batch | **OPEN — HIGH unresolved** (re-opened after c8; re-hunted c9). c9 fresh pass RE-CONFIRMED the HIGH and found a 3rd affected cancel path (`cancel_delivery` alongside cancel_order/void_order). The HIGH is parked (migration). NOT drained — stays open until Mason's fix lands or a clean confirming pass with the fix in place |
| `deliveries-billing` | confirm/complete/quick/cancel/void delivery + inventory txn types | **DRAINED** (c4 + c7) — c7 confirming pass surfaced 0 new (re-confirm of the 2 delivery audit-log items + re-scoped the partial-rebill-cost item MED→LOW) |
| `prepay-blend` | prepay apply/earmark + blend-ticket invoice/payment-status/actor | hunted ×4 (c5/c9/c11/c13) — HUNTING COMPLETE for now. c13: 1 NEW (blend delete_invoices ticket-orphan, MED) + independent re-confirm of the over-reset HIGH (re-verified the multi-customer fan-out). The blend payment_status state machine has multiple parked gaps (over-reset HIGH, orphan MED, prepaid-rebill LOW) — all dormant. Recent yield is MED/LOW only; deprioritized vs Phase 2 |
| `splits-shares-allocation` | order_item_field_allocations, create_split_invoices_from_order, dormant shares subsystems, allocate_payment, write-offs | hunted ×4 (c5/c10/c11/c13) — c13: 0 new (3 refuted, all valid). 1 dry pass since c11's new LOW. Effectively exhausted; deprioritized vs Phase 2 |

## Phase 2 — Broad whole-app sweep — **✅ COMPLETE (swept cycles 14–19, 2026-06-20)**

> Phase-1 hunting completed after cycle 13 (billing engine hunted exhaustively, cycles 1–13, 27 parked incl. 5 HIGH-attention; remaining yield was MED/LOW/dormant + re-confirms; the money HIGHs were all found by c9). Phase 2 then swept fresh ground across cycles 14–19 and reached clean completion. All keys below were hunted; the per-row "a 2nd pass drains" notes are historical (the loop stopped on clean-completion, not the literal two-pass rule).

| Key | Subsystem | Status |
|---|---|---|
| `rls-security` | RLS coverage, NEW anon-exec SECDEF mutators, search_path, actor-forgery | **DRAINED** (c14 + c18) — c18 2nd pass surfaced only the 1 known cycle-14 item (update_blend_ticket_billing_status forgeable-actor, re-confirmed still-unfixed), 0 new |
| `migration-drift` | overload collisions, CHECK regressions, column drift, updated_at violations | hunted ×1 (c16) — **CLEAN**: plpgsql_check over 209 RPCs + 48 triggers = 0 errors; 0 overload collisions; 0 bad updated_at; idempotency all canonical. A 2nd clean pass drains. Reassuring (the 40+-bug March drift class is clean) |
| `types-drift` | src/types/index.ts vs live schema | hunted ×1 (c16) — effectively CLEAN: 0 real findings; 3 type-accuracy nits all refuted (guarded/unreachable/by-design). A 2nd pass drains |
| `frontend-safety` | checkMutationResult / assertRpcResult / confirm()/alert() / Sentry / service_role / logActivity | **DRAINED** (c14 + c18 + 2026-07-15 restart c22) — c22 refreshed Graphify at `8e7b5aef`, mapped all 104 direct `checkMutationResult` connections, ran the full frontend validator, inspected non-owned mutation candidates, and verified every `useUnsavedChanges` consumer renders the shared modal. The cycle-14 insert/upsert coverage-gate item stays parked; 0 new findings. |
| `lifecycle-invariants` | status vs live CHECK, unenforced transitions, delivery two-step, Net-Free | **DRAINED** (c15 + c19 + 2026-07-15 restart c23) — c23 verified the previously parked job-cancel guard is present in current source and in the live function body; return lifecycle is RPC-owned and the quote terminal guard is live. Focused job/quote/return/commission tests passed 143/143. The historical migration stamp was not found under its filename/version, but authoritative live function/trigger behavior is correct; 0 new findings. |
| `edge-and-pdf` | 6 edge fns (CORS/JWT/admin/idempotency/drift) + customer PDFs | **DRAINED** (c15 + c17 + 2026-07-15 restart c24) — live inventory now has 7 active Edge Functions and all 7 enforce `verify_jwt=true`; current source uses shared CORS and caller validation, and 10 focused Edge/PDF suites passed 137/137. Owned delivery/invoice/receiving PDFs were excluded; 0 new findings. |
| `docs-deps-tests` | doc-drift counts, npm audit, test-coverage gaps | **DRAINED** (c17 + c19 + 2026-07-15 restart c25) — doc drift and dependency integrity checks pass; production dependency audit reports 0 vulnerabilities, while the full development audit reports only 2 LOW local-tool advisories (`@babel/core`, `esbuild`) with fixes available. Conditional E2E/staging skips are the already documented posture, not a new product defect. Owned reference documents and money/inventory test gaps were excluded; 0 new findings. |

## Suggested cycle ordering (Phase 1) — *historical (hunt complete; kept for re-run reference)*

1. `invoices-core` + `jobs-to-billing` — the hottest cluster
2. `field-app-invoices` — the single biggest source of the last 2 days' churn
3. `commissions` + `deliveries-billing`
4. `prepay-blend` + `splits-shares-allocation`
5. re-run any Phase-1 key that surfaced findings (verify the fixes didn't open new holes)
6. → Phase 2
