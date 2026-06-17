# Nightly-Debug Remediation — Handoff (resume here)

**UPDATE 2026-06-16 PM-4 — frontend greens (core 4) + #9 delete_invoices DONE; branch-only (NOT pushed).**
Branch `claude/priceless-austin-0d3ccd` tip `abbab21` (worktree `eloquent-hawking-6d28a7`).
- **Greens (commit `8322e38`, no DB change):** OrderDetail "Written Off" tile (shown when `write_off_cents>0`;
  `invoices.balance_cents` is GENERATED = total−paid−prepay−write_off); BlendTicketDetail approve/reject routed
  through the existing `batch_approve_blend_tickets`/`batch_reject_blend_tickets` RPCs (kept `logActivity`,
  errors on 0 rows); AR-aging GROSS-convention doc note (Mason's keep-gross decision); money.ts re-alias-to-`fmt`
  warning. PDF page-overflow guards were SKIPPED this round (Mason chose core-4-only).
- **#9 delete_invoices (commit `3979231`, Codex-P2 follow-up `abbab21`):** NEW admin-only SECDEF RPC
  `delete_invoices(uuid[],uuid,text)` APPLIED LIVE as migration `20260617031416` (full gate: 2 reviewers ×2 clean
  + Codex + BOM-free proof + JWT-spoofed rolled-back functional smoke PASS [soft-delete+audit+idempotent
  replay+non-admin rejected] + sweeps overload=1/anon-exec 53). Replaces the raw `.update({deleted_at})` in
  `Invoices.tsx` (batch) + `FieldApplicationInvoice.tsx` (single); soft-deletes draft/unposted/voided only,
  writes one `invoice_deleted` financial_audit_log row per invoice, idempotent, strict-actor.
  **Role gate = `require_admin()` (admin-only) to MATCH the live `invoices_update`/`invoices_delete` RLS
  (`is_admin()`) — NOT admin_or_sales_rep, which would widen delete access.** Typed client (`src/types/supabase.ts`)
  + 3 RPC idempotency fixtures + docs (474 migrations / 227 RPCs) updated.
- **GOTCHA (new):** `REVOKE ALL ... FROM PUBLIC` does NOT strip `anon` — Supabase default-grants EXECUTE to
  `anon` DIRECTLY on new public functions, so the anon-exec-SECDEF sweep went 53→54. Fix = `REVOKE ... FROM anon`
  explicitly (also added to the migration file; live re-verified back to 53). Always `REVOKE FROM PUBLIC, anon`.
- **Still owner-blocked (need Mason's design input, NOT built):** #3 `create_split_invoices_from_order`
  multi-field redesign; `update_order_items` profit+commission recompute on edit. Nothing pushed/deployed.

**UPDATE 2026-06-16 PM-3 — #2 (update_order_items + PARKED-05) DONE LIVE + COMMITTED (not pushed).** The
riskiest deferred item is finished: migration `20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override`
(commit `2bcfc4c`). It broadens `_enforce_delivery_items_parent_lock` to lock delivery_items on cancelled/voided
(any non-scheduled) parents AND brackets update_order_items' sanctioned cleanup DELETE in `app.admin_override`
— the exact pair the gate deferred. Validation: rls-security + migration-drift reviewers (×2 clean) + Codex;
pre-apply rolled-back trigger smoke (out-of-band cancelled DELETE/INSERT blocked, override-escape + scheduled-edit
allowed); post-apply rolled-back end-to-end smoke on the REAL update_order_items (removes an item whose orphan
ditem is on a cancelled delivery, override resets to false); sweeps clean (anon-exec SECDEF 53, overload 1).
**Codex P2 → the bundled total_profit/total_margin_pct recompute was DROPPED** (recomputing the order-header
profit without also updating the denormalized `commissions` rows would desync commission reports/payouts).
So of the in-scope large-RPC items, only **#9 delete_invoice (optional)** + the **frontend greens** remain;
**#3 split-invoice stays owner-blocked** (field-aware redesign). **NEW DEFERRED (commission-aware):**
update_order_items still does NOT refresh `orders.total_profit`/`total_margin_pct` OR `commissions.order_profit`/
`commission_amount` when an order's items are edited — fixing needs a design that respects pending-vs-paid
commissions + splits. Latent today (commissions denormalized from creation-time profit). Do it as its own change.

**As of 2026-06-16 PM-2.** Branch `claude/priceless-austin-0d3ccd` (worktree this session:
`C:\CRX_Manager\.claude\worktrees\eloquent-hawking-6d28a7`). **Last commit `000c8c0`.** Tree clean.
Large-RPC pass: #8/#11/#5 + cancel_delivery + the original 5 foundation migrations are LIVE; #10 deferred,
#3 owner-blocked, #2 remaining (do-last). **Nothing pushed to main / deployed.** See "Session 2026-06-16 PM-2" below.
Mason authorized **auto-apply-after-review** (apply to live after the gate; **NEVER push to main / deploy
without his OK**). Scope = everything, safest-first. Decisions: **cancel_delivery = Option A**;
**AR-aging = keep gross + document**; OrderDetail = add a "Written Off" tile.

## ✅ DONE (live + committed)
- 5 migrations applied live + committed (see `docs/reference/migration-history.md` "Nightly Debug
  remediation 2026-06-16"): quote draw guard (`…115308`), **invoice-void BLOCKER** (`…120604`),
  payment over-allocation guard (`…121105`), order-share 100% guard (`…121521`), order-share-fn
  grant revoke (`…122108`).
- 5 Green frontend/doc fixes committed earlier (AR-aging label, CLAUDE.md CHECK wording, test comment,
  BlendTicket button gate, PDF footers).
- Codex cross-review done + its 6 findings fixed; crawl hard-gated to staging-only (can't run vs prod).

### Large-RPC pass — IN PROGRESS (2026-06-16 PM, this session). 3 of the queued fixes landed:
- ✅ `20260616135524_link_quick_delivery_invoice_to_delivery` (was REMAINING #4) — create_quick_delivery stamps invoice.delivery_id. Commit `e15e9af`.
- ✅ `20260616140912_complete_delivery_partial_rebill_join_order_item` (was REMAINING #6) — complete_delivery partial re-bill joins order_item_id not product_id. Commit `46ad637`.
- ✅ `20260616142001_void_order_restore_logs_void_delivery_reversal` (was REMAINING #7) — void_order restore logs void_delivery_reversal not adjusted. Commit `2e93593`.

### Large-RPC pass — continued 2026-06-16 (fresh session, worktree `clever-archimedes-67b859`, branch `claude/priceless-austin-0d3ccd`). Mason re-authorized auto-apply-after-review IN THIS CHAT (AskUserQuestion). **Mid-session Mason had me `npm install -g @openai/codex` (v0.140.0, ChatGPT-logged-in) — Codex is now available for future sessions; use `codex review --commit <SHA>` (PowerShell only; `codex exec` hangs on stdin).**
- ✅ **`cancel_delivery` quick-cancel — FULLY DONE + CODEX-CLEAN through 3 rounds** (was REMAINING #1, **HIGH**):
  - `20260616151122_..._release_prebook_on_quick_cancel` — INLINE Option-A (release prebook + cancel exclusive auto-order + zero pending commissions + audit row), NOT `PERFORM cancel_order`; scope-extended to `scheduled`+`in_progress`. Commit `8cb6aea`.
  - `20260616170714_..._codex_p2_fixes` — Codex review of v1 found 2 real P2s → release by `order_items` (not `delivery_items`, so update_order_items edits/adds release) + flag `paid` commissions. Commit `a861096`.
  - `20260616172121_..._lock_order_before_quick_release` — Codex review of v2 found 1 P2 (concurrency) → add `FOR UPDATE` to the order read (serialize vs update_order_items; no new deadlock class). Commit `3b6d944`.
  - Codex review of v3 = **CLEAN** ("no actionable bugs"). Each round: 2 reviewers + rolled-back live smoke + apply + B7 + history + commit. Live post-apply md5 `5bcb78e31d38ab4d4c9f24fbb6658977`; overload=1; anon cannot execute. **No batched-Codex needed for cancel_delivery — already done per-item.**

**Per-migration flow used (proven this session):** pull live fn → write file (verbatim-except-the-change) → rolled-back revert-to-baseline-md5 proof (or post-apply for single-literal/additive) → rls-security + migration-drift reviewers (proof file written to all 3 candidate `.claude/session-state/` dirs since `$CLAUDE_PROJECT_DIR` is empty for this session) → apply → post-apply revert-match == baseline md5 + overload=1 → B7-rename to the stamped version → migration-history.md row → commit (full pre-commit suite). **Codex:** batched — the additive/single-predicate fixes above rely on the 2 mandated reviewers + md5-verbatim proof; per-item Codex is reserved for the behavior-changing MED/HIGH rewrites (#8 save_quote, #9 split-invoice, #11 cancel_delivery, #12 update_order_items pairing), plus one batched Codex cross-review of the whole large-RPC set before any push to main.

**Still REMAINING in the large-RPC pass** (numbering from the list below): ~~#1 cancel_delivery (HIGH)~~ DONE, #2 update_order_items+PARKED-05 (paired, **do last — riskiest, fresh context**), #3 create_split_invoices_from_order (**⚠️ BLOCKED on multi-field billing semantics — see item #3 below; do NOT apply until Mason confirms**), #5 save_quote ~~(idempotency+map)~~ **DONE**, ~~#6 complete_delivery~~ DONE, ~~#7 void_order~~ DONE, #8 blend/field-app invoice audit rows **DONE**, #9 delete_invoice RPC (not in this session's scope), #10 pipeline-auth tokens **DEFERRED (Mason 2026-06-16)**, #11 void_delivery idempotency **DONE**, ~~save_quote transition-map~~ DONE (folded into #5). **Only #2 (do-last) and #3 (owner-blocked) remain of the items in scope.**

**cancel_delivery (HIGH) — ✅ DONE + CODEX-CLEAN, applied live 2026-06-16** (`20260616151122` + Codex P2 follow-ups `20260616170714` & `20260616172121`).

## Session 2026-06-16 PM-2 (this session) — 3 more landed live + Codex-clean, #10 deferred, #3 blocked
**Branch tip after this session: `000c8c0`. Nothing pushed/deployed.** Same proven per-migration flow (now with
the **line-level `pg_get_functiondef` diff** as the fidelity gate — removed/added line arrays, stronger than md5
alone; see [[project_apply-guard-proof-bom-and-diff-proof]]) + per-item Codex review of each commit.
- ✅ **#8** blend/field-app `invoice_created` audit rows — live `20260616191740`, commit `0bdc92d`, Codex clean.
- ✅ **#11** void_delivery canonical idempotency (replays rich payload) — live `20260616201800`, commit `668591f`, Codex clean.
- ✅ **#5** save_quote canonical idempotency + transition-map trim (both findings) — live `20260616204400`,
  commit `000c8c0`, Codex clean. JWT-spoofed rolled-back functional smoke proved retry replays the real quote_id.
- ⏭️ **#10** pipeline-auth tokens — **DEFERRED by Mason** (AskUserQuestion): the population is ~30 freeform RPCs
  (not 7) + a deliberate sibling-consistency freeform family; partial conversion increases inconsistency.
- ⚠️ **#3** split-invoice — **BLOCKED on a multi-field billing-semantics question** (see item #3 below). Dormant
  on live (0 split invoices ever, all single-field). Do NOT apply the Hamilton + sum=100 fix until Mason confirms.

**GOTCHA fixed this session:** the apply-guard proof JSON MUST be written BOM-free — Windows PowerShell
`Set-Content -Encoding utf8` adds a BOM → the hook's `JSON.parse` throws → it silently skips the proof → apply
blocked. Write proofs with **Node** (`fs.writeFileSync`). See [[project_apply-guard-proof-bom-and-diff-proof]].

**NEXT SESSION (fresh context recommended):** (1) get Mason's multi-field answer to unblock/scope #3; (2) do
#2 update_order_items + PARKED-05 — the riskiest paired change (the apply gate already proved that broadening
`_enforce_delivery_items_parent_lock` to `<> 'scheduled'` regresses update_order_items' cancelled/voided
cleanup DELETE; fix = wrap that DELETE in `set_config('app.admin_override','true',true)` + recompute
total_profit/total_margin_pct, THEN broaden the lock in the same/paired migration — see ⛔ DEFERRED block).

## ✅ DONE 2026-06-16 PM-3 (was ⛔ DEFERRED by the gate — shipped as a PAIR)
- **PARKED-05 delivery_items terminal lock + update_order_items override** — DONE LIVE
  (`20260617013523`, commit `2bcfc4c`, not pushed). Broadened the lock to `<> 'scheduled'` AND wrapped
  update_order_items' cancelled/voided cleanup DELETE in `set_config('app.admin_override',...)` in ONE
  paired migration; update_order_items differs from live by ONLY the override bracket. The
  total_profit/total_margin_pct recompute was DROPPED per Codex P2 (it would desync the denormalized
  `commissions` rows) — re-deferred as the commission-aware item noted in the PM-3 banner at top.

## ⏭️ REMAINING (large-RPC pass — each: reproduce full live fn VERBATIM except the change [md5-verify],
##    Codex-review it, run rls-security + migration-drift reviewers, write proof, apply, B7-rename, sweep, commit)
1. ✅ **DONE (live 2026-06-16, `20260616151122`):** cancel_delivery — Option A built INLINE (release prebook +
   cancel the exclusive auto-order + zero pending commissions + audit row), scope-extended to
   `scheduled`+`in_progress`. Codex pending (batched pre-push).
2. **update_order_items (+ PARKED-05 pairing, LOW/MED):** see DEFERRED above.
3. ⚠️ **NEEDS A FIELD-AWARE REDESIGN — Mason answered 2026-06-16: MULTI-FIELD SPLITS ARE REAL.**
   So the originally-prescribed fix (flat per-customer Hamilton + `require sum=100`) is **WRONG** — it assumes a
   single field. The CORRECT fix allocates **per field** (split each field's portion of the order by that field's
   own customer splits, then sum per customer), which needs field→line attribution the function doesn't currently
   have (it applies a flat per-customer `total_pct` to every line). Re-scope as a deeper redesign before building;
   the penny-drift `calculate_billing_splits` idea still applies **within each field's allocation**, not across the
   whole order. Dormant on live (0 split invoices ever, 0 multi-field quotes today) so no urgency. Original analysis:
   create_split_invoices_from_order: the penny-drift is real (each customer's per-line share is `round()`d
   independently → the per-line shares can sum to ≠ the line total). The Hamilton fix is DESIGNED: collect
   customers + summed pct into stable-ordered arrays, create one draft invoice per customer, then for EACH
   order line `v_line_splits := calculate_billing_splits(round(total_price*100), v_cust_pcts)` and write
   `extended_cents = v_line_splits[i]` per customer (item-outer/customer-inner) so each line's cents sum
   EXACTLY; accumulate per-customer totals. **BLOCKER:** `get_field_billing_splits_for_order` SUMS `split_pct`
   per customer ACROSS fields. Single-field order → pcts sum to 100 (fix is correct). **Multi-field order →
   per-customer summed pct can be ≠100** (2 fields each 100% to different customers → sum 200); the original
   bills each customer their FULL summed pct of every line (double-bills), and BOTH the Hamilton apportionment
   AND a `require sum=100` guard would change/break that. **Need:** does CRX ever split-invoice an order that
   spans multiple fields, and if so what's the intended per-customer allocation? LIVE TODAY is safe to defer:
   4 field_billing_defaults rows / 3 fields all sum to 100, **0 multi-field quotes**, 1 order with a quote,
   **0 split invoices ever created** → the bug is dormant and the feature is dark. Do NOT apply the Hamilton +
   sum=100 fix until the multi-field semantics are confirmed (else the first real multi-field split invoice
   mis-bills or is wrongly blocked).
4. **create_quick_delivery (MED):** add `delivery_id = v_delivery_id` to the invoice INSERT (so
   complete_delivery's partial rewrite matches).
5. ✅ **DONE (live 2026-06-16, `20260616204400`):** save_quote idempotency → canonical
   check/save_idempotency at the tail caching the REAL `v_quote_id` + rich result (was: new-quote retry
   returned `quote_id=null` / stored a throwaway `gen_random_uuid()`). **+ folded in the save_quote
   transition-map (MED):** trimmed `v_allowed_transitions` to a strict subset of the enforcer (removed the
   `draft→[revised,declined,expired]` + `expired→[revised]` edges the trigger already rejects). JWT-spoofed
   rolled-back functional smoke proved old=duplicate/null, new=replays the same real id (1 quote created);
   both reviewers clean; enforcer verified unchanged.
6. **complete_delivery (LOW):** partial-invoice rewrite should join on `order_item_id`, not `product_id`.
7. **void_order (LOW):** restore loop should log `void_delivery_reversal`, not `adjusted` (confirm no
   report filters on `'adjusted'` first).
8. ✅ **DONE (live 2026-06-16, `20260616191740`, commit `0bdc92d`):** create_invoice_from_blend_ticket +
   save_field_app_invoice now write an `invoice_created` financial_audit_log row at draft creation (match
   create_invoice_from_order; field-app gated on new `v_is_new_invoice` so edits don't log a creation).
   Byte-faithful verbatim repro (rolled-back line-level pg_get_functiondef diff, removed_from_base=NULL);
   both reviewers clean; smoke accepted; sweeps clean (53 baseline); Codex = SQL sound (2 P3 doc-nits fixed).
9. **Invoices raw soft-delete (LOW):** new `delete_invoice` SECDEF RPC (asserts draft/unposted/voided +
   audit row) + rewire `Invoices.tsx`/`FieldApplicationInvoice.tsx` `.update({deleted_at})` calls.
10. **pipeline-auth-error tokens (LOW):** standardize 7 RPCs onto AUTH_REQUIRED/ACTOR_MISMATCH/INSUFFICIENT_ROLE.
11. ✅ **DONE (live 2026-06-16, `20260616201800`):** void_delivery idempotency moved to canonical
   check_idempotency/save_idempotency — replays the rich payload (was a bare `already_processed`); expires_at
   unchanged (24h default). Byte-faithful; both reviewers clean; round-trip smoke confirmed; sweeps clean.
   **#10 (pipeline-auth tokens): DEFERRED by Mason 2026-06-16** — investigation found ~30 freeform RPCs (not 7)
   + a deliberate sibling-consistency freeform family; partial conversion increases inconsistency. See LEDGER.
- ~~**save_quote transition-map (MED):** trim its internal v_allowed_transitions to a subset of the enforcer.~~
  ✅ **DONE** — folded into `20260616204400` with the #5 idempotency fix (see #5 above).
- **Frontend greens:** OrderDetail "Written Off" tile; money.ts ESLint rule (don't blind-rename); the
  BlendTicketDetail approve/reject RPC routing follow-up; AR-aging gross convention doc note; (optional)
  the 4 PDF page-overflow guards.

## 🔴 OWNER ACTION (Mason — not code, can't be auto-applied)
- **seed-admin (PARKED-07):** confirm `ENVIRONMENT=production` on the live project (closes M4) + **delete
  the function** (recommended) or harden+redeploy with `verify_jwt: true`. Awaiting Mason's "delete" vs
  "harden". Details in `parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md`.

## Gate mechanics (so the next session doesn't relearn them)
- **apply_migration is blocked** unless a proof file exists: `.claude/session-state/migration-review-<name>.json`
  `{migration, timestamp (REAL UTC, <30min), reviewers:[rls-security-reviewer,migration-drift-reviewer], findings:"clean"}`.
  Write it (PowerShell, real `(Get-Date).ToUniversalTime()`) only AFTER both reviewers return clean.
- The `posttooluse-migration` hook fires on every new migration file → run typecheck + the 2 reviewers.
- **B7:** Supabase stamps its own version on apply; `SELECT version FROM supabase_migrations.schema_migrations
  WHERE name='<name>'` then rename the disk file to match.
- **Reviewer subagents can't run live SQL** — they list confirms for the orchestrator; run them via
  `execute_sql` (project `rhyzpcqhnizqbxphqdkr`) before applying.
- **New SECDEF trigger fns** get a default PUBLIC EXECUTE → add a REVOKE (keeps anon-exec-secdef sweep at 53).
- After each apply: `pg_get_functiondef`/census verify + the db-invariant-sweeps (mostly N/A for trigger fns).
- Trust the **rls-security-reviewer's cross-function check** — it caught the delivery_items/update_order_items
  regression. Reproduce big functions byte-faithfully; the migration-drift-reviewer enforces fidelity.
