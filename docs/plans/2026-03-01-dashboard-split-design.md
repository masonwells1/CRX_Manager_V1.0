# Dashboard Split Design — Phase 1

> **Date:** 2026-03-01 | **Status:** Approved | **Approach:** A (two pages, two RPCs)

## Goal

Separate the current monolith Dashboard into two purpose-built pages:

1. **Operations Dashboard** (`/`) — daily ops view for all non-driver users
2. **Financial Dashboard** (`/financial-dashboard`) — financial command center, Admin only

Phase 2 (future) will add new operational widgets to the Operations Dashboard.

---

## Decisions

| Decision | Answer |
|----------|--------|
| Quote Pipeline card | Move to Financial |
| Top Customers widget | Move entirely to Financial |
| New operational widgets in Phase 1? | No — Phase 2 |
| Financial Dashboard scope | Full command center (moved widgets + summaries + quick links) |
| Financial Dashboard access | Admin only |
| Financial Dashboard nav location | First item in Finance sidebar section |
| Architecture | Two separate pages, two RPCs (Approach A) |
| Phasing | Phase 1 = split & new Financial page; Phase 2 = new ops widgets |

---

## Phase 1 Scope

### Operations Dashboard (refactored `Dashboard.tsx` at `/`)

**Widgets that STAY:**

| Widget | Notes |
|--------|-------|
| Inventory (available + prebooked) | Top row card |
| Upcoming Deliveries list | Main content area |
| Recent Activity timeline | Sidebar |
| Low Stock Alert | Conditional alert row |
| Driver Issues Alert | Conditional alert row |
| Stale Inventory Holds Alert | Conditional alert row |
| Cancelled + Posted Alert | Conditional alert row (data integrity) |
| Quick Actions | Button group (Admin/Sales Rep) |

**Widgets REMOVED:**

- Total Revenue card
- Total Profit + Margin % card
- Quote Pipeline card (dollar value + counts)
- Monthly Revenue & Profit chart
- Top Customers (revenue-ranked list)
- Outstanding A/R alert
- Over Credit Limit alert

**Layout note:** With the top row reduced from 4 cards to 1 (Inventory), the layout
will need rearranging. Consider promoting Inventory into a wider card or adding
simple operational counts (open orders, scheduled deliveries) as placeholder cards.
Final layout to be determined during implementation.

### Financial Dashboard (new `FinancialDashboard.tsx` at `/financial-dashboard`)

**Access:** Admin only
**Sidebar:** First item in Finance category, labeled "Dashboard" with LayoutDashboard icon

#### Moved Widgets (from main Dashboard)

| Widget | Original Source |
|--------|----------------|
| Total Revenue card | `total_revenue` |
| Total Profit + Margin % card | `total_profit`, `overall_margin` |
| Quote Pipeline (value + counts) | `quote_pipeline_value`, `quote_counts` |
| Monthly Revenue & Profit chart | `monthly_revenue` array |
| Top Customers (revenue-ranked) | `top_customers` array |
| Outstanding A/R alert | `open_ar_balance` |
| Over Credit Limit alert | `customers_over_credit_count` |

#### New Summary Cards

| Card | Data Source | Display |
|------|------------|---------|
| AR Aging Summary | `get_ar_aging()` RPC data | Aging bucket totals: Current, 31-60, 61-90, 90+ |
| Prepayment Balances | Prepayment tables | Total unallocated prepay across all customers |
| Commission Owed | `get_commission_balances()` RPC data | Total unpaid commissions |
| Month-End Status | `get_period_info()` RPC data | Current period + status + days remaining |

#### Quick-Access Links Grid

A card grid linking to all 9 financial pages with icon + description:

1. AR Aging → `/ar-aging`
2. Prepayments → `/prepayments`
3. Prepay Workspace → `/prepay-workspace`
4. Commission Pay → `/commission-payments`
5. Transactions → `/customer-transactions`
6. Month-End → `/month-end`
7. Rebates → `/rebates`
8. Reports → `/reports`
9. Compliance → `/compliance`

---

## Backend Changes

### New RPC: `financial_dashboard_summary()`

Single RPC call returning all Financial Dashboard data:

```
Returns:
  -- Moved from dashboard_summary():
  total_revenue           numeric
  total_profit            numeric
  overall_margin          numeric
  quote_pipeline_value    numeric
  quote_counts            jsonb { draft, sent, accepted }
  monthly_revenue         jsonb array [{ month, year, revenue, profit }]
  top_customers           jsonb array [{ id, farm_name, total_revenue }]
  open_ar_balance         numeric
  customers_over_credit_count  integer

  -- NEW aggregations:
  ar_aging_buckets        jsonb { current, days_31_60, days_61_90, days_90_plus }
  total_prepay_unallocated  numeric
  total_commission_owed   numeric
  current_period          jsonb { name, status, days_remaining }
```

### Modified RPC: `dashboard_summary()`

Remove financial fields from the return value:
- Remove: `total_revenue`, `total_profit`, `overall_margin`, `quote_pipeline_value`,
  `quote_counts`, `monthly_revenue`, `top_customers`, `open_ar_balance`,
  `customers_over_credit_count`
- Keep: `inventory_available`, `inventory_prebooked`, `upcoming_deliveries`,
  `recent_activity`, `low_stock_count`, `driver_issues_count`,
  `expired_holds_count`, `cancelled_posted_count`

---

## Routing & Navigation

### New Route (`App.tsx`)

```
/financial-dashboard → FinancialDashboard (Admin only)
```

### Sidebar Change (`Sidebar.tsx`)

Add as first item in Finance category:
```
{ path: '/financial-dashboard', label: 'Dashboard', icon: <LayoutDashboard>, roles: ['admin'] }
```

---

## What Does NOT Change

- All 9 existing financial pages remain as-is
- Database schema unchanged (no new tables or columns)
- Driver views unchanged
- Existing E2E tests for Dashboard will need updating (financial assertions removed)
- Pre-commit hooks, CI pipeline unchanged

---

## Testing Plan

- Unit tests for new `FinancialDashboard` component
- Update existing Dashboard E2E to verify financial widgets are gone
- New E2E spec for Financial Dashboard (Admin access, widget presence, quick links)
- Role-guard test: verify non-admin users cannot access `/financial-dashboard`

---

## Phase 2 (Future — Separate Brainstorm)

Enhance the Operations Dashboard with new widgets:
- Today's Deliveries (filtered to today only)
- Delivery Remainders count
- Driver Status Board
- Pending Purchase Orders
- Products Below Reorder Point (expanded)
- Blend Tickets In Progress
- Orders Pending Delivery (backlog)
- Quotes Expiring Soon
- Active Jobs
- RUP Compliance Warnings

Each will require new fields in the `dashboard_summary()` RPC and a separate design pass.
