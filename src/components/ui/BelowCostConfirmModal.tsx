import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';
import { formatUSD } from '../../lib/money';

export interface BelowCostLine {
  productName: string;
  /** Effective sale price in DOLLARS per unit. */
  price: number;
  /** Unit cost in DOLLARS. */
  cost: number;
}

interface BelowCostConfirmModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the (non-empty) reason the user typed. */
  onConfirm: (reason: string) => void;
  lines: BelowCostLine[];
  loading?: boolean;
}

/**
 * Guardrail confirmation for saving a sale with line prices BELOW cost.
 * Styled after ConfirmModal's warning variant, plus a REQUIRED reason
 * textarea — Confirm stays disabled until a reason is entered. The caller
 * records the reason (notes / activity log) and continues the save.
 */
export default function BelowCostConfirmModal({
  open,
  onClose,
  onConfirm,
  lines,
  loading = false,
}: BelowCostConfirmModalProps) {
  const [reason, setReason] = useState('');

  // Fresh reason each time the modal opens — a prior approval's text must not
  // silently pre-approve a new below-cost save.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const trimmedReason = reason.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={loading}
      title="Selling below cost"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={loading} className="min-h-11 w-full sm:w-auto">
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<AlertTriangle className="w-4 h-4" />}
            onClick={() => onConfirm(trimmedReason)}
            loading={loading}
            disabled={trimmedReason.length === 0}
            className="min-h-11 w-full sm:w-auto"
          >
            Approve Below-Cost Sale
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 space-y-1">
            <p>
              {lines.length === 1 ? 'This line is' : `These ${lines.length} lines are`} priced below cost —
              this sale loses money on {lines.length === 1 ? 'it' : 'them'}:
            </p>
            <ul className="list-disc pl-5">
              {lines.map((line, i) => (
                <li key={i}>
                  {line.productName}: price {formatUSD(line.price)} is below cost {formatUSD(line.cost)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div>
          <label htmlFor="below-cost-reason" className="block text-sm font-medium text-nav-dark mb-1">
            Reason (required)
          </label>
          <textarea
            id="below-cost-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={loading}
            placeholder="Why is selling below cost approved here? (e.g. price match, clearance, customer goodwill)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
          />
          <p className="mt-1 text-xs text-secondary">The reason is saved on the record for later review.</p>
        </div>
      </div>
    </Modal>
  );
}
