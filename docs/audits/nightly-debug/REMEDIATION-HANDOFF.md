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

## ⛔ DEFERRED by the gate (do as a PAIR)
- **PARKED-05 delivery_items terminal lock** — broadening `_enforce_delivery_items_parent_lock` to
  `<> 'scheduled'` regresses `update_order_items`' cancelled/voided cleanup `DELETE` (it runs WITHOUT
  `app.admin_override`). **Fix together with the `update_order_items` rewrite:** wrap that DELETE in
  `set_config('app.admin_override','true',true)` (+ recompute total_profit/total_margin_pct — that's the
  update_order_items LOW finding too), THEN apply the lock broadening in the same/paired migration.

## ⏭️ REMAINING (large-RPC pass — each: reproduce full live fn VERBATIM except the change [md5-verify],
##    Codex-review it, run rls-security + migration-drift reviewers, write proof, apply, B7-rename, sweep, commit)
1. **cancel_delivery — Option A (HIGH):** on cancel of a `scheduled` `is_quick_delivery`, also cancel the
   auto-created order so its prebook releases the normal way (no zombie order, no stranded inventory).
2. **update_order_items (+ PARKED-05 pairing, LOW/MED):** see DEFERRED above.
3. **create_split_invoices_from_order (MED):** route per-line split through `calculate_billing_splits`
   (Hamilton) + require split_pct sum = 100.
4. **create_quick_delivery (MED):** add `delivery_id = v_delivery_id` to the invoice INSERT (so
   complete_delivery's partial rewrite matches).
5. **save_quote (MED):** replace inline idempotency with canonical check/save_idempotency at the tail,
   caching the REAL `v_quote_id` (not `gen_random_uuid()`).
6. **complete_delivery (LOW):** partial-invoice rewrite should join on `order_item_id`, not `product_id`.
7. **void_order (LOW):** restore loop should log `void_delivery_reversal`, not `adjusted` (confirm no
   report filters on `'adjusted'` first).
8. **create_invoice_from_blend_ticket + save_field_app_invoice (LOW):** add an `invoice_created`
   financial_audit_log row at draft creation (match create_invoice_from_order).
9. **Invoices raw soft-delete (LOW):** new `delete_invoice` SECDEF RPC (asserts draft/unposted/voided +
   audit row) + rewire `Invoices.tsx`/`FieldApplicationInvoice.tsx` `.update({deleted_at})` calls.
10. **pipeline-auth-error tokens (LOW):** standardize 7 RPCs onto AUTH_REQUIRED/ACTOR_MISMATCH/INSUFFICIENT_ROLE.
11. **void_delivery (LOW):** move idempotency to the canonical helper, cache/replay the rich payload.
- **save_quote transition-map (MED):** trim its internal v_allowed_transitions to a subset of the enforcer.
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
