/**
 * WatchdogFlagBanner — inline advisory flags for a specific job or invoice.
 *
 * Renders a compact list of active (non-dismissed) watchdog flags for the
 * given entity. Each flag shows a plain-English message and a one-tap dismiss
 * button with "looks fine / needs fix" options.
 *
 * Advisory only — never blocks workflow.
 */
import { useEffect, useState, useCallback } from 'react';
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
}

export default function WatchdogFlagBanner({ jobId, invoiceId, showDismissed = false }: Props) {
  const { profile } = useAuth();
  const [flags, setFlags] = useState<WatchdogFlag[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchFlags = useCallback(async () => {
    if (!jobId && !invoiceId) return;
    setLoading(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('get_watchdog_flags', {
        p_job_id:             jobId     ?? null,
        p_invoice_id:         invoiceId ?? null,
        p_flag_type:          null,
        p_include_dismissed:  showDismissed,
      });
      if (error) throw error;
      const result = assertRpcResult<WatchdogFlag[]>(data, 'get_watchdog_flags');
      setFlags(result);
    } catch (err) {
      Sentry.captureException(err, { tags: { component: 'WatchdogFlagBanner' } });
    } finally {
      setLoading(false);
    }
  }, [jobId, invoiceId, showDismissed]);

  useEffect(() => { void fetchFlags(); }, [fetchFlags]);

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
          onDismissed={fetchFlags}
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
