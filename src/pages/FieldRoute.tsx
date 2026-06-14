/**
 * Field Mode — driver mobile workspace ("My Route").
 *
 * A phone-first, task-first surface for delivery drivers. This is an ADDITIVE
 * surface that REUSES the existing delivery RPCs/components; it never edits
 * DeliveryDetail.tsx (which remains the desktop view + deep-link fallback).
 *
 * Slice 1 (this file): the "My Stops" list — open deliveries the logged-in
 * user can see (RLS-scoped: admins/reps see all, a driver sees their own),
 * with an online/offline indicator and pending-sync count. Tapping a stop
 * deep-links into the existing /deliveries/:id detail for now; the guided
 * per-stop runner (Arrive → Verify → Sign → Photo → Complete), Claim, and
 * the offline path are added in later slices per
 * docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Wifi, WifiOff, ChevronRight, RefreshCw, PackageCheck } from 'lucide-react';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { supabase } from '../lib/db';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { getPendingCount } from '../lib/offlineQueue';
import { parseLocalDate } from '../lib/dateUtils';
import { Sentry } from '../lib/sentry';

interface StopRow {
  id: string;
  delivery_number: string | null;
  status: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  priority: string | null;
  assigned_driver: string | null;
  delivery_notes: string | null;
  customer: { farm_name: string | null } | null;
}

const OPEN_STATUSES = ['scheduled', 'in_progress'];

// in_progress (half-done work) surfaces first, then scheduled.
function statusRank(status: string): number {
  return status === 'in_progress' ? 0 : 1;
}

function formatStopDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function FieldRoute() {
  const navigate = useNavigate();
  const isOnline = useOnlineStatus();

  const [stops, setStops] = useState<StopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const fetchStops = useCallback(async () => {
    setLoading(true);
    // No app-side driver/date filter: del_select RLS scopes a driver to their
    // own rows (admins/reps see all). Ordering: in_progress first, then date,
    // then scheduled_time (null on most rows today) as a stable tiebreak.
    const { data, error } = await supabase
      .from('deliveries')
      .select('id, delivery_number, status, scheduled_date, scheduled_time, priority, assigned_driver, delivery_notes, customer:customers(farm_name)')
      .is('deleted_at', null)
      .in('status', OPEN_STATUSES)
      .order('scheduled_date', { ascending: true })
      .order('scheduled_time', { ascending: true, nullsFirst: false });

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-route' } });
      setStops([]);
      setLoading(false);
      return;
    }

    const rows = ((data || []) as unknown as StopRow[]).slice().sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      return (a.scheduled_date || '').localeCompare(b.scheduled_date || '');
    });
    setStops(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStops();
  }, [fetchStops]);

  useEffect(() => {
    let active = true;
    getPendingCount()
      .then((c) => { if (active) setPendingCount(c); })
      .catch(() => { /* IndexedDB unavailable — ignore */ });
    return () => { active = false; };
  }, [isOnline, stops]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Truck className="w-5 h-5 text-crx-green" />
          My Route
        </h1>
        <button
          type="button"
          onClick={fetchStops}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 active:scale-95"
          aria-label="Refresh stops"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* Online / offline status */}
      <div
        className={`flex items-center gap-2 rounded-lg px-3 py-2 mb-3 text-sm font-medium ${
          isOnline ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {isOnline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
        {isOnline ? 'Online' : 'Offline — changes save locally'}
        {pendingCount > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-800">
            <PackageCheck className="w-4 h-4" />
            {pendingCount} waiting to sync
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : stops.length === 0 ? (
        <div className="text-center py-12">
          <Truck className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No open stops right now</p>
          <button
            type="button"
            onClick={() => navigate('/deliveries')}
            className="mt-3 text-sm text-crx-green font-medium underline"
          >
            Go to all deliveries
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {stops.map((stop) => {
            const dateLabel = formatStopDate(stop.scheduled_date);
            return (
              <li key={stop.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/my-route/${stop.id}`)}
                  className="w-full text-left bg-white border border-gray-200 rounded-xl px-4 py-3 min-h-[80px] flex items-center gap-3 hover:border-crx-green active:scale-[0.99] transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 truncate">
                        {stop.customer?.farm_name || 'Unknown customer'}
                      </span>
                      <Badge variant={statusToBadgeVariant(stop.status)}>
                        {stop.status === 'in_progress' ? 'In progress' : 'Not started'}
                      </Badge>
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {stop.delivery_number && <span>{stop.delivery_number}</span>}
                      {dateLabel && <span>{dateLabel}</span>}
                      {stop.scheduled_time && <span>{stop.scheduled_time}</span>}
                    </div>
                    {stop.delivery_notes && (
                      <p className="text-xs text-gray-400 mt-1 truncate">{stop.delivery_notes}</p>
                    )}
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
