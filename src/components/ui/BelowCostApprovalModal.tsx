import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';
import { formatCents } from '../../lib/money';
import type { BelowCostApprovalDetail } from '../../lib/belowCostApproval';

interface Props {
  open: boolean;
  detail: BelowCostApprovalDetail | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export default function BelowCostApprovalModal({ open, detail, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);

  const trimmedReason = reason.trim();
  const price = detail?.unit_price_cents;
  const cost = detail?.locked_unit_cost_cents;
  const hasMoney = price != null && cost != null;
  const shortfall = hasMoney ? cost - price : null;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Approve below-cost price"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} className="min-h-11 w-full sm:w-auto">Cancel</Button>
          <Button
            variant="danger"
            icon={<AlertTriangle className="h-4 w-4" />}
            onClick={() => onConfirm(trimmedReason)}
            disabled={!trimmedReason}
            className="min-h-11 w-full sm:w-auto"
          >
            Approve and Retry
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">{detail?.product_name || 'This product'} is priced below its locked cost.</p>
              {hasMoney && shortfall !== null && (
                <p className="mt-1 tabular-nums">
                  Price {formatCents(price)} · Cost {formatCents(cost)} · Shortfall {formatCents(shortfall)} per unit
                </p>
              )}
              <p className="mt-2">
                The database reported this line first. Approving applies your reason to{' '}
                <span className="font-medium">every below-cost line in this save</span>, not only the one shown —
                review the other line prices before approving if you are unsure.
              </p>
            </div>
          </div>
        </div>
        <div>
          <label htmlFor="below-cost-approval-reason" className="mb-1 block text-sm font-medium text-nav-dark">
            Approval reason (required)
          </label>
          <textarea
            id="below-cost-approval-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder="Example: approved price match for this customer"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          />
        </div>
      </div>
    </Modal>
  );
}
