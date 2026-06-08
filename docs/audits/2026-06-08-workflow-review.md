# Workflow & Business-Logic Review — 2026-06-08

## Verdict

**Your foundation is solid. Build the next feature.** Across all four review layers — graph/navigation wiring, entity lifecycles, cross-entity money/inventory flow, and core safety invariants — there are **zero BLOCKERs and zero data-loss/money-correctness/security-bypass issues**. RLS is universal (every table protected), money is bigint-cents with no float math, both immutability ledgers (`inventory_transactions`, `financial_audit_log`) are enforced, there are no function-overload collisions, and every conversion chain (quote → order → delivery → invoice → payment, plus commissions/PO/returns/blend) produces correctly back-linked entities with a reversal path — nothing gets permanently stranded. The **single thing worth fixing before you pile on more features** is one HIGH bug: cancelling a return that has already been *received* crashes (the app shows the button, but the database rejects the transition), so that one admin action silently fails. It's a ~5-line fix. Everything else is MED/LOW drift — safe today, just worth tidying so it doesn't confuse you (or your AI assistant) later.

## Scope

Routes: 71 · RPC calls: 164 (graph: 94 nodes, 164 edges) · Tables: 95 · RPCs: 218 · Migrations: 370 · Lifecycles checked: 10
Method: regenerated `docs/app-workflow-map.html` from HEAD → ran 4 parallel review layers reading live source + querying the live Supabase DB (project `rhyzpcqhnizqbxphqdkr`) → adversarially verified both HIGH findings with 2 independent skeptic agents each (1 confirmed, 1 refuted). Every finding cited to `file:line` / constraint / migration.

## Findings

### 🛑 BLOCKER (0)

None.

### 🔴 HIGH (1)

- **`cancel_return` crashes when cancelling an already-*received* return** — RPC `cancel_return` (`supabase/migrations/20260507130000_cancel_return_skipped_count.sql:75-126`; live body confirmed identical) explicitly allows cancelling a return in status `received` and runs dedicated inventory-restock-*reversal* logic, then does a plain `UPDATE returns SET status='cancelled'` **without** setting `app.admin_override`. But the live `BEFORE UPDATE` trigger `_enforce_return_status_transition` (`supabase/migrations/20260311200000_wave2_audit_fixes.sql`; `tgenabled='O'`) only permits `received → credited` — so `received → cancelled` raises `Invalid return status transition: received → cancelled` and the **entire RPC rolls back** (no status change, no restock reversal, no activity log). **Both skeptic agents reproduced this against the live DB and could not refute it.** It is user-reachable: `src/pages/Returns.tsx:933-936` renders the Cancel button for `received` returns, and the confirm modal (`Returns.tsx:823-824`) literally tells the admin *"This return has already been received and inventory was restocked. Cancelling will REVERSE the restock."* — inviting exactly the action that crashes. Latent only because `returns` currently holds 1 `requested` row and 0 `received` rows, so no one has hit it yet. **Why it matters:** the first time a real received return needs cancelling instead of crediting, the app will throw and the operator won't be able to complete it. **Recommendation:** mirror the pattern `cancel_delivery`/`complete_delivery` already use — wrap the final UPDATE in `cancel_return` with `SET LOCAL app.admin_override = 'true'` (then reset), OR add a `received → cancelled` branch to the transition trigger. The RPC already gates on role + actor, so either is safe; confirm with yourself that cancelling a received return (vs. crediting it) is intended business behavior first. Confidence: **high**.

### 🟡 MED (3)

- **`void_delivery` marks draft invoices `voided`; every other RPC marks them `cancelled`** — `void_delivery` (`supabase/migrations/20260332300000_fix_void_delivery_three_bugs.sql:138-143`, live-confirmed) sets `invoices.status='voided' WHERE status='draft'`, getting away with it only because it sets `app.admin_override=true` first (the trigger otherwise forbids `draft → voided`). Compare `cancel_delivery`, `void_order`, `void_invoice`, `cancel_order` — all send draft/unposted invoices to `'cancelled'`. Both values are valid in the CHECK so nothing crashes, but a never-posted draft ending up "voided" here and "cancelled" everywhere else is semantically inconsistent and reporting-confusing. **Recommendation:** change that one UPDATE to `status='cancelled'` to match the other four (also removes the need for the override on that line). Low-risk, behavior-aligning.

