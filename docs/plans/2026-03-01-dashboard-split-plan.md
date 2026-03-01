# Dashboard Split — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate the monolith Dashboard into an Operations Dashboard (`/`) and a Financial Dashboard (`/financial-dashboard`, Admin only).

**Architecture:** Two separate pages powered by two separate RPCs. The existing `dashboard_summary()` RPC is slimmed down to only return operational data. A new `financial_dashboard_summary()` RPC returns all financial KPIs, aging buckets, prepay totals, commission owed, and period status. The Financial Dashboard also includes a quick-access grid linking to all 9 financial sub-pages.

**Tech Stack:** React + TypeScript (Vite), Supabase Postgres RPCs, Playwright E2E tests, Tailwind CSS + existing component library (Card, Badge, Button, CardHeader, SkeletonCard).

**Design doc:** `docs/plans/2026-03-01-dashboard-split-design.md`

---

## Task 1: Create `financial_dashboard_summary()` RPC

**Files:**
- Create: `supabase/migrations/20260301300000_financial_dashboard_summary.sql`

**Step 1: Write the migration SQL**

Create a new RPC that returns all financial data in one call. This combines the financial CTEs from `dashboard_summary()` plus new aggregations for AR aging, prepay, commissions, and period status.

```sql
-- ============================================================================
-- FINANCIAL DASHBOARD SUMMARY RPC
-- ============================================================================
-- Returns all financial KPIs for the Financial Dashboard page.
-- Admin-only page — RPC is SECURITY DEFINER so it runs with elevated privileges.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  -- 1. Order aggregates: revenue, profit, margin
  order_agg AS (
    SELECT
      COALESCE(SUM(total_price), 0)  AS total_revenue,
      COALESCE(SUM(total_profit), 0) AS total_profit
    FROM orders
  ),

  -- 2. Quote counts & pipeline value
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM quotes
  ),

  -- 3. Monthly revenue & profit for last 12 months
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0)  AS revenue,
        COALESCE(SUM(total_profit), 0) AS profit
      FROM orders
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),

  -- 4. Top 5 customers by revenue
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),

  -- 5. Open AR balance
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_due, 0)), 0) AS balance
    FROM orders
  ),

  -- 6. Customers over credit limit
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(o.balance_due, 0)), 0) * 100
        FROM orders o
        WHERE o.customer_id = c.id
          AND o.status NOT IN ('cancelled', 'void')
      ) > c.credit_limit_cents
  ),

  -- === NEW FINANCIAL AGGREGATIONS ===

  -- 7. AR Aging buckets
  ar_aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN age_days <= 30 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days > 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_due, 0) AS balance,
        EXTRACT(DAY FROM NOW() - i.invoice_date)::int AS age_days
      FROM invoices i
      WHERE i.status = 'posted'
        AND i.balance_due > 0
    ) aged
  ),

  -- 8. Total unallocated prepay balance
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM customers
    WHERE prepay_balance_cents > 0
  ),

  -- 9. Total unpaid commissions
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM commissions
    WHERE status = 'earned'
      AND paid_date IS NULL
  ),

  -- 10. Current accounting period
  period_info AS (
    SELECT
      COALESCE(period_name, TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  )

  SELECT jsonb_build_object(
    -- Financial KPIs (moved from dashboard_summary)
    'total_revenue',              oa.total_revenue,
    'total_profit',               oa.total_profit,
    'overall_margin',             CASE WHEN oa.total_revenue > 0
                                    THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
                                    ELSE 0
                                  END,
    'quote_counts',               jsonb_build_object(
                                    'draft',    qa.draft_count,
                                    'sent',     qa.sent_count,
                                    'accepted', qa.accepted_count
                                  ),
    'quote_pipeline_value',       qa.pipeline_value,
    'monthly_revenue',            COALESCE(mr.arr, '[]'::jsonb),
    'top_customers',              COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance',            ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    -- New financial aggregations
    'ar_aging_buckets',           jsonb_build_object(
                                    'current',      aa.current_bucket,
                                    'days_31_60',   aa.days_31_60,
                                    'days_61_90',   aa.days_61_90,
                                    'days_90_plus',  aa.days_90_plus
                                  ),
    'total_prepay_unallocated',   pb.total_unallocated,
    'total_commission_owed',      co.total_owed,
    'current_period',             jsonb_build_object(
                                    'name',           COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
                                    'status',         COALESCE(pi.status, 'open'),
                                    'days_remaining', COALESCE(pi.days_remaining, 0)
                                  )
  ) INTO result
  FROM order_agg   oa
  CROSS JOIN quote_agg    qa
  CROSS JOIN monthly      mr
  CROSS JOIN top_cust     tc
  CROSS JOIN ar           ar_total
  CROSS JOIN over_credit  oc
  CROSS JOIN ar_aging     aa
  CROSS JOIN prepay_bal   pb
  CROSS JOIN commission_owed co
  LEFT JOIN  period_info  pi ON true;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.financial_dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.financial_dashboard_summary() IS
  'Returns all financial KPIs for the Financial Dashboard: revenue, profit, margin, '
  'quote pipeline, AR aging buckets, prepay balances, commission owed, and period status.';
```

