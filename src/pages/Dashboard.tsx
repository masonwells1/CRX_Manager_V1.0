import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShoppingCart,
  FileText,
  Truck,
  Package,
  Warehouse,
  ClipboardList,
  ClipboardCheck,
  Clock,
  CalendarCheck,
  ChevronRight,
  Plus,
  Pin,
  User,
  BarChart3,
  CheckCircle2,
  Circle,
  Inbox,
  Calendar,
  CheckSquare,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { SkeletonCard } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { runPeriodicNotificationChecks } from '../lib/notificationTriggers';
import ActionQueue from '../components/dashboard/ActionQueue';

// --- Types ---

interface MonthlyActivity {
  month: string;
  orders_created: number;
  deliveries_completed: number;
  pos_received: number;
}

interface UpcomingDelivery {
  id: string;
  delivery_number: string;
  scheduled_date: string;
  status: string;
  customer_name: string | null;
  driver_name: string | null;
  assigned_driver: string | null;
}

interface ActivityItem {
  id: string;
  event_type: string;
  description: string;
  created_at: string;
}

interface TeamActionItem {
  id: string;
  title: string;
  priority: string;
  due_date: string | null;
  note_type: string;
  is_pinned: boolean;
  assigned_to: string | null;
  assignee_name: string | null;
}

interface OperationalRpc {
  active_orders_count: number;
  open_quotes_draft: number;
  open_quotes_sent: number;
  pending_deliveries_count: number;
  open_pos_count: number;
  team_action_items: TeamActionItem[];
  inventory_available: number;
  inventory_prebooked: number;
  on_order_units: number;
  on_order_po_count: number;
  committed_units: number;
  committed_order_count: number;
  upcoming_deliveries: UpcomingDelivery[];
  delivery_today: number;
  delivery_this_week: number;
  delivery_unassigned: number;
  delivery_remainders_count: number;
  quote_pipeline_draft: number;
  quote_pipeline_sent: number;
  quote_pipeline_accepted: number;
  orders_ytd_total: number;
  orders_this_month: number;
  deliveries_completed_total: number;
  deliveries_completed_this_month: number;
  monthly_activity: MonthlyActivity[];
  season_label: string;
  season_days_remaining: number;
  season_days_elapsed: number;
  period_name: string;
  period_status: string;
  period_days_remaining: number;
  recent_activity: ActivityItem[];
}

interface OperationalData {
  activeOrdersCount: number;
  openQuotesDraft: number;
  openQuotesSent: number;
  pendingDeliveriesCount: number;
  openPosCount: number;
  programCompletionPct: number | null;
  teamActionItems: TeamActionItem[];
  inventoryAvailable: number;
  inventoryPrebooked: number;
  onOrderUnits: number;
  onOrderPoCount: number;
  committedUnits: number;
  committedOrderCount: number;
  upcomingDeliveries: UpcomingDelivery[];
  deliveryToday: number;
  deliveryThisWeek: number;
  deliveryUnassigned: number;
  deliveryRemaindersCount: number;
  quotePipelineDraft: number;
  quotePipelineSent: number;
  quotePipelineAccepted: number;
  ordersYtdTotal: number;
  ordersThisMonth: number;
  deliveriesCompletedTotal: number;
  deliveriesCompletedThisMonth: number;
  monthlyActivity: MonthlyActivity[];
  seasonLabel: string;
  seasonDaysRemaining: number;
  seasonDaysElapsed: number;
  periodName: string;
  periodStatus: string;
  periodDaysRemaining: number;
  recentActivity: ActivityItem[];
}

// --- Helpers ---

/** Smart date label for delivery dates */
function deliveryDateLabel(dateStr: string): { text: string; color: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return { text: 'Today', color: 'text-crx-green font-semibold' };
  if (diffDays === 1) return { text: 'Tomorrow', color: 'text-blue-600' };
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, color: 'text-red-600 font-semibold' };
  if (diffDays <= 7) return { text: `In ${diffDays}d`, color: 'text-secondary' };
  return { text: dateStr, color: 'text-secondary' };
}

