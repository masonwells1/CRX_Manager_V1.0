# Repo Scout — frappe/erpnext

_Mined 2026-06-19 for ideas, data-models, and formulas to improve CRX Manager._

## Identity & stack
- **Repo:** frappe/erpnext (https://github.com/frappe/erpnext)
- **What it is:** A full open-source ERP — accounting, inventory/stock, selling, buying, CRM, manufacturing, projects, HR — built on the Frappe low-code framework. Mature, battle-tested double-entry accounting and stock-valuation engine.
- **Stack:** Python (Frappe framework) + MariaDB/Postgres backend + Frappe's JS UI. Data model is expressed as "DocTypes" (JSON field definitions in `*/doctype/*/*.json`) with Python controllers (`*.py`).
- **CONFIRMED license:** `GPL-3.0` (verified via `gh api repos/frappe/erpnext/license --jq '.license.spdx_id'`). **Copyleft** — borrow IDEAS / DATA-MODEL shapes / FORMULAS only, clean-room re-implemented on Supabase+React. Do NOT lift its Python source into CRX (hosted SaaS = copyleft trigger risk).

## Top features (relevant to CRX)
1. **Double-entry General Ledger** — every financial event posts balanced debit/credit `GL Entry` rows tagged to a hierarchical Chart of Accounts; ledger is append-only (reversed by cancellation rows, never edited/deleted).
2. **Perpetual inventory valuation** — `Stock Ledger Entry` carries running qty + value; FIFO (a `[qty, rate]` queue) and Moving Average are first-class, with explicit negative-stock handling.
3. **Live inventory aggregate (`Bin`)** — one row per item×warehouse holding actual/reserved/ordered/planned and a derived `projected_qty` — the exact shape of CRX's Net Free / On Order.
4. **CRM sales pipeline** — `Lead → Opportunity` with `Sales Stage`, `probability`, `expected_closing`, `opportunity_amount`, lost-reasons, competitors, UTM attribution.
5. **Pricing Rule engine** — declarative, prioritized price/discount rules scoped by customer/group/territory/qty/amount/date, with margin and free-item ("buy X get Y") support.
6. **Payment Terms w/ prompt-pay discount** — staged due dates + early-payment discount windows (2/10 net 30 style).
7. **Landed Cost Voucher** — distributes freight/duty/handling into per-item inventory valuation (by qty / amount / manual).
8. **Repost Item Valuation** — a controlled job that recomputes the stock ledger forward from a back-dated correction — the principled way to re-base inventory cost/qty.

## Data-model highlights (cited)

### GL Entry — the double-entry ledger CRX lacks
`erpnext/accounts/doctype/gl_entry/gl_entry.json` — every row has `account`, `debit`, `credit`, `against_voucher_type`/`against_voucher` (what this entry offsets), `voucher_type`/`voucher_no` (the source document, e.g. Sales Invoice), `posting_date`, `fiscal_year`, `party_type`/`party`, `is_cancelled`. Money is balanced per voucher (sum debit = sum credit). Crucially there is no "update amount" path — corrections post a `is_cancelled` reversal. This is the canonical immutable ledger; CRX already has `financial_audit_log` (append-only) but no true balanced GL or trial-balance/financial-statement layer.

### Account — hierarchical Chart of Accounts (nested set)
`erpnext/accounts/doctype/account/account.json` — `parent_account`, `is_group`, `root_type` (Asset/Liability/Income/Expense/Equity), `report_type` (Balance Sheet vs Profit & Loss), `account_type`, plus `lft`/`rgt` nested-set columns for fast subtree rollups. This is how you get P&L and Balance Sheet for free: tag each GL Entry to a leaf account, roll up the tree.

### Stock Ledger Entry — perpetual valuation
`erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.json` — per movement: `actual_qty` (signed), `incoming_rate`/`outgoing_rate`, `qty_after_transaction`, `valuation_rate` (running average cost), `stock_value` (running balance value), `stock_value_difference`, and `stock_queue` ("FIFO Stock Queue (qty, rate)" — the serialized FIFO bins). One ledger, multiple voucher types, never edited.

### FIFO & Moving-Average formulas (the actual algorithm)
`erpnext/stock/valuation.py` — `FIFOValuation` keeps a queue of `[qty, rate]` bins; `add_stock` appends (merging same-rate), `remove_stock` consumes oldest-first and returns consumed bins (used to compute COGS). Moving-average rate is computed in `erpnext/stock/stock_ledger.py:1038-1044`:
`new_stock_value = (qty_after_transaction * valuation_rate) + stock_value_change; if new_stock_value >= 0: valuation_rate = new_stock_value / new_stock_qty` — i.e. **weighted-average cost, frozen at the prior rate whenever the balance would go negative.** This negative-stock guard is the subtle bit CRX would otherwise get wrong (CRX has 17 negative-inventory products today).

### Bin — live inventory aggregate
`erpnext/stock/doctype/bin/bin.json` — `actual_qty`, `reserved_qty`, `ordered_qty`, `planned_qty`, `projected_qty`, `valuation_rate`, `stock_value`. `projected_qty = actual + ordered + planned + requested − reserved`. Maps almost 1:1 onto CRX's existing Net Free (available − holds − prebooked) and On Order — useful as a reference shape, not a new build.

### Opportunity — CRM pipeline
`erpnext/crm/doctype/opportunity/opportunity.json` — `status`, `sales_stage` (link to `Sales Stage`), `probability`, `expected_closing`, `opportunity_amount`, `items` (line items), `lost_reasons`, `competitors`, `opportunity_owner`, `first_response_time`, UTM source/campaign/medium. `erpnext/crm/doctype/sales_stage/sales_stage.json` is just `{ stage_name }` — stages are data, not a hard-coded enum.

### Pricing Rule
`erpnext/accounts/doctype/pricing_rule/pricing_rule.json` — `apply_on` (item/group/brand), scoping (`customer`/`customer_group`/`territory`/`min_qty`/`max_qty`/`min_amt`/`valid_from`/`valid_upto`), `rate_or_discount`, `discount_percentage`, `margin_type`/`margin_rate_or_amount`, `priority`, `apply_multiple_pricing_rules`, free-item fields. A declarative superset of CRX's static 4-tier pricing.

### Payment Term — staged due dates + prompt-pay discount
`erpnext/accounts/doctype/payment_term/payment_term.json` — `invoice_portion` (%), `due_date_based_on`, `credit_days`/`credit_months`, plus `discount_type`/`discount`/`discount_validity_based_on`/`discount_validity` (early-payment discount). The 2/10-net-30 formula CRX's AR doesn't model.

### Landed Cost Voucher
`erpnext/stock/doctype/landed_cost_voucher/landed_cost_voucher.json` — attaches extra charges (`taxes`) to purchase receipts and distributes them into item valuation; `distribute_charges_based_on` ∈ {Qty, Amount, Distribute Manually}. Folds inbound freight/duty into product cost so margins are honest.

### Repost Item Valuation
`erpnext/stock/doctype/repost_item_valuation/repost_item_valuation.json` — a job (`item_code`, `warehouse`, `posting_date`, `status`, `recalculate_valuation_rate`, `allow_negative_stock`) that replays the stock ledger forward from a back-dated change. The disciplined pattern for CRX's "physical counts to re-base 17 negative-inventory products" owner item (H1).

## Candidate table
See the structured candidates returned alongside this doc. Summary:

| # | Title | Lens | Rel | Effort | Fills gap |
|---|-------|------|-----|--------|-----------|
| 1 | Double-entry General Ledger + Chart of Accounts | financial | 5 | L | double-entry ledger / financial statements |
| 2 | Inventory valuation engine (FIFO + moving-avg) | financial | 5 | L | inventory-valuation method |
| 3 | Negative-stock-safe moving-average formula | financial | 4 | M | inventory-valuation method |
| 4 | CRM sales pipeline (Opportunity + Sales Stage) | CRM-UX | 5 | M | CRM sales pipeline |
| 5 | Repost-from-date ledger replay (re-base inventory) | architecture | 4 | M | inventory-valuation method |
| 6 | Landed Cost allocation into product cost | financial | 3 | M | inventory-valuation method |
| 7 | Declarative Pricing Rule engine | financial | 3 | M | none (extends tier pricing) |
| 8 | Payment Terms w/ prompt-pay discount | financial | 3 | S | none (extends AR) |
| 9 | "Against voucher" reversal pattern for audit log | architecture | 3 | S | none (hardens ledger) |
