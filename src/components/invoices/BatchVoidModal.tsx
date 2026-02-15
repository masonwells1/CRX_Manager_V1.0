/**
 * BatchVoidModal — Confirmation modal for batch-voiding posted invoices.
 * Shows count, collects void reason, calls batch_void_invoices RPC.
 */
import { useState } from 'react';
import { Ban } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

interface BatchVoidModalProps {
  open: boolean;
  onClose: () => void;
  count: number;
  onConfirm: (reason: string) => void;
  loading?: boolean;
}

export default function BatchVoidModal({
  open,
  onClose,
  count,
  onConfirm,
  loading = false,
}: BatchVoidModalProps) {
  const [reason, setReason] = useState('');

  const handleConfirm = () => {
    onConfirm(reason.trim() || 'Batch voided');
    setReason('');
  };

  return (
    <Modal open={open} onClose={onClose} title="Batch Void Invoices">
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
          <Ban className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-800">
            You are about to void <strong>{count}</strong> posted invoice{count !== 1 ? 's' : ''}. This action will be
            recorded in the audit log.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-nav-dark mb-1">Void Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Enter reason for voiding these invoices..."
            rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<Ban className="w-4 h-4" />}
            onClick={handleConfirm}
            loading={loading}
          >
            Void {count} Invoice{count !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
