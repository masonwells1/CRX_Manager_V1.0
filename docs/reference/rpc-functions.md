# RPC Functions Reference (327 callable overloads across 319 names + 82 trigger/internal functions — live DB as of 2026-07-16)

> Function inventory verified live against Supabase project `rhyzpcqhnizqbxphqdkr` (`pg_proc` joined to `pg_namespace` where `nspname='public'`, split by `prorettype = 'trigger'::regtype`): **327 callable overloads across 319 distinct names**, **82 trigger/internal function names**, **401 total public function names**. This supersedes the earlier 2026-06-29 branch-HEAD snapshot (270 + 56), which was measured against a local throwaway DB before the field-app parity migrations and subsequent sprints shipped live.
>
> **2026-07-13 note:** the section-by-section inventory below (Atomic Save/Delete, Order & Delivery, Invoice & Payments, …) is a **curated snapshot last verified 2026-06-29** and has not been re-audited function-by-function against the live count above — treat the live DB (or `.claude/schema-registry.json` for structural facts) as authoritative if a specific function's existence, signature, or behavior is load-bearing. The detailed sections below document the notable functions, not an exhaustive per-function enumeration.

> **Prior baselines:** 2026-06-23 live: 228 callable RPCs + 51 trigger functions. 2026-06-29 branch HEAD (local, pre-live-merge): 270 callable RPCs + 56 trigger functions.

> **IMPORTANT:** As of migration 20260331600000, all mutating RPCs have exactly ONE overload with `p_idempotency_key text DEFAULT NULL`. Never create function overloads — see SAFE_DEVELOPMENT_RULES.md.

> **Audit (2026-03-16):** Round 3 idempotency fix applied via migration 20260332700000. All public functions verified to use correct `idempotency_keys` columns (`idempotency_key`, `operation`, `result`). Pre-commit hook now blocks wrong patterns.

---

## Offline Action Receipts — LIVE

The four offline-receipt migrations were applied live on 2026-07-14 and add five callable RPCs included in the live count above; the fourth hardens the existing processor without adding an overload.

**2026-07-14 read-only verification:** production contains the receipt table, staging guard, and all five offline-action RPCs. Supabase recorded the first three source names under apply-time versions `20260714171331`, `20260714171800`, and `20260714172135`; the target-lock correction is recorded as version/name `20260714203709` / `offline_action_target_lock`. Do not infer MCP application state from a filename prefix alone.

- `stage_offline_action(p_client_action_id, p_operation, p_entity_id, p_schema_version, p_client_created_at, p_payload, p_idempotency_key, p_entity_snapshot_at)` → jsonb — active-user staging gate for only `complete_delivery` and `complete_job`; validates/canonicalizes bounded payloads, checks current target/assignment visibility, and atomically claims the permanent action UUID + idempotency key. When the optional queued `updated_at` snapshot no longer matches, the receipt becomes `TARGET_STATE_CONFLICT` review work before any completion RPC runs; an exact replay still returns an already-committed receipt, preserving lost-response recovery. Changed UUID/key/snapshot reuse raises. Queued guards serialize new staging per actor and distinguish the 250-per-rolling-day `OFFLINE_STAGE_DAILY_CAP` from the 500-unresolved-item `OFFLINE_STAGE_REVIEW_BACKLOG`; exact action-ID replays remain readable at either limit. The SQL defaults remain `NULL` to preserve CRX's one-overload mutator convention, but `StageOfflineActionArgs` requires the key for app callers.
- `process_offline_action(p_client_action_id, p_idempotency_key)` → jsonb — owner-bound processor. Locks the receipt, then locks the referenced delivery/job row while rechecking the saved snapshot and retains that target lock through mutation, so a concurrent office edit cannot cross between comparison and completion. It refuses legacy rows with no original snapshot, calls exactly one current canonical completion RPC, validates its result, and commits the business mutation + `succeeded` receipt in the same database transaction. Target drift and deterministic business conflicts become sanitized `needs_review`; retryable infrastructure failures rethrow and leave the receipt safely `received`. `ProcessOfflineActionArgs` requires the key even though the SQL signature keeps the project-standard default.
- `get_offline_action_status(p_client_action_id)` → jsonb — sanitized status lookup for the active owner or active admin/sales office user, including safe office-resolution metadata. It never returns the saved request payload or idempotency key.
- `get_offline_action_review_queue(p_include_resolved, p_limit, p_offset)` → jsonb — active admin/sales-only queue of sanitized `needs_review` metadata. Raw payloads and idempotency keys are deliberately absent.
- `resolve_offline_action(p_client_action_id, p_resolution, p_note, p_idempotency_key)` → jsonb — active admin/sales-only, idempotent `already_completed` / `abandoned` decision. It locks the receipt, preserves `needs_review`, records resolver/time/note plus one audit event, and cannot call a completion RPC or delete the receipt.

The receipt table has no authenticated direct table grants; all writes are RPC-only. The rollback smoke registry entry `stage_offline_action` covers the base receipt RPCs plus both canonical completion branches; the dedicated disposable resolution proof covers office roles, audit/idempotency, concurrency, and cap release.

## Money and Inventory Hardening — LIVE

### 2026-07-15 gauntlet fixes — APPLIED LIVE 2026-07-16

Migrations `20260716120104`, `20260716120112`, and `20260716120120` were applied live in that order after migration review and Mason's explicit approval. Post-apply catalog checks verified one `submit_purchase_order` overload, one backward-compatible `create_prepay_check_splits` overload, fixed search paths, narrow execution grants, and RPC-only write grants on the protected PO/receiving/AP/prepay tables; all 17 database invariant sweeps matched the established allowlist.

**Promotion order followed:** all three migrations were applied and verified in timestamp
order before merging/deploying the coupled frontend. `PurchaseOrderDetail` calls
the now-live `submit_purchase_order` RPC.
PO create/import/edit/submit/cancel remains available to active admins and sales reps;
receiving reversal remains admin-only. `save_purchase_order` and
`submit_purchase_order` and `cancel_purchase_order` write their own `activity_feed` rows atomically, so the
browser must not duplicate those audit events.

- `complete_delivery(...)` requires an active profile and uses the effective Chicago completion date for the closed-period warning and generated draft invoice. `void_delivery(...)` now relies on the active-aware admin helper.
- `save_purchase_order(...)` is the browser-facing PO create/edit path, while `submit_purchase_order(...)` performs a status-only draft submission without resaving a possibly stale vendor, note, quantity, or cost snapshot. Any received line's product, ordered quantity, unit, and cost are immutable until receiving is reversed. Direct authenticated PO, PO-line, receiving-record, vendor-bill/payment, and prepay table writes are revoked.
- `save_invoice(...)` permits an orderless invoice only when it is an explicit `misc_charge` starting in draft; chemical sales still require an order or blend ticket.
- `get_customer_statement(...)` includes non-reversed write-offs on their Chicago business date; `get_ap_dashboard_summary(...)` excludes voided vendor payments; finance-charge preview/generation reject future business dates.
- `create_prepay_check_splits(p_customer_id, p_reference_number, p_splits, p_performed_by, p_idempotency_key, p_expected_total_cents DEFAULT NULL)` replaces the old five-argument identity with a single backward-compatible identity. Stale clients may omit the trailing total; current clients send it and the RPC rejects any penny mismatch. The vetted active-admin `batch_apply_prepayments(...)` manual-allocation workspace is unchanged; only the separate automatic apply-remaining/apply-all paths stay disabled.
- `get_inventory_position()` clamps each PO line's remaining amount at zero and nets delivery-specific reversals on the original delivery date; order-level void reversals are paired back to the original order/product instead of their later ledger timestamp.

Migrations `20260714220000` through `20260714224000` preserve existing public signatures and harden their implementations. They do not change the live function-name total above; renamed field-app save and invoice-post implementations become owner-only internal helpers when this queued stack is applied.

