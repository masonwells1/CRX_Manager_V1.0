# Theme synthesis — FINANCIAL lens

_Deduped, ranked idea set for improving CRX Manager (an ag-retail DEALER platform). Synthesized 2026-06-19 from 6 repo scouts: frappe/erpnext, twentyhq/twenty, microsoft/farmvibes-ai, ekylibre/ekylibre, LiteFarmOrg/LiteFarm, farmOS/farmOS._

## Where the financial signal actually lives
Only **two** of the six scouted repos carry real financial-accounting depth: **erpnext** (GPL-3.0) and **ekylibre** (AGPL-3.0). Both are strong-copyleft, so everything below is **ideas / data-model shapes / formulas re-implemented clean-room on Supabase + React** — no source is copied. (The MIT repo, farmvibes-ai, has *zero* financial candidates — it's remote-sensing only, so the "MIT = can copy code" exception does not apply to this lens.) twenty, litefarm, and farmos contribute nothing net-new to the financial lens that the two ERPs don't already cover better; farmOS's event-sourced inventory is noted as an architecture-substrate alternative under candidate F2, not a separate build.

## Dedup decisions (what got merged / killed)
- **Double-entry ledger appeared twice** — erpnext's `GL Entry` + Chart of Accounts and ekylibre's `journal_entry`/`journal_entry_item` + `account` are the *same idea*. **Merged into F1.** erpnext contributes the cleaner Chart-of-Accounts rollup shape (root_type/report_type → P&L + Balance Sheet for free); ekylibre contributes two refinements folded in as sub-features: the **`continuous_number`** legally-immutable sequence and the **`letter`/`lettered_at` reconciliation** matching.
- **Invoice↔payment "lettering" (separate ekylibre candidate)** — this is the *reconciliation layer of* the ledger, not a standalone product. **Folded into F1** as the AR/AP-settlement sub-feature. It is only worth building once the GL exists.
- **Negative-stock-safe moving-average formula (separate erpnext candidate)** — this is a *one-conditional sub-rule inside* the valuation engine, not its own project. **Folded into F2** as the must-have edge-case guard (directly relevant: CRX has 17 negative-inventory products today).
- **"Against voucher" reversal pattern (erpnext architecture candidate)** — append-only correction-by-reversal is **a built-in property of F1's ledger**, not separate. Noted inside F1.
- **Repost-from-date ledger replay (erpnext)** — architecture-lensed, not financial; it's the *mechanism* to re-base inventory cost and belongs to the inventory-architecture theme. Cross-referenced from F2 but not double-counted here.
- **Killed as grower-only / out-of-lens noise:** litefarm soil-amendment chemistry, farmos lab-test/plan models, farmvibes NDVI — none are financial.

---

## Ranked candidates

### F1 — Double-entry General Ledger + Chart of Accounts (the financial-statements backbone)
- **Relevance: 5 · Effort: L · Risk: HIGH**
- **Sources:** frappe/erpnext (`gl_entry.json`, `account.json`), ekylibre/ekylibre (`journal_entry.rb`, `journal_entry_item.rb`, `account.rb`)
- **CRX has:** `financial_audit_log` (append-only event log), `invoices.balance_cents` (single AR source of truth), AP vendor bills, prepay, month-end close, finance charges — but **no balanced debit/credit ledger and no P&L / Balance Sheet**.
- **Best repo does:** Every financial event posts balanced debit/credit rows to a leaf account on a hierarchical Chart of Accounts; ledger is append-only (corrections post a reversal, never an edit); trial balance / P&L / Balance Sheet are pure rollups over the account tree. ekylibre adds `continuous_number` (legally-immutable sequence) and invoice↔payment `letter`/`lettered_at` reconciliation.
- **The idea we'd build on Supabase:** An `accounts` table (`parent_account_id`, `is_group`, `root_type` ∈ Asset/Liability/Income/Expense/Equity, `report_type` ∈ BalanceSheet/P&L) and a `gl_entries` table (`account_id`, `debit_cents bigint`, `credit_cents bigint`, `voucher_type`, `voucher_id`, `against_voucher_id`, `posting_date`, `period_id`, `party_type`, `party_id`, `is_cancelled`, immutable `continuous_number`). A `post_to_gl()` SECURITY DEFINER RPC called *as a side-effect* from the existing `post_invoice` / `record_payment` / AP RPCs, inserting balanced rows in one transaction with a `sum(debit)=sum(credit)` per-voucher assertion. Financial-statement views are recursive CTEs over the account tree. Reconciliation `letter` columns let the aging report show true open AR/AP (`letter IS NULL`) as a complement to `balance_cents`. Reuses CRX's bigint-cents + `check_period_open()` conventions.
- **License note:** GPL-3.0 + AGPL-3.0 — ideas/shapes only, clean-room. Debit/credit balancing and chart-of-accounts rollup are standard accounting, not copyrightable.
- **Why HIGH risk / L:** Touches money + period locking + every existing financial RPC; must be additive (mirror, don't replace `balance_cents`) and reconcile to the penny against current AR before it can be trusted. This is the highest-value gap-fill but the one most needing a phased, double-reviewed build.

### F2 — Perpetual inventory-valuation engine (FIFO queue + moving average, negative-stock-safe)
- **Relevance: 5 · Effort: L · Risk: HIGH**
- **Sources:** frappe/erpnext (`stock_ledger_entry.json`, `valuation.py` FIFOValuation, `stock_ledger.py:1038-1044` moving-avg)
- **CRX has:** `inventory_transactions` (12 typed txn types), Net Free / On Order / holds / prebook — but **no cost layer**: no FIFO/average valuation, so on-hand value and COGS/margin in `get_sales_detail_report` aren't grounded in real delivered cost.
- **Best repo does:** One immutable stock ledger carries signed `actual_qty`, running `qty_after_transaction`, `valuation_rate`, `stock_value`, and a `stock_queue` JSON of `[qty, rate]` FIFO bins; outflows pop the queue (FIFO) or apply weighted-average to stamp COGS per line. **Negative-stock guard (folded-in sub-rule):** only recompute `valuation_rate = new_stock_value / new_stock_qty` when `new_stock_value >= 0`; otherwise carry the prior rate forward, and FIFO keeps a negative bin at the last rate — never divide by a non-positive balance.
- **The idea we'd build on Supabase:** Extend `inventory_transactions` with `incoming_rate_cents`, `qty_after_txn`, `valuation_rate_cents`, `stock_value_cents`, and a `stock_queue jsonb`. A valuation RPC that, on a `delivered`/`job_applied` outflow, pops the FIFO queue (or applies moving-avg) to stamp COGS per line — feeding both accurate margin in `get_sales_detail_report` and (if F1 exists) the COGS GL line. Method selectable per company (FIFO vs avg). Bake the negative-stock conditional directly in as a small, unit-tested pure function — it's the exact edge CRX would otherwise get wrong on its **17 known negative-inventory products**; flag the negative bin for the physical-count re-base (owner item H1).
- **License note:** GPL-3.0 — FIFO/weighted-average and the negative-balance guard are standard accounting algorithms, re-implement clean-room.
- **Why HIGH risk / L:** Rewrites the cost meaning of every inventory movement and feeds margin reporting; needs the back-dated-correction replay mechanism (erpnext's "Repost Item Valuation", an architecture-theme cross-ref) to re-base safely. Build the negative-stock pure-function + tests first as a de-risking slice.

### F3 — Declarative Pricing Rule engine (volume breaks, promos, customer deals)
- **Relevance: 3 · Effort: M · Risk: MEDIUM**
- **Sources:** frappe/erpnext (`pricing_rule.json`)
- **CRX has:** static 4-tier pricing (customer tier 1/2/3 → product tier1/2/3_price, quotes inherit tier).
- **Best repo does:** A prioritized, declarative rule set scoped by item/group/brand × customer/group/territory × qty/amount × date range, with discount %, margin, priority, multi-rule stacking, and free-item ("buy X get Y") support — a superset of static tiers.
- **The idea we'd build on Supabase:** A `pricing_rules` table (`apply_on`, `target_id`, scope columns, `min_qty`/`max_qty`, `valid_from`/`valid_to`, `discount_pct` or fixed `rate_cents`, `priority`) and a `resolve_price()` RPC layered *on top of* the existing 4-tier price as the lowest-priority default. Lets CRX run volume breaks, seasonal promos, and customer-specific deals without code changes.
- **License note:** GPL-3.0 — clean-room the rule schema + resolution order.
- **Why MEDIUM:** Touches quote/order pricing but is additive (falls back to tier price); the risk is rule-precedence bugs, not data corruption.

### F4 — Payment Terms with prompt-pay (early-payment) discount
- **Relevance: 3 · Effort: S · Risk: LOW**
- **Sources:** frappe/erpnext (`payment_term.json`)
- **CRX has:** invoices with due dates, AR aging, finance charges, statements — but **no staged terms and no early-pay discount** (classic "2/10 net 30").
- **Best repo does:** Models staged due dates (`invoice_portion %`, `credit_days`) plus an early-payment discount window (`discount_type`, `discount`, `discount_validity`).
- **The idea we'd build on Supabase:** Add `discount_pct` + `discount_days` to invoice/customer terms; the payment-allocation flow auto-computes the discounted amount-due when a payment lands inside the window (and, once F1 exists, posts the discount as a GL line). Small, high-perceived-value addition to the AR module CRX already has.
- **License note:** GPL-3.0 — standard net-terms formula, clean-room.
- **Why LOW / S:** Self-contained AR addition, no schema-wide blast radius; the cheapest "real" financial win on the list.

### F5 — Landed Cost allocation into product cost
- **Relevance: 3 · Effort: M · Risk: MEDIUM**
- **Sources:** frappe/erpnext (`landed_cost_voucher.json`)
- **CRX has:** AP vendor bills + receiving records — but inbound freight/handling/duty is **not folded into product cost**, so margins overstate profit by the cost of getting product to the dealer.
- **Best repo does:** A landed-cost voucher attaches inbound charges to purchase receipts and distributes them into each item's valuation (`distribute_charges_based_on` ∈ Qty / Amount / Manual), so on-hand cost and margin reflect true delivered cost.
- **The idea we'd build on Supabase:** Let a vendor bill carry freight/handling lines; an RPC allocates those charges across received product lines (pro-rata by qty or extended amount, or manual) and bumps each product's `valuation_rate`. Plugs straight into F2's valuation engine and CRX's existing AP.
- **License note:** GPL-3.0 — concept + allocation formula only, clean-room.
- **Why MEDIUM:** Only meaningful *after* F2 exists (it adjusts the valuation rate F2 introduces); on its own it has nowhere to write the cost. Sequence after F2.

### F6 — Fixed-asset depreciation schedules
- **Relevance: 2 · Effort: M · Risk: LOW**
- **Sources:** ekylibre/ekylibre (`fixed_asset.rb`, `fixed_asset_depreciation.rb`)
- **CRX has:** nothing — equipment (Hagie applicators, blenders, spray fleet) isn't on the books.
- **Best repo does:** Tracks owned equipment as depreciable assets (method linear/declining, purchase/depreciable/current amounts) with a schedule that posts periodic depreciation expense.
- **The idea we'd build on Supabase:** `fixed_assets` (`purchase_amount_cents`, `method`, `started_on`, `useful_life`, `current_amount_cents`) + `fixed_asset_depreciation` (`period`, `amount_cents`, `posted`) tables and a `generate_depreciation_schedule()` RPC that posts to F1's GL.
- **License note:** AGPL-3.0 — depreciation-schedule shape + linear/declining formulas are standard, clean-room.
- **Why lowest:** Only matters if CRX wants its *own* equipment on financial statements; depends on F1 to have anywhere to post. Park until F1 lands and there's an owner ask.

---

## Recommended sequence (plain English for Mason)
1. **F4 (prompt-pay discount)** first — small, low-risk, immediately useful, proves the pattern.
2. **F1 (double-entry ledger)** is the big one and the headline gap-fill, but it's L/HIGH — build it additive and phased, reconciled to the penny against current AR, double-reviewed.
3. **F2 (inventory valuation)** next, starting with the negative-stock pure function as a de-risking slice; it makes margin reporting honest and feeds F1's COGS.
4. **F5 (landed cost)** only after F2. **F3 (pricing rules)** whenever flexible pricing becomes a business need. **F6 (depreciation)** last / on demand.
F1 and F2 are the two named-gap fills ("no formal double-entry ledger / financial statements" and "no real inventory-valuation method") and carry the highest relevance; the rest are extensions, not gap-fills.
