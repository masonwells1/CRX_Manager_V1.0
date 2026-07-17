# CRX Manager — Gotchas & Lessons Learned

Project-specific quirks that aren't obvious from reading the code, but have caused real bugs. Read before working in the relevant area.

---

## React & UI

| Quirk | Wrong | Right |
|-------|-------|-------|
| react-map-gl v8 import path | `from 'react-map-gl'` | `from 'react-map-gl/mapbox'` |
| Vite manualChunks for maps | put `react-map-gl` in chunks | only put `mapbox-gl` in chunks |
| Lucide icon tooltips | `<Icon title="..." />` (Lucide ignores it) | `<span title="..."><Icon /></span>` |
| JSX truthy with unknown values | `{maybeNumber && <X/>}` (renders `0`) | `{maybeNumber ? <X/> : null}` |

---

## Supabase / PostgreSQL

| Quirk | Why it matters |
|-------|----------------|
| `PostgrestError` is a plain object — NOT `instanceof Error` | When matching errors in catch blocks, walk the keys instead |
| Singular relationship joins return arrays | Cast with `as unknown as Type[]` rather than expecting a single object |
| Supabase returns `null` for missing columns; React props expect `undefined` | Use `?? undefined` when passing through |
| PostGIS RPCs need `SET search_path = public, extensions` | Without `extensions`, geometry functions are not found |
| Every SECURITY DEFINER function MUST `SET search_path = public, pg_temp` | Hard rule — not optional. Empty `''` search_path is a 2026-05 finding pattern (PR-12). pg_temp prevents temp-table hijacking. |
| A deferred trigger does not inherit the caller RPC's `SECURITY DEFINER` context | `DEFERRABLE INITIALLY DEFERRED` triggers run after the RPC returns, commonly at commit. If the trigger function must read an RPC-owned/RLS-denied table, the trigger function itself needs `SECURITY DEFINER`, a fixed `search_path`, revoked direct execution, and a proof that forces the deferred trigger to fire after the public RPC returns. A rollback-only smoke that never runs `SET CONSTRAINTS ... IMMEDIATE` cannot prove this path. |
| `payments.amount` is `numeric` dollars, NOT `bigint` cents | RPCs convert: `(p_amount_cents / 100.0)::numeric(12,2)` |
| `commissions.commission_amount` is `numeric` dollars (NOT `_cents`) | Same as payments — historical exception |
| `deliveries.scheduled_date` (NOT `delivery_date`) | Always check `information_schema.columns` before assuming a column name. Re-introduced in `complete_delivery` + `void_delivery` 2026-05-09 (PR-01); column refs crashed any closed-period warn path. |
| `customers.farm_name` (NOT `name`) | The `customers` table has no `name` column. Edge Functions selecting `name` get PostgREST 42703. Always log query errors to surface schema drift (PR-03). |
| `idempotency_keys` columns: `idempotency_key`, `operation`, `result` | NOT `key`/`entity_type`/`entity_id`/`result_id` — bug has been re-introduced 3+ times |
| `idempotency_keys.result` is `jsonb` | Do NOT cast to `::text` when inserting — pass `jsonb_build_object(...)` directly |
| `invoices.balance_cents` is a GENERATED column | NEVER UPDATE it directly — update the components (`subtotal_cents`, `tax_cents`, `total_paid_cents`) |
| `vendor_bills.balance_cents` is GENERATED ALWAYS (PR-04) | Same rule — `record_vendor_payment` writes only `paid_cents`/`status`. Pre-2026-05-10 it was plain `bigint` and could drift. |
| `orders.total_paid` / `orders.balance_due` were DROPPED | AR is derived from `invoices.balance_cents` |
| `create_direct_order` returns `{ order_id }` (NOT `{ id }`) | Destructure correctly |
| `complete_delivery` requires `p_signed_by text` | Always pass the signer's name |
| `returns.requested_by` (NOT `created_by`) | And status starts at `'requested'` (NOT `'pending'`) |
| `return_items.order_item_id` (NOT `delivery_item_id`) | Returns are linked to order lines, not delivery lines |
| `invoice_items.extended_cents` (NOT `line_total_cents`) | Naming inconsistency from early schema |
| `financial_audit_log.entity_type` allows: `invoice`, `payment`, `vendor_bill`, `vendor_payment`, `purchase_order`, `write_off` | The CHECK constraint was AR-only until PR-04 (2026-05-10) — adding new entity types means expanding the CHECK. Same for `operation_type`. |

---

