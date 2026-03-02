# Deep Audit: Dashboard Split — CRX Manager V1.0

## CRITICAL INSTRUCTION — READ-ONLY AUDIT, NO CODE CHANGES

**DO NOT write, edit, or modify any files. DO NOT create branches, commits, or PRs. DO NOT run any commands that change state.**

Your job is REVIEW ONLY. Produce a detailed findings report and a proposed fix plan. The developer will hand this plan to a separate AI agent (Claude) for verification before any changes are made.

Your output should be:
1. **Findings report** — every issue found, with severity, file, line numbers, and evidence
2. **Proposed fix plan** — for each finding, the exact code/SQL change you WOULD make (as a diff or code block), but DO NOT apply it
3. **Execution order** — what order the fixes should be applied in, noting any dependencies between fixes
4. **Risk assessment** — which fixes are safe/isolated vs which could have cascading effects

---

You are performing a thorough code audit of a recent dashboard split in CRX Manager V1.0, an agricultural input dealership ERP built with React 18 + TypeScript + Vite + Tailwind CSS + Supabase (Postgres).

The original single Dashboard page was split into:
1. **Operations Dashboard** (`/`) — inventory, deliveries, activity, alerts → all non-driver users
2. **Financial Dashboard** (`/financial-dashboard`) — revenue, AR, commissions, prepay, aging → admin only

This involved 4 new SQL migrations, 2 RPCs, 2 page components, route/sidebar changes, and E2E tests. Your job is to find every bug, edge case, inconsistency, convention violation, security gap, and performance issue.

---

## PROJECT RULES (violations of these are Critical severity)

- All money is stored as **bigint cents** in the database. Display code divides by 100. NEVER use floating point for money.
- The business **season runs October 1 to September 30** (not calendar year). All YTD logic must use this.
- **AR is derived from invoices**, not orders. `orders.total_paid` and `orders.balance_due` are DEPRECATED.
- Migrations are **append-only** — never modify existing migration files, only add new ones.
- Every table has **RLS policies**. RPCs use `SECURITY DEFINER` to bypass RLS for aggregation.
- React 18 **StrictMode** is enabled (double-mount in dev).
- `checkMutationResult()` must be called after every `.update()` or `.delete()`.
- Supabase client imported from `src/lib/db` only — never create inline clients.
- Icons from `lucide-react` only, CSS from Tailwind only.
- No `@ts-ignore` or `any` types.
- Error handling with try/catch + toast notifications.

---

## SOURCE CODE — ALL FILES TO AUDIT

### FILE 1: `src/pages/Dashboard.tsx` (Operations Dashboard)

