import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DollarSign,
  FileText,
  Warehouse,
  Truck,
  TrendingUp,
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
  totalRevenue: number;
  totalProfit: number;
  overallMargin: number;
  quoteCounts: { draft: number; sent: number; accepted: number };
  quotePipelineValue: number;
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
  topCustomers: Array<{
    farm_name: string;
    total: number;
  }>;
  monthlyRevenue: Array<{ month: string; revenue: number; profit: number }>;
  lowStockCount: number;
  openArBalance: number;
  // Phase 3.6: Integrity alert counts
  driverIssuesCount: number;
  customersOverCreditCount: number;
  expiredHoldsCount: number;
  cancelledPostedCount: number;
}

export default function Dashboard() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData>({
    totalRevenue: 0,
    totalProfit: 0,
    overallMargin: 0,
    quoteCounts: { draft: 0, sent: 0, accepted: 0 },
    quotePipelineValue: 0,
    inventoryAvailable: 0,
    inventoryPrebooked: 0,
    upcomingDeliveries: [],
    recentActivity: [],
    topCustomers: [],
    monthlyRevenue: [],
    lowStockCount: 0,
    openArBalance: 0,
    driverIssuesCount: 0,
    customersOverCreditCount: 0,
    expiredHoldsCount: 0,
    cancelledPostedCount: 0,
  });

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await supabase.rpc('dashboard_summary');
      if (error) throw error;

      interface DashboardRpc {
        total_revenue: number;
        total_profit: number;
        overall_margin: number;
        quote_counts: { draft: number; sent: number; accepted: number };
        quote_pipeline_value: number;
        inventory_available: number;
        inventory_prebooked: number;
        upcoming_deliveries: Array<{ id: string; delivery_number: string; scheduled_date: string; status: string; customer: string | { farm_name: string } | null; driver: string | { full_name: string } | null }>;
        recent_activity: Array<{ id: string; event_type: string; description: string; created_at: string }>;
        top_customers: Array<{ farm_name: string; total: number }>;
        monthly_revenue: Array<{ month: string; revenue: number; profit: number }>;
        low_stock_count: number;
        open_ar_balance: number;
        driver_issues_count: number;
        customers_over_credit_count: number;
        expired_holds_count: number;
        cancelled_posted_count: number;
      }
      const d = rpc as DashboardRpc;

      setData({
        totalRevenue: Number(d.total_revenue) || 0,
        totalProfit: Number(d.total_profit) || 0,
        overallMargin: Number(d.overall_margin) || 0,
        quoteCounts: {
          draft: Number(d.quote_counts?.draft) || 0,
          sent: Number(d.quote_counts?.sent) || 0,
          accepted: Number(d.quote_counts?.accepted) || 0,
        },
        quotePipelineValue: Number(d.quote_pipeline_value) || 0,
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
        topCustomers: (d.top_customers || []).map((c) => ({
          farm_name: c.farm_name,
          total: Number(c.total) || 0,
        })),
        monthlyRevenue: (d.monthly_revenue || []).map((m) => ({
          month: m.month,
          revenue: Number(m.revenue) || 0,
          profit: Number(m.profit) || 0,
        })),
        lowStockCount: Number(d.low_stock_count) || 0,
        openArBalance: Number(d.open_ar_balance) || 0,
        driverIssuesCount: Number(d.driver_issues_count) || 0,
        customersOverCreditCount: Number(d.customers_over_credit_count) || 0,
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

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

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
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm text-secondary">Total Revenue</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.totalRevenue)}</p>
            <p className="text-xs text-secondary mt-1">All confirmed orders</p>
          </Card>

          <Card>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-emerald-600" />
              </div>
              <span className="text-sm text-secondary">Total Profit</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.totalProfit)}</p>
            <p className="text-xs text-secondary mt-1">{data.overallMargin.toFixed(1)}% overall margin</p>
          </Card>

          <Card>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <FileText className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-secondary">Quote Pipeline</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.quotePipelineValue)}</p>
            <div className="flex gap-3 mt-1">
              <span className="text-xs text-secondary">
                {data.quoteCounts.draft} Draft
              </span>
              <span className="text-xs text-secondary">
                {data.quoteCounts.sent} Sent
              </span>
              <span className="text-xs text-crx-green font-medium">
                {data.quoteCounts.accepted} Accepted
              </span>
            </div>
          </Card>

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

      {/* GAP FIX #10 + #2 + Phase 3.6: Alerts row */}
      {!isDriver && (data.lowStockCount > 0 || data.openArBalance > 0 || data.driverIssuesCount > 0 || data.customersOverCreditCount > 0 || data.expiredHoldsCount > 0 || data.cancelledPostedCount > 0) && (
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
          {data.openArBalance > 0 && (
            <div
              onClick={() => navigate('/payments')}
              className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-red-100 transition-colors"
            >
              <DollarSign className="w-5 h-5 text-red-600" />
              <div>
                <p className="text-sm font-semibold text-red-800">Outstanding A/R</p>
                <p className="text-xs text-red-600">{fmt(data.openArBalance)} unpaid balance</p>
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
          {data.customersOverCreditCount > 0 && (
            <div
              onClick={() => navigate('/customers')}
              className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-red-100 transition-colors"
            >
              <Users className="w-5 h-5 text-red-600" />
              <div>
                <p className="text-sm font-semibold text-red-800">Over Credit Limit</p>
                <p className="text-xs text-red-600">{data.customersOverCreditCount} customer(s) over credit limit</p>
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

      {/* GAP FIX #21: Monthly Revenue & Profit Chart — Interactive SVG */}
      {!isDriver && data.monthlyRevenue.length > 1 && (() => {
        const maxVal = Math.max(...data.monthlyRevenue.map((r) => r.revenue), 1);
        const chartH = 200;
        const barW = Math.min(40, (600 / data.monthlyRevenue.length) - 8);
        const chartW = data.monthlyRevenue.length * (barW + 8) + 40;

        return (
          <Card padding={false}>
            <div className="p-5">
              <CardHeader title="Monthly" accent="Revenue & Profit" />
              <div className="flex gap-4 mt-2 mb-4">
                <span className="flex items-center gap-1.5 text-xs text-secondary">
                  <span className="w-3 h-3 rounded bg-crx-green inline-block" /> Revenue
                </span>
                <span className="flex items-center gap-1.5 text-xs text-secondary">
                  <span className="w-3 h-3 rounded bg-emerald-300 inline-block" /> Profit
                </span>
              </div>
            </div>
            <div className="px-5 pb-5 overflow-x-auto">
              <svg width={chartW} height={chartH + 50} className="min-w-full">
                {/* Grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
                  <g key={pct}>
                    <line
                      x1={35} y1={chartH * (1 - pct) + 10}
                      x2={chartW} y2={chartH * (1 - pct) + 10}
                      stroke="#f0f0f0" strokeWidth={1}
                    />
                    <text x={0} y={chartH * (1 - pct) + 14} fontSize={10} fill="#9ca3af">
                      {fmt(maxVal * pct).replace('.00', '')}
                    </text>
                  </g>
                ))}

                {/* Bars */}
                {data.monthlyRevenue.map((m, i) => {
                  const x = 40 + i * (barW + 8);
                  const revH = (m.revenue / maxVal) * chartH;
                  const profH = (m.profit / maxVal) * chartH;
                  const monthLabel = new Date(m.month + '-15').toLocaleString('default', { month: 'short' });
                  const yearLabel = m.month.substring(0, 4);

                  return (
                    <g key={m.month}>
                      {/* Revenue bar */}
                      <rect
                        x={x} y={chartH - revH + 10}
                        width={barW} height={revH}
                        rx={4} fill="#28A26A"
                        opacity={0.85}
                      >
                        <title>{`${monthLabel} ${yearLabel}\nRevenue: ${fmt(m.revenue)}\nProfit: ${fmt(m.profit)}`}</title>
                      </rect>
                      {/* Profit overlay bar */}
                      <rect
                        x={x + 2} y={chartH - profH + 10}
                        width={barW - 4} height={profH}
                        rx={3} fill="#6ee7b7"
                        opacity={0.7}
                      >
                        <title>{`${monthLabel} ${yearLabel}\nRevenue: ${fmt(m.revenue)}\nProfit: ${fmt(m.profit)}`}</title>
                      </rect>
                      {/* Month label */}
                      <text
                        x={x + barW / 2} y={chartH + 28}
                        textAnchor="middle" fontSize={10} fill="#6b7280"
                      >
                        {monthLabel}
                      </text>
                      {/* Year label (only show on Jan or first item) */}
                      {(i === 0 || m.month.endsWith('-01')) && (
                        <text
                          x={x + barW / 2} y={chartH + 42}
                          textAnchor="middle" fontSize={9} fill="#9ca3af"
                        >
                          {yearLabel}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Summary row below chart */}
            <div className="px-5 pb-5 grid grid-cols-3 gap-4 border-t border-gray-100 pt-4">
              <div>
                <p className="text-xs text-secondary">Total Revenue (shown)</p>
                <p className="text-lg font-semibold font-heading text-nav-dark">
                  {fmt(data.monthlyRevenue.reduce((s, m) => s + m.revenue, 0))}
                </p>
              </div>
              <div>
                <p className="text-xs text-secondary">Total Profit (shown)</p>
                <p className="text-lg font-semibold font-heading text-crx-green">
                  {fmt(data.monthlyRevenue.reduce((s, m) => s + m.profit, 0))}
                </p>
              </div>
              <div>
                <p className="text-xs text-secondary">Avg Monthly Revenue</p>
                <p className="text-lg font-semibold font-heading text-nav-dark">
                  {fmt(data.monthlyRevenue.reduce((s, m) => s + m.revenue, 0) / data.monthlyRevenue.length)}
                </p>
              </div>
            </div>
          </Card>
        );
      })()}

      {!isDriver && data.topCustomers.length > 0 && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader
              title="Top"
              accent="Customers"
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/customers')}>
                  View All
                </Button>
              }
            />
          </div>
          <div className="px-5 pb-5 space-y-2">
            {data.topCustomers.map((c, idx) => {
              const maxRevenue = data.topCustomers[0]?.total || 1;
              const widthPct = (c.total / maxRevenue) * 100;
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-crx-green-tint transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-secondary shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-nav-dark block truncate">{c.farm_name}</span>
                      <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                        <div
                          className="bg-crx-green rounded-full h-1.5 transition-all"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <span className="text-sm font-mono text-nav-dark ml-3 shrink-0">{fmt(c.total)}</span>
                </div>
              );
            })}
          </div>
        </Card>
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