- **`auto_expire_quotes` would crash on `draft → expired`, and is orphaned/dead** — `auto_expire_quotes` (live; latest disk `supabase/migrations/20260510050000_pg_temp_security_definer_fixes.sql:13`) excludes `('expired','declined','accepted','converted')` then `UPDATE ... SET status='expired'`, but the quote transition trigger only allows `expired` from `sent`/`revised` — not `draft` — and the RPC sets no override. A `draft` quote with a past `expires_at` (nullable, no default) would raise `Invalid quote status transition: draft → expired`. **Dropped to MED because it's dead code:** not in pg_cron (only `mark-overdue-invoices`, `release-expired-quote-holds`, `check-remainder-reminders` are scheduled) and has **0** callers in `src/`. Secondary: the `'converted'` token in its exclude list is an orphan — no such value exists in `quotes_status_check` (converted quotes are `'accepted'`). **Recommendation:** either delete `auto_expire_quotes` (it's unused), or — if you intend to wire it to cron — restrict its loop to `status IN ('sent','revised')` and drop the stale `'converted'` reference.

- **Documented anon-EXECUTE revoke doesn't match live grants (defense-in-depth gap)** — CLAUDE.md's 2026-05-29 entry says migration `20260529214355_revoke_anon_execute_on_report_dashboard_secdef` revoked anon `EXECUTE` on 37 report/dashboard/financial SECDEF RPCs (89→52). But live `pg_proc.proacl` shows functions like `get_customer_statement`, `get_ar_aging`, `financial_dashboard_summary`, `get_sales_summary_report`, `allocate_payment`, `admin_update_profile` **still return `has_function_privilege('anon', oid, 'EXECUTE') = true`**. They are **not exploitable** — each self-gates at the top of its body (`auth.uid()` is NULL for anon, so it raises before touching data) — so this is documentation/state drift on a security control, not a live leak. **Recommendation:** either (a) actually `REVOKE EXECUTE ... FROM anon` on these as the doc claims (true defense-in-depth — don't rely solely on body guards), or (b) correct the CLAUDE.md wording to state the control is the inline role guard, not a grant revoke. Reconcile the "52 remaining" composition note while you're there.

### ⚪ LOW (4)

- **BlendTicket's 4-axis lifecycle is undocumented in CLAUDE.md** — `blend_tickets` has four independent status axes (`status`, `review_status`, `order_link_status`, `payment_status`), each driven by a different RPC/Edge Function; all transitions use valid CHECK values (verified clean). It's the most complex entity in the app yet the only one missing from CLAUDE.md's "Business Logic Lifecycles." **Recommendation:** add a BlendTicket block documenting the four axes and which RPC/function drives each. Docs-only.

- **`invoices` has no DB-level `order_id OR blend_ticket_id` CHECK** — `pg_constraint` on `invoices` returns zero CHECK constraints, but CLAUDE.md's Hard Red Line states invoices "must have order_id or blend_ticket_id." The rule is enforced by RPC convention, not the schema — and credit memos legitimately rely on that looseness (`issue_return_credit` inserts a `credit_memo` with possibly-NULL `order_id` and no `blend_ticket_id`), so a literal CHECK would *break* credit memos. This is doc over-claim, not a stranding bug. **Recommendation:** reword CLAUDE.md to "enforced by RPC convention; credit memos exempt," or add a partial CHECK excluding `invoice_type='credit_memo'` if you want real DB enforcement.

- **Two legacy `commissions` rows with empty-string `recipient`** — rows `dac302c8-…` (status `pending`, recipient `''`, $50, but has a valid `recipient_user_id`) and `1f5da70a-…` (cancelled, $0). New blank-recipient commissions are now impossible (`_insert_commissions_for_order` filters `WHERE NULLIF(btrim(s->>'recipient'),'') IS NOT NULL`); these predate the filter. The pending $50 is technically payable (payout takes explicit IDs) but a blank display name may hide it in a name-grouped UI. **Recommendation:** backfill the blank `recipient` from its `recipient_user_id`'s profile name — a one-row data fix, not code.

- **9 unguarded anon-callable SECDEF helpers (no data exposure)** — `calculate_billing_splits`, `check_period_open`, and 7 `next_*_number()` sequence generators are anon-EXECUTE-able with no inline role guard. All are pure helpers (math / period lookup / advisory-lock sequence) that write no rows and return no PII — worst case anon learns the next document number. **Recommendation:** optional `REVOKE anon EXECUTE` for tidiness/defense-in-depth. Not urgent.

## Lifecycle reconciliation table

| Entity | Live CHECK | CLAUDE.md | Map SVG | RPC transitions | Agree? |
|--------|-----------|-----------|---------|-----------------|--------|
| Quote | draft, sent, revised, accepted, declined, expired, cancelled | same (informally lists `→converted`, no such state) | matches | trigger draft→{sent,cancelled}, sent/revised→{accepted,declined,expired,cancelled}, accepted→sent | ⚠️ `auto_expire` draft→expired not in trigger (MED); `'converted'` orphan token |
| Order | confirmed, partially_fulfilled, fulfilled, cancelled, voided | same | matches | trigger + RPCs all within CHECK; void/cancel use override | ✅ |
| Delivery | scheduled, in_progress, completed, cancelled, voided | same | matches | confirm/complete/cancel/void valid (cancel/void use override) | ✅ |
| Invoice | draft, unposted, posted, paid, overdue, voided, cancelled | same | matches | all reachable | ⚠️ `void_delivery` draft→voided vs cancelled elsewhere (MED) |
| Job | scheduled, in_progress, completed, cancelled, invoiced | same | matches | start/complete/transfer/cancel valid | ✅ |
| PurchaseOrder | draft, submitted, partially_received, fully_received, cancelled | same | matches | receive/cancel/reverse valid | ✅ |
| Return | requested, approved, received, credited, rejected, cancelled | same | matches | trigger blocks `received→cancelled` that `cancel_return` performs | ❌ HIGH (crash) |
| BlendTicket | 4 axes (status/review_status/order_link_status/payment_status) | **not documented** | partial | all axis transitions valid | ⚠️ undocumented (LOW) |
| Commission | pending, paid, cancelled | same | matches | post→paid, void→pending, cancel→cancelled | ✅ |
| CommissionPayment | unposted, posted, voided | same | matches | create→unposted, post→posted, void→voided | ✅ |

## Cross-entity flow status

| Chain | Status |
|-------|--------|
| Quote → Order (`convert_quote_to_order`) | **OK** — holds released, items copied + back-linked, `is_planned` resolved to prebooked + ledger txn, commissions inserted, idempotent re-entry guard |
| Order → Delivery (`confirm_delivery`/`complete_delivery`) | **OK** — items locked after scheduled (trigger), `p_signed_by` required, inventory deducted on complete, partials create remainders, linked draft invoice auto-created |
| Delivery cancel/reversal (`cancel_delivery`) | **OK** — handles scheduled/in_progress/completed, full inventory restore, draft invoices cancelled |
| Order cancel (`cancel_order`) | **OK** — releases prebooked, deactivates quote holds (no double-restore), zeroes pending commissions, flags posted invoices for review |
| Invoice → Payment (`allocate_payment`/`post_invoice`) | **OK** — `check_period_open` enforced, strict-actor + role gated, `balance_cents` is GENERATED single AR truth |
| Order → Commission | **OK** — split validated to 100%, rounding reconciled, entity recipients (CMCTW $72,174.90 / Crop Rx) wired (one legacy blank-recipient $50 row — LOW) |
| PO → Inventory (`receive_po_items`) | **OK** — correct `received` txn, over-receive guarded, idempotent |
| Return → Inventory/Credit (`receive_return`/`issue_return_credit`) | **OK** — restock txns, posted credit_memo with negative total + `check_period_open` |
| Blend ticket → Invoice | **OK** — invoice carries `blend_ticket_id`, ticket marked `billed`; reverse-after-billing inconsistency is self-healing (see Verified Safe) |
| Blend ticket → Order / Application | **OK** — linked rows with dedup guards, unlink reversal exists |

## Verified safe (leads checked, found correct — do not re-chase)

- **`reverse_blend_ticket_approval` "billed invoice dangling" (flagged HIGH, REFUTED by both skeptics)** — the RPC genuinely doesn't reset `payment_status`, BUT: (1) it has **zero callers** in `src/` — no UI button exists in `BlendTicketDetail.tsx`; it's reachable only from a raw SQL console; (2) there are **0 blend tickets** in production; (3) voiding the linked invoice **automatically** un-bills the ticket via live trigger `trg_sync_blend_ticket_payment` → `sync_blend_ticket_payment_status()`, so the state self-heals — the finding's claimed "manual workaround" isn't even manual. No money lost, AR never wrong. Pre-emptive note only: *if* a "Reverse Approval" button is ever added, fix the RPC to also reset `payment_status`/void-or-unlink draft invoices at that time.
- **Orphan pages** — `/notifications`, `/payment-history`, `/getting-started`, `/team-board` all genuinely reachable (sidebar links + FinancialDashboard quickLinks). Not orphans.
- **Dead RPCs** — `get_field_geojson`, `get_fields_with_geojson`, `global_search` all in active use (FieldSetup/FieldDashboard/CommandPalette). Confirms the prior "wrongly flagged" note.
- **Prior security fixes verified live** — batch-RPC strict-actor (`20260531151134`), `void_order`/`void_invoice` transitions (`20260529214538`), anon-EXECUTE revokes (`20260529214355`/`20260526201319`) all in place.
- **RLS universal** — 0 tables without RLS, 0 with RLS-but-no-policy. `profile_public_view` SECDEF exception is intentional (it's a view, correctly not flagged).
- **All SECURITY DEFINER functions set `search_path`** — 0 violations. **Zero function-overload collisions.**
- **Immutability ledgers enforced** — `inventory_transactions` (BEFORE DEL/UPD blocking trigger, documented bypass GUC) and `financial_audit_log` (append-only, no bypass) both active.
- **Money** — no `parseFloat` on `*_cents` in production; the `JobDetail.tsx:302-303` hits are `parseFloat(quantity)` (legitimately fractional) wrapped in `Math.round`.
- **Idempotency** — 7 mutating-key-declaring RPCs without `idempotency_keys` I/O are all classified (non-mutating / natural dedup guard) and test-enforced in `src/lib/rpcContracts.test.ts:1528-1537`.
- **`updated_at` on exempt tables** — 4 regex hits all write `updated_at` to tables that have it (inventory/orders/invoices), never to exempt tables.
- **DB advisors** — 0 performance WARN/ERROR (147 `unused_index` INFO only); 1 security ERROR = the intentional `profile_public_view`.
- **`'converted'` quote token** — confirmed harmless orphan (only inside a `NOT IN` exclusion; no quote ever holds it).

## Before you add features — prioritized punch list

1. **Fix `cancel_return` for received returns (HIGH).** Add `SET LOCAL app.admin_override='true'` around the final UPDATE (or add `received → cancelled` to the transition trigger). This is the only finding that actually breaks a user action. ~5 lines.
2. **Align `void_delivery` to mark draft invoices `cancelled` (MED).** One-word UPDATE change; removes a cross-RPC inconsistency before it confuses reporting.
3. **Decide `auto_expire_quotes`: delete it or wire+constrain it (MED).** It's dead today and would crash if run on a draft — don't leave a loaded gun in the codebase.
4. *(Housekeeping)* Reconcile the anon-EXECUTE doc-vs-live drift (MED), document the BlendTicket 4-axis lifecycle (LOW), reword the invoice-constraint Red Line (LOW), and backfill the one blank-recipient commission (LOW).

---

*Read-only review. No code edited, no migration applied, no deploy, no DB mutation. The only file written is this report; the regenerated workflow map was committed separately (`a570c92`).*