```tsx
import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Warehouse,
  Truck,
  Users,
  Plus,
  ChevronRight,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { SkeletonCard } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { runPeriodicNotificationChecks } from '../lib/notificationTriggers';

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
  // Phase 3.6: Integrity alert counts
  driverIssuesCount: number;
  expiredHoldsCount: number;
  cancelledPostedCount: number;
}

export default function Dashboard() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
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

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await supabase.rpc('dashboard_summary');
      if (error) throw error;

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
      const d = rpc as DashboardRpc;

      setData({
        inventoryAvailable: Number(d.inventory_available) || 0,
        inventoryPrebooked: Number(d.inventory_prebooked) || 0,
        upcomingDeliveries: (d.upcoming_deliveries || []).map((del) => ({
          id: del.id,
          delivery_number: del.delivery_number,
          scheduled_date: del.scheduled_date,
          status: del.status,
          customer: typeof del.customer === 'string' ? { farm_name: del.customer } : del.customer || null,
          driver: typeof del.driver === 'string' ? { full_name: del.driver } : del.driver || null,
        })),
        recentActivity: (d.recent_activity || []).map((act) => ({
          id: act.id,
          event_type: act.event_type,
          description: act.description,
          created_at: act.created_at,
        })),
        lowStockCount: Number(d.low_stock_count) || 0,
        driverIssuesCount: Number(d.driver_issues_count) || 0,
        expiredHoldsCount: Number(d.expired_holds_count) || 0,
        cancelledPostedCount: Number(d.cancelled_posted_count) || 0,
      });
    } catch (err) {
      console.error('Dashboard load error:', err);
      toast('error', 'Failed to load dashboard data. Please refresh.');
    }
    setLoading(false);

    // GAP FIX #17: Run automated notification checks (low stock, expiring quotes)
    runPeriodicNotificationChecks();

    // T4: Check for delivery remainders pending 7+ / 14+ days
    try {
      const { error: reminderErr } = await supabase.rpc('check_remainder_reminders');
      if (reminderErr) throw reminderErr;
    } catch (err) {
      console.error('Remainder reminders check failed:', err);
      supabase.rpc('log_failed_notification', {
        p_notification_type: 'remainder_reminders',
        p_error_message: err instanceof Error ? err.message : String(err),
      });
    }

    // A2.7: Clean up holds from expired quotes
    try {
      const { error: holdsErr } = await supabase.rpc('release_expired_quote_holds');
      if (holdsErr) throw holdsErr;
    } catch (err) {
      console.error('Release expired holds failed:', err);
      supabase.rpc('log_failed_notification', {
        p_notification_type: 'release_expired_holds',
        p_error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [toast]);

  useEffect(() => {
    fetchDashboard();
  }, [role, fetchDashboard]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  const isAdmin = role === 'admin';
  const isDriver = role === 'driver';

  return (
    <div className="space-y-6">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2" padding={false}>
          <div className="p-5">
            <CardHeader
              title="Upcoming"
              accent="Deliveries"
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/deliveries')}>
                  View All
                </Button>
              }
            />
          </div>
          {data.upcomingDeliveries.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No upcoming deliveries scheduled</p>
            </div>
          ) : (
            <div className="px-5 pb-5 space-y-2">
              {data.upcomingDeliveries.map((del) => (
                <div
                  key={del.id}
                  onClick={() => navigate(`/deliveries/${del.id}`)}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-crx-green-tint cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
                      <Truck className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-nav-dark">
                        {del.customer?.farm_name || 'Unknown'}
                      </p>
                      <p className="text-xs text-secondary">
                        {del.delivery_number} &middot; {del.driver?.full_name || 'Unassigned'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-secondary">{del.scheduled_date}</span>
                    <Badge variant={statusToBadgeVariant[del.status] || 'default'}>
                      {del.status.replace('_', ' ')}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Recent" accent="Activity" />
          </div>
          {data.recentActivity.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No recent activity</p>
            </div>
          ) : (
            <div className="px-5 pb-5 space-y-3">
              {data.recentActivity.map((act) => (
                <div key={act.id} className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-crx-green mt-2 shrink-0" />
                  <div>
                    <p className="text-sm text-nav-dark">{act.description}</p>
                    <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {new Date(act.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Operational alerts row */}
      {!isDriver && (data.lowStockCount > 0 || data.driverIssuesCount > 0 || data.expiredHoldsCount > 0 || data.cancelledPostedCount > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.lowStockCount > 0 && (
            <div
              onClick={() => navigate('/inventory')}
              className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-amber-100 transition-colors"
            >
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-800">Low Stock Alert</p>
                <p className="text-xs text-amber-600">{data.lowStockCount} item(s) below reorder point</p>
              </div>
            </div>
          )}
          {data.driverIssuesCount > 0 && (
            <div
              onClick={() => navigate('/deliveries')}
              className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-orange-100 transition-colors"
            >
              <Truck className="w-5 h-5 text-orange-600" />
              <div>
                <p className="text-sm font-semibold text-orange-800">Driver Issues</p>
                <p className="text-xs text-orange-600">{data.driverIssuesCount} delivery(ies) with unresolved issues</p>
              </div>
            </div>
          )}
          {data.expiredHoldsCount > 0 && (
            <div
              onClick={() => navigate('/quotes')}
              className="bg-purple-50 border border-purple-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-purple-100 transition-colors"
            >
              <Warehouse className="w-5 h-5 text-purple-600" />
              <div>
                <p className="text-sm font-semibold text-purple-800">Stale Inventory Holds</p>
                <p className="text-xs text-purple-600">{data.expiredHoldsCount} expired quote(s) with active holds</p>
              </div>
            </div>
          )}
          {data.cancelledPostedCount > 0 && (
            <div
              onClick={() => navigate('/invoices')}
              className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-red-100 transition-colors"
            >
              <FileText className="w-5 h-5 text-red-600" />
              <div>
                <p className="text-sm font-semibold text-red-800">Cancelled + Posted</p>
                <p className="text-xs text-red-600">{data.cancelledPostedCount} cancelled delivery(ies) with posted invoices</p>
              </div>
            </div>
          )}
        </div>
      )}

      {(isAdmin || role === 'sales_rep') && (
        <Card>
          <CardHeader title="Quick" accent="Actions" />
          <div className="flex flex-wrap gap-3">
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
              New Quote
            </Button>
            <Button variant="secondary" icon={<Users className="w-4 h-4" />} showChevron={false} onClick={() => navigate('/customers')}>
              Customers
            </Button>
            {isAdmin && (
              <>
                <Button variant="secondary" icon={<Truck className="w-4 h-4" />} showChevron={false} onClick={() => navigate('/deliveries')}>
                  Deliveries
                </Button>
                <Button variant="secondary" icon={<ChevronRight className="w-4 h-4" />} showChevron={false} onClick={() => navigate('/products')}>
                  Update Costs
                </Button>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
```

