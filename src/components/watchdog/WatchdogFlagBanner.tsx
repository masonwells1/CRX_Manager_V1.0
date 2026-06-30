/**
 * WatchdogFlagBanner — inline advisory flags for a specific job or invoice.
 *
 * Renders a compact list of active (non-dismissed) watchdog flags for the
 * given entity. Each flag shows a plain-English message and a one-tap dismiss
 * button with "looks fine / needs fix" options.
 *
 * Advisory only — never blocks workflow.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle, X } from 'lucide-react';
import { supabaseUntyped, assertRpcResult } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { Sentry } from '../../lib/sentry';
import type {
  WatchdogFlag,
  WatchdogFlagType,
  WatchdogResolution,
  DismissWatchdogFlagResult,
  RefreshWatchdogFlagsResult,
} from '../../types';

const FLAG_LABELS: Record<WatchdogFlagType, string> = {
  acre_divergence:   'Acre Divergence',
  rate_over_label:   'Over-Label Rate',
  double_bill:       'Possible Double-Bill',
  rei_not_cleared:   'REI Not Cleared',
};

interface Props {
  jobId?: string;
  invoiceId?: string;
  /** If true, also shows already-dismissed flags (greyed out). Default: false */
  showDismissed?: boolean;
  /**
   * When true and a jobId is present, runs the DB-side detection sweep scoped to
   * this job BEFORE reading flags, so opening the record always shows CURRENT flags
   * without anyone clicking "Run sweep". Advisory and non-blocking — a sweep failure
   * is swallowed to Sentry and the read still runs. Default: false.
   */
  autoRefresh?: boolean;
}

