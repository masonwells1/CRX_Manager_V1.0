/**
 * BatchCancelModal — Confirmation modal for batch-cancelling scheduled/in-progress deliveries.
 * Shows count, collects cancel reason, calls batch_cancel_deliveries RPC.
 */
import { useState } from 'react';
import { XCircle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

interface BatchCancelModalProps {
  open: boolean;
  onClose: () => void;
  count: number;
  onConfirm: (reason: string) => void;
  loading?: boolean;
}

export default function BatchCancelModal({
  open,
  onClose,
  count,
  onConfirm,
  loading = false,
}: BatchCancelModalProps) {
  const [reason, setReason] = useState('');

  const handleConfirm = () => {
    onConfirm(reason.trim() || 'Batch cancelled');
    setReason('');
  };

  return (
    <Modal open={open} onClose={onClose} title="Batch Cancel Deliveries">
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-800">
            You are about to cancel <strong>{count}</strong> delivery{count !== 1 ? 'ies' : ''}. This action will be
            recorded in the audit log.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-nav-dark mb-1">Cancel Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Enter reason for cancelling these deliveries..."
            rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Keep Deliveries
          </Button>
          <Button
            variant="danger"
            icon={<XCircle className="w-4 h-4" />}
            onClick={handleConfirm}
            loading={loading}
          >
            Cancel {count} Delivery{count !== 1 ? 'ies' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
