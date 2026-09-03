import { useEffect, useState, useMemo , useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Truck,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  CalendarRange,
  MapPin,
  Clock,
  Zap,
  Download,
  FileText,
  Users,
  List,
  CalendarDays,
  PanelRightOpen,
} from 'lucide-react';
import Card from '../components/ui/Card';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { notifyDeliveryCompleted } from '../lib/notificationTriggers';
import BatchCancelModal from '../components/deliveries/BatchCancelModal';
import QuickDeliveryModal from '../components/deliveries/QuickDeliveryModal';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { localToday, parseLocalDate, formatLocalDate } from '../lib/dateUtils';
import { sumNeedByProduct, type ProductLineNeed } from '../lib/inventoryShortage';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import DeliveryCalendar from '../components/deliveries/DeliveryCalendar';
import type { Delivery, Profile } from '../types';

/* ─── Row type ─── */
interface DeliveryRow extends Delivery {
  customer_name: string;
  driver_name: string;
  item_count: number;
  farm_group_name: string | null;
}

/* ─── Helpers ─── */
const today = () => localToday();
const addDays = (d: string, n: number) => {
  const dt = parseLocalDate(d);
  dt.setDate(dt.getDate() + n);
  return formatLocalDate(dt);
};
const weekStart = () => {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return formatLocalDate(d);
};
const dayLabel = (d: string) => {
  const dt = parseLocalDate(d);
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

// Default list order keeps today's work first, followed by upcoming then recent past deliveries.
const compareDefaultDeliveryOrder = (a: DeliveryRow, b: DeliveryRow, todayDate: string) => {
  const bucketFor = (scheduledDate: string) => (
    scheduledDate === todayDate ? 1 : scheduledDate > todayDate ? 2 : 3
  );
  const aBucket = bucketFor(a.scheduled_date);
  const bBucket = bucketFor(b.scheduled_date);
  if (aBucket !== bBucket) return aBucket - bBucket;

  if (a.scheduled_date !== b.scheduled_date) {
    return aBucket === 3
      ? b.scheduled_date.localeCompare(a.scheduled_date)
      : a.scheduled_date.localeCompare(b.scheduled_date);
  }

  const numberComparison = String(a.delivery_number ?? a.id).localeCompare(String(b.delivery_number ?? b.id));
  return numberComparison || a.id.localeCompare(b.id);
};

const SELECTABLE_STATUSES = ['scheduled', 'in_progress'];
const DATE_PRESETS = [
  { value: '', label: 'All Dates' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'future', label: 'Upcoming' },
];

export default function Deliveries() {
  const { role, profile, deniedPages } = useAuth();
  const batchCancelIdem = useIdempotencyKey('batch_cancel_deliveries', profile?.id || '');
  const batchRescheduleIdem = useIdempotencyKey('batch_reschedule_deliveries', profile?.id || '');
  const reassignIdem = useIdempotencyKey('reassign_delivery', profile?.id || '');
  // F3 act-from-list: complete an in_progress delivery in place (signed-by popup).
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  const [completeTarget, setCompleteTarget] = useState<DeliveryRow | null>(null);
  // Send the in-app completion notification at most once per delivery. complete_delivery
  // is idempotent but returns no replay marker, so a same-key retry after a lost
  // response replays its cached success; the stable delivery id avoids duplicate
  // driver/admin notifications on that replay (Codex P2).
  const notifiedCompletionFor = useRef<Set<string>>(new Set());
  const [signedBy, setSignedBy] = useState('');
  const [deliveredOnDate, setDeliveredOnDate] = useState(today());
  const [completing, setCompleting] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  /* Batch selection */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [printingLoadSheet, setPrintingLoadSheet] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');

  // Codex P2 fix (PR #59, 2026-05-16): reset batchRescheduleIdem when the
  // selection or target date changes. Same response-lost replay bug pattern
  // as the BlendTickets/Invoices batch ops — stable selection+date = same
  // key = idempotent retry; different selection or date = fresh intent.
  const rescheduleIntentKey = `${Array.from(selected).sort().join(',')}|${rescheduleDate}`;
  useEffect(() => {
    batchRescheduleIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescheduleIntentKey]);

  const [rescheduling, setRescheduling] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  /* Quick Delivery modal */
  const [quickDeliveryOpen, setQuickDeliveryOpen] = useState(false);
  const [quickDeliveryInitialCustomerId, setQuickDeliveryInitialCustomerId] = useState<string>();

  /* View mode: list or calendar */
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');

  /* Remainder count for summary */
  const [remainderCount, setRemainderCount] = useState(0);

  /* Inventory shortage tracking */
  const [shortageDeliveryIds, setShortageDeliveryIds] = useState<Set<string>>(new Set());

  /* Driver-specific: unassigned deliveries they can claim */
  const [unassigned, setUnassigned] = useState<DeliveryRow[]>([]);

  const canCreate = role === 'admin' || role === 'sales_rep';
  const canQuickDeliver = role === 'admin' || role === 'sales_rep';
  const isDriver = role === 'driver';
  // Customer 360 peek shows AR balance + credit tier. Gate it with the canonical
  // customers-page permission: this blocks drivers (not in the page's roles — Codex
  // P1) AND a sales rep who has /customers in their deny-list (Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');

  // Consume a Quick Delivery deep link per navigation. The param strip is the
  // re-entry guard; a repeat deep link re-adds the param and re-opens the modal.
  useEffect(() => {
    if (searchParams.get('quickDeliver') !== '1') return;
    if (!role) return;

    if (canQuickDeliver) {
      setQuickDeliveryInitialCustomerId(searchParams.get('customer_id') || undefined);
      setQuickDeliveryOpen(true);
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('quickDeliver');
    nextSearchParams.delete('customer_id');
    setSearchParams(nextSearchParams, { replace: true });
  }, [canQuickDeliver, role, searchParams, setSearchParams]);

  const closeQuickDelivery = () => {
    setQuickDeliveryOpen(false);
    setQuickDeliveryInitialCustomerId(undefined);
  };

  const fetchDrivers = useCallback(async () => {
    // PR-07 follow-up: driver filter dropdown only uses d.id + d.full_name; safe via view.
    const { data, error } = await supabase
      .from('profile_public_view')
      .select('id, full_name, role, is_active')
      .eq('role', 'driver')
      .eq('is_active', true)
      .order('full_name');
    if (error) {
      toast('error', 'Failed to load drivers: ' + error.message);
      return;
    }
    setDrivers((data || []) as Profile[]);
  }, [toast]);

  const fetchCustomers = useCallback(async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .limit(500);
    if (error) {
      toast('error', 'Failed to load customers: ' + error.message);
      return;
    }
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  }, [toast]);

  const fetchRemainderCount = useCallback(async () => {
    const { count, error } = await supabase
      .from('delivery_remainders')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'deliveries' } });
      return;
    }
    setRemainderCount(count || 0);
  }, []);

  const fetchDeliveries = useCallback(async () => {
    // PR-07 follow-up: dropped `driver:profiles!fk(full_name)` embed; driver
    // names resolved via profile_public_view post-fetch (see below).
    let query = supabase
      .from('deliveries')
      .select('*, customer:customers(farm_name, parent_customer_id)')
      .order('scheduled_date', { ascending: false })
      .limit(500);

    if (statusFilter === 'cancelled' || statusFilter === 'voided') {
      query = query.eq('status', statusFilter);
    } else {
      query = query.not('status', 'in', '("cancelled","voided")');
    }

    // Driver sees only their deliveries
    if (isDriver && profile?.id) {
      query = query.eq('assigned_driver', profile.id);
    }

    const { data: delData, error: delError } = await query;

    if (delError) {
      Sentry.captureException(delError, { tags: { source: 'fetch', page: 'deliveries' } });
      toast('error', 'Failed to load deliveries. Please try again.');
      setLoading(false);
      return;
    }

    const deliveryIds = (delData || []).map((d) => d.id);

    // Fetch parent customer names for farm group labels
    const parentIds = [...new Set(
      (delData || [])
        .map((d: Record<string, unknown>) => (d.customer as { parent_customer_id?: string })?.parent_customer_id)
        .filter(Boolean) as string[]
    )];

    // PR-07 follow-up: resolve driver names via profile_public_view (safe
    // columns only) so non-admin users still see driver names after
    // profiles_select tightens to admin-or-self.
    const driverIds = [...new Set(
      (delData || [])
        .map((d: Record<string, unknown>) => d.assigned_driver as string | null)
        .filter(Boolean) as string[]
    )];

    // Run all post-fetch queries in parallel — they depend on delData but not each other
    const [itemCountsResult, parentsResult, driversResult] = await Promise.all([
      deliveryIds.length > 0
        ? supabase
            .from('delivery_items')
            .select('delivery_id')
            .in('delivery_id', deliveryIds.slice(0, 500))
        : Promise.resolve({ data: null, error: null }),
      parentIds.length > 0
        ? supabase
            .from('customers')
            .select('id, farm_name')
            .in('id', parentIds)
        : Promise.resolve({ data: null, error: null }),
      driverIds.length > 0
        ? supabase
            .from('profile_public_view')
            .select('id, full_name')
            .in('id', driverIds)
        : Promise.resolve({ data: null, error: null }),
    ]);

    const countMap: Record<string, number> = {};
    const { data: itemCounts, error: itemCountErr } = itemCountsResult;
    if (itemCountErr) {
      Sentry.captureException(itemCountErr, { tags: { source: 'fetch', page: 'deliveries' } });
    }
    (itemCounts || []).forEach((item: { delivery_id: string }) => {
      countMap[item.delivery_id] = (countMap[item.delivery_id] || 0) + 1;
    });

    const parentNameMap: Record<string, string> = {};
    const { data: parents, error: parentErr } = parentsResult;
    if (parentErr) {
      Sentry.captureException(parentErr, { tags: { source: 'fetch', page: 'deliveries' } });
    }
    (parents || []).forEach((p: { id: string; farm_name: string }) => { parentNameMap[p.id] = p.farm_name; });

    const driverNameMap: Record<string, string> = {};
    const { data: drivers } = driversResult;
    ((drivers || []) as Array<{ id: string; full_name: string }>).forEach((d) => { driverNameMap[d.id] = d.full_name; });

    const rows = ((delData || []) as Array<Delivery & {
      customer: { farm_name: string; parent_customer_id: string | null } | null;
    }>).map((d) => ({
      ...d,
      customer_name: d.customer?.farm_name || 'Unknown',
      driver_name: d.assigned_driver ? (driverNameMap[d.assigned_driver] || 'Unknown driver') : 'Unassigned',
      item_count: countMap[d.id] || 0,
      farm_group_name: d.customer?.parent_customer_id ? parentNameMap[d.customer.parent_customer_id] || null : null,
    }));

    const todayForSort = today();
    setDeliveries(rows.sort((a, b) => compareDefaultDeliveryOrder(a, b, todayForSort)));

    // Inventory shortage check for active (non-completed) deliveries
    const activeIds = rows
      .filter((d) => d.status === 'scheduled' || d.status === 'in_progress')
      .map((d) => d.id);

    if (activeIds.length > 0) {
      try {
        const { data: diData } = await supabase
          .from('delivery_items')
          .select('delivery_id, product_id, quantity')
          .in('delivery_id', activeIds.slice(0, 500));

        const productIds = [...new Set((diData || []).map((i: { product_id: string }) => i.product_id).filter(Boolean))];

        if (productIds.length > 0) {
          const { data: invData } = await supabase
            .from('inventory')
            .select('product_id, quantity_available')
            .in('product_id', productIds)
            .eq('location', 'Main Warehouse');

          const invMap: Record<string, number> = {};
          for (const row of (invData || []) as Array<{ product_id: string; quantity_available: number }>) {
            invMap[row.product_id] = (invMap[row.product_id] || 0) + Number(row.quantity_available);
          }

          // Sum each product across the delivery's lines BEFORE comparing to
          // stock. A tier-split booking puts the same product on several lines,
          // so checking each line alone lets two half-sized lines both look
          // covered when together they are not. See src/lib/inventoryShortage.ts.
          const linesByDelivery = new Map<string, ProductLineNeed[]>();
          for (const item of (diData || []) as Array<{ delivery_id: string; product_id: string; quantity: number }>) {
            const lines = linesByDelivery.get(item.delivery_id);
            const line = { productId: item.product_id, label: '', quantity: Number(item.quantity) };
            if (lines) lines.push(line);
            else linesByDelivery.set(item.delivery_id, [line]);
          }

          const shortageIds = new Set<string>();
          for (const [deliveryId, lines] of linesByDelivery) {
            for (const need of sumNeedByProduct(lines)) {
              if ((invMap[need.productId] ?? 0) < need.quantity) {
                shortageIds.add(deliveryId);
                break;
              }
            }
          }
          setShortageDeliveryIds(shortageIds);
        } else {
          setShortageDeliveryIds(new Set());
        }
      } catch {
        setShortageDeliveryIds(new Set());
      }
    } else {
      setShortageDeliveryIds(new Set());
    }

    setLoading(false);
  }, [isDriver, profile, statusFilter, toast]);

  // F3 act-from-list: complete a delivery in full, in place. Scheduled deliveries
  // are confirmed first; p_quantities omitted = deliver in full. Partial deliveries,
  // signature image, and issue flags stay on the detail page.
  const handleCompleteConfirm = async () => {
    if (!completeTarget || !profile) return;
    if (!signedBy.trim()) { toast('error', 'Please enter a signature name'); return; }
    const target = completeTarget;
    const idemKey = completeIdem.getKey();
    let confirmed = false;
    // Route through runCriticalAction for parity with this page's other mutations.
    const completed = await runCriticalAction({
      action: async () => {
        if (target.status === 'scheduled') {
          const { data, error } = await supabase.rpc('confirm_delivery', {
            p_delivery_id: target.id,
            p_idempotency_key: confirmIdem.getKey(),
          });
          if (error) throw error;
          assertRpcResult(data, 'confirm_delivery');
          confirmIdem.resetKey();
          confirmed = true;
        }

        // completeIdem is intentionally retained until onSuccess, so a retry after a
        // lost response replays the same complete_delivery request idempotently.
        const { data, error } = await supabase.rpc('complete_delivery', {
          p_delivery_id: target.id,
          p_signed_by: signedBy.trim(),
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          // Use local midday so the ISO timestamp stays on the selected delivery date.
          ...(deliveredOnDate && deliveredOnDate !== today()
            ? { p_completed_at: new Date(deliveredOnDate + 'T12:00:00').toISOString() }
            : {}),
        });
        if (error) throw error;
        assertRpcResult(data, 'complete_delivery');
        return true;
      },
      toast,
      setLoading: setCompleting,
      successMessage: `Delivery ${target.delivery_number} completed`,
      sentryTag: 'complete_delivery',
      onSuccess: () => {
        completeIdem.resetKey();
        // Fire the same in-app completion notification the detail page sends
        // (driver/admins/sales) — once per delivery so a same-key RPC replay after
        // a lost response can't duplicate it. The customer EMAIL receipt is sent
        // from the delivery's page (rich HTML w/ items+photos the list doesn't
        // load) — see the modal note. Fire-and-forget; never blocks the success path.
        if (!notifiedCompletionFor.current.has(target.id)) {
          notifiedCompletionFor.current.add(target.id);
          notifyDeliveryCompleted(target.id, target.delivery_number, target.customer_name, target.assigned_driver, target.order_id, false).catch(() => { /* non-critical */ });
        }
        setCompleteTarget(null);
        setSignedBy('');
        setDeliveredOnDate(today());
        fetchDeliveries();
      },
    });

    if (!completed && confirmed) {
      // Confirm succeeded so the delivery is now in_progress; keep the modal open
      // with the SAME retained complete-key (completeIdem only resets on success)
      // so a retry replays idempotently. If the failed call actually committed
      // server-side, the replay returns the cached result and onSuccess (including
      // the completion notification) still fires.
      setCompleteTarget((prev) => (prev && prev.id === target.id ? { ...prev, status: 'in_progress' } : prev));
      await fetchDeliveries();
    }
  };

  useEffect(() => {
    fetchDeliveries();
    fetchDrivers();
    fetchCustomers();
    fetchRemainderCount();
  }, [fetchDeliveries, fetchDrivers, fetchCustomers, fetchRemainderCount]);

  // Fetch unassigned deliveries for driver dashboard
  useEffect(() => {
    if (!isDriver) return;
    (async () => {
      const { data, error: unassignedErr } = await supabase
        .from('deliveries')
        .select('*, customer:customers(farm_name, parent_customer_id)')
        .is('assigned_driver', null)
        .in('status', ['scheduled'])
        .order('scheduled_date')
        .limit(20);
      if (unassignedErr) {
        Sentry.captureException(unassignedErr, { tags: { source: 'fetch', page: 'deliveries' } });
        return;
      }
      const pIds = [...new Set(
        (data || []).map((d: Record<string, unknown>) => (d.customer as { parent_customer_id?: string })?.parent_customer_id).filter(Boolean) as string[]
      )];
      const pMap: Record<string, string> = {};
      if (pIds.length > 0) {
        const { data: parents, error: pErr } = await supabase.from('customers').select('id, farm_name').in('id', pIds);
        if (pErr) Sentry.captureException(pErr, { tags: { source: 'fetch', page: 'deliveries' } });
        (parents || []).forEach((p) => { pMap[p.id] = p.farm_name; });
      }
      const rows = (data || []).map((d) => {
        const cust = d.customer as { farm_name?: string; parent_customer_id?: string } | null;
        return {
          ...d,
          customer_name: cust?.farm_name || 'Unknown',
          driver_name: 'Unassigned',
          item_count: 0,
          farm_group_name: cust?.parent_customer_id ? pMap[cust.parent_customer_id] || null : null,
        };
      });
      setUnassigned(rows as DeliveryRow[]);
    })();
  }, [isDriver]);

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
    if (!profile) {
      toast('error', 'Cannot cancel deliveries — profile not loaded. Please refresh.');
      return;
    }
    const ids = selectedCancellable.map((d) => d.id);
    if (ids.length === 0) {
      toast('error', 'No cancellable deliveries selected');
      return;
    }
    await runCriticalAction({
      action: async () => {
        const cancelKey = batchCancelIdem.getKey();
        const { data, error } = await supabase.rpc('batch_cancel_deliveries', {
          p_delivery_ids: ids,
          p_cancel_reason: reason,
          p_performed_by: profile.id,
          p_idempotency_key: cancelKey,
        });
        if (error) throw error;
        const cancelResult = assertRpcResult(data, 'batch_cancel_deliveries');
        batchCancelIdem.resetKey();
        logActivity({ event: 'batch_cancel_deliveries', description: `Batch cancelled ${ids.length} delivery(ies). Reason: ${reason}`, performedBy: profile.id });
        return cancelResult;
      },
      toast,
      successMessage: `Cancelled ${ids.length} delivery(ies)`,
      setLoading: setCancelling,
      sentryTag: 'batch_cancel_deliveries',
      onSuccess: () => {
        setSelected(new Set());
        fetchDeliveries();
      },
    });
    setShowCancelModal(false);
  };

  const handlePrintLoadSheet = async () => {
    await runCriticalAction({
      action: async () => {
        const { generateBatchDeliveryPdf } = await import('../lib/deliveryPdf');

        // Use selected deliveries, or all filtered scheduled/in_progress for today
        const rows = selected.size > 0
          ? selectedDeliveries
          : filtered.filter((d) => d.status === 'scheduled' || d.status === 'in_progress');

        if (rows.length === 0) {
          throw new Error('No deliveries to include in load sheet');
        }

        // Batch-fetch customer contact info, addresses, and order numbers
        const customerIds = [...new Set(rows.map((d) => d.customer_id).filter(Boolean))];
        const orderIds = [...new Set(rows.map((d) => d.order_id).filter(Boolean))];
        const addressIds = [...new Set(
          rows.map((d) => (d as unknown as Record<string, unknown>).delivery_address_id as string)
            .filter(Boolean),
        )];

        const [customerResult, orderResult, addressResult] = await Promise.all([
          customerIds.length > 0
            ? supabase.from('customers').select('id, contact_name, phone, shipping_address, billing_address').in('id', customerIds)
            : Promise.resolve({ data: null, error: null }),
          orderIds.length > 0
            ? supabase.from('orders').select('id, order_number').in('id', orderIds)
            : Promise.resolve({ data: null, error: null }),
          addressIds.length > 0
            ? supabase.from('customer_addresses').select('id, address_line, city, state, zip').in('id', addressIds)
            : Promise.resolve({ data: null, error: null }),
        ]);

        const { data: customerData, error: customerErr } = customerResult;
        if (customerErr) Sentry.captureException(customerErr, { tags: { source: 'load_sheet', page: 'deliveries' } });
        const { data: orderData, error: orderErr } = orderResult;
        if (orderErr) Sentry.captureException(orderErr, { tags: { source: 'load_sheet', page: 'deliveries' } });
        const { data: addressData, error: addressErr } = addressResult;
        if (addressErr) Sentry.captureException(addressErr, { tags: { source: 'load_sheet', page: 'deliveries' } });

        const customerMap: Record<string, { contact_name: string | null; phone: string | null; shipping_address: string | null; billing_address: string | null }> = {};
        ((customerData || []) as Array<{ id: string; contact_name: string | null; phone: string | null; shipping_address: string | null; billing_address: string | null }>).forEach((c) => {
          customerMap[c.id] = { contact_name: c.contact_name, phone: c.phone, shipping_address: c.shipping_address, billing_address: c.billing_address };
        });

        const orderMap: Record<string, string> = {};
        ((orderData || []) as Array<{ id: string; order_number: string }>).forEach((o) => {
          orderMap[o.id] = o.order_number;
        });

        const addressMap: Record<string, string> = {};
        ((addressData || []) as Array<{ id: string; address_line: string | null; city: string | null; state: string | null; zip: string | null }>).forEach((a) => {
          const parts = [a.address_line, a.city, a.state, a.zip].filter(Boolean);
          addressMap[a.id] = parts.join(', ');
        });

        // Build PdfDeliveryData for each delivery (same format as Receipt PDF)
        const pdfDataList = [];
        for (const del of rows) {
          const { data: items } = await supabase
            .from('delivery_items')
            .select('*, product:products(product_name)')
            .eq('delivery_id', del.id)
            .order('id');

          const delAny = del as unknown as Record<string, unknown>;
          const custInfo = customerMap[del.customer_id] || { contact_name: null, phone: null, shipping_address: null, billing_address: null };

          // Address fallback: delivery address → customer shipping → customer billing
          const deliveryAddrId = delAny.delivery_address_id as string | null;
          const address = (deliveryAddrId && addressMap[deliveryAddrId])
            || custInfo.shipping_address
            || custInfo.billing_address
            || undefined;

          pdfDataList.push({
            delivery_number: del.delivery_number,
            order_number: del.order_id ? (orderMap[del.order_id] || '-') : '-',
            customer_name: del.customer_name,
            customer_address: address,
            contact_name: custInfo.contact_name || undefined,
            contact_phone: custInfo.phone || undefined,
            driver_name: del.driver_name,
            scheduled_date: del.scheduled_date,
            completed_at: del.completed_at || undefined,
            status: del.status,
            signed_by: del.signed_by || undefined,
            delivery_notes: del.delivery_notes || undefined,
            priority: del.priority || 'normal',
            issue_type: del.issue_type || undefined,
            issue_notes: del.issue_notes || undefined,
            items: ((items || []) as Array<Record<string, unknown> & { product?: { product_name?: string } }>)
              .map((it) => ({
                product_name: it.product?.product_name || (it.product_name as string) || 'Unknown',
                quantity: it.quantity as number,
                unit_size: (it.unit_size as string) || '-',
                quantity_delivered: (it.quantity_delivered as number) || undefined,
                tote_number: (it.tote_number as string) || undefined,
              }))
              .sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '')),
          });
        }

        if (pdfDataList.length === 0) {
          throw new Error('No deliveries to print');
        }

        await generateBatchDeliveryPdf(pdfDataList);
      },
      toast,
      successMessage: 'Delivery receipt(s) generated',
      setLoading: setPrintingLoadSheet,
      sentryTag: 'print_load_sheet',
    });
  };

  const handleBatchReschedule = async () => {
    if (!rescheduleDate) {
      toast('error', 'Please select a new date');
      return;
    }
    if (!profile) {
      toast('error', 'Cannot reschedule deliveries — profile not loaded. Please refresh.');
      return;
    }
    const ids = selectedCancellable.map((d) => d.id);
    await runCriticalAction({
      action: async () => {
        const rescheduleKey = batchRescheduleIdem.getKey();
        const { data, error } = await supabase.rpc('batch_reschedule_deliveries', {
          p_delivery_ids: ids,
          p_new_date: rescheduleDate,
          p_performed_by: profile.id,
          p_idempotency_key: rescheduleKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'batch_reschedule_deliveries');
        batchRescheduleIdem.resetKey();
        logActivity({ event: 'batch_reschedule_deliveries', description: `Rescheduled ${ids.length} delivery(ies) to ${rescheduleDate}`, performedBy: profile.id });
      },
      toast,
      successMessage: `Rescheduled ${ids.length} delivery(ies) to ${parseLocalDate(rescheduleDate).toLocaleDateString()}`,
      setLoading: setRescheduling,
      sentryTag: 'batch_reschedule_deliveries',
      onSuccess: () => {
        setSelected(new Set());
        setShowReschedule(false);
        setRescheduleDate('');
        fetchDeliveries();
      },
    });
  };

  const handleExportCSV = () => {
    const rows = selected.size > 0 ? selectedDeliveries : filtered;
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      { key: 'delivery_number', header: 'Delivery #' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'driver_name', header: 'Driver' },
      { key: 'scheduled_date', header: 'Scheduled', format: (v) => fmtDateCSV(v as string) },
      { key: 'priority', header: 'Priority' },
      { key: 'status', header: 'Status' },
      { key: 'item_count', header: 'Items' },
      { key: 'completed_at', header: 'Completed', format: (v) => fmtDateCSV(v as string) },
    ], 'deliveries');
    toast('success', `Exported ${rows.length} delivery(ies) to CSV`);
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      const rows = selected.size > 0 ? selectedDeliveries : filtered;
      await downloadReportPdf({
        title: 'Deliveries',
        subtitle: `${rows.length} delivery(ies)`,
        columns: [
          { header: 'Delivery #', key: 'delivery_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Driver', key: 'driver_name' },
          { header: 'Scheduled', key: 'scheduled_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Priority', key: 'priority', format: (v) => v ? String(v) : 'normal' },
          { header: 'Status', key: 'status' },
          { header: 'Items', key: 'item_count', align: 'right' },
        ],
        data: rows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${rows.length} delivery(ies)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
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
      if (!profile) {
        toast('error', 'Cannot take delivery — profile not loaded. Please refresh.');
        return;
      }
      await runCriticalAction({
        action: async () => {
          const reassignKey = reassignIdem.getKey();
          const { data, error } = await supabase.rpc('reassign_delivery', {
            p_delivery_id: deliveryId,
            p_new_driver: profile.id,
            p_performed_by: profile.id,
            p_idempotency_key: reassignKey,
          });
          if (error) throw error;
          assertRpcResult(data, 'reassign_delivery');
          reassignIdem.resetKey();
          logActivity({ event: 'reassign_delivery', description: `Took delivery ${deliveryId}`, performedBy: profile.id, entityType: 'delivery', entityId: deliveryId });
        },
        toast,
        successMessage: 'Delivery assigned to you',
        sentryTag: 'take_delivery',
        onSuccess: () => fetchDeliveries(),
      });
    };

    const DriverCard = ({ d }: { d: DeliveryRow }) => (
      <div
        role="button"
        tabIndex={0}
        onClick={() => navigate(`/deliveries/${d.id}`)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/deliveries/${d.id}`); } }}
        className="bg-gray-800 rounded-xl p-4 space-y-2 cursor-pointer active:bg-gray-700 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-white font-semibold">{d.delivery_number}</span>
            {shortageDeliveryIds.has(d.id) && (
              <span title="Inventory shortage"><AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" /></span>
            )}
          </div>
          <Badge variant={statusToBadgeVariant[d.status] || 'default'}>{d.status.replace('_', ' ')}</Badge>
        </div>
        <p className="text-gray-300 text-sm">{d.customer_name}</p>
        {d.farm_group_name && (
          <div className="flex items-center gap-1">
            <Users className="w-3 h-3 text-blue-400 flex-shrink-0" />
            <span className="text-xs text-blue-400">{d.farm_group_name}</span>
          </div>
        )}
        {(d as unknown as Record<string, unknown>).delivery_address ? (
          <div className="flex items-center gap-2 text-gray-400 text-xs">
            <MapPin className="w-3 h-3" />
            <span className="truncate">{String((d as unknown as Record<string, unknown>).delivery_address)}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            <span>{parseLocalDate(d.scheduled_date).toLocaleDateString()}</span>
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
          <h2 className="text-xl font-bold text-white">My Deliveries</h2>
          <div className="flex items-center gap-2">
            {canQuickDeliver && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Zap className="w-4 h-4" />}
                onClick={() => {
                  setQuickDeliveryInitialCustomerId(undefined);
                  setQuickDeliveryOpen(true);
                }}
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
                  {d.farm_group_name && (
                    <div className="flex items-center gap-1">
                      <Users className="w-3 h-3 text-blue-400 flex-shrink-0" />
                      <span className="text-xs text-blue-400">{d.farm_group_name}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-gray-400 text-xs">
                    <Calendar className="w-3 h-3" />
                    <span>{parseLocalDate(d.scheduled_date).toLocaleDateString()}</span>
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
          onClose={closeQuickDelivery}
          initialCustomerId={quickDeliveryInitialCustomerId}
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
      header: (<span className="flex items-center">Delivery #<HelpTip text="This delivery has items where warehouse stock is running low. Check inventory before dispatching." className="ml-1" /></span>),
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Truck className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.delivery_number}</span>
          {shortageDeliveryIds.has(row.id) && (
            <span title="Inventory shortage"><AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" /></span>
          )}
        </div>
      ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <div>
          <div className="flex items-center gap-1.5">
            <span>{row.customer_name}</span>
            {row.customer_id && canPeekCustomer && (
              <button
                onClick={(e) => { e.stopPropagation(); setDrawerCustomer({ id: row.customer_id, name: row.customer_name }); }}
                title="Peek customer"
                aria-label={`Peek ${row.customer_name}`}
                className="p-0.5 rounded text-gray-300 hover:text-crx-green hover:bg-crx-green-light transition-colors"
              >
                <PanelRightOpen className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {row.farm_group_name && (
            <div className="flex items-center gap-1 mt-0.5">
              <Users className="w-3 h-3 text-blue-500 flex-shrink-0" />
              <span className="text-xs text-blue-600">{row.farm_group_name}</span>
            </div>
          )}
        </div>
      ),
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
        const d = parseLocalDate(row.scheduled_date);
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
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.status === 'in_progress' || row.status === 'scheduled' ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              completeIdem.resetKey();
              if (row.status === 'scheduled') confirmIdem.resetKey();
              setCompleteTarget(row);
              setSignedBy('');
              setDeliveredOnDate(today());
            }}
            title={row.status === 'scheduled' ? 'Mark this delivery delivered' : 'Mark this delivery complete'}
            aria-label={`Mark delivery ${row.delivery_number} ${row.status === 'scheduled' ? 'delivered' : 'complete'}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-crx-green border border-crx-green/30 hover:bg-crx-green-light transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {row.status === 'scheduled' ? 'Mark Delivered' : 'Complete'}
          </button>
        ) : null,
    },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Deliveries"
        actions={(
          <>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'list'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
              aria-label="List view"
            >
              <List className="w-4 h-4" />
              List
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${
                viewMode === 'calendar'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
              aria-label="Calendar view"
            >
              <CalendarDays className="w-4 h-4" />
              Calendar
            </button>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
            onClick={handleExportCSV}
          >
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={handleExportPDF}
            loading={exportingPdf}
          >
            Download PDF
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={handlePrintLoadSheet}
            loading={printingLoadSheet}
          >
            {selected.size > 0 ? `Load Sheet (${selected.size})` : 'Load Sheet'}
          </Button>
          {selected.size > 0 && (
            <>
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
              onClick={() => {
                setQuickDeliveryInitialCustomerId(undefined);
                setQuickDeliveryOpen(true);
              }}
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
          </>
        )}
      />

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

      {/* Calendar View */}
      {viewMode === 'calendar' && (
        <Card>
          <DeliveryCalendar
            deliveries={deliveries}
            onDeliveryClick={(deliveryId) => navigate(`/deliveries/${deliveryId}`)}
            onDateClick={(date) => navigate(`/deliveries/new?date=${date}`)}
          />
        </Card>
      )}

      {/* List View */}
      {viewMode === 'list' && <>
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
            searchKeys={['delivery_number', 'customer_name', 'driver_name', 'farm_group_name']}
            onRowClick={(row) => navigate(`/deliveries/${row.id}`)}
            emptyTitle="No deliveries scheduled"
            emptyDescription="Deliveries are created from orders. Open an order and click 'Schedule Delivery' to get started."
            emptyAction={
              <Button icon={<Truck className="w-4 h-4" />} onClick={() => navigate('/orders')}>
                View Orders
              </Button>
            }
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
                  <option value="voided">Voided</option>
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
      </>}

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
        onClose={closeQuickDelivery}
        initialCustomerId={quickDeliveryInitialCustomerId}
      />

      <CustomerDrawer
        open={canPeekCustomer && !!drawerCustomer}
        customerId={drawerCustomer?.id ?? ''}
        customerName={drawerCustomer?.name ?? ''}
        onClose={() => setDrawerCustomer(null)}
      />

      <Modal
        open={!!completeTarget}
        onClose={() => { setCompleteTarget(null); setSignedBy(''); setDeliveredOnDate(today()); }}
        title={completeTarget?.status === 'scheduled' ? 'Mark Delivered' : 'Mark Delivery Complete'}
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Complete delivery <span className="font-medium text-nav-dark">{completeTarget?.delivery_number}</span> for{' '}
            <span className="font-medium text-nav-dark">{completeTarget?.customer_name}</span> — all items delivered in full.
            For a partial delivery, or to email the customer their receipt, open the delivery instead.
          </p>
          {completeTarget?.status === 'scheduled' && (
            <p className="text-sm text-secondary">
              This will confirm and complete the delivery in one step. Inventory is deducted and a draft invoice is created.
            </p>
          )}
          <div>
            <label htmlFor="complete-signed-by" className="block text-xs font-medium text-secondary mb-1">Signed by</label>
            <input
              id="complete-signed-by"
              type="text"
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Name of person who received"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label htmlFor="delivered-on" className="block text-xs font-medium text-secondary mb-1">Delivered on</label>
            <input
              id="delivered-on"
              type="date"
              value={deliveredOnDate}
              onChange={(e) => setDeliveredOnDate(e.target.value)}
              max={todayStr}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <p className="mt-1 text-xs text-secondary">Recording a delivery that already happened? Set the real date — it becomes the invoice date.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => { setCompleteTarget(null); setSignedBy(''); setDeliveredOnDate(today()); }}>Cancel</Button>
            <Button icon={<CheckCircle2 className="w-4 h-4" />} onClick={handleCompleteConfirm} loading={completing} disabled={!signedBy.trim()}>
              {completeTarget?.status === 'scheduled' ? 'Mark Delivered' : 'Mark Complete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