### FILE 2: `src/pages/FinancialDashboard.tsx` (Financial Dashboard)

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DollarSign,
  TrendingUp,
  FileText,
  AlertTriangle,
  Clock,
  Wallet,
  CreditCard,
  BarChart3,
  Receipt,
  ShieldCheck,
  ArrowLeftRight,
  CalendarCheck,
  ChevronRight,
  Banknote,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { SkeletonCard } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';

// --- Types ---

interface MonthlyData {
  month: string;
  revenue: number;
  profit: number;
}

interface TopCustomer {
  farm_name: string;
  total: number;
}

interface QuoteCounts {
  draft: number;
  sent: number;
  accepted: number;
}

interface ArAgingBuckets {
  current: number;
  days_31_60: number;
  days_61_90: number;
  days_90_plus: number;
}

interface CurrentPeriod {
  name: string;
  status: string;
  days_remaining: number;
}

interface FinancialRpc {
  total_revenue: number;
  total_profit: number;
  overall_margin: number;
  quote_counts: QuoteCounts;
  quote_pipeline_value: number;
  monthly_revenue: MonthlyData[];
  top_customers: TopCustomer[];
  open_ar_balance: number;
  customers_over_credit_count: number;
  ar_aging_buckets: ArAgingBuckets;
  total_prepay_unallocated: number;
  total_commission_owed: number;
  current_period: CurrentPeriod;
}

interface FinancialData {
  totalRevenue: number;
  totalProfit: number;
  overallMargin: number;
  quoteCounts: QuoteCounts;
  quotePipelineValue: number;
  monthlyRevenue: MonthlyData[];
  topCustomers: TopCustomer[];
  openArBalance: number;
  customersOverCreditCount: number;
  arAgingBuckets: ArAgingBuckets;
  totalPrepayUnallocated: number;
  totalCommissionOwed: number;
  currentPeriod: CurrentPeriod;
}

// --- Currency formatter ---

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);

const fmtDecimal = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

// --- Quick Access Links ---

interface QuickLink {
  label: string;
  path: string;
  icon: React.ReactNode;
}

const quickLinks: QuickLink[] = [
  { label: 'AR Aging', path: '/ar-aging', icon: <BarChart3 className="w-5 h-5" /> },
  { label: 'Prepayments', path: '/prepayments', icon: <Banknote className="w-5 h-5" /> },
  { label: 'Prepay Workspace', path: '/prepay-workspace', icon: <Wallet className="w-5 h-5" /> },
  { label: 'Commission Pay', path: '/commission-payments', icon: <CreditCard className="w-5 h-5" /> },
  { label: 'Transactions', path: '/customer-transactions', icon: <ArrowLeftRight className="w-5 h-5" /> },
  { label: 'Month-End', path: '/month-end', icon: <CalendarCheck className="w-5 h-5" /> },
  { label: 'Rebates', path: '/rebates', icon: <Receipt className="w-5 h-5" /> },
  { label: 'Reports', path: '/reports', icon: <FileText className="w-5 h-5" /> },
  { label: 'Compliance', path: '/compliance', icon: <ShieldCheck className="w-5 h-5" /> },
];