- `save_quote(...)` remains the transactional owner of planned-hold synchronization, including releasing holds when a quote is unplanned. Direct authenticated writes to `inventory_holds` are removed, and the redundant browser-side update is retired.
- `batch_apply_prepayments(...)` keeps its signature but becomes active-admin-only and strict-actor. Shared `check_idempotency` now obtains a transaction advisory lock before cache lookup, closing concurrent check-then-mutate races for every canonical caller.
- `update_order_items(...)` keeps its signature but rejects supplied line IDs from another order and creates missing warehouse inventory rows before prebooking new products.
- `complete_cycle_count(...)` and `reverse_completed_cycle_count(...)` keep their signatures and lock every affected inventory row before delegating to the canonical implementation.
- `create_return(...)` now requires `order_item_id` per line, rejects voided/cancelled source orders, and derives product, unit, and price from delivered order items. A return's order/customer identity is immutable. `receive_return(...)` locks the source order and re-verifies the customer relationship plus every linked line before restocking; `void_order(...)` and `cancel_order(...)` reject any order with a received/credited return regardless of line restock flags, preventing duplicate inventory restoration and stranded credits. `issue_return_credit(...)` is admin-only and independently repeats the source-order and line checks before crediting. An exact-record compatibility branch allows only the single verified production source-free RMA to finish while its pinned immutable return/item values still match; every other source-free record is rejected even if backdated. The UI subtracts prior non-rejected/non-cancelled returns from each delivered line and shows section plus negotiated unit price so duplicate products are distinguishable.
- `get_sales_detail_report(...)`, `get_sales_summary_report(...)`, `get_gross_sales_report(...)`, and every order aggregate in `financial_dashboard_summary()` exclude terminal `voided` orders. The gross-sales and finance-dashboard gates explicitly require active profiles.
- `receive_po_items(...)` rejects inactive profiles and permits `p_allow_over_receive=true` only for an active admin; a caller-supplied `NULL` is normalized to false so SQL three-valued logic cannot bypass the quantity ceiling. Normal in-limit receiving remains available to active admins and sales reps.
- Direct authenticated `payments` INSERT/UPDATE/DELETE/TRUNCATE privileges and write policies are removed. Payment ledger mutations remain available only through the audited SECURITY DEFINER payment RPCs.
- `save_field_app_invoice(...)` and `post_invoice_group(...)` first serialize on an immutable group-ID advisory lock, then lock and recheck every current member before delegating to owner-only implementations. Public `post_invoice(...)` rejects grouped members, preventing partial group posting. The general invoice batch screen and Order detail's Post All Drafts action group split siblings by `invoice_group_id` and call `post_invoice_group` once per group. A waiting transaction therefore sees newly created siblings, save/group-post cannot deadlock on changing row-UUID anchors, and a concurrent post either waits for the complete save or causes the save to reject before any bill lines are rebuilt.
- `check_idempotency(...)` and `save_idempotency(...)` reject whitespace-only keys with `IDEMPOTENCY_KEY_REQUIRED`; `NULL` remains the explicit opt-out handled by callers that allow non-idempotent execution.

