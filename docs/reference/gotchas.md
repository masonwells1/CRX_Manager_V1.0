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

## Accounts Payable quirks (PR-04, 2026-05-10 — pending live apply)

The AP RPC trio (`create_vendor_bill`, `record_vendor_payment`, `void_vendor_bill`) had structural gaps that AR resolved years ago. PR-04 brings AP to parity. Important notes for anyone touching AP code:

| Rule | Detail |
|------|--------|
| Closed-period guard on bill creation | `create_vendor_bill` calls `check_period_open(p_bill_date::date)` — same gate as `post_invoice`. Bills outside the open period raise. |
| Closed-period guard on payment recording | NO. Per Q8: payment recording is not the posting equivalent — bill creation is. Recording payment against an open bill always allowed. |
| Idempotency on all 3 RPCs | All 3 use the canonical pattern above. Pre-PR-04 idempotency was missing entirely. |
| Audit log integration | `financial_audit_log` CHECK now allows `vendor_bill`, `vendor_payment`, `purchase_order` entity types and `vendor_bill_created`, `vendor_bill_voided`, `vendor_payment_recorded` operations. Pre-PR-04, AP RPCs couldn't write to the audit log at all. |
| `vendor_bills.balance_cents` GENERATED ALWAYS | `(total_cents - paid_cents)`. NEVER UPDATE — let it recompute. |
| `vendor_bills` UNIQUE on `(vendor_id, bill_number)` WHERE `deleted_at IS NULL AND status <> 'voided'` | Prevents duplicate bills. Voided/deleted bills don't count. |
| `vendor_bills` and `vendor_payments` have soft-delete columns | `voided_at`, `voided_by`, `void_reason` (PR-04). Pre-PR-04, `void_vendor_bill` stuffed reason into `notes`. |
| `void_vendor_bill` paid-bill guard | Hard-blocks if `status = 'paid' AND active payments exist` (Q11). Use `void_vendor_payment` (PR-13, future) per payment first, then void the bill. |
| `vendors_select` RLS | Admin + sales_rep only post-PR-04. Drivers/applicators get empty results — any UI relying on driver vendor reads breaks silently. |

---

## E2E test environment (PR-05, 2026-05-09)

| Rule | Why |
|------|-----|
| `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD` env vars are MANDATORY | Hard-coded fallback was rotated and removed (was `mason@croprxsolutions.com` / live password). Tests now throw at startup if missing. See `docs/CONTRIBUTING.md`. |
| Pointing E2E at production requires `E2E_ALLOW_PROD=true` | `assertNotProductionWithoutOverride()` in `tests/e2e/utils/safety-guards.ts` checks `VITE_SUPABASE_URL` for the prod project ref. Production setup is currently the default — see PR-23 (BLOCKED) for staging. |
| All E2E-created entities MUST use `[E2E]` prefix | `globalSetup` creates shared `[E2E]` fixtures, `globalTeardown` deletes anything matching the prefix. Bare entity names leak across runs and pollute prod. Reuse fixtures from `tests/e2e/fixtures/e2e-constants.ts`. |

---

## Frontend safety (PR-11, PR-15, PR-16, PR-20)

| Rule | Detail |
|------|--------|
| Every `<Route>` first segment must have a `PAGE_PERMISSIONS` entry OR be in `EXEMPT_ROUTE_SEGMENTS` | `pagePermissions.test.ts` enforces by greppping App.tsx routes. ProtectedRoute fails-closed (logs + redirect) when `getPageKeyFromPath()` returns null on a non-exempt path. Adding a Route without an entry now fails CI. |
| `parseDollarsToCents` PRESERVES leading minus | Pre-PR-15 it stripped them, turning `-50` discount into `+5000` cent ADD. Use `parseDollarsToCentsPositive()` for fields that must reject negatives (default callers don't need to switch). |
| Edge Functions throw at startup if `ALLOWED_ORIGIN` is unset (and not localhost) | PR-16 removed silent fallback to `https://croprxsolutions.app`. Five functions now require the secret: create-user, process-blend-ticket, process-document, seed-admin, send-email. reset-user-password uses a separate hard-coded array pattern; setup-blend-tickets-storage is dead code (delete pending). |
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

| Quirk | Workaround |
|-------|-----------|
| `gh` CLI not on PATH | Use full path: `/c/Program Files/GitHub CLI/gh.exe` |
| `tail` is NOT available in this shell | Never pipe to `tail` |
| Working directory is `C:\CRX_Manager_V1.0` | NOT `C:\Users\pc\CRX_Manager_V1.0` |

---

## Money-Integrity Invariants (overnight bug hunt — parked HIGHs, 2026-06-19)

These are **latent** today (the prepay & blend-ticket subsystems are dormant on live), but each is a confirmed HIGH that will corrupt money the moment the subsystem is exercised. Fixes are **parked** for Mason in `docs/audits/overnight-bug-hunt/REPORT.md`. Whoever writes those migrations: preserve these invariants and don't reintroduce the bug.

| Area | Invariant that must hold | The bug to avoid |
|------|--------------------------|------------------|
| **Prepay apply (any path)** | Every spend of prepay must INSERT a `prepay_applications` row (which is what drives `prepay_credits.balance_cents` via `trg_recompute_prepay_credit_balance`) **and** decrement `customers.prepay_balance_cents` in lockstep — exactly like `apply_prepay_to_invoice`. | `apply_remaining_prepayments` / `batch_apply_all_prepayments` decrement only the customer aggregate and write **no** `prepay_applications` row → each credit's `balance_cents` stays stale-HIGH → the **same dollars can be applied a second time** (double-spend). Never adjust only the denormalized aggregate. |
| **Prepay apply → invoice status** | When a prepay application drives an invoice's `balance_cents` to 0, the RPC must also flip `status` to `'paid'` (mirror the `CASE WHEN (...)<=0 THEN 'paid'` in `apply_prepay_to_invoice`). No trigger derives `status` from `balance_cents`. | `apply_remaining_prepayments` updates only `prepay_applied_cents`, leaving a fully-settled invoice stuck at `'posted'` with balance 0 → status-keyed AR/aging misreads it as open. |
| **Blend-ticket re-bill guard** | A grouped (multi-customer) blend ticket fans out into **multiple** invoices sharing one `blend_ticket_id`. Only reset `blend_tickets.payment_status` to `'unbilled'` when **NO** non-voided/non-cancelled invoice remains for that ticket: `... AND NOT EXISTS (SELECT 1 FROM invoices WHERE blend_ticket_id = NEW.blend_ticket_id AND status NOT IN ('voided','cancelled'))`. | `sync_blend_ticket_payment_status` resets the **whole** ticket to `'unbilled'` when **one** of its invoices is voided → the ticket becomes re-billable while siblings stay posted → `create_invoice_from_blend_ticket` generates a **second full set of invoices** = double-billing every customer on the ticket. |

> Regression tests are deferred until the fixes land (a "fails-before / passes-after" test needs the fix to exist). When you write each parked migration, add the matching test then.

---

## Source

This file consolidates lessons from `~/.claude/projects/.../memory/feedback.md` and historical debugging sessions. Add new entries here whenever a non-obvious quirk causes a bug.
