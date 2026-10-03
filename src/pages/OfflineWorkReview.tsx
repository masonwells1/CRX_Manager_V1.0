import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';
import ConfirmModal from '../components/ui/ConfirmModal';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabase } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { Sentry } from '../lib/sentry';
import type {
  OfflineActionReviewQueueItem,
  OfflineActionReviewQueueResult,
  OfflineActionReviewResolution,
  ResolveOfflineActionResult,
} from '../types';

function recordHref(item: OfflineActionReviewQueueItem): string {
  return item.operation === 'complete_delivery'
    ? `/deliveries/${item.entity_id}`
    : `/jobs/${item.entity_id}`;
}

function operationLabel(item: OfflineActionReviewQueueItem): string {
  return item.operation === 'complete_delivery' ? 'Delivery completion' : 'Job completion';
}

function resolutionLabel(resolution: OfflineActionReviewResolution | null): string {
  if (resolution === 'already_completed') return 'Already handled';
  if (resolution === 'abandoned') return 'Do not run';
  return 'Unresolved';
}

export default function OfflineWorkReview() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<OfflineActionReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OfflineActionReviewQueueItem | null>(null);
  const [resolution, setResolution] = useState<OfflineActionReviewResolution>('already_completed');
  const [note, setNote] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadRequestSequence = useRef(0);

  const loadQueue = useCallback(async () => {
    const requestSequence = ++loadRequestSequence.current;
    setLoading(true);
    setLoadError(null);
    // A permanent resolution is only safe against the queue snapshot it was opened from.
    // Invalidate it before every refresh, rather than leaving it actionable while a newer
    // authoritative response is pending.
    setSelected(null);
    setConfirmOpen(false);
    setNote('');
    setIdempotencyKey(null);
    try {
      const { data, error } = await supabase.rpc('get_offline_action_review_queue', {
        p_include_resolved: includeResolved,
        p_limit: 100,
        p_offset: 0,
      });
      if (error) throw error;
      const result = assertRpcResult<OfflineActionReviewQueueResult>(
        data,
        'get_offline_action_review_queue',
      );
      if (requestSequence !== loadRequestSequence.current) return;
      if (!Array.isArray(result.items) || typeof result.total !== 'number') {
        throw new Error('get_offline_action_review_queue returned an invalid result');
      }
      setItems(result.items);
      setTotal(result.total);
    } catch (error) {
      if (requestSequence !== loadRequestSequence.current) return;
      const message = error && typeof error === 'object' && 'code' in error && error.code === 'PGRST202'
        ? 'The offline receipt migrations are not active yet. This page will become available after the reviewed database rollout.'
        : 'Could not load the offline work review queue.';
      setItems([]);
      setTotal(0);
      setSelected(null);
      setConfirmOpen(false);
      setNote('');
      setIdempotencyKey(null);
      setLoadError(message);
      Sentry.captureException(error, { tags: { page: 'OfflineWorkReview', action: 'load' } });
    } finally {
      if (requestSequence === loadRequestSequence.current) setLoading(false);
    }
  }, [includeResolved]);

  useEffect(() => {
    void loadQueue();
    return () => {
      loadRequestSequence.current += 1;
    };
  }, [loadQueue]);

  const unresolvedCount = useMemo(
    () => items.filter((item) => item.resolved_at === null).length,
    [items],
  );

  const openResolution = (item: OfflineActionReviewQueueItem) => {
    if (!profile || loading || loadError) return;
    setSelected(item);
    setResolution('already_completed');
    setNote('');
    setIdempotencyKey(generateIdempotencyKey('resolve_offline_action', profile.id));
  };

  const renewResolutionKey = () => {
    if (!profile) return;
    setIdempotencyKey(generateIdempotencyKey('resolve_offline_action', profile.id));
  };

  const closeResolution = () => {
    if (saving) return;
    setSelected(null);
    setConfirmOpen(false);
    setNote('');
    setIdempotencyKey(null);
  };

  const handleResolve = async () => {
    if (loading || loadError || !selected || !idempotencyKey || note.trim().length < 10) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('resolve_offline_action', {
        p_client_action_id: selected.client_action_id,
        p_resolution: resolution,
        p_note: note.trim(),
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      assertRpcResult<ResolveOfflineActionResult>(data, 'resolve_offline_action');
      toast('success', 'Offline work resolution recorded permanently.');
      setSelected(null);
      setConfirmOpen(false);
      setNote('');
      setIdempotencyKey(null);
      await loadQueue();
    } catch (error) {
      if (
        hasRpcCode(error, RpcErrorCodes.OFFLINE_ACTION_ALREADY_RESOLVED)
        || hasRpcCode(error, RpcErrorCodes.OFFLINE_ACTION_NOT_REVIEWABLE)
      ) {
        setSelected(null);
        setConfirmOpen(false);
        setNote('');
        setIdempotencyKey(null);
        toast('warning', 'Another office user changed this receipt first. The review queue was refreshed.');
        await loadQueue();
        return;
      }
      if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_ARGUMENT_MISMATCH)) {
        renewResolutionKey();
        setConfirmOpen(false);
        toast('warning', 'The resolution details changed after an earlier attempt. Review the final confirmation and try again.');
        return;
      }
      Sentry.captureException(error, { tags: { page: 'OfflineWorkReview', action: 'resolve' } });
      toast('error', 'Could not record this resolution. Nothing was removed or rerun.');
    } finally {
      setSaving(false);
    }
  };

  const confirmMessage = resolution === 'already_completed'
    ? 'This records that the work was independently verified as already handled. It does not mark this receipt as server-processed and does not change inventory.'
    : 'This records that the saved action must never run. It does not undo any work that may already exist and does not delete the permanent receipt.';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary">Offline Work Review</h1>
          <p className="mt-1 text-sm text-secondary">
            Resolve saved driver/applicator completions without impersonating them or rerunning inventory work.
          </p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw className="h-4 w-4" />}
          onClick={() => void loadQueue()}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Needs review</p>
          <p className="mt-1 text-2xl font-bold text-amber-900">{unresolvedCount}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Shown</p>
          <p className="mt-1 text-2xl font-bold text-primary">{items.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Matching total</p>
          <p className="mt-1 text-2xl font-bold text-primary">{total}</p>
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-primary">
        <input
          type="checkbox"
          checked={includeResolved}
          onChange={(event) => setIncludeResolved(event.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
        Include resolved history
      </label>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {loadError}
        </div>
      )}

      {!loading && !loadError && items.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-crx-green" />
          <p className="font-medium text-primary">No offline work needs office review.</p>
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const resolved = item.resolved_at !== null;
          return (
            <article key={item.client_action_id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {resolved
                      ? <ShieldCheck className="h-5 w-5 text-green-600" />
                      : <AlertTriangle className="h-5 w-5 text-amber-600" />}
                    <h2 className="font-semibold text-primary">{operationLabel(item)}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${resolved ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                      {resolutionLabel(item.review_resolution)}
                    </span>
                  </div>
                  <p className="text-sm text-secondary">{item.failure_summary}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary">
                    <span>Saved by {item.actor_name}</span>
                    <span>Review started {new Date(item.needs_review_at).toLocaleString()}</span>
                    <span>Attempts: {item.attempt_count}</span>
                    <span>Support ID: {item.client_action_id}</span>
                  </div>
                  {resolved && item.review_note && (
                    <div className="rounded-lg bg-gray-50 p-3 text-sm text-secondary">
                      <span className="font-medium text-primary">{item.resolver_name}:</span> {item.review_note}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <Link
                    to={recordHref(item)}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-primary hover:bg-gray-50"
                  >
                    Open record <ExternalLink className="h-4 w-4" />
                  </Link>
                  {!resolved && (
                    <Button
                      onClick={() => openResolution(item)}
                      disabled={loading || Boolean(loadError)}
                      className="min-h-11"
                    >
                      Resolve safely
                    </Button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <Modal
        open={selected !== null}
        onClose={closeResolution}
        title="Resolve Offline Work"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={closeResolution} disabled={loading}>Cancel</Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={loading || Boolean(loadError) || note.trim().length < 10}
            >
              Review final confirmation
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            This records an office decision only. It cannot run, undo, or delete the saved business action.
          </div>
          <label className="block">
            <span className="text-sm font-medium text-primary">Resolution</span>
            <select
              value={resolution}
              disabled={loading || Boolean(loadError)}
              onChange={(event) => {
                setResolution(event.target.value as OfflineActionReviewResolution);
                renewResolutionKey();
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            >
              <option value="already_completed">Already handled outside this offline receipt</option>
              <option value="abandoned">Do not run this saved action</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-primary">Required explanation</span>
            <textarea
              value={note}
              disabled={loading || Boolean(loadError)}
              onChange={(event) => {
                setNote(event.target.value);
                renewResolutionKey();
              }}
              maxLength={1000}
              rows={4}
              placeholder="Explain what you checked and why this resolution is safe."
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            />
            <span className="mt-1 block text-xs text-tertiary">Minimum 10 characters; {note.trim().length}/1000</span>
          </label>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleResolve()}
        title="Record this permanent resolution?"
        message={confirmMessage}
        confirmLabel={resolution === 'already_completed' ? 'Record as already handled' : 'Record as do not run'}
        variant="warning"
        loading={saving || loading}
      />
    </div>
  );
}