## Canonical idempotency pattern (PR-02, 2026-05-09)

Five mutating RPCs were silently re-executing on network retries because they used a broken replay check (`(v_existing->>'status') = 'completed'`) that never matched the saved jsonb shape. The canonical pattern below is the only correct one — substitute `'<rpc_name>'` for the function name.

```sql
DECLARE
  v_existing jsonb;
  v_result  jsonb;  -- or uuid, depending on return type
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');
    IF v_existing IS NOT NULL THEN
      -- For RPCs returning jsonb:
      RETURN v_existing;
      -- For RPCs returning uuid: RETURN (v_existing->>'payment_id')::uuid;
    END IF;
  END IF;

  -- ... actual mutation work ...

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, '<rpc_name>', v_result);
  END IF;

  RETURN v_result;
END;
```

**Key rules:**
- `check_idempotency` returns the BARE saved `jsonb` value (NOT `{status, result}`). Test for `IS NOT NULL` only.
- The cache key is `(idempotency_key, operation)`. Use the SAME `'<rpc_name>'` string in both `check_` and `save_`.
- For RPCs returning `uuid`, save with `jsonb_build_object('payment_id', v_id)` and unpack on cache hit.
- TS callers MUST wrap with `assertRpcResult<T>(data, 'rpc_name')` (`local-rules/require-assert-rpc-result` ESLint rule enforces it).
- TS error detection: `hasRpcCode(err, RpcErrorCodes.X)` from `src/lib/db.ts` — never substring-match (a user-supplied note containing `'BILL_VOIDED'` would false-positive).

The `idempotency-body-check.mjs` PreToolUse hook blocks RPCs that declare `p_idempotency_key` but don't reference `idempotency_keys` in the body. Add `-- idempotency-body-check: exempt` at file top to opt out (only when using the helper-function indirection above — never for raw inline lookups).

---

## Accounts Payable quirks (PR-04, 2026-05-10 — LIVE since 2026-05-10; verified live 2026-07-13: `vendor_bills.voided_at`/`voided_by`/`void_reason` columns and `balance_cents` GENERATED ALWAYS all exist in production)

The AP RPC trio (`create_vendor_bill`, `record_vendor_payment`, `void_vendor_bill`) had structural gaps that AR resolved years ago. PR-04 brings AP to parity. Important notes for anyone touching AP code:

| Rule | Detail |
|------|--------|
| Closed-period guard on bill creation | `create_vendor_bill` calls `check_period_open(p_bill_date::date)` — same gate as `post_invoice`. Bills outside the open period raise. |
| Closed-period guard on payment recording | YES since 20260712200000 (2026-07-11): record_vendor_payment gates on check_period_open(p_payment_date) — a payment belongs to its OWN period (same convention as AR allocate_payment per 20260513110000), so old bills stay payable with a current-dated payment; only backdating into a closed month raises. void_vendor_payment/void_vendor_bill gate on the original document date. (Supersedes the 2026-05-10 Q8 answer, which predated the AR payment-date gates.) |
| Idempotency on all 3 RPCs | All 3 use the canonical pattern above. Pre-PR-04 idempotency was missing entirely. |
| Audit log integration | `financial_audit_log` CHECK now allows `vendor_bill`, `vendor_payment`, `purchase_order` entity types and `vendor_bill_created`, `vendor_bill_voided`, `vendor_payment_recorded` operations. Pre-PR-04, AP RPCs couldn't write to the audit log at all. |
| `vendor_bills.balance_cents` GENERATED ALWAYS | `(total_cents - paid_cents)`. NEVER UPDATE — let it recompute. |
| `vendor_bills` UNIQUE on `(vendor_id, bill_number)` WHERE `deleted_at IS NULL AND status <> 'voided'` | Prevents duplicate bills. Voided/deleted bills don't count. |
| `vendor_bills` and `vendor_payments` have soft-delete columns | `voided_at`, `voided_by`, `void_reason` (PR-04). Pre-PR-04, `void_vendor_bill` stuffed reason into `notes`. |
| `void_vendor_bill` active-payment guard | Hard-blocks voiding ANY bill (any status) while it has active (non-voided) `vendor_payments` rows (`BILL_HAS_ACTIVE_PAYMENTS`, codex audit F3 — tightened from the original status='paid'-only check). `void_vendor_payment` now exists and is live (verified live 2026-07-13, was "PR-13, future" in earlier revisions of this doc) — void each payment first, then void the bill. |
| `vendors_select` RLS | Admin + sales_rep only post-PR-04. Drivers/applicators get empty results — any UI relying on driver vendor reads breaks silently. |

