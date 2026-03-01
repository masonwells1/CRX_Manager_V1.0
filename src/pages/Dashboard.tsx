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
                      {del.status.replace(/_/g, ' ')}
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
              role="button"
              tabIndex={0}
              onClick={() => navigate('/inventory')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/inventory'); }}
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
              role="button"
              tabIndex={0}
              onClick={() => navigate('/deliveries')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/deliveries'); }}
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
              role="button"
              tabIndex={0}
              onClick={() => navigate('/quotes')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/quotes'); }}
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
              role="button"
              tabIndex={0}
              onClick={() => navigate('/invoices')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/invoices'); }}
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
