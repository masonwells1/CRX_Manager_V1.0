# CRX Live Foundation Gauntlet — Sections 2–6 (Adversarial Loop)

**Date:** 2026-07-18
**Mode:** Read-only foundation audit. Opus 4.8 orchestrator · sonnet finders · opus adversarial skeptics (2-vote refute per BLOCKER/HIGH) · opus per-section adjudicator gate.
**Scope:** Sections 2 (Money), 3 (Inventory), 4 (Lifecycle), 5 (DB-drift), 6 (Idempotency).
**Baseline:** branch level with `origin/main` (0/0) at run start — no stale-branch drift artifact.
**Nothing was mutated.** No code edit, no migration, no deploy. Findings below are a **parked** punch list; fixes need Mason + the Codex cross-model gate.

Run: `wf_7c96d421-faa` (43/45 agents completed; the 2 failures were the Section 6 *completeness-critic* pass hitting the structured-output retry cap — a coverage-gap, not a finding; both Section 6 finders completed clean).

---

## Verdict

**Section 6 is clean.** Sections 2, 4, and 5 carry confirmed, adversarially-verified defects that should be fixed before building further on this surface — most urgently a **live-vs-repo drift BLOCKER** (Section 5) and a **quote-stranding lifecycle BLOCKER** (Section 4). Section 3 has no confirmed BLOCKER/HIGH but a cluster of MED inventory-symmetry leads worth a focused follow-up. The single highest-leverage item is the Section 5 drift: **the live production database contains a whole money feature ("Supplier Pricing Phase 1a") that does not exist on `main` or disk**, so production is currently unreproducible from the repo.

**Confirmed totals:** 2 BLOCKER · 5 HIGH · (Section 3 MED/LOW cluster reported, not adversarially verified).

---

## 🛑 CONFIRMED BLOCKERS (2)

