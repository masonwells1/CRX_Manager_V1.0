# Billing-day money loop — ledger

**Mission:** `docs/loops/billing-day-money-loop-2026-07-08.md`
**Worktree:** `C:\CRX_BillingFix` · branch `fix/billing-day-money-2026-07` (off origin/main @ d8b8682a)
**Started:** 2026-07-10 (attended, Mason launched via /run-loop)

## Step 0 — setup + credit-memo coordination ✅
- Worktree created off fresh origin/main; `npm ci` clean (exit 0).
- **Credit-memo coordination — LANDED LIVE during this session (~15 min in).** First check: NO col/fn. Re-check ~15 min later: `invoices.credit_applied_cents` col EXISTS, `apply_credit_memo_to_invoice` + `unapply_credit_memo` fns EXIST (applied live under versions `20260710182041`–`194343`, the MCP apply-stamp of the CreditMemo session's `20260711xxx` files). Live `allocate_payment` now reads the 5th (credit) lever in its →paid recompute. Per doc Step 0 "if LANDED → good; re-ground every money unit on post-credit-memo defs."
- **Net effect:** the credit-memo overlap that would have forced parking M3 is resolved — the money functions are re-emitted WITH both the credit lever and the over-allocation guard intact.

## Worklist status

### C1 · Reserve-side unit normalization — ✅ ALREADY LIVE (skip)
- **Finding:** Shipped by Sprint D (commit `9945dc4b`, file `20260710120000_d2_reserve_side_unit_normalization.sql`).
- PROOF — Ran: live `pg_proc` prosrc scan of the 4 reserve paths · Saw: `_sync_job_holds`=4× `normalize_rate_unit(jc.unit)`, `_sync_quote_job_reservations`=2×, `get_job_inventory_shortfalls`=1×, `get_dispatch_stock_status`=1×, **0 raw `jc.unit`** paths remaining (base `20260706080000` emit had 0 normalized / used raw). · Not verified: n/a — behavior is live.
- Note: file `20260710120000` is on disk (origin/main) but not recorded under that version in `schema_migrations` — applied live under a different version (known CRX apply-stamp pattern). Behavior is confirmed live.

### C2 · Applicator snapshot in logbook RPCs — ✅ ALREADY LIVE (skip)
- **Finding:** Shipped by the same Sprint D commit `9945dc4b` (file `20260710130000_d1_logbook_snapshot_preference.sql`).
- PROOF — Ran: live prosrc scan of the 6 functions · Saw: `get_logbook_by_customer/applicator/field`, `get_logbook_faa`, `get_field_dashboard`, `get_lot_application_trace` all prefer `COALESCE(ar.applicator_name, …)`; `get_logbook_faa` also prefers `COALESCE(ar.applicator_license_number, …)`; single overload each. · Not verified: n/a — behavior is live.

### C3 · Wire built-but-unused safety signals — ✅ ALREADY LIVE (skip)
- **Finding:** all three named signals already wired.
- PROOF — Ran: live prosrc scan + frontend grep · Saw: (1) negative-stock-as-low-stock live in `get_inventory_position`, `get_dashboard_action_items`, `run_morning_notification_checks` (U18 `20260709230000` — the report's exact "three one-line changes", `quantity_available < 0` markers present); (2) `get_expiring_planned_holds` called+rendered in `OfficeCockpit.tsx:392`; (3) prepay column "Prepay on file" at `ARaging.tsx:263-269` (`prepay_balance_cents`). · Not verified: n/a — behavior is live.
- Residual (out of C3's frontend-only scope, NOT a gap): `operational_dashboard_summary` low_stock CTE still gates `reorder_point > 0`, but the frontend `OperationalRpc` interface omits `low_stock` → dead SQL, not rendered. No user impact. Trivial cleanup only if that RPC is ever re-emitted.

### M1 · Overdue invoices on Payments page — ✅ ALREADY SHIPPED (skip)
- U1 `20260706010233`; `PaymentAllocation.tsx:155` filters `['posted','overdue']`.

### M3 · allocate_payment over-allocation guard — ✅ ALREADY LIVE (skip)
- **Finding:** live `allocate_payment` accumulates `v_sum_allocated` in the allocation loop and enforces `IF v_sum_allocated > p_total_cents THEN RAISE 'OVER_ALLOCATED: …'` after the loop — plus the per-invoice `v_alloc_cents > v_inv.balance_cents` guard. (Earlier fuzzy `sum(`/`over-alloc` scan missed it: var is `v_sum_allocated`, error is `OVER_ALLOCATED`.)
- PROOF — Ran: full `pg_get_functiondef('allocate_payment')` read · Saw: both guards present; overpay banks the remainder as prepay (`v_prepay_cents = p_total_cents - v_sum_allocated`). A $100 check split $80+$80 raises OVER_ALLOCATED. Credit lever included in the →paid recompute. · Not verified: n/a.

### M2 · Per-delivery billing — ✅ ALREADY LIVE (skip)
- **Finding:** the report/doc's "follow-up deliveries can never be billed" is fixed. Live `complete_delivery` carries **U2 #34 per-DELIVERY-aware guard** — the auto-invoice block counts only invoices where `delivery_id = p_delivery_id OR delivery_id IS NULL`, so a sibling delivery's invoice no longer blocks this delivery's billing.
- PROOF — Ran: live `pg_get_functiondef('complete_delivery')` scan · Saw: per-delivery guard present, single overload; doc ref `20260620220000:226,244-250` (the old per-order check) is superseded. · Not verified: end-to-end E2E not re-run (U7/U2 were [E2E]-proven when shipped — see memory `u7-splits-delivery-shipped-spray-parked`).

### S1 · Split-aware delivery invoices — ✅ SUBSTANTIALLY LIVE (doc premise stale) — residual is out-of-scope
- **Finding:** the doc's "delivery auto-draft mono-bills the primary customer and the split path is gated off once a delivery exists" is **stale** — U7 `20260707070000` (LIVE 2026-07-07, one day before the doc was written; report snapshot 2026-07-05 predates it) already fixed it:
  - `complete_delivery` **skips** the mono-bill auto-draft for a field/acre-allocated order, sets `orders.needs_split_billing=true`, notifies admins (skip-and-queue).
  - `create_split_invoices_from_order` is **reachable after a completed delivery** (only an OPEN delivery blocks) and emits a **per-owner invoice GROUP** (`invoice_group_id`, `calculate_billing_splits`, penny-exact by acres, prorated acres per owner) — clears the flag on success.
- PROOF — Ran: live scan of `complete_delivery` + `create_split_invoices_from_order` + `orders` cols · Saw: `orders.needs_split_billing` exists; skip-and-queue present; group emit present; only-open-delivery-blocks present; single overload each. · Not verified: n/a for the shipped behavior.
- **Genuine residuals (BEYOND the doc's stated S/M scope — owner call, NOT built):**
  1. **Auto-emit vs manual:** U7 is skip-and-queue (office clicks "Create Split Invoices"); the doc phrase "auto-invoice becomes split-aware" *could* mean auto-emit on completion. UX preference, not a bug — the manual gate is arguably safer.
  2. **Per-delivery split billing for a PARTIALLY-delivered allocated order:** U7 explicitly deferred this ("bills the WHOLE order … may only run once nothing remains to deliver … a larger redesign; out of scope"). A landlord/tenant order delivered in multiple partial shipments can't be split-billed until fully delivered. Real gap, but a LARGER redesign than the doc sized.

### M4 · Posting-policy alignment — ⏳ grounded; user-facing goal ALREADY MET, residual = dead RPC
- **Policy decision is already settled** (report §6 decision 7): "Who may post invoices → **Admin + sales** (the DB already says so); align all surfaces." No new owner decision needed — the target is admin+sales, partial-tolerant.
- **Live grounding of the posting surfaces:**
  - `post_invoice`: `role IN ('admin','sales_rep')` ✅ policy-correct.
  - `post_invoice_group`: `IF NOT (is_admin() OR is_sales_rep())` ✅ policy-correct.
  - `batch_post_invoices`: `IF v_actor_role != 'admin' RAISE 'Admin access required'` ❌ admin-only, AND all-or-nothing (`FOREACH … PERFORM post_invoice(v_id)` in one txn — one failure rolls back all with one opaque error).
  - Frontend chemical batch (`Invoices.tsx handleBatchPost`, lines 217-276): **already rewritten** to loop `post_invoice` client-side — admin+sales (`canPostInvoices`), partial-tolerant (`Posted X/Y. Failed: <exact per-invoice reasons>`), leaves only failed rows selected. It does NOT call `batch_post_invoices`.
  - All posting page routes are `allowedRoles={['admin','sales_rep']}`; no admin-only posting page.
- **Conclusion:** every posting surface a USER touches already follows admin+sales + partial-tolerant. The lone residual is the server-side `batch_post_invoices` RPC — still admin-only + all-or-nothing but **DEAD** (grep: no `.rpc('batch_post_invoices')` caller in `src/`; only comments + tests + generated types reference it).
- **Residual work = defense-in-depth only:** align `batch_post_invoices` to admin+sales + per-invoice tolerance so a future re-wiring can't reintroduce the policy violation. Zero user impact today. Owner call: harden the dead RPC vs. leave-and-document.
- **Mason's decision (2026-07-10): HARDEN IT.** Built migration `20260712135000_m4_batch_post_invoices_policy_align.sql`:
  1. Role gate admin-only → admin+sales (mirrors `post_invoice` exactly: `is_active AND role IN ('admin','sales_rep')`).
  2. All-or-nothing → partial-tolerant (per-invoice BEGIN/EXCEPTION; `failed[]` in result). Also fixes the prior idempotency-replay stub (returns real cached result) and points audit `entity_id` at a genuinely-posted invoice.
  Signature byte-identical (single overload), Returns jsonb (no type regen), anon REVOKE + authenticated GRANT.
- **GATE RESULTS (all green so far):**
  - 5 CRX reviewers: rls-security **CLEAN**, compliance **CLEAN**, migration-drift **0 blockers** (2 procedural: confirm version-stamp at apply; migration-history row — deferred to apply), typescript-types-drift **NO DRIFT**. (pdf-output N/A — no PDF.)
  - Rolled-back live smoke: `plpgsql_check` on the full body = **0 issues (clean)** (audit INSERT stubbed to pass the append-only guard; its columns were validated vs the live registry by the drift reviewer and the INSERT is byte-identical to the proven-live original).
  - typecheck **exit 0**; build **clean**; tests **79 passed** (rpcContracts + rpcIdempotencyScope).
  - Cross-branch caller check: production (origin/main) has **ZERO** `batch_post_invoices` callers (loops `post_invoice`); the stale `codex/BrainstormFable` checkout still calls it but is an ancestor of main superseded by the UI rewrite — not production.
  - Codex pre-ship verdict: **CLEAN** (106K-token deep review; read full batch_post_invoices history + credit-memo migs; 0 blockers/highs).
- **Credit-memo collision check (their session pinged mid-build):** NONE. `batch_post_invoices` is not in credit-memo's changed set, is still admin-only live, does NOT reference `credit_applied_cents`, and only delegates to the live `post_invoice` + reads `total_amount_cents` — it can't drop the credit lever. Fast-forwarded branch onto latest origin/main (`13326fb4`, credit-memo landed); re-regen caller-graph → `batch_post_invoices` STILL zero-caller on the new base; typecheck clean on new base. (Courtesy flag sent back: live `post_invoice` itself doesn't reference the credit lever — their call whether that's intended.)
- **✅ SHIPPED LIVE 2026-07-10 (Mason OK'd the apply).**
  - PROOF — Ran: apply_migration (embedded DO post-checks passed, `{success:true}`) + post-apply live verify + targeted invariant sweep · Saw: live `batch_post_invoices` now `overloads=1`, gate = admin+sales (old `!= 'admin'` gate GONE), `partial_tolerant=true`, returns `failed[]`, anon EXECUTE=false / authenticated=true, search_path set, 0 actor-shaped params, binds auth.uid(). · Shipped: migration `20260712135000_m4_batch_post_invoices_policy_align.sql`, **live version `20260710213614`** (MCP apply-stamp; match-by-name). · Not verified: full runtime E2E batch-post (RPC has zero callers — no live path to exercise; behavior proven via plpgsql_check + post-checks + reviewers + Codex).
  - Gates all green: 4 CRX reviewers CLEAN + Codex CLEAN + plpgsql_check 0 + typecheck/build/79 tests + no credit-memo collision.
  - **⚠️ FILE-COMMIT BLOCKED (migration is LIVE regardless):** the pre-commit hook can't go green because **production `main` (13326fb4) is broadly red from OTHER active sessions' incomplete landings** — not M4:
    1. **credit-memo** landed `apply_credit_memo_to_invoice` + `reverse_credit_memo_application` in `src/types/supabase.ts` but never classified them → 2 red idempotency tests (`rpcContracts` unclassified, `rpcFixtureLiveDiff` ghost). **FIXED + verified** in my worktree (both classified WITH idempotency vs live pg_proc; added to the fixture snapshot per the save_job_applied_record precedent) — but uncommitted.
    2. **agent-workflow session** left `skills/architecture-weakness-audit/SKILL.md` out of sync with its Codex adapter (`scripts/sync-agent-workflows.mjs --check` fails). This is that session's LIVE domain (session-start git status shows it actively editing `.claude/commands`, `.claude/hooks`, `skills/`, `check-agent-workflows.mjs`). NOT touched — running the sync would sweep their in-flight files into my commit ("don't commit unrelated files / don't race another session's domain").
  - **Uncommitted in worktree `C:\CRX_BillingFix` (ready to land once main is green):** the M4 migration file, this ledger, migration-history row, CHANGELOG entry, caller-graph regen, + the 2 credit-memo test fixes. The migration is APPLIED LIVE (v20260710213614) and working — the file-commit is pure repo hygiene (disk-behind-live by this one file), not a functional gap.
  - **Follow-up to land the file:** once the credit-memo + agent-workflow sessions green up `main`, a 1-min `git commit` (M4 files) + push lands it. Or run `/update-docs` broadly (migration-history is ~15 rows behind too).
  - **✅ LANDED TO MAIN 2026-07-10 (repo hygiene, behavior already live):** fast-forwarded onto current `origin/main` (`1effc0b0` — credit-memo tests, agent-workflow SKILL sync, and 12-stale-parked cleanup all resolved by their owning sessions). **Renamed the M4 file `20260712130000` → `20260712135000`** to clear a stamp collision with `20260712130000_credit_limit_count_unposted.sql` that landed on `main` in the meantime (file-stamp only; live version `20260710213614` unchanged). Two commits: (1) credit-memo test-classification fix `dc538702`, pushed first to unblock the fleet-red `main`; (2) M4 + Feature A files + docs.
  - **⚠️ Fresh Codex review at landing (this session) = NOT clean — 2 low-severity findings in the ALREADY-LIVE SQL** that the build-time review missed:
    - **P1 (M4, zero live impact):** on a *partial* batch, the immutable `financial_audit_log` stores the full `p_invoice_ids` array (implies failed invoices posted). `batch_post_invoices` is zero-caller → this path can't execute in prod. Fix = accumulate only successfully-posted IDs and store that.
    - **P2 (Feature A, low / safe-failing):** two concurrent same-day *final* deliveries on one allocated order can each read `v_all_delivered=false` under READ COMMITTED (neither sees the other's uncommitted decrement) → both skip the auto-split → order falls back to the pre-Feature-A manual split-billing. No misbill, no lost money. Fix = lock the `orders` row (FOR UPDATE) before computing `v_all_delivered`, or recompute after the order lock (careful: hot path — design for lock ordering / deadlock).
    - **Mason's decision (2026-07-10): ACCEPT both as low-sev / safe-fail and LAND the files now** (they record what is already live) **+ fix both in a separate, carefully-reviewed follow-up migration.** This is an informed owner **accept-with-followup (SHIP-WITH-FOLLOWUPS)** — NOT a clean-Codex landing. Full Codex output archived at `.claude/session-state/codex-review-latest.txt`. **Do NOT edit the applied M4/Feature A files** (CRX hard rule) — the fix is a NEW migration re-emitting `batch_post_invoices` + `complete_delivery`.

---

## LOOP OUTCOME (2026-07-10)
**Every worklist unit was already shipped live by parallel sessions between the mission doc's date (2026-07-08) and launch (2026-07-10)** — C1/C2 by Sprint D, C3 by U18+OfficeCockpit+AR-aging, M1 by U1, M2 by U2#34, M3 by the payments guard (re-emitted by credit-memo WITH the guard), S1 by U7. **Nothing needed building.** The only un-shipped in-scope item is **M4 (owner decision)**. Two genuine residuals (S1 auto-emit; per-delivery split for partial allocated orders) are beyond the doc's stated scope → owner call. This loop was a verification pass that prevented re-implementing 7 already-live units; **M4 was built + shipped** (owner-approved).

---

## Follow-on — split-billing enhancements A + B (owner: "do both", 2026-07-10). Driver: **Codex builds via CLI, Claude orchestrates+verifies, Codex reviews** (Mason corrected me mid-session: route the BUILD through Codex, not just the review — see memory `feedback_honor-loop-driver-model`).

### A · Auto-create split drafts on same-day full delivery — ✅ SHIPPED LIVE 2026-07-10 (owner-approved apply)
- **What:** when the last delivery of a field/acre-allocated order completes TODAY, `complete_delivery` now auto-calls `create_split_invoices_from_order` to create per-owner DRAFT invoices (office still reviews+posts) instead of only flagging needs_split_billing. Backdated / driver-completed / unpriced / any-error → safe fallback to the pre-existing flag+notify (delivery completion never breaks). Verbatim-live base + one gated block.
- **Built by Codex CLI** from my grounding brief; **byte-diff = additions-only** (only the allocated branch). Gates: rls-security / compliance / migration-drift reviewers all **CLEAN**; plpgsql_check **0 errors**; typecheck clean; **Codex pre-ship round 1 caught a real HIGH** (backdated split drafts would get CURRENT_DATE, shifting AR) → I fixed with the same-day guard `COALESCE(p_completed_at::date, CURRENT_DATE) = CURRENT_DATE` → **Codex round 2 CLEAN**.
- PROOF — Ran: apply_migration (post-check passed, `{success:true}`) + live verify + guard behavior test · Saw: live `complete_delivery` overloads=1, same-day guard present, calls split engine, auto-split event present, search_path set, anon EXECUTE=false; guard test: backdated→false, today/NULL→true. · Shipped: mig `20260712140000_a_auto_split_drafts_on_full_delivery.sql`, **live version `20260710234404`**. · Not verified: full runtime E2E (would need a live [E2E] allocated order + delivery; behavior proven via plpgsql_check + reviewers + Codex + the diff). · **File-commit BLOCKED** by the same fleet-red `main` as M4 (batches with the M4 landing follow-up).
- Optional follow-up (compliance note, owner call): success path writes an activity_feed row but no admin bell notification — the drafts still appear in the office queue.

### B · Per-delivery split for partial allocated orders — 🅿️ PARKED (design-review BLOCKER → handoff)
- **Design-first ran; Codex adversarial design-review = BLOCKER (5 BLOCKER + 2 HIGH).** The naive "mirror the whole-order engine per delivery" design would LOSE MONEY: independent per-delivery rounding overbills (1 unit @ $0.01 delivered 0.5+0.5 → 2¢ vs 1¢); the final delivery would be stranded unbilled (wrongly routes to Feature A which then errors + flags); canonical amount must be `order_items.total_price` not qty×price (discount drift); mid-fulfillment split edits break reconciliation without a snapshot; no void/rebill reversal policy. This is exactly what design-first is for — caught before any code.
- **Corrected design = a residual-ledger** (freeze the order split at first delivery, consume canonical per-owner targets per delivery, final delivery zeroes the remainder) + per-delivery ledger states + snapshot + reversal policy + order-lock dispatch. A new-table + state-machine + reversal-policy redesign — **its own project** (comparable to credit-memo), NOT a quick follow-on.
- **Handoff:** `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md` (corrected approach + the 5 BLOCKERs the build must solve + build plan). Two OWNER decisions gate the build: negative-owner-on-partial policy (carry-forward vs credit memo) + mid-fulfillment edit policy.
- **Until built:** partial allocated deliveries keep today's behavior (flag + office manually splits once fully delivered); Feature A already covers the full-delivery common case.
