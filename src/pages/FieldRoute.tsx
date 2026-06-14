/**
 * Field Mode — driver mobile workspace ("My Route").
 *
 * Phone-first list of open delivery stops the logged-in user can see (RLS-scoped:
 * admins/reps see all, a driver sees their own). Additive surface — never edits
 * DeliveryDetail.tsx. Tapping a stop opens the per-stop runner (/my-route/:id).
 * Unassigned stops show a "Claim" action (reassign_delivery) so a driver can
 * self-assign. See docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Wifi, WifiOff, ChevronRight, RefreshCw, PackageCheck, UserPlus } from 'lucide-react';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import ConfirmModal from '../components/ui/ConfirmModal';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
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
  const { profile } = useAuth();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const reassignIdem = useIdempotencyKey('reassign_delivery', profile?.id || '');

  const [stops, setStops] = useState<StopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [claimTarget, setClaimTarget] = useState<StopRow | null>(null);
  const [claiming, setClaiming] = useState(false);

  const fetchStops = useCallback(async () => {
    setLoading(true);
    // No app-side driver/date filter: del_select RLS scopes a driver to their
    // own rows (admins/reps see all). Ordering: in_progress first, then date.
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

  const handleClaim = async () => {
    if (!claimTarget || !profile) return;
    setClaiming(true);
    try {
      const { data, error } = await supabase.rpc('reassign_delivery', {
        p_delivery_id: claimTarget.id,
        p_new_driver: profile.id,
        p_performed_by: profile.id,
        p_idempotency_key: reassignIdem.getKey(),
      });
      if (error) {
        toast('error', sanitizeError(error));
      } else {
        assertRpcResult(data, 'reassign_delivery');
        reassignIdem.resetKey();
        toast('success', 'Stop claimed — assigned to you');
        setClaimTarget(null);
        await fetchStops();
      }
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setClaiming(false);
  };

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
              <li key={stop.id} className="bg-white border border-gray-200 rounded-xl flex items-stretch overflow-hidden">
                <button
                  type="button"
                  onClick={() => navigate(`/my-route/${stop.id}`)}
                  className="flex-1 min-w-0 text-left px-4 py-3 min-h-[80px] flex items-center gap-3 hover:bg-gray-50 active:scale-[0.99] transition"
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
                      {!stop.assigned_driver && <span className="text-amber-600">Unassigned</span>}
                    </div>
                    {stop.delivery_notes && (
                      <p className="text-xs text-gray-400 mt-1 truncate">{stop.delivery_notes}</p>
                    )}
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
                </button>
                {!stop.assigned_driver && (
                  <button
                    type="button"
                    onClick={() => setClaimTarget(stop)}
                    className="px-3 border-l border-gray-200 text-crx-green flex flex-col items-center justify-center gap-0.5 hover:bg-green-50 active:scale-95"
                    aria-label={`Claim ${stop.customer?.farm_name || 'this stop'}`}
                  >
                    <UserPlus className="w-5 h-5" />
                    <span className="text-[10px] font-medium">Claim</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmModal
        open={claimTarget !== null}
        onClose={() => setClaimTarget(null)}
        onConfirm={handleClaim}
        title="Claim this stop?"
        message={`Assign ${claimTarget?.customer?.farm_name || 'this delivery'} to you?`}
        confirmLabel="Claim"
        variant="info"
        loading={claiming}
      />
    </div>
  );
}
