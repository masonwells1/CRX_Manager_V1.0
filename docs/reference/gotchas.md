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
| `payments.amount` is `numeric` dollars, NOT `bigint` cents | RPCs convert: `(p_amount_cents / 100.0)::numeric(12,2)` |
| `commissions.commission_amount` is `numeric` dollars (NOT `_cents`) | Same as payments — historical exception |
| `deliveries.scheduled_date` (NOT `delivery_date`) | Always check `information_schema.columns` before assuming a column name |
| `idempotency_keys` columns: `idempotency_key`, `operation`, `result` | NOT `key`/`entity_type`/`entity_id`/`result_id` — bug has been re-introduced 3+ times |
| `idempotency_keys.result` is `jsonb` | Do NOT cast to `::text` when inserting — pass `jsonb_build_object(...)` directly |
| `invoices.balance_cents` is a GENERATED column | NEVER UPDATE it directly — update the components (`subtotal_cents`, `tax_cents`, `total_paid_cents`) |
| `orders.total_paid` / `orders.balance_due` were DROPPED | AR is derived from `invoices.balance_cents` |
| `create_direct_order` returns `{ order_id }` (NOT `{ id }`) | Destructure correctly |
| `complete_delivery` requires `p_signed_by text` | Always pass the signer's name |
| `returns.requested_by` (NOT `created_by`) | And status starts at `'requested'` (NOT `'pending'`) |
| `return_items.order_item_id` (NOT `delivery_item_id`) | Returns are linked to order lines, not delivery lines |
| `invoice_items.extended_cents` (NOT `line_total_cents`) | Naming inconsistency from early schema |

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

## Source

This file consolidates lessons from `~/.claude/projects/.../memory/feedback.md` and historical debugging sessions. Add new entries here whenever a non-obvious quirk causes a bug.
