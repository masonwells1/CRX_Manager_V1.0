import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { supabase, assertRpcResult } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
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

/** Exported for testing */
// eslint-disable-next-line react-refresh/only-export-components
export function buildAdjustmentCalls(
  items: AdjustmentItem[],
  reason: string,
  userId: string,
  getKey: () => string = () => crypto.randomUUID(),
): RpcCall[] {
  return items
    .filter((it) => it.delta !== 0)
    .map((it) => ({
      p_inventory_id: it.inventory_id,
      p_delta: it.delta,
      p_reason: reason,
      p_performed_by: userId,
      p_idempotency_key: getKey(),
    }));
}

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
  // Per-item idempotency keys: generated once on first submit, reused on retry
  const [batchKeys, setBatchKeys] = useState<string[]>([]);

  const delta = Number(uniformDelta) || 0;
  const hasDelta = uniformDelta !== '' && Number.isFinite(Number(uniformDelta));
  const negativeCount = hasDelta ? items.filter((it) => it.quantity_available + delta < 0).length : 0;

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast('error', 'Please enter a reason for the adjustment');
      return;
    }
    if (delta === 0) {
      toast('error', 'Adjustment quantity cannot be zero');
      return;
    }

    setSaving(true);
    const adjustItems: AdjustmentItem[] = items.map((it) => ({
      inventory_id: it.id,
      product_name: it.product_name,
      current_qty: it.quantity_available,
      delta,
    }));

    // Generate stable per-item keys on first attempt; reuse on retry
    const keys = batchKeys.length === adjustItems.length ? batchKeys : adjustItems.map(() => crypto.randomUUID());
    if (batchKeys.length !== adjustItems.length) setBatchKeys(keys);
    let keyIndex = 0;
    const calls = buildAdjustmentCalls(adjustItems, reason.trim(), userId, () => keys[keyIndex++]);
    let successCount = 0;
    let errorCount = 0;

    for (const call of calls) {
      const { data, error } = await supabase.rpc('adjust_inventory', call);
      if (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Batch adjust error' } });
        errorCount++;
      } else {
        assertRpcResult(data, 'adjust_inventory');
        successCount++;
      }
    }

    if (successCount > 0) {
      setBatchKeys([]);
      await logActivity({ event: 'inventory_batch_adjusted', description: `Batch adjusted ${successCount} product(s) by ${delta > 0 ? '+' : ''}${delta}: ${reason.trim()}`, performedBy: userId, entityType: 'inventory' });
    }

    if (errorCount > 0) {
      toast('error', `${errorCount} adjustment(s) failed. ${successCount} succeeded.`);
    } else {
      toast('success', `Adjusted ${successCount} product(s) by ${delta > 0 ? '+' : ''}${delta}`);
    }

    setSaving(false);
    setReason('');
    setUniformDelta('');
    onSuccess();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Batch" accent="Adjustment">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Adjusting <strong>{items.length}</strong> product{items.length !== 1 ? 's' : ''}
        </p>

        {/* Preview list */}
        <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg divide-y">
          {items.map((it) => {
            const projected = it.quantity_available + delta;
            const willGoNegative = hasDelta && projected < 0;
            return (
              <div key={it.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate">{it.product_name}</span>
                <span className={`whitespace-nowrap ml-2 ${willGoNegative ? 'text-red-600 font-medium' : 'text-secondary'}`}>
                  {it.quantity_available} → {projected}
                </span>
              </div>
            );
          })}
        </div>

        {negativeCount > 0 && (
          <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
            <strong>Warning:</strong> this adjustment will drive {negativeCount} product{negativeCount !== 1 ? 's' : ''} below zero. Verify with a physical count before proceeding.
          </div>
        )}

        <Input
          label="Adjustment Quantity (+ or -)"
          type="number"
          value={uniformDelta}
          onChange={(e) => setUniformDelta(e.target.value)}
          placeholder="e.g. 5 or -3"
        />

        <Input
          label="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Cycle count correction, Damaged goods"
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={delta === 0 || !reason.trim()}
          >
            Adjust {items.length} Product{items.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