## Atomic Save/Delete
- `commit_blend_ticket_ocr_result(p_blend_ticket_id, p_queue_id, p_lease_token, p_ticket_update, p_products, p_idempotency_key)` → jsonb — **LIVE (`20260714230100`, 2026-07-15)**. Service-role only. Locks and rechecks the current unreviewed/unlinked/unbilled ticket plus the owned OCR queue lease, preserves manual/current fields, replaces non-manual OCR products, and completes the queue in one transaction.
- `create_blend_ticket(p_ticket_id, p_ticket_payload, p_products, p_images, p_enqueue_ocr, p_performed_by, p_idempotency_key)` → jsonb — **LIVE (`20260714230100`, 2026-07-15)**. Active admin/sales only; one transaction creates the ticket, products, bounded image metadata, optional OCR queue row, and activity entry. Uses a caller-stable ticket UUID and canonical exact-result replay.
- `save_quote()` — upsert quote + items; validates commission splits sum to 100%
- `save_job()` — upsert job + chemicals
- `save_customer()` — upsert customer; validates commission splits server-side (recipient required, no duplicates, each percentage >0 and <=100, total 100%)
- `save_blend_ticket()` — upsert blend ticket + items
- `save_blend_recipe(p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, ...)` — atomic create-or-replace for blend recipes. For updates, DELETE + INSERT items happen in the same transaction so a failed insert rolls back the DELETE too — closes audit #34 (BlendRecipes wiped items on failed save). Migration 20260513010000.
- `save_purchase_order()` — upsert PO + items. **Live gauntlet hardening (`20260716120104`):** blocks edits/removal of received line evidence and is the browser's PO create/edit boundary after direct table writes were revoked. **Live lifecycle correction (`20260716144353`):** rejects any new PO whose requested initial status is not `draft` and rejects status changes during ordinary edits; submission, receiving, and cancellation remain separate lifecycle RPCs. The new-PO screen keeps one-click submission by saving the draft first and then invoking `submit_purchase_order` with a separate idempotency key; lost save responses reuse the original PO number and save key.
- `submit_purchase_order(p_po_id, p_performed_by, p_idempotency_key?)` — **Live (`20260716120104`).** Active admin/sales_rep, idempotent draft → submitted status transition that locks the PO row and never resaves stale draft fields.
- `save_invoice()` — upsert invoice + items. **U8 (2026-07-06):** on a job invoice edit, recomputes its pending job commission(s) from the new chemical-line profit (COGS×qty + penny reconciliation on the last row); guarded by `JOB_HAS_BATCHED_COMMISSIONS` (active payout batch) / `JOB_COMMISSIONS_PAID`. **Live gauntlet hardening (`20260716120112`):** explicitly permits orderless draft miscellaneous charges while preserving the order/blend requirement for chemical sales.
- `save_field()` — upsert field record
- `delete_purchase_order()` — soft-delete PO (must be draft)
- `duplicate_quote()` — deep-clone quote + items with new number; canonical idempotency wired in migration 20260526090000
- `create_quote_version(p_quote_id uuid, p_performed_by uuid)` — snapshots full quote state (sections + items) for version history. SECURITY DEFINER, search_path = public, pg_temp
- `restore_quote_version(p_version_id uuid, p_performed_by uuid)` — restores quote from a version snapshot as revised draft. SECURITY DEFINER, search_path = public, pg_temp
- `admin_update_profile()` — admin-only profile updates (name, role, email, active flag)
- `save_quote_template()` — Saves quote template with sections and items
- `create_quote_from_template()` — Creates a new quote from a saved template
- `revert_quote_status(p_quote_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin/sales_rep, strict-actor. Status revert (e.g. accepted → sent) under an `app.admin_override` bracket; powers QuoteBuilder "unstick" actions.

## Order & Delivery
- `convert_quote_to_order()` — whole-quote conversion; also releases inventory holds linked to the quote. Copies `qi.notes` to `order_items.notes` and aggregates section_header_notes into `orders.program_notes`. Since `20260610145253`: rejects draft/declined/expired/cancelled quotes (`BOOKING_CLOSED`), rejects partially-drawn quotes (`BOOKING_PARTIALLY_DRAWN`), and marks all products fully drawn in `quote_product_draws`
- `draw_down_quote(p_quote_id, p_draws, …)` — **partial booking draw-down** (sell-side roadmap #1 v1, `20260610145253`): pulls part of a sent/revised quote's booked quantities into a new confirmed order at the quote's locked (booking-weighted) price; tracks per-product balances in `quote_product_draws`; decrements the quote's active holds FIFO (drawn qty moves to `quantity_prebooked` — Net Free invariant); overdraw blocked (`BOOKING_OVERDRAWN`); final draw sets the quote `accepted`. admin/sales_rep, strict-actor, idempotent
- `create_direct_order()` — create order without a quote; warns (not blocks) on low inventory using net position. Role-gated `admin`/`sales_rep` (`INSUFFICIENT_ROLE`) since `20260610142204` — audit W1 closed an RPC-direct hole where any authenticated user could create orders. Accepts `p_customer_po_number` (since `20260614142939`) so the SECDEF RPC sets `orders.customer_po_number` directly — the post-create `orders.update()` it replaced failed for `sales_rep` under the admin-only `orders_update` RLS.
- `create_order_from_blend_ticket(p_blend_ticket_id, p_order_number, p_order_date, p_notes, p_performed_by, p_idempotency_key)` — **LIVE (`20260714230200`, 2026-07-15):** creates and atomically links an order only from a completed, approved, unbilled ticket with a customer and nonempty fully matched active positive products. Exact first result is cached for replay.
- `cancel_order()` — cancels order, releases prebooked inventory. **F7 (2026-05-07):** no longer adds `v_hold.quantity` to `inventory.quantity_available` when deactivating planned-quote holds — holds are soft reservations that never debited it.
- `update_order_items()` — update items on an existing order
- `confirm_delivery()` — scheduled -> in_progress transition
- `complete_delivery()` — requires in_progress, creates remainder rows for partial deliveries, copies `tote_number` from delivery items. **Live closed-period corrections (`20260716152906`, `20260716172956`):** the delivery transition trigger calls `check_period_open()` on the effective Chicago completion date; a closed date rejects and atomically rolls back the full RPC, including the older warning rows, inventory/order changes, draft invoice, and idempotency write. The follow-up checks both stored and requested dates on later terminal rewrites, so authenticated direct updates cannot move completed history into or out of a closed period. **F8 (2026-05-07):** restored the post-loop `tote_number` copy step that Phase 15 dropped — load sheets now correctly carry tote numbers again.
- `edit_delivery()` — logistics always editable; items (add/remove/adjust) editable only when status = 'scheduled'. Validates quantities against order_items.quantity_remaining minus other active deliveries.
- `cancel_delivery()` — cancels delivery, releases prebooked inventory
- `batch_cancel_deliveries()` — batch cancel multiple deliveries
- `batch_reschedule_deliveries()` — batch reschedule deliveries to new dates
- `reassign_delivery()` — reassign delivery to different driver
- `create_followup_delivery()` — create follow-up delivery for remaining items; canonical idempotency wired in migration 20260526090000
- `get_customer_delivery_remainders()` — get undelivered remainder items for a customer
- `create_quick_delivery()` — atomic order + delivery + draft invoice in one transaction; includes inventory pre-check with `FOR UPDATE` locks to prevent overselling. **2026-05-13 (audit #6):** uses `_insert_commissions_for_order()` helper instead of inline INSERT — fixes a latent bug where the prior inline block referenced columns that don't exist on `commissions`. **2026-05-13 (audit #7):** uses `safe_cents_qty(price_cents, qty)` instead of the truncating `(price_cents * qty)::bigint` cast.
- `create_delivery_with_items(p_order_id uuid, p_customer_id uuid, p_scheduled_date date, p_items jsonb, ...)` — atomic delivery + items create. Frontend (`NewDelivery.tsx`) calls this instead of two separate `.insert()`s — closes audit #10 (orphaned-delivery race). Generates `delivery_number` via `next_delivery_number()`. SECURITY DEFINER, role-gated to admin/sales_rep. Migration 20260513010000.
- `bulk_import_order(p_order_number text, p_customer_id uuid, p_status text, totals..., p_items jsonb, ...)` — atomic per-order create for `BulkOrderImport.tsx`. Closes audit #31 (orphaned-orders during CSV import). Frontend resolves customer/product IDs first then ships per-order to this RPC. Migration 20260513010000.
- `check_duplicate_delivery()` — check if a duplicate delivery exists for an order
- `void_delivery()` — void a completed delivery, reversing inventory transactions. **Live closed-period corrections (`20260716152906`, `20260716172956`):** the same non-bypassable delivery transition trigger checks the original Chicago completion date (scheduled date only as a legacy fallback); a closed date rejects and rolls back every reversal, draft-invoice cancellation, lifecycle write, warning, audit, and idempotency side effect. The follow-up also checks the requested date on terminal rewrites, so voided history cannot be moved into a closed period through direct authenticated table access.
- `void_order(p_order_id, p_performed_by, p_reason, p_idempotency_key)` → jsonb — admin-only, strict-actor. Voids a confirmed/fulfilled order, reversing prebooked inventory and cancelling draft invoices. Brackets the enforcer-forbidden status write with `app.admin_override`.
- `restore_cancelled_order(p_order_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor. Restores a cancelled order back to confirmed (`app.admin_override` bracket).
- `restore_cancelled_delivery(p_delivery_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor. Restores a cancelled delivery back to scheduled (override bracket).

## Invoice & Payments
- `create_invoice_from_order()` — create invoice from order items
- `create_invoice_for_unbilled_delivery(p_delivery_id, p_performed_by, p_idempotency_key)` → jsonb — backfill a draft invoice for a completed-but-unbilled delivery (admin-only; sets `delivery_id`; guards on one active invoice per order). *(Retired `create_invoice_from_delivery` 2026-06-17 — it was unused dead code superseded by this fn; migration `20260617210000`.)*
- `create_invoice_from_blend_ticket(p_blend_ticket_id, p_created_by, p_idempotency_key)` → jsonb `{invoice_ids[], invoice_group_id}` — creates draft invoice(s) from approved blend ticket. **Phase 1 (2026-04-29):** return type changed from `uuid` to `jsonb`. Multi-customer fields produce grouped split invoices via `invoice_group_id`. Acres come from `blend_ticket_fields.actual_acres → planned_acres → fields.total_acres → 0`. Mode A (grower-share `price_override_cents`) bills $/ac, Mode B bills line items + tier/quoted/manual + service fee.
- `create_split_invoices_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` → uuid[] — creates proportional split invoices based on field billing splits for an order
- `post_invoice()` — posts invoice; calls `check_period_open()` before posting; raises error if accounting period is closed. Also triggers `generate_rup_sales_records()` for RUP products.
- `void_invoice()` — void a posted invoice, reversing all related records. **U8 (2026-07-06):** on a `field_application` invoice, also cancels+zeroes the pending job commission(s) THIS invoice minted (generation-precise via `commissions.invoice_id`, both the draft/unposted→cancelled and posted→voided paths), blocked by `JOB_HAS_BATCHED_COMMISSIONS` and notifying admins if the commission was already paid out.
- `batch_post_invoices()` — batch post multiple invoices at once
- `batch_void_invoices()` — batch void multiple invoices
- `delete_invoices(p_invoice_ids, p_performed_by, p_idempotency_key)` → integer — **admin-only** soft-delete of draft/unposted/voided invoices (posted/paid/overdue skipped); writes an `invoice_deleted` financial_audit_log row per invoice; idempotent; strict-actor. Replaces the raw UI `.update({deleted_at})` (nightly-debug #9). Gate matches the invoices RLS (`is_admin()`). **U8 (2026-07-06):** also cancels+zeroes a deleted job invoice's pending commission(s) and releases the stranded job.
- `record_invoice_payment()` — record payment against a specific invoice
- ~~`record_payment()`~~ — **DROPPED 2026-06-08** (migration `20260608145944`, audit AW-3): deprecated + unreachable; use `allocate_payment` / `record_invoice_payment` instead
- `allocate_payment()` — allocate/re-allocate payment amounts across invoices
- `void_payment(p_allocation_set_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor. Reverses a recorded payment/allocation set, re-opening the affected invoices' balances and reversing any overpayment prepay credit.
- `unapply_credit_memo(p_credit_memo_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor. Un-applies a credit memo from the invoices it was applied to, restoring their balances.

## Inventory & Receiving
- `adjust_inventory()` — manual inventory adjustment with reason
- `manual_inventory_add()` — add inventory manually (does not override product unit cost)
- `receive_po_items(p_items, p_performed_by, p_idempotency_key, p_allow_over_receive)` — per-item condition/lot/notes/storage, creates receiving records. **LIVE (`20260714230000`, 2026-07-15):** linewise PO completion; actual overreceive requires admin plus per-item `over_receive_reason`, which is appended to the server audit note.
- `release_inventory_hold()` — release a specific inventory hold
- `create_planned_holds()` — Creates inventory holds for planned quote sections
- `create_inventory_hold(p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at, p_notes, p_performed_by, p_force, p_force_reason, p_idempotency_key)` — server-side manual hold creation with FOR UPDATE lock + atomic check against today's free stock (`available − prebooked − active holds`). Blocks negative-going holds by default; admin can pass `p_force=true` with a non-blank `p_force_reason` to override (mirrors PO over-receive admin-override). SECURITY DEFINER, search_path = public, pg_temp. Phase 4 P4-3 (2026-05-07). Replaces the bare `inventory_holds` insert from `InventoryPage.tsx`. **F1 (2026-05-07):** `FORCE_REQUIRES_REASON` / `FORCE_REQUIRES_ADMIN` checks hoisted above the inventory threshold so they fire unconditionally when `p_force=true`, fixing a NULL-concat crash on the sufficient-inventory force path.
- `mark_inventory_row_verified(p_inventory_id, p_performed_by, p_idempotency_key)` — admin-only RPC that clears the `inventory.manufactured_at_delivery` flag on a row after physical-stock confirmation. Used by `/integrity-cleanup`'s "Phantom inventory rows" section. SECURITY DEFINER, search_path = public, pg_temp. Idempotent. Phase 4 P4-7 (2026-05-07).
- `complete_cycle_count()` — finalize cycle count, create adjustment transactions
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats (expected_today, pending_receipt, received_this_week, items_ytd, damaged_this_week)
- `match_quick_receive_items()` — auto-allocate products to oldest open POs for Quick Receive
- `validate_product_units()` — trigger function that validates product unit consistency
- `convert_to_gl_lb()` — convert quantity from any unit to gallons or pounds for standardized reporting
- `reverse_receiving_record(p_record_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor. Reverses a receiving event, subtracting the received quantity (ledger ≡ snapshot — no zero-clamp since `20260610131048`) and recomputing the PO header (skips cancelled POs).
- `get_expiring_planned_holds(p_days_ahead int, p_idempotency_key)` → jsonb — lists planned-quote inventory holds expiring within N days (powers the expiring-holds Dashboard alert).

## Job Scheduling
- `assign_job_applicator(p_job_id, p_applicator_id, p_license_override, p_performed_by, p_idempotency_key)` → jsonb — assign/unassign a job's applicator (strict-actor, admin/sales_rep; the `enforce_applicator_license` trigger on `jobs` raises `LICENSE_EXPIRED` when the applicator's linked active licenses are all expired; `p_license_override` is admin-only and brackets the update with `app.admin_override`). Whole-job assignment path; JobDetail uses it for the override flow. (B5, 20260610185714)
- `dispatch_job_locations(p_assignments jsonb, p_performed_by, p_idempotency_key, p_license_override)` → jsonb `{ dispatched }` — per-LOCATION dispatch commit for the 3-step Dispatch Jobs wizard (field-app #36). SECURITY DEFINER, `search_path=public,pg_temp`, one overload, anon revoked. `p_assignments = [{ job_field_id, applicator_id|null, crew_id|null }, …]`. Strict-actor (`ACTOR_MISMATCH`) + admin/sales_rep gate; idempotency scoped to `dispatch_job_locations`; per-assignment XOR (exactly one of applicator/crew → `ONE_ASSIGNEE_REQUIRED`), active-applicator/active-crew validation, **applicator-license gate** (all-expired tracked active licenses → `LICENSE_EXPIRED`; admin-only `p_license_override` hatch — replicates the `jobs` license trigger this RPC bypasses), job derived from `job_fields` and scoped to dispatchable status (`scheduled`/`in_progress` → else `JOB_NOT_DISPATCHABLE`); upserts into `job_location_dispatches` on `job_field_id` (re-dispatch replaces, never duplicates). Writes are RPC-only (the new table has no client write policy). (field-app #36, 20260626120000)
- `_is_dispatched_to_me(p_job_id)` → boolean — SECURITY DEFINER RLS helper (field-app #36): is the caller dispatched to any location of the job (as the assigned applicator OR a member of the assigned crew)? Used by the additive `jobs_select_location_dispatchee` policy so a per-location-only assignee can read the parent job; runs as definer to break the jobs↔job_location_dispatches policy recursion. (20260626120000)
- `complete_job()` — marks completed, creates application_record, deducts inventory
- `transfer_job_to_invoice()` — creates invoice from job, sets status='invoiced'
- `load_recipe_into_job()` — copies recipe items into job chemicals
- `create_application_record_from_blend_ticket(p_blend_ticket_id, p_performed_by, p_idempotency_key)` → uuid[] — create application records from blend ticket data (one per field, returns array of record IDs)

## Blend Ticket Linkage
- `link_blend_ticket_to_order(p_blend_ticket_id, p_order_id, p_item_mappings, p_performed_by, p_idempotency_key)` — **LIVE (`20260714230200`, 2026-07-15):** requires completed/approved/unbilled/customer/nonempty/fully matched ticket state; every explicit or automatic mapping must cover a matching selected-order item; zero-link success raises.
- `unlink_blend_ticket_from_order(p_blend_ticket_id, p_performed_by, p_idempotency_key)` — **LIVE (`20260714230200`, 2026-07-15):** locks the ticket and removes mappings only while it is unbilled and has no active invoice or application record; linked billing/compliance provenance cannot be erased.

## Blend Ticket Phase 1
- `batch_approve_blend_tickets(p_ticket_ids, p_approved_by, p_idempotency_key)` — bulk approve completed+unreviewed tickets
- `batch_reject_blend_tickets(p_ticket_ids, p_rejected_by, p_idempotency_key)` → jsonb — bulk reject completed+unreviewed tickets, returns `rejected_count`
- `save_blend_ticket_fields(p_blend_ticket_id, p_fields, p_performed_by, p_idempotency_key)` — save per-field application assignments (delete+reinsert)
- `check_duplicate_blend_ticket(p_ticket_number, p_ticket_date)` — check for duplicate ticket by number+date
- `reverse_blend_ticket_approval(p_ticket_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin/sales_rep, strict-actor. Reverts an approved blend ticket back to `unreviewed` so it can be re-reviewed.

## Lot Capture & Trace (B1) — ✅ live (migration `20260622170000` applied 2026-06-23; the 3 RPCs are counted above)
- `set_application_record_lots(p_application_record_id, p_lots, p_performed_by, p_idempotency_key)` → jsonb `{success, count}` — replace-all save of one application record's lots from a JSON array of `{product_id, lot_number, source_receiving_record_id?, quantity_from_lot?, unit?, notes?}`. SECURITY DEFINER, `search_path=public,pg_temp`, canonical idempotency (op `set_application_record_lots`), strict-actor (`ACTOR_MISMATCH`), in-body admin/sales gate, parent `FOR UPDATE` race-lock; validates each product is on the record, the cited source receipt matches the product+lot, and rejects a duplicate (product, lot). Writes an `activity_feed` audit row (the replace-all edit otherwise leaves no trace of a clear-to-zero). Admin/sales only.
- `get_recent_lots_for_product(p_product_id)` → TABLE(lot_number, last_received_at, receiving_record_id, source) — recent distinct (case-insensitive) received lots for the application-time suggestion dropdown, newest first, ≤50. `receiving_record_id` lets the editor preserve the source-receipt link. Read-only, admin/sales.
- `get_lot_application_trace(p_lot_number)` → TABLE(application_record_id, record_number, product_id, product_name, lot_number, quantity_from_lot, unit, application_date, customer_id, customer_name, applicator_id, applicator_name, field_names, invoice_id, source_receiving_record_id) — the recall/compliance payoff: every application that used a lot (case-insensitive). `field_names` falls back to the legacy single `application_records.field_id`; `invoice_id` falls back to the newest active blend-ticket invoice when `ar.invoice_id` is unset. Read-only, admin/sales.
- *Blend propagation:* the `CREATE OR REPLACE create_application_record_from_blend_ticket` in the same migration adds an auto-INSERT into `application_record_lots` from `blend_ticket_products.lot_number` (case-insensitive dedup, skips null product / blank lot) — body otherwise reproduced verbatim from live; no new overload.

## Returns & Credits
- `approve_return()` — approve a return request
- `receive_return()` — receive returned items, update inventory
- `issue_return_credit()` — issue credit memo for a return, integrated with AR
- `create_prepay_credit()` — create prepay credit for a customer
- `reconcile_prepay_balances()` — reconcile prepay balances across all customers
- `cancel_return(p_return_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin/sales_rep, strict-actor. Cancels a return at any non-terminal stage (requested/approved/received → cancelled); brackets the status write with `app.admin_override`.
- `create_prepay_check_splits(p_customer_id, p_reference_number, p_splits, p_performed_by, p_idempotency_key, p_expected_total_cents DEFAULT NULL)` → jsonb — records one customer check split into multiple labeled prepay buckets; the trailing default preserves old/stale client calls while current clients assert the independent check total.
- `edit_prepay_credit(p_credit_id, p_new_balance_cents, p_reference_number, p_bucket_label, p_notes, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor edit of a prepay credit (balance/reference/label).
- `delete_prepay_credit(p_credit_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor soft-delete/void of a prepay credit.
- `increment_customer_prepay(p_customer_id, p_amount_cents, p_idempotency_key)` → void — internal helper that bumps a customer's prepay balance (called from payment/overpayment paths).

## Sequential Numbers (advisory locks)
- `next_delivery_number()` -> DEL-YYYY-NNNN
- `next_po_number()` -> PO-YYYY-NNNN
- `next_application_record_number()` -> APP-YYYY-NNNN
- `next_job_number()` -> JOB-YYYY-NNNN
- `next_invoice_number(p_invoice_type text DEFAULT 'field_application')` -> typed prefixes (`INV`, `CS`, `MC`, `CM`); single overload after migration 20260526090000
- `next_cycle_count_number()` -> CC-YYYY-NNNN
- `next_return_number()` -> RET-YYYY-NNNN
- `next_commission_payment_number()` -> CP-YYYY-NNNN
- `generate_order_number()` — auto-generate order number
- `generate_quote_number()` — auto-generate quote number
- `generate_ticket_number()` — auto-generate blend ticket number

## Reporting (13 RPCs)
- `get_logbook_by_customer()`, `get_logbook_by_applicator()`, `get_logbook_by_field()`, `get_logbook_faa()`
- `get_bottom_line_pnl()`, `get_gross_sales_report()`, `get_customer_balance_listing()`
- `get_chemical_history()`, `get_commission_balance_report()`, `get_inventory_cost_report()`

## Sales Reports (3 RPCs)
- `get_sales_detail_report(p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — line-item sales detail with LATERAL JOIN to invoices for invoice_number. Joins order_items -> orders -> customers -> products -> profiles. All filters optional
- `get_sales_summary_report(p_group_by, p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — aggregated sales grouped by dimension (product/customer/sales_rep/month/category). CTE-based with same filter set
- `get_customer_farm_group(p_customer_id)` — recursive CTE that walks up parent_customer_id chain to find root parent, then returns parent + all direct children. Powers multi-customer farm group reporting

## AR & Statements
- `get_ar_aging()` — AR aging report with current/30/60/90+ day buckets
- `get_customer_statement()` — customer statement with invoice/payment history
- `get_detailed_statement_data()` — detailed statement data for PDF generation. Includes both 'posted' and 'overdue' invoices. Aging buckets: current(0-30), 31-60, 61-90, 91-120, over-120 (non-overlapping).
- `generate_batch_statements()` — generate batch PDF statements for multiple customers
- `get_season_comparison()` — compare two seasons side-by-side
- `get_customer_year_end_summary(p_customer_id, p_season)` → jsonb — one customer's year-end purchase/AR summary for the season.
- `get_batch_year_end_summaries(p_customer_ids uuid[], p_season)` → jsonb — year-end summaries for many customers at once (batch statement / year-end mailing).

## Financial
- `close_accounting_period()`, `check_period_open()`, `get_monthly_summary()`
- `create_commission_payment()`, `post_commission_payment()`
- `apply_write_off(invoice_id, amount_cents, reason, performed_by, idempotency_key?)` — writes off balance with idempotency guard, creates write-off record and audit log entry. Auto-sets status='paid' when write-off brings balance to 0. Accepts 'posted' or 'overdue' invoices.
- `reverse_write_off(write_off_id, reason, performed_by?, idempotency_key?)` — admin-only. Marks write-off `reversed_at`/`reversed_by`/`reversed_reason`, decrements `invoices.write_off_cents` (balance_cents is GENERATED — never written directly), and re-derives status when reversal lifts balance > 0: `'overdue'` if past due_date, `'posted'` otherwise. Returns `{ success, write_off_id, amount_cents, invoice_id, new_balance_cents, status_changed, new_status }`. Idempotent: replays return the previously stored result. Wave A.1 + 20260506200000 follow-up / migration 20260506170000 + 20260506200000.
- `generate_finance_charges(performed_by, ...)` — admin-only (role check enforced in RPC body), idempotent, advisory-locked by as-of date, generates finance charge invoices excluding prior charges
- `get_customer_transaction_review()`
- `apply_remaining_prepayments(customer_id, performed_by, idempotency_key?)` — applies a customer's available prepay balance to oldest-unpaid posted invoices. Wave A.4 / migration 20260506180000 enforces `check_period_open` per-invoice (not just `CURRENT_DATE`). Any invoice in a closed period raises and rolls back the entire batch.
- `batch_apply_prepayments(allocations jsonb, performed_by, idempotency_key?)` — atomic batch of explicit prepay-credit→invoice allocations with idempotency; loops `apply_prepay_to_invoice`. **Queued migration 20260714185130 (not live)** will make the wrapper admin-only to align with the workspace route while retaining Wave A.4 per-invoice `check_period_open` enforcement.
- `apply_prepay_to_invoice(credit_id, invoice_id, amount_cents, performed_by)` — atomic single allocation with `FOR UPDATE` locks, creates `prepay_applications` record, deducts from both balances, writes `financial_audit_log` entry
- `calculate_billing_splits()` — calculate billing splits for an order
- `check_customer_credit_limit()` — check if customer has exceeded credit limit
- `mark_overdue_invoices()` — batch scan: sets posted invoices past due_date to 'overdue', logs to financial_audit_log, returns `{ invoices_marked_overdue, run_at }`
- `reopen_accounting_period(p_period_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — admin-only, strict-actor reopen of a closed accounting period (audited).
- `batch_apply_all_prepayments(p_performed_by, p_idempotency_key)` → jsonb — admin-only. Applies every customer's available prepay balance to their oldest-unpaid posted invoices in one batch ("Apply all prepayments" button).
- `preview_finance_charges(p_as_of_date)` → table — read-only preview of the charges `generate_finance_charges` would create (customer, overdue balance, rate, days overdue, charge amount).
- `compute_application_service_fee(p_service_id, p_customer_id, p_acres, p_season)` → jsonb — computes a field-application service fee using the per-customer rate override, falling back to the service default.

## Pricing
- `calculate_prices_from_margin()` — trigger: auto-calculate tier prices from margin target

## Season Helpers
- `compute_season(p_date)` — returns season year for a given date (Oct 1 - Sep 30)
- `current_season()` — returns current season year
- `season_start_date(p_season)` — returns Oct 1 of the season
- `season_end_date(p_season)` — returns Sep 30 of the following year

## Geo / Maps
- `get_fields_with_geojson()`, `get_field_geojson()`, `save_field_geometry()` — use `SET search_path = public, extensions` for PostGIS
- `get_field_polygons(p_field_id)` → table — returns the multi-polygon set for a field (`field_polygons`: geojson, label, acres, sort_order).
- `save_field_polygons(p_field_id, p_polygons, p_performed_by, p_idempotency_key)` → void — replaces a field's polygon set (delete + reinsert) in one transaction.
- `link_fields_to_parent(p_parent_id, p_child_ids uuid[], p_performed_by, p_idempotency_key)` → void — groups child fields under a parent field (`fields.parent_field_id`).
- `unlink_field_from_parent(p_field_id, p_performed_by, p_idempotency_key)` → void — removes a field from its parent grouping.

## Dashboard
- `dashboard_summary()` — legacy operational summary (inventory levels, deliveries, recent activity, integrity alerts). Slimmed from original 8-query version; financial KPIs moved to `financial_dashboard_summary()`
- `operational_dashboard_summary()` — comprehensive 25-CTE RPC powering the Operational Dashboard. Returns KPIs (active orders, open quotes, pending deliveries, open POs), team board action items, inventory position, upcoming deliveries, delivery stats, sales pipeline, 9 operational alert counts, 12-month activity chart data, season progress, accounting period status, and recent activity feed
- `financial_dashboard_summary()` — admin-only RPC returning all financial KPIs: AR aging buckets, revenue totals, payment activity, prepay balances, finance charge summary, period status. Includes 3 margin alert fields: `bottom_products_by_margin`, `bottom_customers_by_margin`, `monthly_margin_trend`. Total CTEs: 16.
- `get_customer_summary(p_customer_id uuid)` → jsonb — Returns 5 KPIs for CustomerDetail summary bar: `ar_balance_cents`, `order_count`, `delivery_count`, `credit_tier`, `last_activity`. Season-aware (Oct 1 - Sep 30).
- `get_dashboard_action_items(p_limit int DEFAULT 5)` → jsonb — Returns specific actionable items per category for Dashboard Action Queue: overdue invoices, cancelled+posted orders, overdue deliveries, low stock items, expiring quotes, unassigned deliveries. Each item includes entity ID, primary text, secondary text, and category-specific details.

## Accounts Payable

> ⚠️ **Migrations queued, not yet live (2026-05-10)**: PR-04 / PR-13 / PR-14 / PR-22 / PR-22b / PR-25 rewrites of the AP RPCs are committed to `fix/audit-2026-05-09` but not applied to live Supabase. Signatures below reflect the QUEUED state. The helper-function idempotency pattern is `check_idempotency` / `save_idempotency` — see CLAUDE.md "Canonical Patterns for New RPCs."

- `create_vendor_bill(p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date, p_due_date, p_payment_terms, p_subtotal_cents, p_adjustment_cents, p_notes, p_idempotency_key)` → uuid — admin-only. Creates vendor bill with auto-calculated due_date from payment terms (Net 15/30/45/60/90/Due on Receipt). Calls `check_period_open(bill_date)` (PR-04). Validates `subtotal > 0` AND `total = subtotal + adjustment > 0` (PR-04 + audit-fix-2 codex F4). Verifies vendor exists + is not soft-deleted. PR-22b additionally checks PO-to-bill vendor consistency (raises `VENDOR_PO_MISMATCH`) and posts a soft-warn notification when bill total drifts >5% from the linked PO total. Audit log entry with `operation_type='vendor_bill_created'`. Canonical idempotency.
- `record_vendor_payment(p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method, p_reference_number, p_notes, p_idempotency_key)` → uuid — admin-only. Records payment against a bill; updates `paid_cents` only (`balance_cents` is GENERATED ALWAYS post-PR-04, recomputes automatically). Auto-transitions status (`unpaid` → `partially_paid` → `paid`). Validates `amount <= balance`. Audit log with `operation_type='vendor_payment_recorded'`. No period gate (per Q8: only bill creation gates the period, not payment recording). Canonical idempotency.
- `update_vendor_bill(p_bill_id, p_subtotal_cents, p_adjustment_cents, p_bill_date, p_due_date, p_notes, p_idempotency_key)` → jsonb — admin-only (PR-14). Edits an unpaid bill with no active payments. Re-runs `check_period_open(bill_date)` since the date may change. Recomputes `total_cents`. `bill_number` is NOT editable (uniqueness invariant). Audit log with `operation_type='vendor_bill_updated'`. Returns `{success, bill_id, old_total_cents, new_total_cents}`. Canonical idempotency.
- `void_vendor_bill(p_vendor_bill_id, p_reason, p_idempotency_key)` → void — admin-only. Voids a bill; populates `voided_at`/`voided_by`/`void_reason` columns (PR-04 added these). **Hard-blocks if any active (non-voided) payments exist regardless of bill status** (audit-fix-2 codex F3). Workflow: void each payment via `void_vendor_payment` first, then void the bill. Audit log with `operation_type='vendor_bill_voided'`. Canonical idempotency. Frontend (`VendorBillDetail.tsx:268`) uses `.throwOnError()` since there's no return payload to assert. Docs corrected 2026-05-16 (ultra-review P3 #8).
- `void_vendor_payment(p_payment_id, p_reason, p_idempotency_key)` → jsonb — admin-only (PR-13). Reverses a wrong vendor payment. Locks payment + bill, validates payment isn't already voided, decrements `paid_cents` (balance recomputes via GENERATED), recalculates bill status (`paid` / `partially_paid` / `unpaid`), populates payment void columns. `REASON_REQUIRED` raised on blank reason. Audit log with `operation_type='vendor_payment_voided'`.
- `cancel_purchase_order(p_po_id, p_reason, p_performed_by, p_idempotency_key)` → jsonb — active admin/sales_rep. Soft-cancels a PO. The local 2026-07-15 gauntlet follow-up aligns this role gate with PO create/edit/submit and checks authorization before idempotency replay. PR-22b adds: refuses with `PO_HAS_ACTIVE_BILLS` if any non-voided vendor_bills reference the PO. Existing checks: refuses if any items have `quantity_received > 0` or status is already `fully_received`.
- `delete_purchase_order(p_po_id, p_performed_by, p_idempotency_key)` → jsonb — admin-only (PR-10 wired idempotency). PR-22b adds: refuses with `PO_HAS_LINKED_BILLS` if ANY vendor_bills reference the PO (stricter than cancel; even voided bills count since delete is permanent). DELETEs the PO + items.
- `save_vendor(p_vendor_id, p_payload jsonb, p_idempotency_key)` → jsonb — admin-only (PR-25). INSERT-or-UPDATE; pass NULL `p_vendor_id` to create. Partial-update pattern: `p_payload ? key` to differentiate "update to NULL" from "preserve existing." Vendor name required.
- `delete_vendor(p_vendor_id, p_idempotency_key)` → jsonb — admin-only (PR-25). Soft-delete via `deleted_at`. Refuses if any unpaid `vendor_bills` exist. PO check intentionally omitted (purchase_orders uses legacy `vendor` TEXT column, not `vendor_id` — FK migration is out of scope per CLAUDE.md "What's NOT in this plan").
- `get_ap_aging(p_as_of_date)` — AP aging report: Current / 31-60 / 61-90 / 90+ day buckets with vendor breakdown. PR-22 dropped the unused `p_idempotency_key` parameter (read-only RPC).
- `get_ap_dashboard_summary()` — KPI totals: total_owed, due_this_week, due_this_month, overdue_amount, bill counts, recent vendor bills.

## RUP Sales Reporting
- `generate_rup_sales_records(p_invoice_id)` — auto-called after `post_invoice()` for invoices with RUP products. Creates rup_sales_records for each RUP line item, snapshots product/customer/license data, flags compliance_status (compliant/warning/non_compliant based on applicator license validity). Fixed 20260610185741: license lookup filtered a nonexistent `deleted_at` column (latent 42703 that would have crashed `post_invoice` on the first RUP invoice); now filters `is_active = true` (customer-held licenses only — `customer_id = …` naturally excludes staff-held rows).
- `get_rup_sales_register(p_start_date, p_end_date, p_product_id, p_customer_id, p_compliance_status)` — filterable register query for state reporting. Returns all FIFRA-required fields (date, product, EPA reg, qty, buyer cert)

## Email Infrastructure
- `get_ar_reminder_candidates()` — admin-only. Returns customers with overdue invoices (30+ days) grouped by customer, with invoice details array, total_balance, and max_days_past_due. Only includes customers with email addresses on file. Called by "Send AR Reminders" button on ARaging.tsx

## Team Board V2
- `get_team_board_deliveries()` — SECURITY DEFINER, role-aware. Returns `{ today: [...], tomorrow: [...], unassigned_count, today_total }`. Drivers see only their assigned deliveries; admin/sales_rep see all. Sorted by scheduled_time, then priority (urgent->low).
- `get_yesterday_delivery_recap()` — SECURITY DEFINER, role-aware. Returns `{ completed: [...], issues: [...], summary: { total_completed, total_with_issues, total_cancelled } }`. Same role filtering as above.
- `get_notes_for_entity(p_entity_type text, p_entity_id uuid)` — SECURITY DEFINER. Returns all non-deleted team_notes linked to a specific entity, ordered by is_pinned DESC, created_at DESC.
- `get_team_workload()` — SECURITY DEFINER. Returns jsonb array of team members with `id`, `full_name`, `role`, `open_tasks`, `overdue_tasks`, `today_deliveries`, `week_deliveries`. Aggregates from team_notes and deliveries tables.

## Inventory Forecasting
- `get_inventory_forecast(p_months_ahead integer DEFAULT 6)` → Returns jsonb array of planned demand vs supply by product and month. SECURITY DEFINER, search_path = public, pg_temp
- `get_inventory_position()` → Returns jsonb array, one row per (product, location) for active products. Fields: `inventory_id`, `product_id`, `product_name`, `inventory_unit`, `container_size`, `container_type`, `vendor`, `current_cost`, `location`, `unit_size`, `quantity_available`, `quantity_prebooked`, `quantity_on_order`, `holds_qty`, `planned_qty`, `delivered_ytd` (season-to-date), `net_position` (= available − prebooked + on_order), `reorder_point`, `min_stock_level`, `is_low_stock`. Read-only; replaces 4 separate fetches in InventoryPage. Holds and planned-quote demand are RETURNED separately, not subtracted from `net_position`. SECURITY DEFINER, search_path = public, pg_temp. **LIVE (`20260714230000`, 2026-07-15):** explicitly requires active admin or sales role.

## Seasonal Rollover
- `rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)` → Returns jsonb with new quote_id, quote_number, season. Creates duplicate quote with updated pricing for the new season. SECURITY DEFINER, search_path = public, pg_temp

## Field Billing Splits
- `get_field_billing_splits_for_order(p_order_id)` → table — returns billing splits for all fields associated with an order
- `get_field_billing_splits_for_blend_ticket(p_blend_ticket_id)` → table — returns billing splits for all fields associated with a blend ticket

## Automation
- `auto_expire_quotes()` — cron-callable: expires quotes past their expiration date, deactivates inventory holds. **F7 (2026-05-07):** belt-and-suspenders restoration UPDATE removed; deactivation only — holds are soft reservations that never debited `quantity_available`.
- `check_remainder_reminders()` — cron-callable: checks for delivery remainders needing follow-up reminders
- `retry_failed_notifications()` → jsonb — cron-callable: retries entries in `failed_notifications` (e.g. email sends that errored). EXECUTE revoked from anon/authenticated — service_role/cron only.
- `log_failed_notification(p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload, p_idempotency_key)` → uuid — records a failed notification for later retry.

## Helper Functions (SQL)
```sql
is_admin()      -- SECURITY DEFINER STABLE
is_sales_rep()  -- SECURITY DEFINER STABLE
is_driver()     -- SECURITY DEFINER STABLE
is_applicator() -- SECURITY DEFINER STABLE
is()            -- base role-check helper

-- Audit #6 (2026-05-13) — canonical commission math
compute_commission_amount(p_profit numeric, p_percentage numeric) RETURNS numeric
  -- IMMUTABLE; GREATEST(ROUND(profit * pct / 100, 2), 0). The ONLY place
  -- the formula lives. Called by _insert_commissions_for_order().

-- Audit #7 (2026-05-13) — to-nearest-cent multiplication
safe_cents_qty(p_cents bigint, p_qty numeric) RETURNS bigint
  -- IMMUTABLE; ROUND(p_cents * p_qty)::bigint. Use this instead of
  -- (p_cents * p_qty)::bigint which truncates fractional cents. The
  -- sql-safety.mjs hook flags the unsafe pattern in new migrations.
```

## Rebate RPCs (audit #33, 2026-05-13)
- `create_rebate_claim(p_program_id uuid, p_quantity numeric, p_claim_amount_cents bigint, p_order_id uuid?, p_customer_id uuid?, p_product_id uuid?, p_notes text?, p_idempotency_key text?)` — atomic claim create with auto-generated `RC-YYYY-NNNN` claim_number from per-year `rebate_claim_counters` table (atomic via `INSERT ... ON CONFLICT DO UPDATE` row-lock). Replaces the racy `count(*) + 1` pattern in `Rebates.tsx`. SECURITY DEFINER, role-gated to admin/sales_rep.
- `transition_rebate_claim(p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint?, p_manufacturer_ref text?, p_idempotency_key text?)` — state-machine transition under `SELECT FOR UPDATE` row lock. Validates pending→submitted/rejected, submitted→approved/rejected, approved→paid. Raises `INVALID_TRANSITION` token on stale-state. For `'paid'`, writes `paid_amount_cents` (defaults to `claim_amount_cents`) — closes the gap where the original UI never set this column. Admin-only.

## Sell-Side: Pricing & Booking (2026-06-14, roadmap #2 / #4 / #6)
- `create_rush_order(p_customer_id, p_items, p_notes, p_customer_po_number, p_performed_by, p_idempotency_key)` → jsonb — **ship-now / price-later (#2):** creates a confirmed order with prices pending (`orders.pricing_status='pending'`, `order_items.pricing_pending=true`) so product can ship before final pricing. admin/sales_rep, strict-actor, idempotent.
- `price_order(p_order_id, p_items, p_performed_by, p_idempotency_key)` → jsonb — **#2:** applies final per-line prices to a pending order, clears `pricing_pending`, recomputes totals + commissions, flips `pricing_status` to priced.
- `check_unpriced_orders()` → jsonb — **#2:** cron-callable scan (06:10 UTC) flagging shipped-but-unpriced orders for owner follow-up.
- `consolidate_draft_invoices(p_order_id, p_performed_by, p_idempotency_key)` → jsonb — **order billing cockpit (#4):** merges an order's multiple per-delivery DRAFT invoices into ONE draft (Agvance pattern).
- `get_booking_settlement(p_quote_id)` → jsonb — **prepay-backed bookings (#6, read-only):** settlement view of a booking (quote) against its linked prepay credit (`prepay_credits.quote_id`).
- `get_open_booking_rollover(p_customer_id, p_season)` → jsonb — **#6 (read-only):** a customer's open (undrawn) booking balance available to roll into the next season.

---

## Internal / Trigger Functions

These are NOT called directly from the frontend. They power triggers, guards, and infrastructure.

### Status Transition Enforcement (trigger functions)
- `_enforce_delivery_status_transition()` — enforces delivery status state machine
- `_enforce_invoice_status_transition()` — enforces invoice status state machine
- `_enforce_job_status_transition()` — enforces job status state machine
- `_enforce_order_status_transition()` — enforces order status state machine
- `_enforce_po_status_transition()` — enforces PO status state machine
- `_enforce_quote_status_transition()` — enforces quote status state machine
- `_enforce_return_status_transition()` — enforces return status state machine
- `enforce_invoice_draft_on_insert()` — ensures new invoices start as draft

### Delete Guards (trigger functions)
- `_guard_delivery_delete()` — prevents deletion of non-draft deliveries
- `_guard_invoice_delete()` — prevents deletion of non-draft invoices
- `_guard_order_delete()` — prevents deletion of non-draft orders
- `_guard_po_delete()` — prevents deletion of non-draft POs
- `prevent_order_shares_edit_after_post()` — blocks `order_shares` INSERT/UPDATE/DELETE when any invoice on the order is `posted`/`paid`/`overdue`. Wired by `trg_order_shares_lock_when_posted` (added 2026-05-04, OPEN_ITEMS #1)

### Auth & Security
- `_is_admin_override()` — internal admin check for RLS policies
- `handle_new_user()` — triggered on `auth.users` INSERT, auto-creates `profiles` row
- `check_idempotency(p_key, p_operation)` — check if an idempotency key has been used. **LIVE (`20260714230000`, 2026-07-15):** takes a key-only transaction advisory lock so same-operation retries serialize and cross-operation reuse fails before business mutation. A trigger forces legacy inline-key concurrent losers to roll back.
- `save_idempotency()` — persist an idempotency key result
- `check_rate_limit()` — rate limiting check
- `cleanup_rate_limits()` — cron-callable cleanup of expired rate-limit rows. EXECUTE revoked from anon/authenticated — service_role/cron only.
- `execute_sql_readonly(sql_query text)` → jsonb — **internal/admin diagnostic** that runs a caller-supplied SELECT as the table owner. EXECUTE revoked from anon (2026-05-26, B4) AND authenticated (`20260614153000`, HIGH RLS-bypass) — service_role/postgres only, no production callers.

### Commission / Order Helpers (audit #6, 2026-05-13)
- `_insert_commissions_for_order(p_order_id uuid, p_customer_id uuid, p_order_profit numeric, p_commission_split jsonb, p_order_date date)` — single source of truth for commission INSERT. Called via `PERFORM` from `convert_quote_to_order`, `create_direct_order`, and `create_quick_delivery`. Uses `compute_commission_amount()` helper for the formula. SECURITY DEFINER. EXECUTE revoked from PUBLIC/anon/authenticated — only callable from inside other SECURITY DEFINER bodies (which run as the owner).
- `_snapshot_order_item_cost()` — BEFORE INSERT trigger function on `order_items`. Snapshots `products.current_cost * 100` into `order_items.cost_at_time_cents` if caller didn't pre-populate. SECURITY DEFINER. Migration 20260513050000 (audit #32).

### Commission / Job Helpers (U8, migration `20260707060000`, APPLIED LIVE 2026-07-06, finding #99)
- `_insert_commissions_for_job(p_job_id uuid, p_invoice_id uuid, p_customer_id uuid, p_profit numeric, p_commission_split jsonb, p_commission_date date)` — job-channel sibling of `_insert_commissions_for_order`, same INSERT/reconciliation logic with `job_id`/`invoice_id` lineage instead of `order_id`. Called via `PERFORM` from `transfer_job_to_invoice` with the job's chemical-line profit only (the per-acre application fee and customer-supplied $0 lines are excluded). No-ops on a NULL/splits-less split; validates a present one via `validate_commission_split_json()` (`COMMISSION_SPLIT_INVALID` aborts). SECURITY DEFINER. EXECUTE revoked from PUBLIC/anon/authenticated — only callable from inside other SECURITY DEFINER bodies.
- `jobs_snapshot_commission_split()` — `BEFORE INSERT` trigger function on `jobs` (`trg_jobs_snapshot_commission_split`). For a DIRECT job (no `quote_id`) with no `commission_split` supplied, copies the customer's `default_commission_split`, falling back to the locked empty sentinel `{"splits":[]}` if the customer has none — so a customer default added AFTER scheduling can never re-attribute an already-scheduled job. Quote-born jobs are untouched by this trigger; their split is set explicitly by `create_job_from_quote_section` from the parent quote.

### Dispatch Preservation (U13 assignment-unification, migration `20260707020000`, APPLIED LIVE 2026-07-06)
- `_preserve_job_location_dispatch_on_field_delete()` — BEFORE DELETE trigger on `job_fields`. Stashes any live `job_location_dispatches` row for the field being deleted into `job_dispatch_preservation` before `save_job`'s delete-then-reinsert cascades it away.
- `_sync_job_location_dispatch_on_field_insert()` — AFTER INSERT trigger on `job_fields`. Matches a freshly re-inserted field (by location) against a stashed preservation row and restores the per-location dispatch onto the new `job_fields.id`, so a `save_job` re-save no longer silently wipes a dispatcher's assignment.
- `_sync_job_location_dispatch_on_applicator_change()` — trigger on `jobs`. Keeps the whole-job `applicator_id` and per-location `job_location_dispatches` assignment systems from drifting apart when one is edited without the other.
- `_close_job_location_dispatch_on_job_terminal()` — trigger on `jobs`. Closes a job's open per-location dispatch rows when the job reaches a terminal status (completed/cancelled). All four are SECURITY DEFINER with anon EXECUTE revoked.

### Status Change Triggers
- `trg_delivery_status_change()` — fires on delivery status change (notifications, side effects)
- `trg_inventory_significant_change()` — fires on significant inventory changes (alerts)
- `trg_order_status_change()` — fires on order status change (commission creation, etc.)
- `trg_payment_update_order()` — fires on payment changes to update order totals
- `trg_po_status_change()` — fires on PO status change
- `trg_recalc_order_totals()` — recalculates order totals when items change
- `release_holds_on_quote_status_change()` — deactivates inventory holds when quote is declined/expired/accepted. **F7 (2026-05-07):** restoration UPDATE removed from declined/expired branch; deactivation only — fixes phantom inventory accrual that had been live since 2026-03-16.
- `release_expired_quote_holds()` — releases holds from expired quotes

### Inventory Helpers
- `_prebook_quick_delivery_inventory()` — internal: prebooks inventory during quick delivery creation

### Timestamp Update Triggers
- `update_updated_at()` — generic updated_at timestamp trigger
- `update_blend_ticket_updated_at()` — blend ticket timestamp trigger
- `update_fields_updated_at()` — fields timestamp trigger
- `update_note_comment_timestamp()` — note/comment timestamp trigger

### Activity Logging Triggers
- `log_comment_activity()` — log comment activity to activity feed
- `log_note_activity()` — log note activity to activity feed

### Notification Triggers
- `notify_damaged_receiving()` — notify on damaged item receipt
- `notify_mentioned_users_in_comment()` — notify users @mentioned in comments

### Blend Ticket Helpers
- `update_blend_ticket_billing_status(p_blend_ticket_id, p_payment_status, p_performed_by, p_idempotency_key)` — **LIVE (`20260714230000`, 2026-07-15):** active admin/sales, strict actor, ticket row lock, canonical exact-result replay, one overload.
- `sync_blend_ticket_payment_status()` → trigger — auto-syncs blend ticket payment_status when linked invoice is voided

### Crop History
- `snapshot_field_crop_history()` → trigger — auto-snapshots crop_type changes on fields to field_crop_history table

### Field Dashboard
- `get_field_dashboard(p_field_id, p_season)` — returns JSONB: field data + season summary + application records + recent activity

### Global Search
- `global_search(p_query text, p_limit int DEFAULT 5)` → TABLE(entity_type text, id uuid, primary_text text, secondary_text text) — Searches customers, orders, invoices, deliveries, products with ILIKE. Used by Command Palette (Ctrl+K).

### Custom Application Workflow
- `create_job_from_quote_section(p_quote_id, p_section_id, p_performed_by, p_idempotency_key)` -> jsonb {job_id} -- Creates scheduled job from planned quote section with pre-filled chemicals and fields
- `get_program_completion(p_season)` -> jsonb array -- Returns planned vs actual acres per program section for the Program Tracker dashboard

### Field Application Workflow V2 / Phase 1 (2026-04-29 rewrite)
- `derive_customer_shares_from_fields(p_field_ids uuid[], p_applied_acres_map jsonb DEFAULT NULL)` -> jsonb `{rows[], customers[], total_applied_acres, field_count, fallback_used_field_ids[]}` — **Phase 1 rewrite:** returns per-(field × customer) detail in `rows` and per-customer aggregate in `customers`. Falls back to `fields.customer_id` at 100% when a field has no `field_billing_defaults` rows.
- `save_field_app_invoice(p_invoice_id, p_invoice, p_locations, p_chemicals, p_performed_by, p_application_service_id, p_idempotency_key)` -> jsonb `{invoice_ids[], invoice_group_id}` — **Phase 1 rewrite:** creates one invoice per customer (grouped via `invoice_group_id` when 2+). Per customer chooses Mode A (grower-share $/ac for fields with `price_override_cents`) or Mode B (line items + tier/quoted/manual pricing + application service fee). Posted-invoice edit lock covers the whole group. `field_app_locations` keyed at group level. `field_app_location_shares` carries TRUE per-customer split for audit. `invoice_shares` populated for PDF/statement compat (one 100% row per child invoice). **Unit-price fix (2026-07-01, mig `20260630180000_field_app_pricing_unit_fix`):** each chemical line now prices on `field_app_priced_quantity(...)` — the applied rate-unit qty converted into the product's pricing/inventory unit — for both revenue and cost/margin; unconvertible unit pairs raise a clear error instead of mis-billing (was a ~128× overcharge: 16 oz/ac @ $32.10/gal × 100 ac billed $51,360 vs the correct $401.25).
- `post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)` -> jsonb `{posted_invoice_ids[], invoice_group_id, total_posted_cents, member_count}` — **Phase 1 new:** atomically posts every invoice in a group. Pre-checks all members are in `draft`/`unposted` and that each `invoice_date` falls in an open period; rolls back the entire transaction on any failure.
- `preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL, p_invoice_id uuid DEFAULT NULL)` -> jsonb `{per_customer[], grand_total_cents, customer_count, shares_detail}` — **Phase 1 new:** read-only preview returning the same per-customer breakdown that `save_field_app_invoice` would produce, without writing anything. Backs the "Preview" button on the field app invoice page. p_invoice_id (2026-06-24): when editing a split group, pass the invoice id so preview excludes customers whose only group invoice was soft-deleted (matches save_field_app_invoice deleted-stays-deleted); NULL = no exclusion. **Unit-price fix (2026-07-01):** mirrors `save_field_app_invoice` — prices each line on the converted `field_app_priced_quantity(...)` so the on-page preview matches the invoice.
- `field_app_priced_quantity(p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)` -> numeric — **IMMUTABLE pricing helper (2026-07-01, mig `20260630180000_field_app_pricing_unit_fix`).** Converts an applied quantity from its **rate unit** (e.g. total oz = oz/ac × acres) into the product's **inventory/pricing unit** (e.g. gallons) so a field-app line prices correctly. Liquid base = fl oz (oz/fl oz=1, pt=16, qt=32, gal=128); dry base = oz (oz=1, lb=16, ton=32000); NULL/unknown form → liquid. Same unit → passthrough; genuinely unconvertible pair → returns NULL so the caller errors instead of mis-billing. Backs the field-app ~128× overcharge fix. Pure converter (no idempotency/actor).

### Field App Workflow Phases 7-22 (Audit-driven hardening, 2026-04-30 → 2026-05-01)

**Auth-gate hardening (Phases 7, 9-14):** all 12 P1 actor-spoofing SECURITY DEFINER RPCs got the strict pattern `auth.uid()` not null + `p_performed_by` mismatch reject + role check. Affected RPCs: `start_job`, `complete_job`, `save_field_app_invoice`, `create_invoice_from_blend_ticket`, `post_invoice_group`, `save_invoice`, `create_invoice_from_order`, `confirm_delivery`, `complete_delivery`, `create_quick_delivery`, `save_purchase_order`, `receive_po_items`, `void_commission_payment`, `allocate_payment`.

**Sprint D-policy (Phase 15):** drivers can complete deliveries they're assigned to (matches `confirm_delivery` pattern). `complete_delivery` auto-creates a draft invoice when `order_id IS NOT NULL` and no active invoice exists for the order.

**Sprint E inventory transactional integrity (Phases 16-18):**
- `retire_inventory_item(p_inventory_id, p_performed_by, p_idempotency_key)` -> jsonb — atomic delete-with-validation; replaces the multi-step direct-write flow in `InventoryPage.tsx`. Locks inventory row with `FOR UPDATE`, re-validates active holds + prebooked + pending deliveries post-lock, inserts audit ledger row, deletes. Admin-only.
- `complete_cycle_count(p_cycle_count_id, p_completed_by, p_idempotency_key)` -> void — **rewritten:** replaced `GREATEST(0, ...)` clamp with `RAISE EXCEPTION` when math would drive on-hand negative (E2a — "block, don't drift"). Closes the audit's "ledger ↔ on-hand permanent disagreement" finding. Now properly accepts idempotency key (was previously dropped silently by PostgREST).
- `reverse_completed_cycle_count(p_cycle_count_id, p_reversed_by, p_idempotency_key)` -> void — same E2a fix mirrored on the reversal path.
- `update_cycle_count_item(p_item_id, p_counted_qty, p_notes, p_performed_by, p_idempotency_key)` -> jsonb — locks parent `cycle_counts` row, validates `status='in_progress'`, computes variance + variance_pct server-side. Replaces direct PostgREST `.update()` from React. Admin-only.
- `cancel_cycle_count(p_cycle_count_id, p_performed_by, p_idempotency_key)` -> jsonb — replaces the bare `.update({ status: 'cancelled' })` in CycleCounts. Validates `status='in_progress'` before flipping. RLS WITH CHECK guards added to `cycle_count_items` to block direct PostgREST writes when parent is not `in_progress`.

**Sprint F operations hardening (Phases 19-22):**
- `release-expired-quote-holds` and `check-remainder-reminders` now run on pg_cron schedule (Phase 19) at 6:15 / 6:30 UTC daily. Frontend Dashboard.tsx still triggers both — belt-and-suspenders since RPCs are idempotent.
- Edge Function lockdown: `send-email` now requires `customer_id`, validates `to` matches customer email, allowlists `email_type` per role (driver = `delivery_completed` only), drivers must supply `resource_type='delivery'` + assigned-driver auth, attachment cap 5/10MB, rate limit 50/hour. `process-blend-ticket` now requires applicator to be the ticket uploader. Both gain Sentry alerting via `_shared/sentry.ts`.
- `create_commission_payment(p_commission_ids, p_payment_method, p_reference, p_payment_date, p_notes, p_performed_by, p_idempotency_key)` -> uuid — **Phase 20 rewrite + 20260714180000 hardening:** no longer flips commissions to `paid` status. The `paid` transition now happens in `post_commission_payment`. Double-pay guard checks `commission_payment_items` membership in non-voided payments, and stale selections now fail if any selected commission is missing, non-pending, soft-deleted, or already batched.
- `post_commission_payment(p_payment_id, p_performed_by, p_idempotency_key)` -> jsonb `{success, payment_id, payment_number, commissions_paid}` — **Phase 20 rewrite:** sets `commissions.status = 'paid'` and `paid_date = payment_date`; accepts idempotency key and returns jsonb. **LIVE (`20260714230000`, 2026-07-15):** rejects zero-item batches and any header/item total mismatch before mutation.
- `reconcile_negative_inventory(p_inventory_id, p_new_quantity, p_reason, p_performed_by, p_idempotency_key)` -> jsonb — **Phase 22 cleanup:** admin sets correct on-hand for a row in negative state; delta becomes paired `inventory_transactions` audit row with reason. Used by `/integrity-cleanup` page.
- `create_invoice_for_unbilled_delivery(p_delivery_id, p_performed_by, p_idempotency_key)` -> jsonb `{success, delivery_id, invoice_id, invoice_number, total_cents}` — **Phase 22 cleanup:** factors Phase 15's auto-invoice logic into a manual-trigger RPC for the 60 historical completed deliveries that pre-date Phase 15. Refuses if delivery is not `completed`, has no `order_id`, or order already has an active invoice.