**Step 2: Apply migration to Supabase**

Run: Apply migration via Supabase MCP tool (`apply_migration`) with:
- project_id: `rhyzpcqhnizqbxphqdkr`
- name: `financial_dashboard_summary`
- query: (the SQL above)

**Step 3: Verify RPC works**

Run: Execute SQL via Supabase MCP tool:
```sql
SELECT financial_dashboard_summary();
```
Expected: Returns a JSONB object with all fields populated.

**Step 4: Commit**

```bash
git add supabase/migrations/20260301300000_financial_dashboard_summary.sql
git commit -m "feat: add financial_dashboard_summary() RPC for Financial Dashboard"
```

---

## Task 2: Slim down `dashboard_summary()` RPC (operational only)

**Files:**
- Create: `supabase/migrations/20260301300001_slim_dashboard_summary.sql`

**Step 1: Write the migration SQL**

Rewrite `dashboard_summary()` to only return operational fields. Remove CTEs: `order_agg`, `quote_agg`, `monthly`, `top_cust`, `ar`, `over_credit`. Keep: `inv_agg`, `low_stock`, `upcoming`, `activity`, `driver_issues`, `expired_holds`, `cancelled_posted`.

```sql
-- ============================================================================
-- SLIM DOWN dashboard_summary() — Remove financial fields
-- ============================================================================
-- Phase 1 Dashboard Split: This RPC now returns only operational data.
-- Financial data is served by financial_dashboard_summary() instead.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH
  -- 1. Inventory totals
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0)  AS total_available,
      COALESCE(SUM(quantity_prebooked), 0)  AS total_prebooked
    FROM inventory
  ),

  -- 2. Low stock count
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),

  -- 3. Next 5 upcoming deliveries
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date,
        d.status,
        jsonb_build_object('farm_name', cust.farm_name) AS customer,
        jsonb_build_object('full_name', drv.full_name)  AS driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 5
    ) ud
  ),

  -- 4. Last 10 activity feed items
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT
        id,
        event_type,
        description,
        created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 10
    ) af
  ),

  -- 5. Driver issues count
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),

  -- 6. Expired quote holds
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),

  -- 7. Cancelled deliveries with posted invoices
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  )

  SELECT jsonb_build_object(
    'inventory_available',  ia.total_available,
    'inventory_prebooked',  ia.total_prebooked,
    'low_stock_count',      ls.cnt,
    'upcoming_deliveries',  COALESCE(ud.arr, '[]'::jsonb),
    'recent_activity',      COALESCE(ra.arr, '[]'::jsonb),
    'driver_issues_count',          di.cnt,
    'expired_holds_count',          eh.cnt,
    'cancelled_posted_count',       cp.cnt
  ) INTO result
  FROM inv_agg     ia
  CROSS JOIN low_stock   ls
  CROSS JOIN upcoming    ud
  CROSS JOIN activity    ra
  CROSS JOIN driver_issues   di
  CROSS JOIN expired_holds   eh
  CROSS JOIN cancelled_posted cp;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated;

COMMENT ON FUNCTION public.dashboard_summary() IS
  'Returns operational Dashboard KPIs: inventory, deliveries, activity, and integrity alerts. '
  'Financial data moved to financial_dashboard_summary().';
```