// --- Default data ---

const defaultData: FinancialData = {
  totalRevenue: 0,
  totalProfit: 0,
  overallMargin: 0,
  quoteCounts: { draft: 0, sent: 0, accepted: 0 },
  quotePipelineValue: 0,
  monthlyRevenue: [],
  topCustomers: [],
  openArBalance: 0,
  customersOverCreditCount: 0,
  arAgingBuckets: { current: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
  totalPrepayUnallocated: 0,
  totalCommissionOwed: 0,
  currentPeriod: { name: '', status: 'open', days_remaining: 0 },
};

// --- Component ---

export default function FinancialDashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FinancialData>(defaultData);

  const fetchFinancials = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await supabase.rpc('financial_dashboard_summary');
      if (error) throw error;

      const d = rpc as FinancialRpc;

      setData({
        totalRevenue: Number(d.total_revenue) || 0,
        totalProfit: Number(d.total_profit) || 0,
        overallMargin: Number(d.overall_margin) || 0,
        quoteCounts: d.quote_counts || { draft: 0, sent: 0, accepted: 0 },
        quotePipelineValue: Number(d.quote_pipeline_value) || 0,
        monthlyRevenue: (d.monthly_revenue || []).map((m) => ({
          month: m.month,
          revenue: Number(m.revenue) || 0,
          profit: Number(m.profit) || 0,
        })),
        topCustomers: (d.top_customers || []).map((c) => ({
          farm_name: c.farm_name,
          total: Number(c.total) || 0,
        })),
        openArBalance: Number(d.open_ar_balance) || 0,
        customersOverCreditCount: Number(d.customers_over_credit_count) || 0,
        arAgingBuckets: d.ar_aging_buckets || { current: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
        totalPrepayUnallocated: Number(d.total_prepay_unallocated) || 0,
        totalCommissionOwed: Number(d.total_commission_owed) || 0,
        currentPeriod: d.current_period || { name: '', status: 'open', days_remaining: 0 },
      });
    } catch (err) {
      console.error('Financial dashboard load error:', err);
      toast('error', 'Failed to load financial dashboard. Please refresh.');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchFinancials();
  }, [fetchFinancials]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  // Monthly chart calculations
  const maxRevenue = Math.max(...data.monthlyRevenue.map((m) => m.revenue), 1);
  const totalMonthlyRevenue = data.monthlyRevenue.reduce((sum, m) => sum + m.revenue, 0);
  const totalMonthlyProfit = data.monthlyRevenue.reduce((sum, m) => sum + m.profit, 0);
  const avgMonthlyRevenue = data.monthlyRevenue.length > 0 ? totalMonthlyRevenue / data.monthlyRevenue.length : 0;

  // AR Aging bar calculations
  const agingBuckets = [
    { label: 'Current', value: data.arAgingBuckets.current, color: 'bg-emerald-500' },
    { label: '31-60', value: data.arAgingBuckets.days_31_60, color: 'bg-amber-500' },
    { label: '61-90', value: data.arAgingBuckets.days_61_90, color: 'bg-orange-500' },
    { label: '90+', value: data.arAgingBuckets.days_90_plus, color: 'bg-red-500' },
  ];
  const maxAgingBucket = Math.max(...agingBuckets.map((b) => b.value), 1);

  // Top customer max for progress bars
  const maxCustomerTotal = data.topCustomers.length > 0 ? data.topCustomers[0].total : 1;

  return (
    <div className="space-y-6">
      {/* ... (full JSX as shown above — all 6 sections) */}
    </div>
  );
}
```

### FILE 3: `supabase/migrations/20260211270000_dashboard_summary_rpc.sql` (Original — Migration 1)

```sql
-- Original dashboard_summary() — mixed ops + financial.
-- Returns: total_revenue, total_profit, overall_margin, quote_counts, quote_pipeline_value,
-- inventory_available, inventory_prebooked, low_stock_count, open_ar_balance,
-- monthly_revenue, top_customers, upcoming_deliveries, recent_activity
-- 13 CTEs, SECURITY DEFINER, GRANT TO authenticated
-- NOTE: This is superseded by migrations 3 and 4 below (CREATE OR REPLACE).
```

### FILE 4: `supabase/migrations/20260301300000_financial_dashboard_summary.sql` (Migration 2)

```sql
-- financial_dashboard_summary() — pure financial RPC
-- Returns: total_revenue, total_profit, overall_margin, quote_counts, quote_pipeline_value,
-- monthly_revenue, top_customers, open_ar_balance, customers_over_credit_count,
-- ar_aging_buckets, total_prepay_unallocated, total_commission_owed, current_period
-- 10 CTEs + CROSS JOINs + LEFT JOIN period_info
-- SECURITY DEFINER, GRANT TO authenticated

