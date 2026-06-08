# Workflow & Business-Logic Review — 2026-06-08

## Verdict
**The foundation is solid — safe to build the next feature on.** Four parallel layers (graph/connection, lifecycle, cross-entity flow, business-logic invariants) read the live source + queried the live Supabase DB and found **0 BLOCKER and 0 HIGH**. No entity can be permanently stranded; no ghost status states; money is integer cents everywhere; all 95 tables have RLS; every SECURITY DEFINER function has `search_path`; the immutability + status-enforcer triggers are all attached and working. The single most worthwhile fix is **`restore_quote_version`** (MED): its "restore an earlier version" button is *reachable* on an `accepted` quote but the status-enforcer trigger blocks the `→revised` write, so the user gets a generic "Failed to restore version" toast — proven with a rolled-back live smoke test. Everything else is dead-in-UI landmines (the `restore_cancelled_*` RPCs) or documentation/defense-in-depth hygiene.

## Scope
Routes: **71** · RPC calls: **164** · Tables: **95** · Lifecycles checked: **10**
Method: regenerated `docs/app-workflow-map.html` from HEAD + read live source + queried the live Supabase DB (`pg_proc` bodies, triggers, CHECK constraints, `pg_policies`, advisors) + **rolled-back runtime smoke tests** on real prod rows. Every finding carries a `file:line` / RPC / trigger / constraint citation. Schema registry was 8 days old, so the layers used the live DB directly.

## Findings

### 🛑 BLOCKER (0)
None.

### 🔴 HIGH (0)
None.

### 🟡 MED (2)

- **`restore_quote_version` button is reachable on quotes the enforcer won't restore.** `restore_quote_version` unconditionally writes `UPDATE quotes SET status='revised'` with **no `admin_override` bracket**, but the `BEFORE UPDATE OF status` trigger `enforce_quote_status_transition` only permits `→revised` from `sent` (or the no-op when already `revised`). The handler `handleRestoreVersion` (`src/pages/QuoteBuilder.tsx:1164-1181`) and its button (`:1585`) are rendered whenever a version is selected, **with no guard on the quote's current status**. Real scenario: revise a quote a few times (creating snapshots) → accept it → later try to roll back → throws `Invalid quote status transition: accepted → revised`, surfaced only as the generic toast `Failed to restore version`. **Proven** (rolled-back live smoke test on a real `accepted` quote: `BLOCKED from accepted: Invalid quote status transition: accepted → revised`). The happy path (`revised`/`sent`) works, which is why it hasn't obviously broken.
  **Why it matters:** a legitimate, common admin action silently fails with an unhelpful message. **Recommendation:** mirror the `void_order` pattern — bracket the status write with `set_config('app.admin_override','true',true)` … `'false'` so a deliberate restore is allowed from any source state — **or** gate the QuoteBuilder button to only show when status ∈ (`sent`,`revised`), **or** add `accepted→revised` (and likely `declined/expired`) to the enforcer's allowed set. Add a rolled-back smoke test from an `accepted` quote. Requires a `CREATE OR REPLACE` migration through the standard `rls-security-reviewer`/`migration-drift-reviewer` gate — do not hand-apply. Confidence: **high**.

- **`restore_cancelled_order` + `restore_cancelled_delivery` are broken (but dead-in-UI).** Both attempt an enforcer-forbidden transition with **no `admin_override`**: `restore_cancelled_order` does `UPDATE orders SET status='confirmed'` from a `cancelled` order; `restore_cancelled_delivery` does `UPDATE deliveries SET status='scheduled'` from a `cancelled` delivery. Neither enforcer has a `cancelled→…` rule (`sets_override_flag=FALSE` for both, vs `TRUE` for `void_order`/`void_delivery`/`cancel_order`). **Proven** (rolled-back live smoke test: `UPDATE orders SET status='confirmed'` on a real cancelled order → `BLOCKED: Invalid order status transition: cancelled → confirmed`). So both would fail on **every** call. Capped at MED because a repo-wide grep shows **zero `src/**.tsx` callers** — they appear only in test allow-lists (`rpcContracts.test.ts:1396-1397`, `schemaIntegrity.test.ts:574-576`).
  **Why it matters:** landmines — if anyone later wires a "Restore" button to these, it breaks immediately. **Recommendation:** add the `set_config('app.admin_override','true',true)` bracket around each status write (copy the 3-line `void_order` pattern), **bundled into one migration with the `restore_quote_version` fix**. If they're considered abandoned, the alternative is to `DROP` them so they can't be wired broken — but fixing is cheap and they were clearly meant to work. Confidence: **high**.

### ⚪ LOW (10)

