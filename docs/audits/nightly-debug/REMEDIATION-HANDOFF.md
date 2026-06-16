# Nightly-Debug Remediation — Handoff (resume here)

**As of 2026-06-16 ~07:25 CT.** Branch `claude/priceless-austin-0d3ccd`, worktree
`C:\CRX_Manager\.claude\worktrees\priceless-austin-0d3ccd`. Last commit `15581f3`. Tree clean.
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

**Still REMAINING in the large-RPC pass** (numbering from the list below): ~~#1 cancel_delivery (HIGH)~~ **DONE + Codex-clean (3 rounds, live)**, #2 update_order_items+PARKED-05 (paired, do last), #3 create_split_invoices_from_order (Hamilton), #5 save_quote (idempotency+map), ~~#6 complete_delivery~~ DONE, ~~#7 void_order~~ DONE, #8 blend/field-app invoice audit rows, #9 delete_invoice RPC, #10 pipeline-auth tokens, #11 void_delivery idempotency, + save_quote transition-map + the frontend greens. (Items #1/#4/#6/#7 in the numbered list below are DONE.) **Codex is now installed → run it BEFORE apply per-item on the remaining behavior changes (#2/#3/#5).**

**cancel_delivery (HIGH) — ✅ DONE + CODEX-CLEAN, applied live 2026-06-16** (`20260616151122` + Codex P2 follow-ups `20260616170714` & `20260616172121`). Built INLINE (Option A intent, NOT `PERFORM cancel_order` — admin-only), scope-extended to `scheduled`+`in_progress`, releases by `order_items`, flags paid commissions, locks the order. Codex review of the final commit = clean. See the DONE block above + the 3 migration-history rows.

**Session boundary (2026-06-16 PM):** stopped here deliberately after 3 clean fixes + the cancel_delivery analysis — the remaining items are all either large-function verbatim reproductions (drift-sensitive) or behavior changes needing Codex + functional smokes, which deserve fresh context for fidelity. Branch tip `7542d30`+ (this doc). Nothing pushed/deployed.

## ⛔ DEFERRED by the gate (do as a PAIR)
- **PARKED-05 delivery_items terminal lock** — broadening `_enforce_delivery_items_parent_lock` to
  `<> 'scheduled'` regresses `update_order_items`' cancelled/voided cleanup `DELETE` (it runs WITHOUT
  `app.admin_override`). **Fix together with the `update_order_items` rewrite:** wrap that DELETE in
  `set_config('app.admin_override','true',true)` (+ recompute total_profit/total_margin_pct — that's the
  update_order_items LOW finding too), THEN apply the lock broadening in the same/paired migration.

## ⏭️ REMAINING (large-RPC pass — each: reproduce full live fn VERBATIM except the change [md5-verify],
##    Codex-review it, run rls-security + migration-drift reviewers, write proof, apply, B7-rename, sweep, commit)
1. ✅ **DONE (live 2026-06-16, `20260616151122`):** cancel_delivery — Option A built INLINE (release prebook +
   cancel the exclusive auto-order + zero pending commissions + audit row), scope-extended to
   `scheduled`+`in_progress`. Codex pending (batched pre-push).
2. **update_order_items (+ PARKED-05 pairing, LOW/MED):** see DEFERRED above.
3. **create_split_invoices_from_order (MED):** route per-line split through `calculate_billing_splits`
   (Hamilton) + require split_pct sum = 100.
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