-- KEY CONCERN: AR balance CTE uses orders.balance_due (deprecated).
-- Should use invoices.balance_cents instead.

-- Over-credit CTE also uses orders.balance_due * 100 to compare against credit_limit_cents.
-- Same concern — should this use invoices?
```

### FILE 5: `supabase/migrations/20260301300001_slim_dashboard_summary.sql` (Migration 3)

```sql
-- Slimmed dashboard_summary() — ops only
-- Returns: inventory_available, inventory_prebooked, low_stock_count,
-- upcoming_deliveries, recent_activity, driver_issues_count,
-- expired_holds_count, cancelled_posted_count
-- 7 CTEs, SECURITY DEFINER, GRANT TO authenticated
-- NOTE: This is immediately superseded by Migration 4.
```

### FILE 6: `supabase/migrations/20260303200000_dashboard_integrity_alerts.sql` (Migration 4)

```sql
-- RESTORES financial fields to dashboard_summary() + adds 4 integrity alert counts.
-- Returns ALL original fields PLUS: driver_issues_count, customers_over_credit_count,
-- expired_holds_count, cancelled_posted_count
-- 13 CTEs, SECURITY DEFINER, GRANT TO authenticated

-- Also adds: check_customer_credit_limit(uuid) helper RPC
-- Same AR concern: uses orders.balance_due (deprecated)
```

### FILE 7: Route config in `src/App.tsx`

```tsx
const FinancialDashboard = lazy(() => import('./pages/FinancialDashboard'));