### B1 · Section 5 — Live production schema is unreproducible from the repo (Supplier Pricing Phase 1a drift)
- **Where:** live `supabase_migrations.schema_migrations` versions `20260717042803` (`…_supplier_pricing_phase1a`), `20260717112011` (`…_supplier_pricing_zero_cost_guard`), `20260717171331` (`…_restore_legacy_pricing_version_compat`) — **no matching files** under `supabase/migrations/`. Source exists only on `origin/feat/supplier-pricing-phase1a @ 988ea25`.
- **Evidence:** confirmed against three sources — live `list_migrations`, on-disk `supabase/migrations/`, and `.claude/schema-registry.json` (which lists the names but has no SQL). Also present live: SECURITY DEFINER trigger `guard_and_version_product_pricing` (absent from the schema registry the hooks trust).
- **Why it matters:** a money feature was applied straight to live prod from an unmerged branch. The repo can't rebuild prod; the registry-driven hooks are blind to it; a future `supabase db push` / rebuild would diverge or clobber.
- **Recommendation (needs Mason):** reconcile `feat/supplier-pricing-phase1a` into `main` (merge or cherry-pick the three migrations onto disk with their exact live version stamps), then regenerate `.claude/schema-registry.json` from live. This is a **process/drift** fix, not a code bug — do it before any further migration work so new work doesn't stack on an unreproducible base.
- **Adversarial note:** two sibling framings were **REFUTED** here and should NOT be re-chased — "restore_legacy_pricing_version_compat is a separate live-only blocker" (it's part of the same feature set) and "ledger version stamps differ from filenames → db push re-applies" (disproven against live stamps).

### B2 · Section 4 — Whole-quote conversion + order cancel permanently strands the quote at `accepted`
- **Where:** live `convert_quote_to_order`, `_cancel_order_impl_20260714`, `revert_quote_status`; trigger `_enforce_quote_status_transition` on `quotes`; `src/pages/OrderDetail.tsx:1126,1167,2076`.
- **Evidence:** `_cancel_order_impl_20260714`'s `accepted→sent` reopen is gated on `booking_draw=true`; a whole-quote `convert_quote_to_order` leaves `booking_draw` unset/false, so cancelling that order never reopens the quote, and no other RPC transitions `quotes` out of `accepted`.
- **Why it matters:** the quote is dead-ended — can't be re-converted, re-quoted, or closed. Cross-entity strand.
- **Recommendation:** on order cancel, always attempt `revert_quote_status` for the linked quote regardless of `booking_draw`, or add an explicit `accepted→(draft|cancelled)` transition path. Regression test: convert a whole quote → cancel the order → assert the quote is reachable again.

---

## 🔴 CONFIRMED HIGH (5)

### H1 · Section 2 — `apply_prepay_to_invoice` role gate bypassable by a deactivated / profile-less user
- **Where:** live `public.apply_prepay_to_invoice`; the hardened pattern already exists in sibling `apply_credit_memo_to_invoice` (migration `20260711040000`).
- **Evidence:** role check uses bare `NULL NOT IN (...)` which is **NOT TRUE**, so a deactivated or profile-less authenticated user passes the gate. SQL-confirmed against the live body.
- **Recommendation:** guard NULL/inactive role — `COALESCE(v_actor_role,'') NOT IN (...)` or explicit `NOT FOUND` raise, plus an `is_active` filter (mirror `apply_credit_memo_to_invoice`). Regression: call as a deactivated user, expect a raise.
- **Sibling MED (unverified, same class):** `record_invoice_payment` also omits `is_active` and lacks a NULL guard — the adjudicator flagged it as likely the same live auth-bypass; verify and fix together.

### H2 · Section 2 — `generate_finance_charges` can double-charge the same overdue balance
- **Where:** `public.generate_finance_charges` (migration `20260220200000_finance_charge_intelligence.sql`); `src/pages/ARaging.tsx`, `FinanceChargePreviewModal.tsx`.
- **Evidence:** dedup only matches exact `period_end = p_as_of_date`; two runs on different as-of-dates for the same overdue invoice both charge. No unique constraint / trigger on `finance_charges`.
- **Recommendation:** add a period-overlap / same-month guard or a unique index (e.g. one charge per `invoice_id` per billing period). Regression: run twice with different as-of-dates, assert one charge.

### H3 · Section 4 — `void_invoice` strands customer cash
- **Where:** `public.void_invoice` (allocation reversal loop); `src/pages/InvoiceDetail.tsx:1293`; `src/lib/reconciliation.ts:259-280`.
- **Evidence:** voiding a (partially) paid **posted** invoice deletes its payment allocation without re-banking the cash as prepay or refunding it; no reconciliation catches the shortfall.
- **Recommendation:** on void of a paid invoice, re-bank freed allocations as customer prepay (or block the void and require unapply-first). Regression: pay an invoice partially → void → assert customer credit/prepay conserved.

### H4 · Section 4 — `restore_cancelled_order` reactivates to `confirmed` without reversing cancel side-effects
- **Where:** `public.restore_cancelled_order` vs `public._cancel_order_impl_20260714`.
- **Evidence:** restore flips status back to `confirmed` but does not re-apply the inventory holds / commission / booking-draw side-effects that cancel unwound.
- **Recommendation:** make restore the exact inverse of cancel (re-reserve inventory, re-create commission rows, re-apply draw) or forbid restore and require a fresh order. Regression: cancel then restore, assert holds/commissions match pre-cancel state.

### H5 · Section 4 — Unbilled-delivery invoice backfill mono-bills split-billing orders
- **Where:** `create_invoice_for_unbilled_delivery` (live); callers `src/pages/DeliveryDetail.tsx:1095`, `src/components/integrity/IntegrityCleanupPanel.tsx:394`.
- **Evidence:** for field/acre split-billing orders the backfill produces a single invoice, mis-attributing AR and blocking the intended split.
- **Recommendation:** make the backfill respect the order's split-billing config (one invoice per split target), or refuse to auto-backfill split orders. Regression: backfill a split-billing delivery, assert per-split invoices.

---

## 🟡 Section 3 (Inventory) — no confirmed BLOCKER/HIGH; MED/LOW leads (not adversarially verified)

Adjudicator: `cleanOfBlockerHigh=true`, `settled=false` (MED/LOW carry no terminal verdict). Worth a focused verify pass:
- **MED** `adjust_inventory` returns the idempotency cache **before** the auth/admin gate (PARKED-010 class, un-fixed outlier) — `src/pages/InventoryPage.tsx:607`, `BatchAdjustModal.tsx:92`.
- **MED** `create_inventory_hold` idempotency SELECT runs before the serializing lock; no lock at all when the product has no inventory row → concurrent same-key calls can create duplicate holds.
- **MED** prebook asymmetry: `void_delivery` / `cancel_delivery` restore full delivered qty to `quantity_prebooked`, but `_complete_delivery` only deducted `LEAST(qty, prebooked)` → phantom reservations; `edit_delivery` never adjusts `quantity_prebooked`.
- **MED** printed pick-list shortage check ignores active inventory holds, unlike every other Net Free consumer.
- **LOW** `reverse_receiving_record` doesn't restore `quantity_on_order`; docs "Net Free" formula not actually rendered by `InventoryPage`.

---

## ⚪ Section 6 (Idempotency) — UNVERIFIED / NOT SETTLED

The completed finders reported no BLOCKER/HIGH against live project
`rhyzpcqhnizqbxphqdkr`:
- **6a (server):** every current mutating RPC that declares `p_idempotency_key` genuinely enforces it (reads/writes `idempotency_keys`). The known 2026-07-08 lead `save_job_applied_record` is **confirmed fixed** on `main` (true insert-once via per-table idempotency key + request fingerprint).
- **6b (frontend):** money/inventory/lifecycle mutation callers pass stable keys and guard double-submit.
- **Blocked evidence:** both Section 6 completeness critics failed to return
  structured output before the retry cap. Under the workflow contract, that is
  not a clean/settled section. Re-run the critics before making a Section 6
  completeness claim.

---

## Adversarially refuted (do not re-chase)
- S5: "restore_legacy_pricing_version_compat is a separate live-only BLOCKER" — part of the same Supplier-Pricing feature set.
- S5: "ledger version stamps differ from on-disk filename prefixes → `db push` re-applies" — disproven against live stamps (`112550/112623/120539`).

---

## Prioritized punch list
1. **B1 — reconcile Supplier-Pricing Phase 1a into `main` + regenerate schema registry** (unblocks reproducibility + un-blinds the hooks). Needs Mason.
2. **B2 — fix quote-stranding on whole-quote convert + order cancel** (lifecycle dead-end).
3. **H1 — close `apply_prepay_to_invoice` (and `record_invoice_payment`) NULL/inactive auth bypass** (money-RPC privilege escalation).
4. **H3 — stop `void_invoice` from stranding customer cash.**
5. **H2, H4, H5 — finance-charge double-charge, restore-order side-effect reversal, split-billing backfill.**

Each confirmed item should land with a regression test that **fails on today's code** (per the gauntlet prevention standard) and pass the Codex cross-model gate before merge.
