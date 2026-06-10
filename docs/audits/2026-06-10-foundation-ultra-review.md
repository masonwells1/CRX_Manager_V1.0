# Foundation Ultra Review — 2026-06-10 (first run)

**Tool:** `/foundation-ultra-review` (canonical prompt: `docs/audits/foundation-ultra-review-prompt.md`)
**Mode:** read-only — no migrations applied, no deploys, no code changes. SELECT-only SQL.
**Scope:** the 5 blind-spot layers no prior audit covered — A live-data integrity, B disk-vs-live drift, C edge-function bundle drift, D deferred-ledger reconciliation, E frontend runtime safety. Delta reviewers skipped: only change since the last clean audit is PR #70 (already reviewed + applied through the migration gate).

---

## 1. Verdict: **SOLID-WITH-FOLLOWUPS**

**0 code/security BLOCKER — but the foundation is not "fully healthy."** No BLOCKER stops you *writing* the next feature: the code, schema, 2026-06 security state, edge bundles, and route guards are all sound. However (a) **H1 is an active operational breakage** — 17 products cannot be delivered at all right now — to clear before the next delivery cycle, and (b) the "money/AR consistent" result is **mathematically true but unvalidated by volume** (0 posted invoices, 0 payments) → a re-run gate after the first real billing cycle is now **mandatory**, not suggested (§8). Follow-ups: the inventory data re-base, two proven still-live code bugs (`reverse_receiving_record` clamp [HIGH], ungated forward deductions [MED]), an anonymous employee-directory exposure (MED), the pre-May-26 migration-rebuild debt (HIGH), and a stack of doc/ledger fixes.