export default function WatchdogFlagBanner({
  jobId,
  invoiceId,
  showDismissed = false,
  autoRefresh = false,
}: Props) {
  const { profile } = useAuth();
  const [flags, setFlags] = useState<WatchdogFlag[]>([]);
  const [loading, setLoading] = useState(false);
  // Monotonic token: each load bumps it; a stale in-flight load whose token no longer
  // matches must NOT write flags (prevents an older record's response landing last and
  // showing/dismissing the wrong record's flags when navigating quickly).
  const loadSeq = useRef(0);

  // The watchdog RPCs are admin/sales_rep-only. /jobs/:id is also reachable by
  // applicators — without this gate every applicator opening a job would trip
  // WATCHDOG_ACCESS_DENIED (Sentry noise) and render nothing anyway. So the banner
  // is inert for other roles: it makes no RPC calls and renders null.
  const canViewWatchdog = profile?.role === 'admin' || profile?.role === 'sales_rep';

  const fetchFlags = useCallback(async (seq: number) => {
    if (!canViewWatchdog) return;
    if (!jobId && !invoiceId) return;
    try {
      // get_watchdog_flags ANDs its scope filters, so passing BOTH job and invoice
      // would only return flags matching both — and would hide an invoice-only flag
      // (job_id NULL) or a job-only flag (invoice_id NULL). When both scopes are
      // present we query each separately and merge by id, so the banner surfaces
      // job flags (acre/rate/REI) AND the invoice's own flags (double-bill).
      const scopes: Array<{ p_job_id: string | null; p_invoice_id: string | null }> = [];
      if (jobId)     scopes.push({ p_job_id: jobId,  p_invoice_id: null });
      if (invoiceId) scopes.push({ p_job_id: null,   p_invoice_id: invoiceId });

      const results = await Promise.all(
        scopes.map(async (scope) => {
          const { data, error } = await supabaseUntyped.rpc('get_watchdog_flags', {
            ...scope,
            p_flag_type:         null,
            p_include_dismissed: showDismissed,
          });
          if (error) throw error;
          return assertRpcResult<WatchdogFlag[]>(data, 'get_watchdog_flags');
        }),
      );

      const byId = new Map<string, WatchdogFlag>();
      for (const list of results) {
        for (const f of list) {
          // The job-scoped read returns EVERY flag on the job, including double-bill
          // flags that belong to a SIBLING invoice on the same job. When an invoiceId
          // is in scope, drop any invoice-bound flag whose invoice_id isn't this one,
          // so the banner never shows (or lets you dismiss) a sibling's warning.
          if (invoiceId && f.invoice_id && f.invoice_id !== invoiceId) continue;
          byId.set(f.id, f);
        }
      }
      // Ignore a stale response: a newer load (different record / re-run) has started.
      if (seq !== loadSeq.current) return;
      setFlags([...byId.values()]);
    } catch (err) {
      Sentry.captureException(err, { tags: { component: 'WatchdogFlagBanner' } });
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [canViewWatchdog, jobId, invoiceId, showDismissed]);

  // GAP 2 — always-on check: when enabled, refresh this job's flags on load before
  // reading them, so the advisory surfaces current issues without the manual button.
  // Scoped to jobId only (the cheap, safe path); invoice-only views still read live.
  const refreshAndFetch = useCallback(async () => {
    if (!canViewWatchdog) return;
    // Bump the load token so any earlier in-flight load becomes stale and won't write.
    const seq = ++loadSeq.current;
    // Clear the prior record's flags and show loading BEFORE the sweep, so navigating
    // from one job/invoice to another never leaves the previous record's banner on
    // screen (where it could be read or dismissed against the wrong record).
    setLoading(true);
    setFlags([]);
    if (autoRefresh && jobId) {
      try {
        const { data, error } = await supabaseUntyped.rpc('refresh_watchdog_flags', {
          p_job_id:                    jobId,
          p_acre_divergence_threshold: 10,
          p_rate_fallback_multiple:    3,
        });
        if (error) throw error;
        assertRpcResult<RefreshWatchdogFlagsResult>(data, 'refresh_watchdog_flags');
      } catch (err) {
        // Non-blocking: advisory only. Fall through to the read so stale flags still show.
        Sentry.captureException(err, {
          tags: { component: 'WatchdogFlagBanner', action: 'auto_refresh' },
        });
      }
    }
    if (seq !== loadSeq.current) return; // a newer load superseded us during the sweep
    await fetchFlags(seq);
  }, [canViewWatchdog, autoRefresh, jobId, fetchFlags]);

  useEffect(() => { void refreshAndFetch(); }, [refreshAndFetch]);

  // After a dismissal, re-read (no re-sweep needed) under a fresh token.
  const refetch = useCallback(() => { void fetchFlags(++loadSeq.current); }, [fetchFlags]);

  if (!canViewWatchdog) return null;
  if (loading) return null;
  const activeFlags = flags.filter(f => !f.is_dismissed);
  if (activeFlags.length === 0) return null;

  return (
    <div className="space-y-2 mb-4">
      {activeFlags.map(flag => (
        <FlagItem
          key={flag.id}
          flag={flag}
          profileId={profile?.id ?? null}
          onDismissed={refetch}
        />
      ))}
    </div>
  );
}

// ── FlagItem — own component so each can have its own idempotency hook ────────

interface FlagItemProps {
  flag:       WatchdogFlag;
  profileId:  string | null;
  onDismissed: () => void;
}

function FlagItem({ flag, profileId, onDismissed }: FlagItemProps) {
  const [pending, setPending]     = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const dismissIdem = useIdempotencyKey('dismiss_watchdog_flag', profileId ?? 'anon');

  const handleDismiss = useCallback(async (resolution: WatchdogResolution) => {
    if (!profileId) return;
    setDismissing(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('dismiss_watchdog_flag', {
        p_flag_id:           flag.id,
        p_resolution:        resolution,
        p_note:              null,
        p_performed_by:      profileId,
        p_idempotency_key:   dismissIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult<DismissWatchdogFlagResult>(data, 'dismiss_watchdog_flag');

      await logActivity({
        event:       'watchdog_flag_dismissed',
        description: `Watchdog flag dismissed as "${resolution}": ${flag.message}`,
        performedBy: profileId,
        entityType:  'watchdog_flag',
        entityId:    flag.id,
      });

      dismissIdem.resetKey();
      setPending(false);
      onDismissed();
    } catch (err) {
      Sentry.captureException(err, {
        tags: { component: 'WatchdogFlagBanner', action: 'dismiss' },
      });
    } finally {
      setDismissing(false);
    }
  }, [flag, profileId, dismissIdem, onDismissed]);

  return (
    <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
            {FLAG_LABELS[flag.flag_type] ?? flag.flag_type}
          </span>
        </div>
        <p className="text-sm text-amber-900 mt-0.5">{flag.message}</p>
      </div>

      {/* Dismiss controls */}
      {pending ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-amber-700">Mark as:</span>
          <button
            onClick={() => void handleDismiss('looks_fine')}
            disabled={dismissing}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-100 text-green-800 hover:bg-green-200 disabled:opacity-50 transition-colors"
          >
            <CheckCircle className="w-3 h-3" />
            Looks fine
          </button>
          <button
            onClick={() => void handleDismiss('needs_fix')}
            disabled={dismissing}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50 transition-colors"
          >
            <AlertTriangle className="w-3 h-3" />
            Needs fix
          </button>
          <button
            onClick={() => setPending(false)}
            className="text-amber-500 hover:text-amber-700 transition-colors"
            aria-label="Cancel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setPending(true)}
          className="shrink-0 text-xs text-amber-600 hover:text-amber-800 underline transition-colors"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
