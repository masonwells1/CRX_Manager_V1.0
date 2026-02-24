import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Truck,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Printer,
  CalendarRange,
  MapPin,
  Clock,
  Zap,
  Download,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import BatchCancelModal from '../components/deliveries/BatchCancelModal';
import QuickDeliveryModal from '../components/deliveries/QuickDeliveryModal';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import type { Delivery, Profile } from '../types';

/* ─── Row type ─── */
interface DeliveryRow extends Delivery {
  customer_name: string;
  driver_name: string;
  item_count: number;
}

/* ─── Helpers ─── */
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
};
const weekStart = () => {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
};
const dayLabel = (d: string) => {
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

const priorityBadge = (p: string) => {
  const map: Record<string, { variant: 'default' | 'warning' | 'error' | 'info'; label: string }> = {
    low: { variant: 'default', label: 'Low' },
    normal: { variant: 'info', label: 'Normal' },
    high: { variant: 'warning', label: 'High' },
    urgent: { variant: 'error', label: 'Urgent' },
  };
  const s = map[p] || { variant: 'default' as const, label: p };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

const SELECTABLE_STATUSES = ['scheduled', 'in_progress'];
const DATE_PRESETS = [
  { value: '', label: 'All Dates' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'future', label: 'Upcoming' },
];

export default function Deliveries() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);

  /* Filters */
  const [statusFilter, setStatusFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [datePreset, setDatePreset] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [scheduleDate, setScheduleDate] = useState(''); // from schedule strip click

  /* Lookup data */
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);

  /* Batch selection */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduling, setRescheduling] = useState(false);

  /* Quick Delivery modal */
  const [quickDeliveryOpen, setQuickDeliveryOpen] = useState(false);

  /* Remainder count for summary */
  const [remainderCount, setRemainderCount] = useState(0);

  /* Driver-specific: unassigned deliveries they can claim */
  const [unassigned, setUnassigned] = useState<DeliveryRow[]>([]);

  const canCreate = role === 'admin' || role === 'sales_rep';
  const canQuickDeliver = role === 'admin' || role === 'sales_rep';
  const isDriver = role === 'driver';

  useEffect(() => {
    fetchDeliveries();
    fetchDrivers();
    fetchCustomers();
    fetchRemainderCount();
  }, []);

  // Fetch unassigned deliveries for driver dashboard
  useEffect(() => {
    if (!isDriver) return;
    supabase
      .from('deliveries')
      .select('*, customer:customers(farm_name)')
      .is('assigned_driver', null)
      .in('status', ['scheduled'])
      .order('scheduled_date')
      .limit(20)
      .then(({ data }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = ((data || []) as any[]).map((d) => ({
          ...d,
          customer_name: d.customer?.farm_name || 'Unknown',
          driver_name: 'Unassigned',
          item_count: 0,
        }));
        setUnassigned(rows);
      });
  }, [isDriver, deliveries]);

  const fetchDrivers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'driver')
      .eq('is_active', true)
      .order('full_name');
    setDrivers((data || []) as Profile[]);
  };

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .limit(500);
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  };

  const fetchRemainderCount = async () => {
    const { count } = await supabase
      .from('delivery_remainders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    setRemainderCount(count || 0);
  };

  const fetchDeliveries = async () => {
    let query = supabase
      .from('deliveries')
      .select('*, customer:customers(farm_name), driver:profiles!deliveries_assigned_driver_fkey(full_name)')
      .order('scheduled_date', { ascending: false })
      .limit(500);

    // Driver sees only their deliveries
    if (isDriver && profile?.id) {
      query = query.eq('assigned_driver', profile.id);
    }

    const { data: delData, error: delError } = await query;

    if (delError) {
      console.error('Failed to load deliveries:', delError.message);
      toast('error', 'Failed to load deliveries. Please try again.');
      setLoading(false);
      return;
    }

    const deliveryIds = (delData || []).map((d) => d.id);
    const countMap: Record<string, number> = {};
    if (deliveryIds.length > 0) {
      const { data: itemCounts } = await supabase
        .from('delivery_items')
        .select('delivery_id')
        .in('delivery_id', deliveryIds.slice(0, 500));
      (itemCounts || []).forEach((item) => {
        countMap[item.delivery_id] = (countMap[item.delivery_id] || 0) + 1;
      });
    }

    const rows = ((delData || []) as Array<Delivery & {
      customer: { farm_name: string } | null;
      driver: { full_name: string } | null;
    }>).map((d) => ({
      ...d,
      customer_name: d.customer?.farm_name || 'Unknown',
      driver_name: d.driver?.full_name || 'Unassigned',
      item_count: countMap[d.id] || 0,
    }));

    setDeliveries(rows);
    setLoading(false);
  };

  /* ─── Summary stats ─── */
  const todayStr = today();
  const weekStartStr = weekStart();

  const scheduledToday = deliveries.filter(
    (d) => d.scheduled_date === todayStr && (d.status === 'scheduled' || d.status === 'in_progress')
  ).length;
  const inProgress = deliveries.filter((d) => d.status === 'in_progress').length;
  const completedThisWeek = deliveries.filter(
    (d) => d.status === 'completed' && d.completed_at && d.completed_at.slice(0, 10) >= weekStartStr
  ).length;

  /* ─── 7-Day Schedule Strip ─── */
  const scheduleStrip = useMemo(() => {
    const strip = [];
    const t = today();
    for (let i = 0; i < 7; i++) {
      const d = addDays(t, i);
      const dayDeliveries = deliveries.filter(
        (del) => del.scheduled_date === d && del.status !== 'cancelled'
      );
      const unassigned = dayDeliveries.filter((del) => !del.assigned_driver).length;
      strip.push({ date: d, count: dayDeliveries.length, unassigned });
    }
    return strip;
  }, [deliveries]);

  /* ─── Filtering ─── */
  const filtered = useMemo(() => {
    return deliveries.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (driverFilter && d.assigned_driver !== driverFilter) return false;
      if (priorityFilter && d.priority !== priorityFilter) return false;
      if (customerFilter && d.customer_id !== customerFilter) return false;

      // Date filtering
      if (scheduleDate) {
        if (d.scheduled_date !== scheduleDate) return false;
      } else if (datePreset === 'today') {
        if (d.scheduled_date !== todayStr) return false;
      } else if (datePreset === 'week') {
        if (d.scheduled_date < weekStartStr || d.scheduled_date > addDays(weekStartStr, 6)) return false;
      } else if (datePreset === 'future') {
        if (d.scheduled_date < todayStr) return false;
      }

      return true;
    });
  }, [deliveries, statusFilter, driverFilter, datePreset, priorityFilter, customerFilter, scheduleDate, todayStr, weekStartStr]);

  /* ─── Batch actions ─── */
  const selectedDeliveries = deliveries.filter((d) => selected.has(d.id));
  const selectedCancellable = selectedDeliveries.filter((d) => SELECTABLE_STATUSES.includes(d.status));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const selectable = filtered.filter((d) => SELECTABLE_STATUSES.includes(d.status));
    if (selected.size === selectable.length && selectable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((d) => d.id)));
    }
  };

  const handleBatchCancel = async (reason: string) => {
    const ids = selectedCancellable.map((d) => d.id);
    if (ids.length === 0) {
      toast('error', 'No cancellable deliveries selected');
      return;
    }
    setCancelling(true);
    try {
      const cancelKey = generateIdempotencyKey('batch_cancel_deliveries', profile?.id || '');
      const { data, error } = await supabase.rpc('batch_cancel_deliveries', {
        p_delivery_ids: ids,
        p_cancel_reason: reason,
        p_performed_by: profile?.id,
        p_idempotency_key: cancelKey,
      });
      if (error) {
        console.error('Batch cancel failed:', error.message);
        toast('error', sanitizeError(error));
      } else {
        toast('success', `Cancelled ${data} delivery(ies)`);
        setSelected(new Set());
        fetchDeliveries();
      }
    } catch (err: unknown) {
      console.error('Batch cancel error:', err);
      toast('error', sanitizeError(err));
    }
    setShowCancelModal(false);
    setCancelling(false);
  };

  const handleBatchPrint = async () => {
    setPrinting(true);
    try {
      const { generateBatchDeliveryPdf } = await import('../lib/deliveryPdf');
      const pdfDataList = [];

      for (const del of selectedDeliveries) {
        const { data: items } = await supabase
          .from('delivery_items')
          .select('*, product:products(product_name)')
          .eq('delivery_id', del.id)
          .order('sort_order');

        const delAny = del as unknown as Record<string, unknown>;
        pdfDataList.push({
          delivery_number: del.delivery_number,
          order_number: (delAny.order_number as string) || '-',
          customer_name: del.customer_name,
          customer_address: (delAny.delivery_address as string) || undefined,
          driver_name: del.driver_name,
          scheduled_date: del.scheduled_date,
          completed_at: del.completed_at || undefined,
          status: del.status,
          signed_by: del.signed_by || undefined,
          delivery_notes: del.delivery_notes || undefined,
          priority: del.priority || 'normal',
          issue_type: del.issue_type || undefined,
          issue_notes: del.issue_notes || undefined,
          items: ((items || []) as Array<Record<string, unknown> & { product?: { product_name?: string } }>).map((it) => ({
            product_name: it.product?.product_name || (it.product_name as string),
            quantity: it.quantity as number,
            unit_size: (it.unit_size as string) || '-',
            quantity_delivered: it.quantity_delivered as number,
          })),
        });
      }

      if (pdfDataList.length === 0) {
        toast('error', 'No deliveries to print');
        setPrinting(false);
        return;
      }

      await generateBatchDeliveryPdf(pdfDataList);
      toast('success', `Printed ${pdfDataList.length} delivery receipt(s) to PDF`);
    } catch (err: unknown) {
      console.error('Batch print failed:', err);
      toast('error', sanitizeError(err));
    }
    setPrinting(false);
  };

  const handleBatchReschedule = async () => {
    if (!rescheduleDate) {
      toast('error', 'Please select a new date');
      return;
    }
    setRescheduling(true);
    try {
      const ids = selectedCancellable.map((d) => d.id);
      const rescheduleKey = generateIdempotencyKey('batch_reschedule_deliveries', profile?.id || '');
      const { error } = await supabase.rpc('batch_reschedule_deliveries', {
        p_delivery_ids: ids,
        p_new_date: rescheduleDate,
        p_performed_by: profile?.id,
        p_idempotency_key: rescheduleKey,
      });
      if (error) {
        toast('error', sanitizeError(error));
      } else {
        toast('success', `Rescheduled ${ids.length} delivery(ies) to ${new Date(rescheduleDate).toLocaleDateString()}`);
        setSelected(new Set());
        setShowReschedule(false);
        setRescheduleDate('');
        fetchDeliveries();
      }
    } catch (err: unknown) {
      console.error('Batch reschedule error:', err);
      toast('error', sanitizeError(err));
    }
    setRescheduling(false);
  };

  const handleExportCSV = () => {
    exportToCSV(selectedDeliveries as unknown as Record<string, unknown>[], [
      { key: 'delivery_number', header: 'Delivery #' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'driver_name', header: 'Driver' },
      { key: 'scheduled_date', header: 'Scheduled', format: (v) => fmtDateCSV(v as string) },
      { key: 'priority', header: 'Priority' },
      { key: 'status', header: 'Status' },
      { key: 'item_count', header: 'Items' },
      { key: 'completed_at', header: 'Completed', format: (v) => fmtDateCSV(v as string) },
    ], 'deliveries');
    toast('success', `Exported ${selectedDeliveries.length} delivery(ies) to CSV`);
  };

  /* ─── Driver Dashboard View ─── */
  if (isDriver) {
    const myToday = deliveries.filter(
      (d) => d.scheduled_date === todayStr && d.status !== 'cancelled' && d.status !== 'completed'
    );
    const myUpcoming = deliveries.filter(
      (d) => d.scheduled_date > todayStr && d.status !== 'cancelled' && d.status !== 'completed'
    );
    const myCompleted = deliveries.filter((d) => d.status === 'completed').slice(0, 10);

    const handleTakeDelivery = async (deliveryId: string) => {
      try {
        const reassignKey = generateIdempotencyKey('reassign_delivery', profile?.id || '');
        const { error } = await supabase.rpc('reassign_delivery', {
          p_delivery_id: deliveryId,
          p_new_driver: profile?.id,
          p_performed_by: profile?.id,
          p_idempotency_key: reassignKey,
        });
        if (error) {
          toast('error', sanitizeError(error));
        } else {
          toast('success', 'Delivery assigned to you');
          fetchDeliveries();
        }
      } catch (err: unknown) {
        console.error('Take delivery error:', err);
        toast('error', sanitizeError(err));
      }
    };

    const DriverCard = ({ d }: { d: DeliveryRow }) => (
      <div
        onClick={() => navigate(`/deliveries/${d.id}`)}
        className="bg-gray-800 rounded-xl p-4 space-y-2 cursor-pointer active:bg-gray-700 transition-colors"
      >
        <div className="flex items-center justify-between">
          <span className="text-white font-semibold">{d.delivery_number}</span>
          <Badge variant={statusToBadgeVariant[d.status] || 'default'}>{d.status.replace('_', ' ')}</Badge>
        </div>
        <p className="text-gray-300 text-sm">{d.customer_name}</p>
        {(d as unknown as Record<string, unknown>).delivery_address ? (
          <div className="flex items-center gap-2 text-gray-400 text-xs">
            <MapPin className="w-3 h-3" />
            <span className="truncate">{String((d as unknown as Record<string, unknown>).delivery_address)}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            <span>{new Date(d.scheduled_date).toLocaleDateString()}</span>
          </div>
          {d.delivery_window_start && (
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>{d.delivery_window_start}{d.delivery_window_end ? ` - ${d.delivery_window_end}` : ''}</span>
            </div>
          )}
          <span>{d.item_count} items</span>
        </div>
        {d.priority && d.priority !== 'normal' && (
          <div className="pt-1">{priorityBadge(d.priority)}</div>
        )}
        {d.status === 'scheduled' && (
          <p className="text-xs text-emerald-400 font-medium pt-1">Tap to start delivery &rarr;</p>
        )}
        {d.status === 'in_progress' && (
          <p className="text-xs text-amber-400 font-medium pt-1">Ready to complete &rarr;</p>
        )}
      </div>
    );

    return (
      <div className="space-y-6 bg-gray-900 -m-4 sm:-m-6 p-4 sm:p-6 min-h-screen">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">My Deliveries</h1>
          <div className="flex items-center gap-2">
            {canQuickDeliver && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Zap className="w-4 h-4" />}
                onClick={() => setQuickDeliveryOpen(true)}
              >
                Quick Delivery
              </Button>
            )}
            <Badge variant="info">{deliveries.filter((d) => d.status !== 'cancelled' && d.status !== 'completed').length} Active</Badge>
          </div>
        </div>

        {/* Today */}
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Today</h2>
          {myToday.length === 0 ? (
            <p className="text-gray-500 text-sm">No deliveries scheduled for today.</p>
          ) : (
            <div className="space-y-3">
              {myToday.map((d) => <DriverCard key={d.id} d={d} />)}
            </div>
          )}
        </div>

        {/* Upcoming */}
        {myUpcoming.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Upcoming</h2>
            <div className="space-y-3">
              {myUpcoming.map((d) => <DriverCard key={d.id} d={d} />)}
            </div>
          </div>
        )}

        {/* Completed */}
        {myCompleted.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Recently Completed</h2>
            <div className="space-y-3">
              {myCompleted.map((d) => <DriverCard key={d.id} d={d} />)}
            </div>
          </div>
        )}

        {/* Available (unassigned) */}
        {unassigned.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-3">
              Available Deliveries
            </h2>
            <div className="space-y-3">
              {unassigned.map((d) => (
                <div
                  key={d.id}
                  className="bg-gray-800 border border-amber-700/30 rounded-xl p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-white font-semibold">{d.delivery_number}</span>
                    <Badge variant="warning">Unassigned</Badge>
                  </div>
                  <p className="text-gray-300 text-sm">{d.customer_name}</p>
                  <div className="flex items-center gap-2 text-gray-400 text-xs">
                    <Calendar className="w-3 h-3" />
                    <span>{new Date(d.scheduled_date).toLocaleDateString()}</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); handleTakeDelivery(d.id); }}
                    className="w-full mt-2"
                  >
                    Take This Delivery
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Delivery Modal */}
        <QuickDeliveryModal
          open={quickDeliveryOpen}
          onClose={() => setQuickDeliveryOpen(false)}
        />
      </div>
    );
  }

  /* ─── Admin / Sales Rep View ─── */
  const columns: Column<DeliveryRow>[] = [
    {
      key: 'id',
      header: '',
      className: 'w-10',
      render: (row) =>
        SELECTABLE_STATUSES.includes(row.status) ? (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={(e) => { e.stopPropagation(); toggleSelect(row.id); }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
          />
        ) : null,
    },
    {
      key: 'delivery_number',
      header: 'Delivery #',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Truck className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.delivery_number}</span>
        </div>
      ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
    },
    {
      key: 'driver_name',
      header: 'Driver',
      sortable: true,
      render: (row) => (
        <span className={!row.assigned_driver ? 'text-amber-600 font-medium' : ''}>
          {row.driver_name}
        </span>
      ),
    },
    {
      key: 'scheduled_date',
      header: 'Scheduled',
      sortable: true,
      render: (row) => {
        const d = new Date(row.scheduled_date);
        const window = row.delivery_window_start
          ? ` ${row.delivery_window_start}${row.delivery_window_end ? '-' + row.delivery_window_end : ''}`
          : '';
        return (
          <span>
            {d.toLocaleDateString()}
            {window && <span className="text-xs text-secondary ml-1">{window}</span>}
          </span>
        );
      },
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      render: (row) => priorityBadge(row.priority || 'normal'),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'item_count',
      header: 'Items',
      sortable: true,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header + Actions */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Deliveries</h1>
        <div className="flex gap-2 flex-wrap justify-end">
          {selected.size > 0 && (
            <>
              <Button
                variant="secondary"
                icon={<Download className="w-4 h-4" />}
                onClick={handleExportCSV}
              >
                Export CSV
              </Button>
              <Button
                variant="secondary"
                icon={<Printer className="w-4 h-4" />}
                onClick={handleBatchPrint}
                loading={printing}
              >
                Print {selected.size} Selected
              </Button>
              {selectedCancellable.length > 0 && (
                <Button
                  variant="danger"
                  icon={<XCircle className="w-4 h-4" />}
                  onClick={() => setShowCancelModal(true)}
                >
                  Cancel {selectedCancellable.length} Selected
                </Button>
              )}
              {selectedCancellable.length > 0 && (
                <Button
                  variant="secondary"
                  icon={<CalendarRange className="w-4 h-4" />}
                  onClick={() => setShowReschedule(true)}
                >
                  Reschedule {selectedCancellable.length}
                </Button>
              )}
            </>
          )}
          {canQuickDeliver && (
            <Button
              variant="secondary"
              icon={<Zap className="w-4 h-4" />}
              onClick={() => setQuickDeliveryOpen(true)}
            >
              Quick Delivery
            </Button>
          )}
          {canCreate && (
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/deliveries/new')}>
              Schedule Delivery
            </Button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Scheduled Today</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">{scheduledToday}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <Truck className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">In Progress</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{inProgress}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Completed This Week</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{completedThisWeek}</p>
        </Card>
        <Card>
          <button
            onClick={() => navigate('/delivery-remainders')}
            className="w-full text-left"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <span className="text-sm text-secondary">Pending Remainders</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-red-600">{remainderCount}</p>
          </button>
        </Card>
      </div>

      {/* 7-Day Schedule Strip */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {scheduleStrip.map((day) => {
          const isToday = day.date === todayStr;
          const isActive = scheduleDate === day.date;
          return (
            <button
              key={day.date}
              onClick={() => setScheduleDate(isActive ? '' : day.date)}
              className={`flex-shrink-0 px-4 py-3 rounded-xl border text-center min-w-[100px] transition-all ${
                isActive
                  ? 'border-crx-green bg-crx-green-tint shadow-sm'
                  : isToday
                  ? 'border-blue-300 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`text-xs font-medium ${isToday ? 'text-blue-600' : 'text-secondary'}`}>
                {isToday ? 'TODAY' : dayLabel(day.date).split(',')[0]}
              </div>
              <div className={`text-xs ${isToday ? 'text-blue-500' : 'text-secondary'}`}>
                {dayLabel(day.date).split(' ').slice(1).join(' ')}
              </div>
              <div className={`text-lg font-bold mt-1 ${
                day.count === 0 ? 'text-gray-300' : isActive ? 'text-crx-green' : 'text-nav-dark'
              }`}>
                {day.count}
              </div>
              {day.unassigned > 0 && (
                <div className="text-[10px] text-amber-600 font-medium">{day.unassigned} unassigned</div>
              )}
            </button>
          );
        })}
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<DeliveryRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search deliveries..."
            searchKeys={['delivery_number', 'customer_name', 'driver_name']}
            onRowClick={(row) => navigate(`/deliveries/${row.id}`)}
            emptyTitle="No deliveries"
            emptyDescription="Schedule a delivery from an order"
            loading={loading}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by delivery status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select
                  value={driverFilter}
                  onChange={(e) => setDriverFilter(e.target.value)}
                  aria-label="Filter by driver"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Drivers</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.full_name}</option>
                  ))}
                </select>
                <select
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                  aria-label="Filter by priority"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Priorities</option>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <select
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                  aria-label="Filter by customer"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Customers</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.farm_name}</option>
                  ))}
                </select>
                <select
                  value={scheduleDate ? 'custom' : datePreset}
                  onChange={(e) => {
                    setScheduleDate('');
                    setDatePreset(e.target.value === 'custom' ? '' : e.target.value);
                  }}
                  aria-label="Filter by date range"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {DATE_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                  {scheduleDate && <option value="custom">{dayLabel(scheduleDate)}</option>}
                </select>
                {filtered.some((d) => SELECTABLE_STATUSES.includes(d.status)) && (
                  <button
                    onClick={toggleAll}
                    className="text-xs text-crx-green hover:underline ml-2"
                  >
                    {selected.size > 0 ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      {/* Batch Cancel Modal */}
      <BatchCancelModal
        open={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        count={selectedCancellable.length}
        onConfirm={handleBatchCancel}
        loading={cancelling}
      />

      {/* Reschedule Modal (inline) */}
      {showReschedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <h3 className="text-lg font-semibold text-nav-dark">Reschedule Deliveries</h3>
            <p className="text-sm text-secondary">
              Select a new date for {selectedCancellable.length} delivery{selectedCancellable.length !== 1 ? 'ies' : ''}.
            </p>
            <input
              type="date"
              value={rescheduleDate}
              onChange={(e) => setRescheduleDate(e.target.value)}
              min={todayStr}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => { setShowReschedule(false); setRescheduleDate(''); }}>
                Cancel
              </Button>
              <Button onClick={handleBatchReschedule} loading={rescheduling} disabled={!rescheduleDate}>
                Reschedule
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Delivery Modal */}
      <QuickDeliveryModal
        open={quickDeliveryOpen}
        onClose={() => setQuickDeliveryOpen(false)}
      />
    </div>
  );
}