> **Revised after Codex cross-review (2026-06-10).** Disposition: `docs/audits/2026-06-10-claude-disposition-of-codex-foundation-ultra-review.md`. Codex returned NEEDS-WORK; all 8 points accepted after independent live re-verification. Changes folded in below: M1 MED→**HIGH**; M4 **removed** as a production finding (formula artifact) → LOW test-data cleanup; H1 earliest crossing corrected to a `job_applied` row (strengthens M2); two **new MED** findings (#6 anon `profile_public_view`, #7 `adjusted`-type ambiguity); verdict prose softened; mandatory post-billing re-run gate; new **Layer F** added to the reusable method.

| Layer | Verdict | BLOCKER | HIGH | MED | LOW |
|---|---|---|---|---|---|
| A. Live-data integrity | NEEDS-WORK on inventory; CLEAN on money/AR (unvalidated by volume) | 0 | 1 | 2 | 3 |
| B. Disk-vs-live drift | CLEAN behaviorally; historical structural debt | 0 | 1 | 1 | 1 |
| C. Edge-function bundles | CLEAN (1 known repo-ahead) | 0 | 0 | 1 | 1 |
| D. Deferred ledger | CLEAN (no escalations; stale entries) | 0 | 0 | 0 | 6 |
| E. Frontend runtime safety | CLEAN structurally (sampled ~14/66 pages) | 0 | 0 | 3 | 4 |
| F. Authorization/exposure surface | NEEDS-WORK (1 anon exposure) | 0 | 0 | 1 | 0 |
| **Total** | | **0** | **3** | **8** | **15** |

Phase 3 gate: HIGHs independently verified; 2 candidate findings **refuted** (released-path mechanism, prebooked-formula mismatch — see §4). Severities reflect the Codex round.

---

## 2. Findings

### HIGH

**H1 (Layer A, F1) — 17 inventory rows have negative `quantity_available`; all 17 products are currently UNDELIVERABLE.**
Verified three times (Agent A probe + Phase-2 re-run + Codex-round reproduction): exactly 17 rows, worst `Water W/ D-Chlorinator −2,345`; `Black Strap Molasses Sugar - Bulk −1,325` is a proven Tote↔Bulk mispost causally linked to M1 below. Cause is **historical, not an active `complete_delivery` bug**: live migration stamps show the `complete_delivery` insufficient-stock block was deliberately removed 2026-03-19 (`complete_delivery_remove_inventory_block`) and restored 2026-04-30 (`field_app_workflow_phase12`); the **last negative crossing is `2026-04-30 17:59:53 UTC` — zero after**. Because the hard block is back (`RAISE EXCEPTION 'Insufficient inventory…'` verified in the live body), **every delivery attempt against these 17 products now fails** — operationally urgent, and the negatives distort inventory valuation / Net Position. **Correction (Codex round):** the crossings are *not* all `delivered` — the **earliest is a `job_applied` row on 2026-03-15** (2,4D Amine → −10), before the delivery-block window and via the ungated `complete_job` path. That doesn't weaken H1 (still no post-Apr-30 crossing) but **corroborates M2** — the forward `job_applied` deduction has already driven a row negative once.
**Fix route:** physical count → admin data re-base via `reconcile_negative_inventory`/`adjust_inventory` for the 17 + the Black Strap Bulk/Tote pair (no code change to `complete_delivery`).

**H2 (Layer B) — the pre-2026-05-26 migration directory cannot rebuild production.**
Now quantified (closes the deferred 2026-05-29 "rebuild-fidelity shadow diff"): live `schema_migrations` = **479** versions vs disk 396 files (376 unique versions); **411 live-only / 308 disk-only** versions, mostly MCP-stamp renames and one-disk-file→many-applies chunk splits from before the B7 protocol existed, plus **18 duplicate version prefixes on disk** (alone fatal to `supabase db push`). Pre-existing structural debt, not a new incident — and crucially **zero behavioral consequence today** (see CLEAN list). **B7-era (≥ 2026-05-26) parity is PERFECT: 43/43, zero mismatches.**
**Fix route:** one-time squashed baseline (`<stamp>_baseline.sql` schema dump) + freeze of pre-B7 files, via `/ship` with Mason's approval; until then the never-`db push` / never-`migration repair`-from-disk rule stays absolute.

**H3 (Layer A→Phase 2; was M1, upgraded MED→HIGH after Codex round) — `reverse_receiving_record` clamp silently desyncs the append-only ledger from the inventory snapshot (live).**
`SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0)` while the ledger row unconditionally logs the full negative — proven to have swallowed exactly 1,325 units on 2026-03-23 (Black Strap Tote). The clamp is live in **exactly two objects** (live `pg_proc` scan): `reverse_receiving_record` (`20260333400000:72-90`) and the raw-DELETE trigger `_receiving_records_before_delete` (`20260333400000:143-177`). A financial/inventory source-of-truth silently disagreeing with its own immutable ledger, reachable via both an RPC and a raw delete, with proven material damage = HIGH (Codex-concurred).
**Fix route (`/ship`):** **subtract the full amount (allow the row to go negative)** so ledger ≡ snapshot, in both objects — do NOT block: this is a *reversal*, the goods already left, and the existing negative-inventory surfacing path is the right place to flag it. (Blocking belongs on the forward deductions of M2, not here.)

### MED

**M2 (Layer A→Phase 2) — `complete_job` and `create_application_record_from_blend_ticket` deduct inventory with NO insufficient-stock check.** `job_applied` can drive rows negative — and **already has** (the 2026-03-15 2,4D Amine crossing in H1 came through this path). The door stays open while `complete_delivery` blocks the delivered path.
**Fix route (`/ship`):** add an insufficient-stock guard (block on the forward deduction, or warn+notify — match the chosen policy).

**M3 (Layer A, F4) — 4 stale pending commissions out of sync with their orders' profit**, including ORD-2026-0343 where commission **$22,784.59 exceeds profit $22,716.14**. Orders edited 2026-05-12 after commission creation, no recalc.
**Fix route:** recalc the 4 before any payout; consider recalc-on-order-edit for pending commissions.

**M6b (Layer F→Codex round) — anonymous REST exposure of the employee directory via `profile_public_view`.**
The view grants `SELECT` to `anon` (`relacl = anon=r/postgres`) and uses `security_invoker = off`, so it bypasses RLS on `profiles`. Verified at runtime: `SET ROLE anon; SELECT … FROM public.profile_public_view` → **10 rows, all with `full_name`** (id, full_name, role, is_active) — readable with just the anon key, no auth. The intended grant (`20260510070000:90-107`) was authenticated-only; the restore migration `20260516132645` never re-REVOKEd anon. Internal **employee** data (not customer PII), so MED — but an unnecessary staff directory + stable UUIDs. Distinct from the accepted "52 anon-SECDEF functions" gotcha (those self-gate on `auth.uid()`; a view does not).
**Fix route (`/ship`):** `REVOKE SELECT ON public.profile_public_view FROM anon;` — all 30+ frontend callers are authenticated pages (grepped: TeamBoard/Deliveries/CustomerDetail/CommissionPayments/Reports/VendorBillDetail/notificationTriggers), zero anon reads, so no breakage.

**M9 (Layer A→Codex round; was the F2 root-cause) — `adjusted` ledger type does not reliably describe its own effect.**
`INVENTORY_RULES.md:73-89` says `adjusted` changes `quantity_available`, but `20260331900000` uses `adjusted` for a **prebooked-only** correction with no available effect, disambiguated only by free-text `notes` — which produced this audit's F2 false positive (§4). For an append-only ledger, a type that doesn't describe its effect is a real reconcilability defect.
**Fix route (`/ship`):** add a distinct `prebook_reconciliation` transaction type (or a structured `affected_column` field) so recompute is machine-checkable; touches the `inventory_transactions` CHECK → migration-drift review required. Until then, document the notes convention in `INVENTORY_RULES.md`.

**(removed) M4 — prebooked-formula mismatch:** withdrawn as a production finding. The original "27-of-111 mismatch, 2 negative-expected" was a wrong-formula artifact (`booked − released − delivered`). Re-run with the canonical reconciliation (active-order `quantity_remaining` over `confirmed`/`partially_fulfilled` orders): **exactly 1 mismatch — `1A TEST PRODUCT - FAKE PRODUCT`, 36 units, zero non-test, zero negative-expected.** → reclassified LOW test-data cleanup (L-A3).

**M5 (Layer C) — `process-blend-ticket` v19 is REPO-AHEAD: the committed M3 OCR atomic-claim is not deployed** (= known owner item L1, now diff-confirmed: deployed bundle updates the queue row unconditionally; repo adds the `status.eq.pending,…` claim + `already_processing` race-loss bail).
**Fix route:** `/deploy-edge-function process-blend-ticket` with the OCR smoke test.

**M6 (Layer B) — CLAUDE.md's "disk migration version-list matches live exactly" (2026-05-30 entry) is false globally** — true only for that sprint's window / the B7 era. Doc fix: scope the claim, note live=479.

**M7 (Layer E) — swallowed failures on the AR collections path** (`src/pages/ARaging.tsx:567-570, 662-664`): genuine reminder/statement email failures are counted as "skipped (already sent today)" or dropped — a customer who never got their statement is undetectable. No Sentry.
**Fix route (`/ship`):** separate `failed` counter + `Sentry.captureException` + distinct toast in both batch loops.

**M8 (Layer E) — failed quote-status revert swallowed** (`src/pages/QuoteBuilder.tsx:1306-1311`): if `convert_quote_to_order` fails and the best-effort revert also fails, the quote sticks in `accepted` with no order, no toast, no Sentry.
**Fix route (`/ship`):** Sentry + warning toast in the inner catch.

### LOW (grouped)

- **L-A1 (A, F5):** accepted quote `Q-2026-1811` for "A1 TEST FARM" — manual test data without the `[E2E]` prefix; escapes teardown, pollutes reports. Cancel it; audit other "A1 TEST" entities.
- **L-A2 (A, F6):** 15 customers carry JSONB `null` (not SQL NULL) in `default_commission_split` — passes `IS NOT NULL` with no usable object. Optional hygiene migration through the gate.
- **L-B1 (B):** 17 of 30 audited functions show comment-only live-vs-disk drift (MCP apply strips `--` comments). No action; future md5 protocols should compare comment-stripped bodies.
- **L-C1 (C):** `seed-admin` v15 deployed bundle is a comment-stripped rendering of the repo file (inline MCP deploy artifact); logic identical incl. the production gate.
- **L-D1..D6 (D, ledger doc fixes):** (1) CLAUDE.md still says the `20260609203541` hardening is "NOT yet on main" — it merged via PR #70 (`6b6ff46`); (2) header "218 RPCs" → live is 217 non-trigger public functions; (3) remit-to PO box flag is stale — Mason confirmed 2026-05-30 (`src/lib/companyInfo.ts:33-47`); (4) 2026-05-29 deferred items 2 (`batch_void_invoices` disk hardening → done `20260531151134`) and 3 (restore RPCs → done `20260608174251`/`20260608193139`) should be marked closed; (5) the **2026-06-09 foundation audit report is unrecoverable from the repo** — branch `docs/foundation-audit-2026-06-09` was never pushed; the L2/L3 specs it carried survive only as summaries. The L3 trio was re-derived live: `create_invoice_from_delivery`, `generate_batch_statements`, `generate_rup_sales_records`. Record durably + push/recommit the report if the branch still exists on the work machine; (6) INVENTORY_RULES.md additions from §4 (adjusted-rows-may-be-prebooked-corrections; warn-not-block applies to order creation, not delivery completion; early-March seeds are unledgered).
- **L-E1..E4 (E):** stale-fetch races — `InvoiceDetail.tsx:321-323` (money-displaying: rapid invoice-to-invoice nav can render the previous invoice's amounts), `InvoiceDetail.tsx:325-338` + `PaymentAllocation.tsx:104-130` (typeahead out-of-order); copy the `cancelled`-guard pattern from `QuoteBuilder.tsx:249-251`. Plus `ARaging.tsx:557-570`: a failed dedup-tracking insert after a successful send is mislabeled "skipped" → duplicate reminder next run.

---

## 3. Confirmed-clean (the foundation you're building on)

- **Money/AR data: fully consistent.** Zero violations across ~15 probes: balance generation inputs, credit-memo signs, the order-or-blend-ticket convention, prepay credits vs applications, write-offs, allocation sets vs lines, invoice totals vs items. (Low financial volume to date — 0 payments, 0 posted invoices — so re-run after the first real billing cycle.)
- **2026-06 security state intact live:** all 30 audited SECDEF mutators code-identical to disk (auth gates, role checks, strict-actor blocks verbatim); `20260609203541` REVOKEs hold (authenticated/anon=false, service_role=true on all 4); the 10 strict-actor RPCs anon-blocked, one overload each; **global overload check: ZERO duplicates.**
- **Edge functions: repo is the source of truth.** 6/7 in sync byte-for-byte (modulo CRLF/comments); B8 `entity_recipient` guard verified present in deployed `create-user` v20; zero DEPLOYED-AHEAD; `_shared` lib identical everywhere.
- **Route-guard matrix: zero contradictions** with the documented role rules (month-end/commissions/settings admin-only; `/payments` admin+sales_rep; full matrix in Agent E's pass). Unguarded mutating routes (Dashboard maintenance RPCs, TeamBoard, Notifications) all verified intentional.
- **Double-submit: clean** — all 35 mutating RPC callsites in the 14 money pages pass `p_idempotency_key`, every trigger button has pending-state. `checkMutationResult` coverage complete.
- **Deferred ledger: no escalations** — nothing recorded as LOW/deferred is exploitable (L2's only direct path is admin-gated; the 37 report RPCs spot-checked with internal gates intact).
- **Inventory holds:** all 9 active holds trace to a live planned quote; zero expired-but-active.
- Security advisors match the accepted baseline exactly (1 known view ERROR, 52 accepted anon-SECDEF, 211 authenticated-SECDEF by design, 1 open L4 WARN).

---

## 4. Refuted appendix (Phase-3 gate kills)

1. **"`released` transactions decrement `quantity_available`" (Agent A's F2-as-reported, HIGH) — REFUTED.** The 4 "delta = net released" exact matches were a recompute artifact: the deltas came from `adjusted` ledger rows that recorded **prebooked-only** reconciliations (notes: "Prebooked reconciliation: cancel_delivery bug fix (migration 20260331900000)") which the recompute misclassified as available-affecting — and those reconciliations equaled the wrongly-released amounts *by construction*. All 3 live writers of `'released'` (`cancel_order`, `update_order_items`, `release_inventory_hold`) verified to never touch `quantity_available`. INVENTORY_RULES.md is **correct** on this row. Excluding the artifact rows, the mismatch list drops 10 → 5, all explained in §2 (M1) + historical residue.
2. **"`complete_delivery` doesn't block negative inventory" (Agent A side-claim) — REFUTED.** Live body hard-blocks (`RAISE EXCEPTION 'Insufficient inventory…'`). The warn-not-block migration applies to **order creation**, not delivery completion. (The block *was* absent 2026-03-19→04-30 — that window produced H1.)
3. **"Old `reverse_receiving_record` version added instead of subtracting" (candidate explanation for Start Right Tote +530) — REFUTED.** All disk versions subtract; the same fn reconciled correctly 2 days earlier on another product. Residue attributed to unledgered manual correction / early-March receiving churn.
4. **15 customers "commission splits don't sum to 100%" — REFUTED on inspection:** JSONB `null` encoding, no splits set at all (downgraded to L-A2 hygiene).

## 5. Reconciled deferred ledger (Agent D)

| Item | Verified status |
|---|---|
| L2 `void_invoice` paid-guard | OPEN, accurately LOW (no paid-guard live; UI-unreachable confirmed `InvoiceDetail.tsx:871`, `Invoices.tsx:176`; direct RPC admin-only) |
| L3 idempotency wiring (trio re-derived: `create_invoice_from_delivery`, `generate_batch_statements`, `generate_rup_sales_records`) | OPEN, accurately LOW |
| M4 seed-admin `ENVIRONMENT=production` | UNVERIFIABLE by tooling (dashboard secret); code gate verified in repo (`seed-admin/index.ts:31-37`) |
| L4 leaked-password protection | OPEN (advisor WARN present) |
| L1 process-blend-ticket M3 deploy | OPEN — now diff-confirmed (M5) |
| `20260609203541` "not yet on main" | **STALE** — merged via PR #70 |
| Phase 4 backup verification / restore drill | UNVERIFIABLE (dashboard-only), still pending Mason |
| Customer RLS lower-bound-only design | OK — live policies match exactly |
| Remit-to PO box flag | **STALE** — confirmed 2026-05-30 |
| 2026-05-29 deferred #2 batch_void disk-hardening, #3 restore-RPCs | **DONE** — close in docs |
| 2026-05-29 #1 defense-in-depth guards on the 37, #4 rebuild-fidelity diff | #1 OPEN (mitigated — spot-checked gates intact); #4 **CLOSED BY THIS AUDIT** (= H2) |
| ACTOR_MISMATCH attribution sweep (2026-06-09 rec) | OPEN |
| Header counts | 66 pages ✓ / 95 tables ✓ / 396 disk migrations ✓ / 7 edge fns ✓ / **218 RPCs → 217** |

## 6. Escalation trace & unverified leads

- **Phase 2 wave 1 (1 agent):** F1/F2 causal trace + adversarial verification → refuted F2 mechanism, found M1 (clamp) + M2 (missing guard), corrected the complete_delivery claim, dated H1's damage window via migration stamps. No wave 2 needed.
- **Unverified leads:** (1) M4/F3 — the canonical `quantity_prebooked` reconciliation formula was never code-traced; the 27-product mismatch needs that trace + re-base (fold into the H1/M1 inventory cleanup job). (2) Start Right Tote +530 mechanism unprovable (evidence destroyed by the RPC's DELETE of the receiving record) — physical count decides.

## 7. Suggested remediation order

1. **Inventory data re-base** (H1 + Black Strap pair; admin + physical count) — unblocks deliveries on 17 products. Operational, not a code change. **Do before the next delivery cycle.**
2. `/ship` H3 — `reverse_receiving_record` + `_receiving_records_before_delete` clamp fix (subtract-full / allow-negative; the only proven still-live desync writer).
3. `/ship` M2 — insufficient-stock guard on `complete_job` + `create_application_record_from_blend_ticket` (forward deductions; has already caused a crossing).
4. `/ship` M6b — `REVOKE SELECT ON public.profile_public_view FROM anon` (anon employee-directory exposure; tiny, safe).
5. `/deploy-edge-function process-blend-ticket` (M5/L1) + recalc the 4 commissions (M3).
6. `/ship` M7+M8 — ARaging/QuoteBuilder swallowed-error fixes (one small frontend job).
7. `/ship` M9 — `prebook_reconciliation` transaction type + INVENTORY_RULES.md fix (machine-checkable ledger).
8. Doc batch: M6 + L-D1..D6 ledger fixes (one commit).
9. H2 squashed-baseline migration — schedule deliberately with Mason; biggest job, zero urgency.
10. **MANDATORY re-run gate:** re-run the money/AR probes **+ Layer F** after the first real billing cycle — today's "consistent" is vacuous (0 posted invoices, 0 payments). This is a gate, not a suggestion.

Codex cross-review: recommended for items 2, 3, 7, and 9 before applying (migration/money class); items 1, 4, 5, 6, 8 are below the Codex-worthy bar.

---
*Run mechanics: 5 parallel Phase-1 agents + 1 Phase-2 escalation agent + Codex cross-review round (NEEDS-WORK, all 8 points accepted after independent live re-verification — disposition `docs/audits/2026-06-10-claude-disposition-of-codex-foundation-ultra-review.md`); ~150 SELECT probes; every HIGH independently reproduced; 2 candidate findings killed by the gate (§4). Nothing was changed — read-only.*