**Step 2: Apply migration**

Run: Apply migration via Supabase MCP tool.

**Step 3: Verify slimmed RPC**

Run SQL: `SELECT dashboard_summary();`
Expected: Returns JSONB with ONLY operational fields. No `total_revenue`, `total_profit`, etc.

**Step 4: Commit**

```bash
git add supabase/migrations/20260301300001_slim_dashboard_summary.sql
git commit -m "refactor: slim dashboard_summary() to operational-only data"
```

---

## Task 3: Refactor `Dashboard.tsx` to operational-only

**Files:**
- Modify: `src/pages/Dashboard.tsx`

**Step 1: Update the DashboardData interface**

Remove all financial fields from the interface. Keep only operational fields:

```typescript
interface DashboardData {
  inventoryAvailable: number;
  inventoryPrebooked: number;
  upcomingDeliveries: Array<{
    id: string;
    delivery_number: string;
    scheduled_date: string;
    status: string;
    customer: { farm_name: string } | null;
    driver: { full_name: string } | null;
  }>;
  recentActivity: Array<{
    id: string;
    event_type: string;
    description: string;
    created_at: string;
  }>;
  lowStockCount: number;
  driverIssuesCount: number;
  expiredHoldsCount: number;
  cancelledPostedCount: number;
}
```

**Step 2: Update the initial state**

Remove financial initial values. Keep only operational:

```typescript
const [data, setData] = useState<DashboardData>({
  inventoryAvailable: 0,
  inventoryPrebooked: 0,
  upcomingDeliveries: [],
  recentActivity: [],
  lowStockCount: 0,
  driverIssuesCount: 0,
  expiredHoldsCount: 0,
  cancelledPostedCount: 0,
});
```

**Step 3: Update fetchDashboard — RPC mapping**

Remove all financial field mappings from the RPC response. The `DashboardRpc` interface inside `fetchDashboard` should only have operational fields:

```typescript
interface DashboardRpc {
  inventory_available: number;
  inventory_prebooked: number;
  upcoming_deliveries: Array<{ id: string; delivery_number: string; scheduled_date: string; status: string; customer: string | { farm_name: string } | null; driver: string | { full_name: string } | null }>;
  recent_activity: Array<{ id: string; event_type: string; description: string; created_at: string }>;
  low_stock_count: number;
  driver_issues_count: number;
  expired_holds_count: number;
  cancelled_posted_count: number;
}
```

Update `setData` to only map operational fields.

**Step 4: Remove financial JSX sections**

Remove from the JSX:
1. The **Total Revenue** card (lines 212-221)
2. The **Total Profit** card (lines 223-232)
3. The **Quote Pipeline** card (lines 234-253)
4. The **Outstanding A/R alert** (lines 365-376)
5. The **Over Credit Limit alert** (lines 389-400)
6. The **Monthly Revenue & Profit chart** (lines 428-537)
7. The **Top Customers** section (lines 539-581)

Keep: Inventory card, Upcoming Deliveries, Recent Activity, Low Stock alert, Driver Issues alert, Stale Holds alert, Cancelled+Posted alert, Quick Actions.

**Step 5: Adjust the top row layout**

The top row previously had 4 cards. Now it only has Inventory. Change the grid to accommodate a single card more prominently:

```tsx
{!isDriver && (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <Card>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
          <Warehouse className="w-5 h-5 text-amber-600" />
        </div>
        <span className="text-sm text-secondary">Inventory</span>
      </div>
      <p className="text-2xl font-semibold font-heading text-nav-dark">
        {(data.inventoryAvailable + data.inventoryPrebooked).toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
      </p>
      <div className="flex gap-3 mt-1">
        <span className="text-xs text-crx-green">{data.inventoryAvailable.toLocaleString()} available</span>
        <span className="text-xs text-amber-600">{data.inventoryPrebooked.toLocaleString()} pre-booked</span>
      </div>
    </Card>
  </div>
)}
```

**Step 6: Remove unused imports**

Remove: `DollarSign`, `TrendingUp`, `Users` (if not used by Quick Actions — check), `BarChart3`. Keep imports used by remaining widgets.

**Step 7: Run typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors.

