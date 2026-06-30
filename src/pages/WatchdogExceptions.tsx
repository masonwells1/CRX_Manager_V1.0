/**
 * WatchdogExceptions — standing exceptions list for the Watchdog Flags system (§2).
 *
 * Shows ALL active (non-dismissed) flags across all jobs/invoices, grouped by type.
 * Each flag has a one-tap "Looks fine / Needs fix" dismiss action.
 * Also exposes a "Refresh flags" button that re-runs the DB-side detection sweep.
 *
 * This page is designed to be embedded in the §3 Office Cockpit as a panel,
 * or navigated to directly at /watchdog.
 *
 * Advisory only — flags are never blocking.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  X,
  Eye,
} from 'lucide-react';
import { supabaseUntyped, assertRpcResult } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import { formatLocalDate } from '../lib/dateUtils';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import type {
  WatchdogFlag,
  WatchdogFlagType,
  WatchdogResolution,
  DismissWatchdogFlagResult,
  RefreshWatchdogFlagsResult,
} from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const FLAG_LABELS: Record<WatchdogFlagType, string> = {
  acre_divergence:  'Acre Divergence',
  rate_over_label:  'Over-Label Rate',
  double_bill:      'Possible Double-Bill',
  rei_not_cleared:  'REI Not Cleared',
};

const FLAG_DESCRIPTIONS: Record<WatchdogFlagType, string> = {
  acre_divergence:
    "Applied acres on a completed job differ from the field's authoritative boundary acres by more than 10%.",
  rate_over_label:
    'A chemical was applied at a rate exceeding its label maximum (or the fallback multiple of the suggested rate).',
  double_bill:
    'Two or more active invoices exist for the same job or blend ticket.',
  rei_not_cleared:
    "A product was applied to a field while a prior application's REI (re-entry interval) may not have cleared.",
};

const FLAG_BADGE_VARIANT: Record<WatchdogFlagType, BadgeVariant> = {
  acre_divergence:  'warning',
  rate_over_label:  'error',
  double_bill:      'error',
  rei_not_cleared:  'warning',
};

const ALL_FLAG_TYPES: WatchdogFlagType[] = [
  'acre_divergence',
  'rate_over_label',
  'double_bill',
  'rei_not_cleared',
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function WatchdogExceptions() {
  const { profile } = useAuth();

  const [flags, setFlags]                   = useState<WatchdogFlag[]>([]);
  const [loading, setLoading]               = useState(true);
  const [refreshing, setRefreshing]         = useState(false);
  const [showDismissed, setShowDismissed]   = useState(false);
  const [expandedTypes, setExpandedTypes]   = useState<Set<WatchdogFlagType>>(
    new Set(ALL_FLAG_TYPES),
  );
  const [lastRefreshed, setLastRefreshed]   = useState<Date | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchFlags = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('get_watchdog_flags', {
        p_job_id:            null,
        p_invoice_id:        null,
        p_flag_type:         null,
        p_include_dismissed: showDismissed,
      });
      if (error) throw error;
      const result = assertRpcResult<WatchdogFlag[]>(data, 'get_watchdog_flags');
      setFlags(result);
    } catch (err) {
      Sentry.captureException(err, { tags: { page: 'WatchdogExceptions' } });
    } finally {
      setLoading(false);
    }
  }, [showDismissed]);

  useEffect(() => { void fetchFlags(); }, [fetchFlags]);

  // ── Re-run DB detection sweep ──────────────────────────────────────────────

  const handleRefreshDetection = useCallback(async () => {
    if (!profile?.id) return;
    setRefreshing(true);
    setRefreshSummary(null);
    try {
      const { data, error } = await supabaseUntyped.rpc('refresh_watchdog_flags', {
        p_job_id:                    null,
        p_acre_divergence_threshold: 10,
        p_rate_fallback_multiple:    3,
      });
      if (error) throw error;
      const result = assertRpcResult<RefreshWatchdogFlagsResult>(data, 'refresh_watchdog_flags');
      setLastRefreshed(new Date());
      setRefreshSummary(
        `Sweep complete — ${result.flags_total} active flag${result.flags_total !== 1 ? 's' : ''} ` +
        `(${result.flags_deleted} stale removed).`,
      );
      await fetchFlags();
    } catch (err) {
      Sentry.captureException(err, { tags: { page: 'WatchdogExceptions', action: 'refresh' } });
    } finally {
      setRefreshing(false);
    }
  }, [profile, fetchFlags]);

  // ── Grouping ───────────────────────────────────────────────────────────────

  const grouped = useMemo(() => {
    const map = new Map<WatchdogFlagType, WatchdogFlag[]>();
    for (const type of ALL_FLAG_TYPES) map.set(type, []);
    for (const f of flags) {
      map.get(f.flag_type)?.push(f);
    }
    return map;
  }, [flags]);

  const activeCount = flags.filter(f => !f.is_dismissed).length;
  const totalCount  = flags.length;

  // ── Toggle section ─────────────────────────────────────────────────────────
  const toggleType = (t: WatchdogFlagType) => {
    setExpandedTypes(prev => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-primary flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Watchdog Exceptions
          </h1>
          <p className="text-sm text-secondary mt-1">
            Advisory flags for suspicious jobs and invoices — never blocks workflow.
            {lastRefreshed && (
              <span className="ml-2 text-xs text-tertiary">
                Last swept: {formatLocalDate(lastRefreshed)}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={e => setShowDismissed(e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
            />
            <Eye className="w-4 h-4" />
            Show dismissed
          </label>

          <button
            onClick={() => void handleRefreshDetection()}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       bg-crx-green text-white hover:bg-crx-green/90 disabled:opacity-60
                       transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Sweeping…' : 'Run sweep'}
          </button>
        </div>
      </div>

      {/* Sweep summary */}
      {refreshSummary && (
        <div className="flex items-center gap-2 text-sm bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-green-800">
          <CheckCircle className="w-4 h-4 shrink-0" />
          {refreshSummary}
        </div>
      )}

      {/* Summary counts */}
      {!loading && (
        <div className="flex items-center gap-4">
          <span className="text-sm text-secondary">
            <span className="font-semibold text-primary">{activeCount}</span> active flag
            {activeCount !== 1 ? 's' : ''}
            {showDismissed && totalCount !== activeCount && (
              <span className="text-tertiary"> ({totalCount - activeCount} dismissed)</span>
            )}
          </span>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-sm text-secondary py-8 text-center">Loading flags…</div>
      )}

      {/* Sections per flag type */}
      {!loading && ALL_FLAG_TYPES.map(type => {
        const typeFlags  = grouped.get(type) ?? [];
        const isExpanded = expandedTypes.has(type);
        const activeTypeCount = typeFlags.filter(f => !f.is_dismissed).length;

        return (
          <div key={type} className="border border-gray-200 rounded-lg overflow-hidden">
            {/* Section header */}
            <button
              onClick={() => toggleType(type)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50
                         hover:bg-gray-100 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <Badge variant={activeTypeCount > 0 ? FLAG_BADGE_VARIANT[type] : 'default'}>
                  {activeTypeCount}
                </Badge>
                <div>
                  <span className="text-sm font-medium text-primary">{FLAG_LABELS[type]}</span>
                  <p className="text-xs text-secondary mt-0.5">{FLAG_DESCRIPTIONS[type]}</p>
                </div>
              </div>
              {isExpanded
                ? <ChevronUp className="w-4 h-4 text-secondary shrink-0" />
                : <ChevronDown className="w-4 h-4 text-secondary shrink-0" />
              }
            </button>

            {/* Flag rows */}
            {isExpanded && (
              <div className="divide-y divide-gray-100">
                {typeFlags.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-tertiary italic">No flags of this type.</div>
                ) : (
                  typeFlags.map(flag => (
                    <FlagRow
                      key={flag.id}
                      flag={flag}
                      profileId={profile?.id ?? null}
                      onDismissed={fetchFlags}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Empty state */}
      {!loading && activeCount === 0 && !showDismissed && (
        <div className="text-center py-12 text-secondary">
          <CheckCircle className="w-10 h-10 text-crx-green mx-auto mb-3 opacity-60" />
          <p className="text-sm font-medium">No active watchdog flags.</p>
          <p className="text-xs text-tertiary mt-1">
            Run a sweep to detect new issues, or toggle &ldquo;Show dismissed&rdquo; to see history.
          </p>
        </div>
      )}
    </div>
  );
}

// ── FlagRow — owns its own dismiss state + idempotency hook ───────────────────

interface FlagRowProps {
  flag:        WatchdogFlag;
  profileId:   string | null;
  onDismissed: () => void;
}

function FlagRow({ flag, profileId, onDismissed }: FlagRowProps) {
  const [pending,    setPending]    = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const dismissIdem = useIdempotencyKey('dismiss_watchdog_flag', profileId ?? 'anon');

  const handleDismiss = useCallback(async (resolution: WatchdogResolution) => {
    if (!profileId) return;
    setDismissing(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('dismiss_watchdog_flag', {
        p_flag_id:          flag.id,
        p_resolution:       resolution,
        p_note:             null,
        p_performed_by:     profileId,
        p_idempotency_key:  dismissIdem.getKey(),
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
        tags: { page: 'WatchdogExceptions', action: 'dismiss' },
      });
    } finally {
      setDismissing(false);
    }
  }, [flag, profileId, dismissIdem, onDismissed]);

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 ${
        flag.is_dismissed ? 'opacity-50 bg-gray-50' : 'bg-white'
      }`}
    >
      <AlertTriangle
        className={`w-4 h-4 mt-0.5 shrink-0 ${
          flag.is_dismissed ? 'text-gray-400' : 'text-amber-500'
        }`}
      />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-primary">{flag.message}</p>

        {/* Metadata line */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
          {flag.is_dismissed && flag.resolution && (
            <span className={`text-xs font-medium ${
              flag.resolution === 'looks_fine' ? 'text-green-700' : 'text-red-700'
            }`}>
              {flag.resolution === 'looks_fine' ? '✓ Looks fine' : '⚠ Needs fix'}
            </span>
          )}
          <span className="text-xs text-tertiary">
            {new Date(flag.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
          {flag.detail?.divergence_pct != null && (
            <span className="text-xs text-secondary">
              {String(flag.detail.divergence_pct)}% divergence
            </span>
          )}
        </div>
      </div>

      {/* Dismiss controls — not shown for already-dismissed flags */}
      {!flag.is_dismissed && (
        <div className="flex items-center gap-2 shrink-0">
          {pending ? (
            <>
              <span className="text-xs text-secondary">Mark as:</span>
              <button
                onClick={() => void handleDismiss('looks_fine')}
                disabled={dismissing}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded
                           bg-green-100 text-green-800 hover:bg-green-200
                           disabled:opacity-50 transition-colors"
              >
                <CheckCircle className="w-3 h-3" />
                Looks fine
              </button>
              <button
                onClick={() => void handleDismiss('needs_fix')}
                disabled={dismissing}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded
                           bg-red-100 text-red-800 hover:bg-red-200
                           disabled:opacity-50 transition-colors"
              >
                <AlertTriangle className="w-3 h-3" />
                Needs fix
              </button>
              <button
                onClick={() => setPending(false)}
                className="text-secondary hover:text-primary transition-colors"
                aria-label="Cancel dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </>
          ) : (
            <button
              onClick={() => setPending(true)}
              className="text-xs text-amber-600 hover:text-amber-800 underline transition-colors"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