/** Relative timestamp */
function relativeTime(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

/** Color dot for activity event types */
const eventTypeDot: Record<string, string> = {
  order: 'bg-blue-500',
  delivery: 'bg-crx-green',
  inventory: 'bg-amber-500',
  quote: 'bg-purple-500',
  payment: 'bg-emerald-500',
  invoice: 'bg-indigo-500',
};

/** Priority badge colors */
const priorityBadge: Record<string, { bg: string; text: string }> = {
  urgent: { bg: 'bg-red-100', text: 'text-red-700' },
  high: { bg: 'bg-orange-100', text: 'text-orange-700' },
  medium: { bg: 'bg-blue-100', text: 'text-blue-700' },
  low: { bg: 'bg-gray-100', text: 'text-gray-600' },
};

// --- Default data ---

const defaultData: OperationalData = {
  activeOrdersCount: 0,
  openQuotesDraft: 0,
  openQuotesSent: 0,
  pendingDeliveriesCount: 0,
  openPosCount: 0,
  programCompletionPct: null,
  teamActionItems: [],
  inventoryAvailable: 0,
  inventoryPrebooked: 0,
  onOrderUnits: 0,
  onOrderPoCount: 0,
  committedUnits: 0,
  committedOrderCount: 0,
  upcomingDeliveries: [],
  deliveryToday: 0,
  deliveryThisWeek: 0,
  deliveryUnassigned: 0,
  deliveryRemaindersCount: 0,
  quotePipelineDraft: 0,
  quotePipelineSent: 0,
  quotePipelineAccepted: 0,
  ordersYtdTotal: 0,
  ordersThisMonth: 0,
  deliveriesCompletedTotal: 0,
  deliveriesCompletedThisMonth: 0,
  monthlyActivity: [],
  seasonLabel: '',
  seasonDaysRemaining: 0,
  seasonDaysElapsed: 0,
  periodName: '',
  periodStatus: 'open',
  periodDaysRemaining: 0,
  recentActivity: [],
};

// --- Component ---

export default function Dashboard() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<OperationalData>(defaultData);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await supabase.rpc('operational_dashboard_summary');
      if (error) throw error;

      const d = assertRpcResult<OperationalRpc>(rpc, 'operational_dashboard_summary');

      setData({
        activeOrdersCount: Number(d.active_orders_count) || 0,
        openQuotesDraft: Number(d.open_quotes_draft) || 0,
        openQuotesSent: Number(d.open_quotes_sent) || 0,
        pendingDeliveriesCount: Number(d.pending_deliveries_count) || 0,
        openPosCount: Number(d.open_pos_count) || 0,
        teamActionItems: d.team_action_items || [],
        inventoryAvailable: Number(d.inventory_available) || 0,
        inventoryPrebooked: Number(d.inventory_prebooked) || 0,
        onOrderUnits: Number(d.on_order_units) || 0,
        onOrderPoCount: Number(d.on_order_po_count) || 0,
        committedUnits: Number(d.committed_units) || 0,
        committedOrderCount: Number(d.committed_order_count) || 0,
        upcomingDeliveries: d.upcoming_deliveries || [],
        deliveryToday: Number(d.delivery_today) || 0,
        deliveryThisWeek: Number(d.delivery_this_week) || 0,
        deliveryUnassigned: Number(d.delivery_unassigned) || 0,
        deliveryRemaindersCount: Number(d.delivery_remainders_count) || 0,
        quotePipelineDraft: Number(d.quote_pipeline_draft) || 0,
        quotePipelineSent: Number(d.quote_pipeline_sent) || 0,
        quotePipelineAccepted: Number(d.quote_pipeline_accepted) || 0,
        ordersYtdTotal: Number(d.orders_ytd_total) || 0,
        ordersThisMonth: Number(d.orders_this_month) || 0,
        deliveriesCompletedTotal: Number(d.deliveries_completed_total) || 0,
        deliveriesCompletedThisMonth: Number(d.deliveries_completed_this_month) || 0,
        monthlyActivity: (d.monthly_activity || []).map((m) => ({
          month: m.month,
          orders_created: Number(m.orders_created) || 0,
          deliveries_completed: Number(m.deliveries_completed) || 0,
          pos_received: Number(m.pos_received) || 0,
        })),
        seasonLabel: d.season_label || '',
        seasonDaysRemaining: Number(d.season_days_remaining) || 0,
        seasonDaysElapsed: Number(d.season_days_elapsed) || 0,
        periodName: d.period_name || '',
        periodStatus: d.period_status || 'open',
        periodDaysRemaining: Number(d.period_days_remaining) || 0,
        recentActivity: d.recent_activity || [],
        programCompletionPct: null,
      });
      // Fetch program completion for dashboard card
      try {
        const { data: progData } = await supabase.rpc('get_program_completion');
        const progResult = assertRpcResult<Array<{ completion_pct: number }>>(progData, 'get_program_completion');
        if (Array.isArray(progResult) && progResult.length > 0) {
          const totalPct = progResult.reduce((s, p) => s + (p.completion_pct || 0), 0);
          setData(prev => ({ ...prev, programCompletionPct: Math.round(totalPct / progResult.length) }));
        } else { setData(prev => ({ ...prev, programCompletionPct: 0 })); }
      } catch (progErr) { Sentry.captureException(progErr, { tags: { source: 'fetch', action: 'program_completion' } }); }
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'fetch', page: 'dashboard' } });
      toast('error', 'Failed to load dashboard data. Please refresh.');
    }
    setLoading(false);

    // Side-effects from original dashboard
    runPeriodicNotificationChecks();

    try {
      const { data: reminderData, error: reminderErr } = await supabase.rpc('check_remainder_reminders');
      if (reminderErr) throw reminderErr;
      assertRpcResult(reminderData, 'check_remainder_reminders');
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'mutation', action: 'check_remainder_reminders' } });
      supabase.rpc('log_failed_notification', {
        p_notification_type: 'remainder_reminders',
        p_error_message: err instanceof Error ? err.message : String(err),
      }).then(({ error: logErr }) => { if (logErr) Sentry.captureException(logErr, { tags: { source: 'mutation', action: 'log_failed_notification' } }); });
    }

    try {
      const { data: holdsData, error: holdsErr } = await supabase.rpc('release_expired_quote_holds');
      if (holdsErr) throw holdsErr;
      assertRpcResult(holdsData, 'release_expired_quote_holds');
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'mutation', action: 'release_expired_quote_holds' } });
      supabase.rpc('log_failed_notification', {
        p_notification_type: 'release_expired_holds',
        p_error_message: err instanceof Error ? err.message : String(err),
      }).then(({ error: logErr }) => { if (logErr) Sentry.captureException(logErr, { tags: { source: 'mutation', action: 'log_failed_notification' } }); });
    }
  }, [toast]);

  useEffect(() => {
    fetchDashboard();
  }, [role, fetchDashboard]);

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

  const isAdmin = role === 'admin';
  const isDriver = role === 'driver';
  const showFull = !isDriver; // Admin & Sales see everything

  // Monthly chart calculations
  const maxMonthlyValue = Math.max(
    ...data.monthlyActivity.map((m) => Math.max(m.orders_created, m.deliveries_completed, m.pos_received)),
    1,
  );

  // Season progress
  const seasonTotalDays = data.seasonDaysElapsed + data.seasonDaysRemaining;
  const seasonPercent = seasonTotalDays > 0 ? Math.round((data.seasonDaysElapsed / seasonTotalDays) * 100) : 0;


  return (
    <div className="space-y-6">
      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Quick Actions (hidden from drivers)                       */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {(isAdmin || role === 'sales_rep') && (
        <Card>
          <CardHeader title="Quick" accent="Actions" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <button
              onClick={() => navigate('/orders/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-50 group-hover:bg-blue-100 flex items-center justify-center transition-colors">
                <Plus className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">New Order</span>
            </button>
            <button
              onClick={() => navigate('/purchase-orders/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-teal-50 group-hover:bg-teal-100 flex items-center justify-center transition-colors">
                <Package className="w-5 h-5 text-teal-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">New PO</span>
            </button>
            <button
              onClick={() => navigate('/deliveries/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-green-50 group-hover:bg-green-100 flex items-center justify-center transition-colors">
                <Truck className="w-5 h-5 text-green-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">Schedule Delivery</span>
            </button>
            <button
              onClick={() => navigate('/inventory')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-amber-50 group-hover:bg-amber-100 flex items-center justify-center transition-colors">
                <Warehouse className="w-5 h-5 text-amber-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">Inventory</span>
            </button>
            <button
              onClick={() => navigate('/receiving')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                <Inbox className="w-5 h-5 text-indigo-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">Receiving</span>
            </button>
          </div>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 1: Top KPI Row (hidden from drivers)              */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showFull && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Active Orders */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/orders')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <ShoppingCart className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-secondary">Active Orders</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.activeOrdersCount}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Confirmed & partially fulfilled <ChevronRight className="w-3 h-3" />
            </p>
          </Card>

          {/* Open Quotes */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/quotes')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                <FileText className="w-5 h-5 text-purple-600" />
              </div>
              <span className="text-sm text-secondary">Open Quotes</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">
              {data.openQuotesDraft + data.openQuotesSent}
            </p>
            <div className="flex gap-2 mt-1">
              <Badge variant="draft">{data.openQuotesDraft} draft</Badge>
              <Badge variant="sent">{data.openQuotesSent} sent</Badge>
            </div>
          </Card>

          {/* Pending Deliveries */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/deliveries')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                <Truck className="w-5 h-5 text-green-600" />
              </div>
              <span className="text-sm text-secondary">Pending Deliveries</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.pendingDeliveriesCount}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Scheduled & in progress <ChevronRight className="w-3 h-3" />
            </p>
          </Card>

          {/* Open POs */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/purchase-orders')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center">
                <Package className="w-5 h-5 text-teal-600" />
              </div>
              <span className="text-sm text-secondary">Open POs</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.openPosCount}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Submitted & partially received <ChevronRight className="w-3 h-3" />
            </p>
          </Card>

          {/* Program Progress */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/program-tracker')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                <CheckSquare className="w-5 h-5 text-emerald-600" />
              </div>
              <span className="text-sm text-secondary">Program Progress</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.programCompletionPct ?? '-'}%</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Season application programs <ChevronRight className="w-3 h-3" />
            </p>
          </Card>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 2: Team Board Action Items                        */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <Card padding={false}>
        <div className="p-5">
          <CardHeader
            title="Team Board"
            accent="Action Items"
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate('/team-board')}>
                View Board
              </Button>
            }
          />
        </div>
        {data.teamActionItems.length === 0 ? (
          <div className="px-5 pb-5">
            <div className="flex items-center gap-3 p-4 bg-crx-green-tint rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-crx-green" />
              <p className="text-sm text-crx-green font-medium">All Clear — No urgent action items</p>
            </div>
          </div>
        ) : (
          <div className="px-5 pb-5 space-y-2">
            {data.teamActionItems.map((item) => {
              const isOverdue = item.due_date && new Date(item.due_date + 'T00:00:00') < new Date(new Date().toDateString());
              const pBadge = priorityBadge[item.priority] || priorityBadge.low;
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate('/team-board')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/team-board'); }}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-crx-green-tint cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {item.is_pinned ? (
                      <Pin className="w-4 h-4 text-amber-500 shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-gray-300 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-nav-dark truncate">{item.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {item.assignee_name && (
                          <span className="text-xs text-secondary">{item.assignee_name}</span>
                        )}
                        {item.due_date && (
                          <span className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : 'text-secondary'}`}>
                            Due {item.due_date}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${pBadge.bg} ${pBadge.text}`}>
                      {item.priority}
                    </span>
                    {isOverdue && (
                      <Badge variant="danger">overdue</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 3: Inventory Position (hidden from drivers)       */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showFull && (
        <div>
          <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Inventory Position</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Floor Stock */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/inventory')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                  <Warehouse className="w-5 h-5 text-amber-600" />
                </div>
                <span className="text-sm text-secondary">Floor Stock</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {data.inventoryAvailable.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <div className="flex gap-3 mt-1">
                <span className="text-xs text-crx-green">{(data.inventoryAvailable - data.inventoryPrebooked).toLocaleString()} free</span>
                <span className="text-xs text-amber-600">{data.inventoryPrebooked.toLocaleString()} pre-booked</span>
              </div>
            </Card>

            {/* On Order */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/purchase-orders')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-sky-50 flex items-center justify-center">
                  <Package className="w-5 h-5 text-sky-600" />
                </div>
                <span className="text-sm text-secondary">On Order</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {data.onOrderUnits.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <p className="text-xs text-secondary mt-1 flex items-center gap-1">
                Across {data.onOrderPoCount} open PO(s) <ChevronRight className="w-3 h-3" />
              </p>
            </Card>

            {/* Committed */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/orders')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-violet-50 flex items-center justify-center">
                  <ClipboardCheck className="w-5 h-5 text-violet-600" />
                </div>
                <span className="text-sm text-secondary">Committed</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {data.committedUnits.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <p className="text-xs text-secondary mt-1 flex items-center gap-1">
                Across {data.committedOrderCount} active order(s) <ChevronRight className="w-3 h-3" />
              </p>
            </Card>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 4: Delivery Command Center                        */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2" padding={false}>
          <div className="p-5">
            <CardHeader
              title="Delivery"
              accent="Command Center"
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
              {data.upcomingDeliveries.map((del) => {
                const dateInfo = deliveryDateLabel(del.scheduled_date);
                return (
                  <div
                    key={del.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/deliveries/${del.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/deliveries/${del.id}`); }}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-crx-green-tint cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
                        <Truck className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-nav-dark">
                          {del.customer_name || 'Unknown'}
                        </p>
                        <p className="text-xs text-secondary">
                          {del.delivery_number} &middot; {del.driver_name || 'Unassigned'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs ${dateInfo.color}`}>{dateInfo.text}</span>
                      <Badge variant={statusToBadgeVariant[del.status] || 'default'}>
                        {del.status.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Delivery stats mini-cards */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-4 h-4 text-crx-green" />
              <span className="text-xs text-secondary">Today</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.deliveryToday}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <CalendarCheck className="w-4 h-4 text-blue-600" />
              <span className="text-xs text-secondary">This Week</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{data.deliveryThisWeek}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <User className="w-4 h-4 text-orange-600" />
              <span className="text-xs text-secondary">Unassigned</span>
            </div>
            <p className={`text-2xl font-semibold font-heading ${data.deliveryUnassigned > 0 ? 'text-orange-600' : 'text-nav-dark'}`}>
              {data.deliveryUnassigned}
            </p>
          </Card>
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <ClipboardList className="w-4 h-4 text-purple-600" />
              <span className="text-xs text-secondary">Remainders</span>
            </div>
            <p className={`text-2xl font-semibold font-heading ${data.deliveryRemaindersCount > 0 ? 'text-purple-600' : 'text-nav-dark'}`}>
              {data.deliveryRemaindersCount}
            </p>
          </Card>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 5: Sales Pipeline Snapshot (hidden from drivers)  */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showFull && (
        <div>
          <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Sales Pipeline</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Quote Pipeline */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/quotes')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-purple-600" />
                </div>
                <span className="text-sm text-secondary">Quote Pipeline</span>
              </div>
              <div className="flex gap-2">
                <Badge variant="draft">{data.quotePipelineDraft} draft</Badge>
                <Badge variant="sent">{data.quotePipelineSent} sent</Badge>
                <Badge variant="accepted">{data.quotePipelineAccepted} accepted</Badge>
              </div>
            </Card>

            {/* Orders This Season */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/orders')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <ShoppingCart className="w-5 h-5 text-blue-600" />
                </div>
                <span className="text-sm text-secondary">Orders (Season)</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{data.ordersYtdTotal}</p>
              <p className="text-xs text-secondary mt-1">{data.ordersThisMonth} this month</p>
            </Card>

            {/* Deliveries Completed */}
            <Card hover className="cursor-pointer" onClick={() => navigate('/deliveries')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                </div>
                <span className="text-sm text-secondary">Delivered (Season)</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{data.deliveriesCompletedTotal}</p>
              <p className="text-xs text-secondary mt-1">{data.deliveriesCompletedThisMonth} this month</p>
            </Card>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 6: Action Queue (replaces Operational Alerts)     */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <ActionQueue />

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 7: Monthly Activity Chart (hidden from drivers)   */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showFull && (
        <Card>
          <CardHeader title="Monthly" accent="Activity" />
          {data.monthlyActivity.length === 0 ? (
            <p className="text-sm text-secondary">No monthly activity data available</p>
          ) : (
            <>
              <div className="flex items-end gap-1 h-48 mt-2">
                {data.monthlyActivity.map((m) => {
                  const ordH = (m.orders_created / maxMonthlyValue) * 100;
                  const delH = (m.deliveries_completed / maxMonthlyValue) * 100;
                  const poH = (m.pos_received / maxMonthlyValue) * 100;
                  const monthLabel = m.month.length >= 7 ? m.month.slice(5, 7) : m.month;
                  return (
                    <div key={m.month} className="flex-1 flex flex-col items-center gap-1 group">
                      <div className="w-full flex items-end justify-center gap-px h-40 relative">
                        {/* Orders bar */}
                        <div
                          className="flex-1 max-w-[10px] bg-blue-400 rounded-t"
                          style={{ height: `${Math.max(ordH, m.orders_created > 0 ? 4 : 0)}%` }}
                        />
                        {/* Deliveries bar */}
                        <div
                          className="flex-1 max-w-[10px] bg-crx-green rounded-t"
                          style={{ height: `${Math.max(delH, m.deliveries_completed > 0 ? 4 : 0)}%` }}
                        />
                        {/* POs bar */}
                        <div
                          className="flex-1 max-w-[10px] bg-teal-400 rounded-t"
                          style={{ height: `${Math.max(poH, m.pos_received > 0 ? 4 : 0)}%` }}
                        />
                        {/* Tooltip */}
                        <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-nav-dark text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                          O:{m.orders_created} D:{m.deliveries_completed} P:{m.pos_received}
                        </div>
                      </div>
                      <span className="text-xs text-secondary">{monthLabel}</span>
                    </div>
                  );
                })}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-blue-400" />
                  <span className="text-xs text-secondary">Orders</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-crx-green" />
                  <span className="text-xs text-secondary">Deliveries</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-teal-400" />
                  <span className="text-xs text-secondary">POs Received</span>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 8: Season Progress Bar (hidden from drivers)      */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showFull && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Season Progress */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <span className="text-sm text-secondary">Season Progress</span>
                <p className="text-lg font-semibold font-heading text-nav-dark">{data.seasonLabel}</p>
              </div>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-4 relative overflow-hidden">
              <div
                className="bg-gradient-to-r from-crx-green to-emerald-400 h-4 rounded-full transition-all"
                style={{ width: `${seasonPercent}%` }}
              />
              <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-nav-dark">
                {seasonPercent}%
              </span>
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-xs text-secondary">Oct 1</span>
              <span className="text-xs text-secondary">{data.seasonDaysRemaining}d remaining</span>
              <span className="text-xs text-secondary">Sep 30</span>
            </div>
          </Card>

          {/* Accounting Period */}
          <Card>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
                <CalendarCheck className="w-5 h-5 text-indigo-600" />
              </div>
              <span className="text-sm text-secondary">Accounting Period</span>
            </div>
            <p className="text-lg font-semibold font-heading text-nav-dark">{data.periodName || 'N/A'}</p>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant={data.periodStatus === 'open' ? 'success' : 'default'}>
                {data.periodStatus}
              </Badge>
              {data.periodStatus === 'open' && (
                <span className="text-xs text-secondary flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {data.periodDaysRemaining}d remaining
                </span>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Section 9: Recent Activity (improved)                     */}
      {/* ═══════════════════════════════════════════════════════════ */}
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
            {data.recentActivity.map((act) => {
              const dotColor = eventTypeDot[act.event_type] || 'bg-gray-400';
              return (
                <div key={act.id} className="flex gap-3">
                  <div className={`w-2 h-2 rounded-full ${dotColor} mt-2 shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-nav-dark">{act.description}</p>
                    <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {relativeTime(act.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

    </div>
  );
}