// In routes:
{ path: 'financial-dashboard', element: <ProtectedRoute allowedRoles={['admin']}><FinancialDashboard /></ProtectedRoute> },
```

### FILE 8: Sidebar config in `src/components/layout/Sidebar.tsx`

```tsx
// Under Finance category:
{ path: '/financial-dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" />, roles: ['admin'] },
```

### FILE 9: `tests/e2e/dashboard.spec.ts`

```ts
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
    await expect(page.getByText('Total Revenue')).not.toBeVisible();
    await expect(page.getByText('Total Profit')).not.toBeVisible();
    await expect(page.getByText('Quote Pipeline')).not.toBeVisible();
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

### FILE 10: `tests/e2e/financial-dashboard.spec.ts`

```ts
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
    await expect(page.getByText('Total Revenue')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Total Profit')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Quote Pipeline')).toBeVisible({ timeout: 5000 });
  });

  test('should show AR aging summary', async ({ page }) => {
    await expect(page.getByText(/AR Aging|Aging/i)).toBeVisible({ timeout: 5000 });
  });

  test('should show financial summary cards', async ({ page }) => {
    const summaryTexts = ['Prepay', 'Commission', 'Period'];
    for (const text of summaryTexts) {
      const el = page.getByText(new RegExp(text, 'i')).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(el).toBeVisible();
      }
    }
  });

  test('should show quick access links to financial pages', async ({ page }) => {
    const links = ['AR Aging', 'Prepayments', 'Month-End', 'Reports', 'Compliance'];
    for (const label of links) {
      const link = page.getByText(label).first();
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(link).toBeVisible();
      }
    }
  });

  test('should show monthly revenue chart when data exists', async ({ page }) => {
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

---

## AUDIT CHECKLIST — Check every single one

### Category 1: CRITICAL — Migration Consistency & Data Integrity

1. **Migration supersession chain:** Migration 3 slimmed `dashboard_summary()` to ops-only. Migration 4 restored ALL financial fields + added integrity alerts. This means migration 3 is dead code — its version is immediately overwritten. Is this correct and intentional, or did we accidentally undo the dashboard split at the DB level?

2. **The big one — AR from deprecated source:** Both `financial_dashboard_summary()` and `dashboard_summary()` (migration 4) compute `open_ar_balance` from `orders.balance_due`. But per project rules, **AR is derived from invoices, not orders**. `orders.balance_due` is DEPRECATED. Check whether this is returning stale/wrong data. The correct source should be `invoices.balance_cents` where `status = 'posted'`.

3. **Over-credit check uses deprecated field:** The `over_credit` CTE in both RPCs uses `SUM(orders.balance_due) * 100 > credit_limit_cents`. Same deprecation issue. Should this use invoices instead?

4. **Money type inconsistency:** The `financial_dashboard_summary()` RPC returns `total_revenue` and `total_profit` from `orders.total_price` and `orders.total_profit`. Are these stored as bigint cents or dollars? If cents, the frontend needs to divide by 100. If dollars, the `fmt()` formatter is correct as-is. Verify consistency.

5. **AR aging uses invoices correctly** (CTE 7 in financial_dashboard_summary): It reads `invoices.balance_cents / 100.0`. But the open AR balance (CTE 5) reads `orders.balance_due`. These two numbers will disagree. Is this a bug?

6. **Commission CTE:** Filters on `status = 'earned' AND paid_date IS NULL`. Verify the `commissions` table actually has these columns with these exact names and semantics.

7. **Period info CTE:** Uses `LEFT JOIN period_info ON true`. If no open period exists, `pi.name`, `pi.status`, `pi.days_remaining` will be NULL. The COALESCE in the jsonb_build_object handles this, but double-check the fallback values are sensible.

### Category 2: HIGH — Frontend ↔ RPC Contract Mismatch

8. **Dashboard.tsx consumes only 8 fields** from `dashboard_summary()`, but migration 4's version returns 16+ fields (including all financial ones: total_revenue, total_profit, monthly_revenue, etc.). This means the Operations Dashboard frontend is ignoring financial data that the RPC still sends. Is this wasted bandwidth, or is the intent for `dashboard_summary()` to stay slim (migration 3)?

9. **The DashboardRpc interface** (declared inside `fetchDashboard`) only lists 8 fields. But the actual RPC returns 16+. TypeScript won't catch extra fields — this is safe but means the interface is stale/misleading.

10. **FinancialRpc interface fields:** Does the `FinancialRpc` interface match exactly what `financial_dashboard_summary()` returns? Check every field name character-by-character (e.g., `quote_counts` vs `quote_count`, `days_31_60` vs `days_31_to_60`).

11. **Nested objects from RPC:** The `quote_counts`, `ar_aging_buckets`, and `current_period` are JSONB objects. When Supabase returns them, are they already parsed objects or JSON strings? The code does `d.quote_counts || { draft: 0, ... }` — will this work if `quote_counts` comes back as a string?

12. **Number coercion:** Dashboard.tsx uses `Number(d.inventory_available) || 0`. FinancialDashboard.tsx uses the same pattern for all numeric fields. But Supabase bigint returns as string. Verify `Number()` correctly handles large bigint strings without precision loss. (JavaScript's `Number` is safe up to 2^53, which is ~$90 trillion in cents — probably fine, but confirm.)

### Category 3: HIGH — Security & Access Control

13. **No server-side role check on `financial_dashboard_summary()`:** The RPC has `SECURITY DEFINER` + `GRANT TO authenticated`. Any authenticated user (including drivers and sales reps) can call this RPC directly via the Supabase client, bypassing the frontend `ProtectedRoute`. Assess whether this is a real security risk (leaking financial data to non-admin users).

14. **`dashboard_summary()` returns financial data to all users:** Since migration 4 restored all financial fields, any authenticated user calling `dashboard_summary()` gets total_revenue, total_profit, quote pipeline, top customers, etc. The frontend ignores these fields, but they're in the response payload. Is this acceptable, or should migration 3's slimmed version be the final state?

15. **`check_customer_credit_limit()` has no role restriction:** Any authenticated user can call it for any customer. Is this intentional? Sales reps seeing credit info may be fine, but drivers probably shouldn't.

### Category 4: MEDIUM — React Lifecycle & State

16. **React StrictMode double-mount:** `fetchDashboard()` runs in `useEffect` on mount. In StrictMode, this fires twice. This means:
    - `dashboard_summary()` RPC called twice
    - `runPeriodicNotificationChecks()` runs twice
    - `check_remainder_reminders()` runs twice
    - `release_expired_quote_holds()` runs twice
    Are any of these non-idempotent? Could double-running `release_expired_quote_holds()` cause issues?

17. **No abort controller / cleanup:** If the user navigates away from the dashboard before `fetchDashboard` completes, `setData()` and `setLoading(false)` will be called on an unmounted component. This causes a React warning and potential memory leak. Should use `AbortController` or an `isMounted` ref.

18. **`role` in useEffect dependency array:** `useEffect(() => { fetchDashboard(); }, [role, fetchDashboard])`. If `role` changes (e.g., user context updates), the dashboard re-fetches. Is this intentional? `fetchDashboard` is memoized with `useCallback([toast])`, so it only changes if `toast` changes. Is that correct — should `role` be in the deps?

19. **Background tasks run AFTER `setLoading(false)`:** The notification checks and hold releases happen after `setLoading(false)`. This means the UI appears loaded, but mutations are still happening in the background. Is this intentional? If one fails, should the user see an error?

20. **`log_failed_notification` calls are fire-and-forget:** The `.rpc('log_failed_notification', ...)` calls inside catch blocks are not awaited and have no error handling. If logging fails, it silently fails. Is this acceptable?

### Category 5: MEDIUM — E2E Test Gaps

21. **No test for non-admin accessing `/financial-dashboard`:** The E2E tests always `login(page)` which logs in as admin. There's no test verifying that a sales_rep or driver user gets redirected away from `/financial-dashboard`.

22. **Soft assertions everywhere:** Many financial dashboard tests use `if (await el.isVisible(...).catch(() => false))` — if the element doesn't appear, the test silently passes. This means a broken page could still pass all tests. These should be hard assertions.

23. **No test for integrity alert cards:** Dashboard E2E tests don't verify the alert cards (Low Stock, Driver Issues, Stale Holds, Cancelled+Posted). These are conditional and hard to test without data, but at minimum there should be a test that the alert section doesn't appear when counts are 0.

24. **No test for RPC failure state:** Neither test suite verifies what happens when the RPC call fails (network error, timeout). The UI should show a toast error — this should be tested.

25. **No test for empty state:** What does the Financial Dashboard look like with zero data? Are the charts, customer lists, and aging buckets handled gracefully?

26. **Dashboard E2E uses `page.locator('h1')` to find the title**, but `Dashboard.tsx` doesn't render an `<h1>`. The page header is only on `FinancialDashboard.tsx`. Will this test actually find anything?

### Category 6: LOW — UI/UX Issues

27. **Inconsistent currency formatting:** Dashboard.tsx doesn't display any currency values (it's ops-only). FinancialDashboard.tsx uses `fmt()` (no decimals) for revenue/profit/pipeline and `fmtDecimal()` (2 decimals) for AR aging, prepay, commission. Is this the right choice for each? AR balance in the KPI card uses `fmt()` (no decimals) but AR aging bars use `fmtDecimal()`.

28. **`del.status.replace('_', ' ')` only replaces the first underscore.** If a status has multiple underscores (e.g., `in_progress`), only the first is replaced. Should use `.replaceAll('_', ' ')` or a regex.

29. **`_profitHeight` is assigned but never used** in the monthly chart calculation (line 400 of FinancialDashboard.tsx). This is dead code — the profit bar height is calculated differently inline. Remove the unused variable or use it.

30. **Monthly chart tooltip shows revenue/profit** with `fmt()` (no decimals). For large values this is fine, but for small operations it might lose precision. Consistent with the summary below but worth verifying.

31. **Accessibility:** The alert cards, quick access grid, and delivery list items use `onClick` on `<div>` elements. These are not keyboard-accessible (no `role="button"`, no `tabIndex`, no `onKeyDown`). Consider using `<button>` elements instead.

32. **Skeleton count mismatch:** Dashboard.tsx shows 8 skeleton cards in a 4-column grid. But the actual loaded UI has different layout sections. Does the skeleton layout match the final layout?

### Category 7: LOW — Performance

33. **`dashboard_summary()` migration 4 computes 13 CTEs** including financial data that the frontend ignores. This is wasted DB compute. If the intent was ops-only (migration 3), migration 4 should be reverted to match.

34. **No indexes noted for RPC queries.** Check if `deliveries.status`, `invoices.status`, `invoices.balance_cents`, `quotes.status`, `inventory_holds.source_id + is_active`, `orders.customer_id + status`, `activity_feed.created_at` have appropriate indexes.

35. **`financial_dashboard_summary()` does 10+ CTEs in one call.** For a small dataset this is fine, but as data grows, some CTEs (especially monthly aggregation over orders, top customers) could slow down. Consider whether any CTEs need date filters (e.g., only current season's orders).

---

## EXPECTED OUTPUT FORMAT

**Remember: DO NOT make any changes. Report only.**

### Part 1: Findings Report

For each finding, provide:

```
### Finding [N]: [Title]
- **File:** [path]:[line(s)]
- **Severity:** Critical | High | Medium | Low
- **Category:** [from above]
- **Issue:** [what's wrong]
- **Evidence:** [relevant code snippet or SQL]
- **Proposed Fix:** [exact code/SQL diff you WOULD apply — but DO NOT apply it]
```

### Part 2: Summary Table

| # | Severity | File | Issue | Fix Complexity |
|---|----------|------|-------|----------------|

### Part 3: Scorecard

- Total findings: X
- Critical: X | High: X | Medium: X | Low: X
- Blocking issues (must fix before next deploy): X
- Recommended improvements: X

### Part 4: Proposed Execution Plan

List every fix in the order it should be applied:

```
Step 1: [Fix title] — [file to change] — [dependency notes]
Step 2: ...
```

Group into phases:
- **Phase A: Critical/blocking fixes** (must do before deploy)
- **Phase B: High-priority improvements** (should do soon)
- **Phase C: Medium/low cleanup** (nice to have)

For each step, note:
- What file(s) change
- Whether it requires a new migration (append-only — never edit existing)
- Whether it could break existing tests
- Whether it needs a build/test verification after

### Part 5: Risk Assessment

For each proposed fix, rate:
- **Safe** — isolated change, no cascading effects
- **Moderate** — touches shared code, needs testing
- **High risk** — affects data, RPC contracts, or multiple consumers

---

## IMPORTANT NOTES FOR CODEX

- **DO NOT WRITE CODE. DO NOT EDIT FILES. REPORT ONLY.**
- Read ALL the source code above carefully. Do not skim.
- The full SQL for all 4 migrations is provided inline. Read every CTE.
- When you flag an issue, include the exact line numbers and write out the fix as a diff/code block, but DO NOT apply it.
- Do NOT suggest adding features or refactoring for style. Only flag actual bugs, data integrity issues, security gaps, convention violations, and meaningful test gaps.
- If you find that migration 3 is dead code because migration 4 overwrites it, say so explicitly and recommend whether to keep migration 4's version or revert to migration 3's ops-only version.
- Pay special attention to the AR deprecation issue — this could be returning WRONG financial data in production.
- Your output will be reviewed by Claude (a separate AI) before any changes are made. Be precise enough that Claude can verify each finding independently.