**Step 8: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "refactor: strip financial widgets from Dashboard (ops-only)"
```

---

## Task 4: Create `FinancialDashboard.tsx`

**Files:**
- Create: `src/pages/FinancialDashboard.tsx`

**Step 1: Create the component**

Build the full Financial Dashboard page with:
- Top row: Revenue, Profit+Margin, Quote Pipeline, AR Balance (4 cards — moved from Dashboard)
- Second row: AR Aging Buckets, Prepay Balance, Commission Owed, Month-End Status (4 NEW summary cards)
- Third section: Monthly Revenue & Profit chart (moved from Dashboard)
- Fourth section: Top Customers (moved from Dashboard)
- Fifth section: Financial alerts (Outstanding AR, Over Credit Limit)
- Sixth section: Quick Access Links grid (9 cards to financial pages)

Follow the exact same component patterns as Dashboard.tsx:
- `useCallback` for fetch
- `useEffect` on mount
- `SkeletonCard` loading state
- `useToast` for errors
- `useNavigate` for links
- `fmt()` for currency formatting

The component calls `supabase.rpc('financial_dashboard_summary')` and maps the response.

**Step 2: Run typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors.

**Step 3: Commit**

```bash
git add src/pages/FinancialDashboard.tsx
git commit -m "feat: add FinancialDashboard page (financial command center)"
```

---

## Task 5: Wire up routing and navigation

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`

**Step 1: Add lazy import in App.tsx**

Add after the existing lazy imports (around line 58):

```typescript
const FinancialDashboard = lazy(() => import('./pages/FinancialDashboard'));
```

**Step 2: Add route in App.tsx**

Add in the children array (around line 156, near the other admin-only routes):

```typescript
{ path: 'financial-dashboard', element: <ProtectedRoute allowedRoles={['admin']}><FinancialDashboard /></ProtectedRoute> },
```

**Step 3: Add sidebar entry in Sidebar.tsx**

Add as the FIRST item in the `finance` category's `items` array (line 152, before AR Aging):

```typescript
{ path: '/financial-dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" />, roles: ['admin'] },
```

Also add `LayoutDashboard` to the lucide-react import at the top of Sidebar.tsx.

**Step 4: Run typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors.

**Step 5: Commit**

```bash
git add src/App.tsx src/components/layout/Sidebar.tsx
git commit -m "feat: wire FinancialDashboard route + sidebar nav entry"
```

---

## Task 6: Update Dashboard E2E test

**Files:**
- Modify: `tests/e2e/dashboard.spec.ts`

**Step 1: Update assertions**

The existing test checks for dashboard summary cards. Update to verify:
- Financial widgets are NOT present (no "Total Revenue", "Total Profit" text)
- Operational widgets ARE present (Inventory, Upcoming Deliveries, Recent Activity)

```typescript
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Dashboard (Operations)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('should display operational dashboard without financial data', async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText(/Dashboard/i);
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });

    // Financial widgets should NOT be present
    await expect(page.getByText('Total Revenue')).not.toBeVisible();
    await expect(page.getByText('Total Profit')).not.toBeVisible();
    await expect(page.getByText('Quote Pipeline')).not.toBeVisible();
    await expect(page.getByText('Monthly Revenue & Profit')).not.toBeVisible({ timeout: 3000 }).catch(() => {});

    // Operational widgets should be present
    await expect(page.getByText('Inventory')).toBeVisible({ timeout: 5000 });
  });

  test('should show upcoming deliveries section', async ({ page }) => {
    const deliveries = page.getByText('Upcoming').first();
    await expect(deliveries).toBeVisible({ timeout: 5000 });
  });

  test('should show recent activity feed', async ({ page }) => {
    const activity = page.locator('text=Recent Activity, text=Recent Orders, text=Activity').first();
    if (await activity.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(activity).toBeVisible();
    }
  });

  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    const criticalErrors = errors.filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
```

**Step 2: Commit**

```bash
git add tests/e2e/dashboard.spec.ts
git commit -m "test: update dashboard E2E for operations-only view"
```

---

## Task 7: Add Financial Dashboard E2E test

**Files:**
- Create: `tests/e2e/financial-dashboard.spec.ts`

**Step 1: Write the E2E spec**

