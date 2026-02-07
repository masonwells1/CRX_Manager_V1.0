import { useEffect, useState } from 'react';
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
  });

  useEffect(() => {
    fetchDashboard();
  }, [role]);

  const fetchDashboard = async () => {
    setLoading(true);
    try {
      const [ordersRes, quotesRes, inventoryRes, deliveriesRes, activityRes] =
        await Promise.all([
          supabase.from('orders').select('customer_id, total_price, total_profit, total_margin_pct, status'),
          supabase.from('quotes').select('status, total_price'),
          supabase.from('inventory').select('quantity_available, quantity_prebooked'),
          supabase
            .from('deliveries')
            .select('id, delivery_number, scheduled_date, status, customer:customers(farm_name), driver:profiles!deliveries_assigned_driver_fkey(full_name)')
            .in('status', ['scheduled', 'in_progress'])
            .order('scheduled_date', { ascending: true })
            .limit(5),
          supabase
            .from('activity_feed')
            .select('id, event_type, description, created_at')
            .order('created_at', { ascending: false })
            .limit(10),
        ]);

      const orders = ordersRes.data || [];
      const quotes = quotesRes.data || [];
      const inv = inventoryRes.data || [];

      const totalRevenue = orders.reduce((s, o) => s + (o.total_price || 0), 0);
      const totalProfit = orders.reduce((s, o) => s + (o.total_profit || 0), 0);
      const overallMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

      const draft = quotes.filter((q) => q.status === 'draft').length;
      const sent = quotes.filter((q) => q.status === 'sent').length;
      const accepted = quotes.filter((q) => q.status === 'accepted').length;
      const quotePipelineValue = quotes
        .filter((q) => ['draft', 'sent'].includes(q.status))
        .reduce((s, q) => s + (q.total_price || 0), 0);

      const inventoryAvailable = inv.reduce((s, i) => s + (i.quantity_available || 0), 0);
      const inventoryPrebooked = inv.reduce((s, i) => s + (i.quantity_prebooked || 0), 0);

      const customerRevenue: Record<string, { farm_name: string; total: number }> = {};
      for (const ord of orders) {
        const cid = (ord as Record<string, unknown>).customer_id as string;
        if (!cid) continue;
        if (!customerRevenue[cid]) customerRevenue[cid] = { farm_name: '', total: 0 };
        customerRevenue[cid].total += ord.total_price || 0;
      }

      if (Object.keys(customerRevenue).length > 0) {
        const { data: custNames } = await supabase
          .from('customers')
          .select('id, farm_name')
          .in('id', Object.keys(customerRevenue));
        (custNames || []).forEach((c) => {
          if (customerRevenue[c.id]) customerRevenue[c.id].farm_name = c.farm_name;
        });
      }

      const topCustomers = Object.values(customerRevenue)
        .filter((c) => c.farm_name)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

      // GAP FIX #21: Monthly revenue breakdown
      const monthlyMap: Record<string, { revenue: number; profit: number }> = {};
      for (const ord of orders) {
        const d = new Date((ord as any).order_date || (ord as any).created_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyMap[key]) monthlyMap[key] = { revenue: 0, profit: 0 };
        monthlyMap[key].revenue += ord.total_price || 0;
        monthlyMap[key].profit += ord.total_profit || 0;
      }
      const monthlyRevenue = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([month, vals]) => ({
          month,
          ...vals,
        }));

      // GAP FIX #10: Low stock count
      const { data: lowStockData } = await supabase
        .from('inventory')
        .select('id, quantity_available, reorder_point')
        .gt('reorder_point', 0);
      const lowStockCount = (lowStockData || []).filter(
        (i: any) => Number(i.quantity_available) <= Number(i.reorder_point)
      ).length;

      // GAP FIX #2: Open AR balance
      const { data: arOrders } = await supabase
        .from('orders')
        .select('balance_due');
      const openArBalance = (arOrders || []).reduce(
        (s: number, o: any) => s + Math.max(0, Number(o.balance_due) || 0),
        0
      );

      setData({
        totalRevenue,
        totalProfit,
        overallMargin,
        quoteCounts: { draft, sent, accepted },
        quotePipelineValue,
        inventoryAvailable,
        inventoryPrebooked,
        upcomingDeliveries: (deliveriesRes.data as unknown as DashboardData['upcomingDeliveries']) || [],
        recentActivity: activityRes.data || [],
        topCustomers,
        monthlyRevenue,
        lowStockCount,
        openArBalance,
      });
    } catch (err) {
      console.error('Dashboard load error:', err);
      toast('error', 'Failed to load dashboard data. Please refresh.');
    }
    setLoading(false);
  };

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

      {/* GAP FIX #10 + #2: Alerts row */}
      {!isDriver && (data.lowStockCount > 0 || data.openArBalance > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        </div>
      )}

      {/* GAP FIX #21: Monthly Revenue Chart */}
      {!isDriver && data.monthlyRevenue.length > 1 && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Monthly" accent="Revenue" />
          </div>
          <div className="px-5 pb-5">
            <div className="flex items-end gap-1 h-40">
              {data.monthlyRevenue.map((m) => {
                const maxRevenue = Math.max(...data.monthlyRevenue.map((r) => r.revenue), 1);
                const heightPct = (m.revenue / maxRevenue) * 100;
                const monthLabel = new Date(m.month + '-15').toLocaleString('default', { month: 'short' });
                return (
                  <div key={m.month} className="flex-1 flex flex-col items-center gap-1" title={`${monthLabel}: ${fmt(m.revenue)}`}>
                    <span className="text-[10px] text-secondary">{fmt(m.revenue).replace('.00', '')}</span>
                    <div
                      className="w-full bg-crx-green rounded-t-md transition-all hover:bg-crx-green-dark"
                      style={{ height: `${Math.max(heightPct, 2)}%` }}
                    />
                    <span className="text-[10px] text-secondary">{monthLabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

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
            {data.topCustomers.map((c, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-crx-green-tint transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-secondary">
                    {idx + 1}
                  </div>
                  <span className="text-sm font-medium text-nav-dark">{c.farm_name}</span>
                </div>
                <span className="text-sm font-mono text-nav-dark">{fmt(c.total)}</span>
              </div>
            ))}
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
