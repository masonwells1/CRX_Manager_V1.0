import { useRef, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { supabase, assertRpcResult, sanitizeError } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { getIdempotencyBindingRejection, isDefinitiveRpcRejection } from '../../lib/idempotency';
import {
  UNCERTAIN_MUTATION_INTENT_CONFLICT,
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  UNCERTAIN_MUTATION_RETRY_EXPIRED,
  useUncertainMutationIntent,
} from '../../hooks/useUncertainMutationIntent';
import { useToast } from '../ui/Toast';

import { Sentry } from '../../lib/sentry';

export interface AdjustmentItem {
  inventory_id: string;
  product_name: string;
  current_qty: number;
  delta: number;
}

interface RpcCall {
  p_inventory_id: string;
  p_delta: number;
  p_reason: string;
  p_performed_by: string;
  p_idempotency_key: string;
}

/**
 * Exported for testing. `getKey` is required on purpose: a random key per call
 * cannot be replayed after a lost reply, which is exactly the double-move this
 * modal used to cause.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildAdjustmentCalls(
  items: AdjustmentItem[],
  reason: string,
  userId: string,
  getKey: (item: AdjustmentItem) => string,
): RpcCall[] {
  return items
    .filter((it) => it.delta !== 0)
    .map((it) => ({
      p_inventory_id: it.inventory_id,
      p_delta: it.delta,
      p_reason: reason,
      p_performed_by: userId,
      p_idempotency_key: getKey(it),
    }));
}

/**
 * A row's key is the frozen batch key plus the row. The batch key only exists
 * while one exact batch (rows, delta, reason) is frozen, so a retry of that batch
 * re-sends every row under the key it was first sent with, and any change to the
 * rows, delta or reason is a different batch with a different key.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function batchRowIdempotencyKey(batchKey: string, inventoryId: string): string {
  return `${batchKey}:${inventoryId}`;
}

export type RowOutcome = 'adjusted' | 'refused' | 'uncertain' | 'binding_rejected';

/**
 * 'binding_rejected' is checked first: IDEMPOTENCY_ACTOR_MISMATCH is a P0001 that
 * isDefinitiveRpcRejection would call an ordinary refusal, and
 * IDEMPOTENCY_INTENT_MISMATCH is one it deliberately calls uncertain. Either way
 * this key can never succeed again, but an earlier request may have moved the
 * stock, so the operator must check before adjusting that product again.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function classifyAdjustmentError(error: unknown): Exclude<RowOutcome, 'adjusted'> {
  if (getIdempotencyBindingRejection(error)) return 'binding_rejected';
  if (isDefinitiveRpcRejection(error)) return 'refused';
  return 'uncertain';
}

type BatchAdjustIntent = {
  rows: Array<{ inventoryId: string; productName: string }>;
  delta: number;
  reason: string;
  performedBy: string;
};

// The outcome is remembered together with the batch key it was observed under.
// A row is only skipped on a retry of THAT batch: a different frozen batch (for
// example one adopted from another tab) must still send every one of its rows.
type RowResult = { outcome: RowOutcome; batchKey: string };

// A row in one of these states moved the stock already or holds a key the server
// will never accept, so it is never re-sent under the same batch.
const SETTLED: ReadonlySet<RowOutcome | undefined> = new Set<RowOutcome | undefined>(['adjusted', 'binding_rejected']);

const OUTCOME_LABEL: Record<RowOutcome, string> = {
  adjusted: 'Adjusted',
  refused: 'Refused — nothing changed',
  uncertain: 'Not confirmed — retry',
  binding_rejected: 'Check stock history',
};

const OUTCOME_CLASS: Record<RowOutcome, string> = {
  adjusted: 'text-green-700',
  refused: 'text-red-600',
  uncertain: 'text-yellow-800',
  binding_rejected: 'text-red-700 font-medium',
};

interface Props {
  open: boolean;
  onClose: () => void;
  items: Array<{ id: string; product_id: string; product_name: string; quantity_available: number }>;
  userId: string;
  onSuccess: () => void;
}

export default function BatchAdjustModal({ open, onClose, items, userId, onSuccess }: Props) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [uniformDelta, setUniformDelta] = useState('');
  const [saving, setSaving] = useState(false);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});
  // The rows of the last batch this dialog sent. Its results stay listed until the
  // dialog closes, even when the current selection no longer contains them (e.g.
  // a frozen batch retried after a reload with a different selection).
  const [lastBatchRows, setLastBatchRows] = useState<BatchAdjustIntent['rows']>([]);
  // The Inventory page's onSuccess clears the selection, which empties `items`.
  // Calling it mid-dialog would wipe the per-row results the operator still needs,
  // so it runs when the dialog closes — whenever stock moved or may have moved.
  const stockMayHaveChangedRef = useRef(false);

  // adjust_inventory replays on the idempotency key. A batch whose reply was lost
  // may already have moved some stock, so the exact batch is frozen until every
  // row has a definitive answer, and a retry re-sends it under the same keys. This
  // uses its own operation name so an unresolved batch never locks the
  // single-product adjustment dialog on the Inventory page (the server keys differ).
  const batchIntent = useUncertainMutationIntent<BatchAdjustIntent>({
    operation: 'adjust_inventory_batch',
    userId,
    surface: 'inventory-batch-adjust',
    getIntentIdentity: (intent) => ({
      inventory_ids: intent.rows.map((row) => row.inventoryId),
      p_delta: intent.delta,
      p_reason: intent.reason,
      p_performed_by: intent.performedBy,
    }),
  });
  const frozen = batchIntent.unresolvedIntent;

  // A non-finite entry (e.g. 1e400 → Infinity) would be frozen as null by JSON.
  const parsedDelta = Number(uniformDelta);
  const delta = Number.isFinite(parsedDelta) ? parsedDelta : 0;
  const hasDelta = uniformDelta !== '' && Number.isFinite(parsedDelta);
  const negativeCount = hasDelta ? items.filter((it) => it.quantity_available + delta < 0).length : 0;
  const pendingItems = items.filter((it) => !SETTLED.has(rowResults[it.id]?.outcome));

  const resetAndClose = () => {
    const refreshPage = stockMayHaveChangedRef.current;
    stockMayHaveChangedRef.current = false;
    setRowResults({});
    setRowMessages({});
    setLastBatchRows([]);
    setReason('');
    setUniformDelta('');
    if (refreshPage) onSuccess();
    onClose();
  };

  const handleClose = () => {
    if (saving) return;
    resetAndClose();
  };

  const handleSubmit = async () => {
    if (saving) return;
    if (batchIntent.isForeignIntentLocked) {
      toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
      return;
    }
    if (batchIntent.isRetryExpired) {
      toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
      return;
    }

    // A frozen batch is retried exactly as it was sent; form validation only
    // applies to a new batch.
    let candidate = batchIntent.getUnresolvedIntent();
    if (!candidate) {
      if (!reason.trim()) {
        toast('error', 'Please enter a reason for the adjustment');
        return;
      }
      if (delta === 0) {
        toast('error', 'Adjustment quantity cannot be zero');
        return;
      }
      if (pendingItems.length === 0) {
        toast('error', 'Every selected product has already been handled');
        return;
      }
      candidate = {
        rows: [...pendingItems]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((it) => ({ inventoryId: it.id, productName: it.product_name })),
        delta,
        reason: reason.trim(),
        performedBy: userId,
      };
    }

    setSaving(true);
    try {
      let request: BatchAdjustIntent;
      let batchKey: string;
      try {
        request = await batchIntent.beginIntent(candidate);
        batchKey = batchIntent.getIdempotencyKey();
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message === UNCERTAIN_MUTATION_INTENT_CONFLICT) toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
        else if (message === UNCERTAIN_MUTATION_RETRY_EXPIRED) toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
        else toast('error', sanitizeError(err));
        return;
      }

      const results = { ...rowResults };
      const messages = { ...rowMessages };
      const settledUnderThisBatch = (inventoryId: string) =>
        results[inventoryId]?.batchKey === batchKey && SETTLED.has(results[inventoryId].outcome);
      let newlyAdjusted = 0;
      const calls = buildAdjustmentCalls(
        request.rows
          .filter((row) => !settledUnderThisBatch(row.inventoryId))
          .map((row) => ({ inventory_id: row.inventoryId, product_name: row.productName, current_qty: 0, delta: request.delta })),
        request.reason,
        request.performedBy,
        (item) => batchRowIdempotencyKey(batchKey, item.inventory_id),
      );

      for (const call of calls) {
        let outcome: RowOutcome;
        try {
          const { data, error } = await supabase.rpc('adjust_inventory', call);
          if (error) {
            outcome = classifyAdjustmentError(error);
            messages[call.p_inventory_id] = sanitizeError(error);
            Sentry.captureException(error instanceof Error ? error : new Error(messages[call.p_inventory_id]), {
              extra: { context: 'Batch adjust error', outcome },
            });
          } else {
            assertRpcResult(data, 'adjust_inventory');
            outcome = 'adjusted';
          }
        } catch (err) {
          // A thrown request or an unusable reply: the database may still have
          // committed, so the row keeps its key.
          outcome = 'uncertain';
          messages[call.p_inventory_id] = sanitizeError(err);
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
            extra: { context: 'Batch adjust error', outcome },
          });
        }
        results[call.p_inventory_id] = { outcome, batchKey };
        if (outcome === 'adjusted') {
          newlyAdjusted++;
          delete messages[call.p_inventory_id];
        }
      }

      // Every row of this batch now has a result under this batch key: it was
      // either sent above or skipped because it had already settled under it.
      const outcomes = request.rows.map((row) => results[row.inventoryId].outcome);
      const uncertainCount = outcomes.filter((o) => o === 'uncertain').length;
      const refusedCount = outcomes.filter((o) => o === 'refused').length;
      const bindingCount = outcomes.filter((o) => o === 'binding_rejected').length;
      const adjustedCount = outcomes.filter((o) => o === 'adjusted').length;
      if (newlyAdjusted > 0 || uncertainCount > 0) stockMayHaveChangedRef.current = true;

      // Only unfreeze once no row is left uncertain. A refused or binding-rejected
      // row committed nothing under its key, so a later, deliberately new batch
      // may safely use fresh keys. Unfreeze BEFORE showing the row results so the
      // dialog never shows final results under an "Unconfirmed batch" banner.
      let resolveFailed = false;
      if (uncertainCount === 0) {
        try {
          await batchIntent.resolveIntent();
        } catch (err) {
          // The batch stays frozen; retrying it only replays receipts.
          resolveFailed = true;
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
            extra: { context: 'Batch adjust resolve failed' },
          });
        }
      }
      setRowResults(results);
      setRowMessages(messages);
      setLastBatchRows(request.rows);

      const signedDelta = `${request.delta > 0 ? '+' : ''}${request.delta}`;
      if (newlyAdjusted > 0) {
        await logActivity({ event: 'inventory_batch_adjusted', description: `Batch adjusted ${newlyAdjusted} product(s) by ${signedDelta}: ${request.reason}`, performedBy: request.performedBy, entityType: 'inventory' });
      }

      if (adjustedCount === request.rows.length) {
        if (resolveFailed) {
          toast('warning', `Adjusted ${adjustedCount} product(s) by ${signedDelta}, but this browser could not record that the batch finished. If it reappears as unconfirmed, retrying it will not move stock again.`);
        } else {
          toast('success', `Adjusted ${adjustedCount} product(s) by ${signedDelta}`);
        }
        resetAndClose();
        return;
      }

      const summary = `${adjustedCount} adjusted, ${refusedCount} refused, ${uncertainCount} not confirmed, ${bindingCount} need checking.`;
      if (uncertainCount > 0) {
        toast('warning', `${summary} Some adjustments may already have gone through. Retry the batch unchanged; rows that went through will not move again.`);
      } else if (bindingCount > 0) {
        toast('error', `${summary} Nothing changed for the rows marked "Check stock history", but an earlier attempt may have. Check each product's stock history before adjusting it again.`);
      } else {
        toast('error', summary);
      }
    } finally {
      setSaving(false);
    }
  };

  const quantityById = new Map(items.map((it) => [it.id, it.quantity_available]));
  const listedRows = frozen
    ? frozen.rows
    : [
      ...lastBatchRows,
      ...items
        .filter((it) => !lastBatchRows.some((row) => row.inventoryId === it.id))
        .map((it) => ({ inventoryId: it.id, productName: it.product_name })),
    ];
  const displayRows = listedRows.map((row) => ({
    id: row.inventoryId,
    name: row.productName,
    qty: frozen ? null : quantityById.get(row.inventoryId) ?? null,
  }));
  const actionCount = frozen
    ? frozen.rows.filter((row) => !SETTLED.has(rowResults[row.inventoryId]?.outcome)).length
    : pendingItems.length;

  return (
    <Modal open={open} onClose={handleClose} title="Batch" accent="Adjustment">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Adjusting <strong>{displayRows.length}</strong> product{displayRows.length !== 1 ? 's' : ''}
        </p>

        {frozen && (
          <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900" role="status">
            <strong>Unconfirmed batch:</strong> the last batch adjustment ({frozen.delta > 0 ? '+' : ''}{frozen.delta}, “{frozen.reason}”) may have partly gone through. Retry it unchanged — a product this batch already moved will not move again. If you have adjusted any of these products another way since, check its stock history first.
          </div>
        )}

        {/* Preview list */}
        <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg divide-y">
          {displayRows.map((row) => {
            const outcome = rowResults[row.id]?.outcome;
            const projected = row.qty === null ? null : row.qty + delta;
            const willGoNegative = hasDelta && projected !== null && projected < 0;
            const label = outcome === 'refused' && frozen ? 'Refused — will retry' : outcome ? OUTCOME_LABEL[outcome] : null;
            return (
              <div key={row.id} className="px-3 py-2 text-sm" data-testid={`batch-row-${row.id}`}>
                <div className="flex items-center justify-between">
                  <span className="truncate">{row.name}</span>
                  {outcome ? (
                    <span className={`whitespace-nowrap ml-2 ${OUTCOME_CLASS[outcome]}`}>{label}</span>
                  ) : row.qty !== null ? (
                    <span className={`whitespace-nowrap ml-2 ${willGoNegative ? 'text-red-600 font-medium' : 'text-secondary'}`}>
                      {row.qty} → {projected}
                    </span>
                  ) : null}
                </div>
                {outcome && outcome !== 'adjusted' && rowMessages[row.id] && (
                  <p className="text-xs text-secondary mt-0.5">{rowMessages[row.id]}</p>
                )}
              </div>
            );
          })}
        </div>

        {!frozen && negativeCount > 0 && (
          <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
            <strong>Warning:</strong> this adjustment will drive {negativeCount} product{negativeCount !== 1 ? 's' : ''} below zero. Verify with a physical count before proceeding.
          </div>
        )}

        <Input
          label="Adjustment Quantity (+ or -)"
          type="number"
          value={frozen ? String(frozen.delta) : uniformDelta}
          onChange={(e) => setUniformDelta(e.target.value)}
          placeholder="e.g. 5 or -3"
          disabled={Boolean(frozen)}
        />

        <Input
          label="Reason (required)"
          value={frozen ? frozen.reason : reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Cycle count correction, Damaged goods"
          disabled={Boolean(frozen)}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={!frozen && (delta === 0 || !reason.trim() || pendingItems.length === 0)}
          >
            {frozen
              ? `Retry ${actionCount} Unchanged`
              : `Adjust ${actionCount} Product${actionCount !== 1 ? 's' : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