```typescript
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Financial Dashboard', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/financial-dashboard');
    await page.waitForTimeout(2000);
  });

  test('should load with financial KPI cards', async ({ page }) => {
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });

    // Financial KPI cards should be visible
    await expect(page.getByText('Total Revenue')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Total Profit')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Quote Pipeline')).toBeVisible({ timeout: 5000 });
  });

  test('should show AR aging summary', async ({ page }) => {
    await expect(page.getByText(/AR Aging|Aging/i)).toBeVisible({ timeout: 5000 });
  });

  test('should show financial summary cards', async ({ page }) => {
    // New summary cards
    const summaryTexts = ['Prepay', 'Commission', 'Period'];
    for (const text of summaryTexts) {
      const el = page.getByText(new RegExp(text, 'i')).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(el).toBeVisible();
      }
    }
  });

  test('should show quick access links to financial pages', async ({ page }) => {
    // Quick access grid should link to financial sub-pages
    const links = ['AR Aging', 'Prepayments', 'Month-End', 'Reports', 'Compliance'];
    for (const label of links) {
      const link = page.getByText(label).first();
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(link).toBeVisible();
      }
    }
  });

  test('should show monthly revenue chart when data exists', async ({ page }) => {
    // Chart or "Monthly Revenue & Profit" header
    const chart = page.getByText(/Monthly.*Revenue/i).first();
    if (await chart.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(chart).toBeVisible();
    }
  });

  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/financial-dashboard');
    await page.waitForTimeout(3000);

    const criticalErrors = errors.filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
```

**Step 2: Commit**

```bash
git add tests/e2e/financial-dashboard.spec.ts
git commit -m "test: add E2E spec for Financial Dashboard page"
```

---

## Task 8: Visual verification + final commit

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Verify Operations Dashboard (`/`)**

Navigate to `/`. Verify:
- NO financial cards (Revenue, Profit, Quote Pipeline) visible
- Inventory card shows
- Upcoming Deliveries list shows
- Recent Activity shows
- Alerts row shows (if any alerts exist)
- Quick Actions shows
- No console errors

**Step 3: Verify Financial Dashboard (`/financial-dashboard`)**

Navigate to `/financial-dashboard`. Verify:
- Revenue, Profit, Quote Pipeline, AR Balance cards visible
- AR Aging buckets card shows
- Prepay Balance card shows
- Commission Owed card shows
- Month-End Status card shows
- Monthly chart renders
- Top Customers shows
- Quick Access links grid shows all 9 pages
- No console errors

**Step 4: Verify sidebar**

- Finance section shows "Dashboard" as first item
- Clicking it navigates to `/financial-dashboard`

**Step 5: Run full test suite**

Run: `npx vitest run && npx playwright test`
Expected: All tests pass.

**Step 6: Commit any visual tweaks**

If any layout adjustments were needed, commit them.

---

## Task 9: Update reference docs

**Files:**
- Modify: `docs/reference/pages-routes.md` — add `/financial-dashboard` entry
- Modify: `docs/reference/rpc-functions.md` — add `financial_dashboard_summary()` entry, update `dashboard_summary()` description
- Modify: `docs/reference/migration-history.md` — add new migration entries

**Step 1: Update each doc file**

Add the new page, new RPC, and migration entries to match the changes made.

**Step 2: Commit**

```bash
git add docs/reference/
git commit -m "docs: update reference docs for dashboard split"
```

---

## Summary

| Task | What | Files | Estimated |
|------|------|-------|-----------|
| 1 | New `financial_dashboard_summary()` RPC | 1 migration | 5 min |
| 2 | Slim `dashboard_summary()` to ops-only | 1 migration | 3 min |
| 3 | Refactor `Dashboard.tsx` (remove financial) | 1 file | 10 min |
| 4 | Create `FinancialDashboard.tsx` | 1 new file | 15 min |
| 5 | Wire routing + sidebar | 2 files | 3 min |
| 6 | Update Dashboard E2E | 1 file | 3 min |
| 7 | New Financial Dashboard E2E | 1 new file | 3 min |
| 8 | Visual verification | — | 5 min |
| 9 | Update reference docs | 3 files | 3 min |
| **Total** | | **~11 files** | **~50 min** |