1. **CLAUDE.md prose lifecycle arrows misrepresent branching graphs as linear chains** (Quote, Return especially). e.g. Quote `draft → sent → revised → accepted → declined → expired → cancelled` implies `declined→expired→cancelled`, but `declined/expired/cancelled` are **terminal** and `revised↔sent`/`accepted→sent` are real edges. The per-entity SVGs in `docs/app-workflow-map.html:152-279` model these correctly. Doc-accuracy only — no code is wrong. **Rec:** reword the lifecycle lines to show branches/terminals, or point readers to the SVGs as the source of truth.
2. **`blend_tickets` has 4 orthogonal status axes and no CLAUDE.md lifecycle entry.** `status` (OCR pipeline), `review_status`, `payment_status`, `order_link_status` — all writes verified against their live CHECK constraints (no ghost states); the section just omits BlendTicket. **Rec:** add a BlendTicket lifecycle entry documenting the 4 axes + which RPC owns each.
3. **`void_invoice` can't void a `paid` invoice** (`paid→voided` not in the enforcer). Unreachable today — both callers (`InvoiceDetail.tsx:837-873`, `batch_void_invoices`) gate on `status='posted'`, and 0 paid invoices exist in prod. Minor UX: `overdue` is enforcer-voidable but the InvoiceDetail Void button only shows for `posted`. **Rec (defense-in-depth):** have `void_invoice` raise a clear domain error (`CANNOT_VOID_PAID_INVOICE — reverse payment first`) rather than leaking the raw trigger message; optionally show the Void button for `overdue` too.
4. **`transfer_job_to_invoice` bypasses canonical `next_invoice_number()`** — inline `MAX()+1` under a *different* advisory lock than the canonical path, so two concurrent txns (a job-invoice + a `field_application` invoice) could compute the same `INV-YYYY-NNNN`. Blast radius bounded: `invoices.invoice_number` is UNIQUE → a real collision raises `unique_violation` and rolls back (no silent dup). **Rec:** replace the inline block with `next_invoice_number('field_application')` so both paths share one sequence + lock. Hygiene, not a data-integrity blocker.
5. **`create_order_from_blend_ticket` lacks the strict-actor guard** its sibling conversion RPCs enforce (no `auth.uid()`/`ACTOR_MISMATCH` block; trusts `p_performed_by`). Attribution-only, RLS-gated, doesn't strand anything — same class as the `2026-05-31` `batch_rpc_strict_actor` work and today's `save_blend_ticket` fix. **Rec:** fold the canonical strict-actor block in when the next blend-ticket migration is touched.
6. **`anon` still has EXECUTE on 52 SECURITY DEFINER functions** (advisor + live `proacl`), which reads as contradicting CLAUDE.md's claim that `20260529214355` revoked anon EXECUTE on report/dashboard RPCs. **Proven non-exploitable:** the 21 trigger functions error on direct call; every mutator self-gates on `auth.uid()`/`require_admin` as its first statement; runtime probes as `anon` returned `BLOCKED: requires admin role` / `Admin access required` / `Access denied`. Residual grant-debt, not a hole. **Rec:** either `REVOKE EXECUTE … FROM anon, PUBLIC` on the 52 (keep authenticated/service_role; **not** the trigger fns) through the migration gate, or reconcile CLAUDE.md to state plainly that anon EXECUTE remains as inert grant-debt gated by the in-body checks.
7. **`create_planned_holds` uses non-canonical inline idempotency** (save-before-work, 24h window) instead of `check_idempotency`/`save_idempotency`. Not a stranding risk — it DELETEs existing active holds then re-creates, so it's self-idempotent per quote. **Rec:** migrate to the helpers when next touched. (Consistent with the documented 2026-05-07-era inline-idempotency RPCs.)
8. **`Fields` delete has no app-level pre-delete active-reference check** (`Fields.tsx:190-214` deletes with `checkMutationResult` but no guard for active quotes/orders/deliveries). Safety depends on the FK `ON DELETE` rule. **Rec:** confirm the FKs are `RESTRICT` (DB blocks), or add a pre-delete reference query.
9. **Two RPCs are UI-unused** (`dashboard_summary`, `create_invoice_from_delivery`) — referenced only as test-harness contracts. **Rec:** optional cleanup (drop + update test lists) only if explicitly desired.
10. **Stale workflow-map Problems note** claims `commission_payments` lifecycle is missing from CLAUDE.md — it's actually documented at `CLAUDE.md:197-200`. The note is FALSE/already-fixed. **Rec:** strike it from the map's Problems section.

