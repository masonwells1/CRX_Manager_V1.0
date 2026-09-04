/**
 * WriteOffModal — Write-off amount + reason for posted invoices
 *
 * Sprint 11: Financial Workflows
 */
import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { sanitizeError, supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../../lib/parseCents';
import { logActivity } from '../../lib/activityLogger';
import { formatCents as fmt } from '../../lib/money';

interface WriteOffModalProps {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceNumber: string;
  balanceCents: number;
  onSuccess: () => void;
}


export default function WriteOffModal({
  open,
  onClose,
  invoiceId,
  invoiceNumber,
  balanceCents,
  onSuccess,
}: WriteOffModalProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const writeOffIdem = useIdempotencyKey('apply_write_off', profile?.id || '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!profile) {
      toast('error', 'Cannot apply write-off — profile not loaded. Please refresh.');
      return;
    }
    const amountCents = parseDollarsToCents(amount);
    if (amountCents === null) {
      toast('error', MONEY_PRECISION_MESSAGE);
      return;
    }
    if (amountCents <= 0) {
      toast('error', 'Enter a valid write-off amount');
      return;
    }
    if (amountCents > balanceCents) {
      toast('error', `Write-off amount cannot exceed balance of ${fmt(balanceCents)}`);
      return;
    }
    if (!reason.trim()) {
      toast('error', 'Reason is required for write-offs');
      return;
    }

    setSubmitting(true);
    try {
      const key = writeOffIdem.getKey();
      const { data, error } = await supabase.rpc('apply_write_off', {
        p_invoice_id: invoiceId,
        p_amount_cents: amountCents,
        p_reason: reason.trim(),
        p_performed_by: profile?.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult<string>(data, 'apply_write_off');
      writeOffIdem.resetKey();
      logActivity({ event: 'apply_write_off', description: `Write-off of ${fmt(amountCents)} applied to invoice ${invoiceNumber}. Reason: ${reason.trim()}`, performedBy: profile.id, entityType: 'invoice', entityId: invoiceId });
      toast('success', `Write-off of ${fmt(amountCents)} applied to ${invoiceNumber}`);
      setAmount('');
      setReason('');
      onClose();
      onSuccess();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'WriteOffModal.handleSubmit' } });
      toast('error', sanitizeError(err));
    }
    setSubmitting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Write Off Balance">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Write off a portion or all of the balance for invoice <strong>{invoiceNumber}</strong>.
        </p>
        <div className="bg-gray-50 p-3 rounded-lg flex justify-between text-sm">
          <span className="text-secondary">Current Balance</span>
          <span className="font-semibold text-red-600">{fmt(balanceCents)}</span>
        </div>
        <Input
          label="Write-Off Amount ($)"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={0}
          step={0.01}
          placeholder={`Up to ${(balanceCents / 100).toFixed(2)}`}
        />
        <div>
          <label className="block text-sm font-medium text-nav-dark mb-1">Reason *</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            placeholder="e.g., Uncollectible, customer dispute, small balance write-off"
          />
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting}>
            Apply Write-Off
          </Button>
        </div>
      </div>
    </Modal>
  );
}