---

## E2E test environment (PR-05, 2026-05-09)

| Rule | Why |
|------|-----|
| `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD` env vars are MANDATORY | Hard-coded fallback was rotated and removed (was `mason@croprxsolutions.com` / live password). Tests now throw at startup if missing. See `docs/CONTRIBUTING.md`. |
| E2E is staging-only; production has no override | `resolveSafeE2EConfig()` requires `E2E_TARGET_ENV=staging` plus staging URL/key and categorically rejects the production project. Playwright also blocks while direct production endpoint literals remain. PR-23 staging is still BLOCKED. |
| All E2E-created entities MUST use `[E2E]` prefix | `globalSetup` creates shared `[E2E]` fixtures, `globalTeardown` deletes anything matching the prefix. Bare entity names leak across runs and pollute prod. Reuse fixtures from `tests/e2e/fixtures/e2e-constants.ts`. |

---

## Frontend safety (PR-11, PR-15, PR-16, PR-20)

| Rule | Detail |
|------|--------|
| Every `<Route>` first segment must have a `PAGE_PERMISSIONS` entry OR be in `EXEMPT_ROUTE_SEGMENTS` | `pagePermissions.test.ts` enforces by greppping App.tsx routes. ProtectedRoute fails-closed (logs + redirect) when `getPageKeyFromPath()` returns null on a non-exempt path. Adding a Route without an entry now fails CI. |
| `parseDollarsToCents` PRESERVES leading minus | Pre-PR-15 it stripped them, turning `-50` discount into `+5000` cent ADD. Use `parseDollarsToCentsPositive()` for fields that must reject negatives (default callers don't need to switch). |
| Edge Functions throw at startup if `ALLOWED_ORIGIN` is unset (and not localhost) | PR-16 removed silent fallback to `https://croprxsolutions.app`. Functions requiring the secret: create-user, process-blend-ticket, process-document, send-email (`seed-admin` — one of the original 5 — was deleted 2026-06-16 as a security cleanup; it no longer exists, verified against `supabase/functions/` 2026-07-13). reset-user-password uses a separate hard-coded array pattern; setup-blend-tickets-storage still exists on disk and is still dead code (delete pending — verified 2026-07-13). |
| `logActivity({performedBy})` requires `profile.id` (no empty-string fallback) | PR-20 patched 8 handlers: WriteOffModal, FinanceChargePreviewModal, MonthEndClose, Deliveries, InvoiceDetail. If `profile` is null, handler returns early with toast. QuoteBuilder's compliance check is the one useEffect-gated callsite (still gates on `profile?.id`). |

---

## Quick delivery soft-warn (PR-06, 2026-05-09)

Customers over credit limit no longer block quick deliveries. Per Q4 (Option C):

- AR balance includes `'draft'`, `'posted'`, `'overdue'` invoices (was: `'posted'` only)
- Projected exposure = current AR + new delivery's total
- When `projected_exposure >= credit_limit`: INSERT `activity_feed` (`event_type='credit_limit_warning'`) + INSERT `notifications` row per active admin. Delivery proceeds normally.
- Return jsonb gains `credit_warning: boolean`. `assertRpcResult<T>` ignores extra fields, so callers don't need updates.

---

## Tables WITHOUT `updated_at`

Setting `updated_at = now()` in an UPDATE on these tables will crash the RPC. The pre-commit hook blocks this, but here's the full list for reference:

`payments`, `write_offs`, `delivery_items`, `order_items`, `quote_items`, `return_items`, `purchase_order_items`, `commissions`, `finance_charges`, `prepay_applications`, `cycle_counts`, `cycle_count_items`, `activity_feed`, `financial_audit_log`, `idempotency_keys`, `receiving_records`, `inventory_transactions`, `invoice_line_allocations`, `order_line_allocations`, `invoice_shares`, `order_shares`, `commission_payment_items`, `blend_ticket_products`, `blend_ticket_images`, `blend_ticket_to_order_items`, `blend_recipe_items`, `delivery_photos`, `receiving_photos`, `email_log`, `ar_reminder_tracking`, `rup_sales_records`, `vendor_payments`, `cost_history`

---

## TypeScript & Linting

| Quirk | Right way |
|-------|-----------|
| ESLint `no-unused-vars` requires `_` prefix | `function fn(_unused: T)` |
| E2E catch clauses with unused param | `catch (_e)` (NOT `catch (e)`) |

---

## Business Logic

| Rule | Why |
|------|-----|
| Money = `bigint` cents (integers). NEVER floating point. | `parseFloat()` introduces rounding errors. Use `parseDollarsToCents()`. |
| Season = October 1 to September 30 | Hardcoded in commission and prepay rollover logic |
| Status enum strings are case- and value-sensitive | DB CHECK constraints enforce exact strings — `'void'` vs `'voided'` matters |

---

## Environment Quirks

_Corrected 2026-07-16: the three quirks previously listed here were stale — `gh` and `tail` are both available in the current shell, and the repo path was wrong. Verified by using both directly this session._

| Quirk | Workaround |
|-------|-----------|
| Repo lives at `C:\CRX_Manager` | Not `C:\CRX_Manager_V1.0` (older layout). Linked worktrees live under `C:\CRX_Manager\.claude\worktrees\`. |
| Shell is Git Bash (POSIX), not PowerShell/cmd | Use Unix syntax (`/dev/null`, forward slashes, `$VAR`); `gh`, `tail`, `head`, `grep`, `sed` are all available. |
| `cd` in a compound command can prompt; shell cwd can reset between tool calls | Prefer absolute paths; don't rely on a persisted `cd`. |

---

## Money-Integrity Invariants (overnight bug hunt, 2026-06-19) — RESOLVED 2026-06-20/21, re-verified live 2026-07-13

All six items originally parked here were fixed and applied live within a day or two of being found (the 2026-06-20 "Overnight bug-hunt remediation" + 2026-06-21 "As-Applied" changelog entries), and the current live function bodies were re-checked directly against `pg_proc` on 2026-07-13 to confirm the fixes are still in place. Kept here (marked resolved, not deleted) so the invariants stay documented for whoever next touches these RPCs — don't reintroduce the bugs described below.

| Area | Invariant | Resolution (verified live 2026-07-13) |
|------|-----------|----------------------------------------|
| **Prepay bulk-apply double-spend** | Every spend of prepay must ledger through `prepay_applications` in lockstep with the `customers.prepay_balance_cents` decrement. | **Closed by disabling the vulnerable path**, not by adding the ledger writes: `apply_remaining_prepayments` and `batch_apply_all_prepayments` both now `RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'` as their first statement (migration `20260620200000`, live). Per-invoice `apply_prepay_to_invoice` (which already ledgers correctly) is the only live apply path. The reserved-pool redesign that would let bulk-apply come back safely is still not built — don't re-enable these two functions without it. |
| **Prepay apply → invoice status** | A prepay application that zeroes an invoice's balance must flip `status` to `'paid'`. | Same fix as above — the only functions with this gap are hard-disabled, so the gap can't be hit today. |
| **Blend-ticket re-bill guard** | Only reset a grouped blend ticket to `'unbilled'` when no live sibling invoice remains. | Confirmed live in `sync_blend_ticket_payment_status` (migration `20260620140000`): body includes `AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.blend_ticket_id = NEW.blend_ticket_id AND i.status NOT IN ('voided','cancelled') AND i.deleted_at IS NULL)` verbatim. |
| **`transfer_job_to_invoice` parity** | Strict actor, `invoice_created` audit row, header derived from summed lines, `invoice_shares` reconciled to the header unconditionally. | Confirmed live: `IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'` is present; both the single-owner and multi-owner (U7 group) paths insert an `invoice_created` `financial_audit_log` row; the percentage-split share path now does `UPDATE invoices SET total_amount_cents = v_share_total` (comment: "reconcile the header to the share sum for BOTH the override AND the percentage-split path") so header and `invoice_shares` always tie. |
| **Cancel/void must not strand a batched commission** | `cancel_order`, `void_order`, `cancel_delivery` must skip zeroing a commission that's in a non-voided payout batch. | Confirmed live: all three functions reference `commission_payment_items` with a `cp.status <> 'voided'`-style guard (2026-06-20 "commission batch-freeze"). |
| **Prepay credit ↔ invoice must be same customer** | `apply_prepay_to_invoice` must reject a credit/invoice customer mismatch. | Confirmed live: function body contains a `CUSTOMER_MISMATCH` check (migration `20260620120000`). |

> Regression-test status not re-verified in this pass — if you touch any of these six functions, confirm a fails-before/passes-after test exists before assuming one does.

---

## Source

This file consolidates lessons from `~/.claude/projects/.../memory/feedback.md` and historical debugging sessions. Add new entries here whenever a non-obvious quirk causes a bug.