## Lifecycle reconciliation table
| Entity | Live CHECK | CLAUDE.md | Map SVG | RPC transitions | Agree? |
|--------|-----------|-----------|---------|-----------------|--------|
| Order | confirmed/partially_fulfilled/fulfilled/cancelled/voided | ✓ | ✓ | enforcer matches | ✅ |
| Delivery | scheduled/in_progress/completed/cancelled/voided | ✓ | ✓ | enforcer matches (completed→voided via override) | ✅ |
| Invoice | draft/unposted/posted/paid/overdue/voided/cancelled | ✓ | ✓ | matches; only unreachable `paid→voided` gap | ✅ (LOW #3) |
| Job | scheduled/in_progress/completed/cancelled/invoiced | ✓ | ✓ | enforcer matches | ✅ |
| PurchaseOrder | draft/submitted/partially_received/fully_received/cancelled | ✓ | ✓ | matches (incl. reverse-receiving) | ✅ |
| Return | requested/approved/received/credited/rejected/cancelled | ✓ (gotcha noted) | ✓ | matches; no `pending`/`void` drift | ✅ (prose arrows LOW #1) |
| Commission | pending/paid/cancelled | ✓ | ✓ | valid literals; no enforcer needed | ✅ |
| CommissionPayment | unposted/posted/voided | ✓ | ✓ | matches | ✅ |
| Quote | draft/sent/revised/accepted/declined/expired/cancelled | ✓ (arrows misleading) | ✓ (correct) | enforcer matches; **`restore_quote_version` can't reach `→revised` from terminal states** | ⚠️ MED |
| BlendTicket | 4 axes, all valid | ✗ (undocumented) | partial | all writes valid; no ghost states | ⚠️ LOW #2 (docs) |

## Cross-entity flow status
- **Quote→Order→Delivery→Invoice→Payment** — intact; no stranding. Conversions (`convert_quote_to_order`, `create_quick_delivery`, `create_invoice_from_*`) all wired + idempotent.
- **Commission** — created per order/recipient; `void_invoice`/`void_order` cancel; `void_commission_payment` resets paid→pending. Clean.
- **PO / Receiving / Inventory** — receive + reverse-receive transitions match the enforcer; immutable `inventory_transactions` ledger. Clean.
- **Return → Inventory** — `approve/receive/issue_return_credit` wired + idempotent. Clean.
- **Blend Ticket → Order/Invoice** — conversions work; only the strict-actor attribution gap (LOW #5) + the multi-axis status (LOW #2). No stranding.
- **Job → Invoice** — works; only the non-canonical invoice-number generation (LOW #4). No stranding.

## Verified safe (leads checked, found correct — do not re-chase)
- **Graph:** all 66 lazy routes have Route entries; `/notifications` (TopBar bell), `/payment-history` (FinancialDashboard nav-array), `/customers/new`→`:id` pattern all resolve; `get_field_geojson` is live (`FieldSetup.tsx:131`); `/payments` correctly admin+sales; no unguarded financial-table writes; Return RPCs + all major lifecycle RPCs idempotency-wired.
- **Lifecycle:** **zero ghost states** across all 218 RPCs × 10 CHECK constraints; `void_order`/`void_delivery`/`cancel_order`/`cancel_delivery`/`complete_delivery` all correctly set `admin_override` for enforcer-exempt writes; all 7 `enforce_*_status_transition` triggers attached + enabled; Return uses `requested`/`credited` (no `pending`/`returned` drift); `create_followup_delivery` writes `delivery_remainders.status` (valid), not `deliveries.status`.
- **Invariants:** money is integer cents everywhere (no float storage; no `parseFloat(...cents)`); **95/95 tables RLS-enabled**, 0 disabled, 0 enabled-but-no-policy (the 1 advisor ERROR is the documented `profile_public_view` exception); all SECDEF functions have `search_path`; immutability triggers on `inventory_transactions` + `financial_audit_log` runtime-proven to BLOCK UPDATE/DELETE; **0 function-overload collisions**; the 11 no-`updated_at` tables verified never written with `updated_at`; performance advisors 0 WARN (146 INFO unused-index = expected FK indexes); anon-executable mutators runtime-proven to reject the anon role.

## Before you add features — prioritized punch list
1. **Fix `restore_quote_version`** (MED) — bracket the `→revised` write with `admin_override` (or gate the button). One `CREATE OR REPLACE` migration through the reviewer gate + a rolled-back smoke test from an `accepted` quote. *This is the only user-reachable defect.*
2. **Fix or drop `restore_cancelled_order` + `restore_cancelled_delivery`** (MED) — same `admin_override` bracket, **bundle into the same migration** as #1. Defuses the landmines before anyone wires a Restore button.
3. **Doc hygiene (LOW, batchable, no code):** add the BlendTicket lifecycle (LOW #2), reword the Quote/Return lifecycle arrows or point to the SVGs (LOW #1), strike the stale `commission_payments` map note (LOW #10), and reconcile the anon-EXECUTE wording (LOW #6).

*Everything below the punch list is optional defense-in-depth / hygiene (LOW #3-#9) — safe to leave until the relevant code is next touched.*
