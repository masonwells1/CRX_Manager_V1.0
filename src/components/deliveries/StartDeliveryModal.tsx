/**
 * StartDeliveryModal — Confirmation modal before starting a delivery.
 * Shows inventory check warning and items list before transitioning scheduled → in_progress.
 */
import { AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import type { Delivery } from '../../types';

interface DeliveryItemDisplay {
  id: string;
  product_name?: string;
  quantity: number;
  unit_size?: string;
}

interface StartDeliveryModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  delivery: Delivery | null;
  items: DeliveryItemDisplay[];
  loading?: boolean;
}

export default function StartDeliveryModal({
  open,
  onClose,
  onConfirm,
  delivery,
  items,
  loading = false,
}: StartDeliveryModalProps) {
  if (!delivery) return null;

  return (
    <Modal open={open} onClose={onClose} title="Start Delivery">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">
              Before starting, please verify that all items are loaded and counted on the truck/trailer.
            </p>
            <p className="text-xs text-amber-700 mt-1">
              Once started, the delivery will be marked as in-progress and ready for completion.
            </p>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-nav-dark mb-2">
            Items for {delivery.delivery_number}
          </h3>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-3 py-2 font-medium text-secondary">Product</th>
                  <th className="text-right px-3 py-2 font-medium text-secondary">Qty</th>
                  <th className="text-left px-3 py-2 font-medium text-secondary">Unit</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 text-nav-dark">{item.product_name || 'Unknown'}</td>
                    <td className="px-3 py-2 text-right font-mono">{item.quantity}</td>
                    <td className="px-3 py-2 text-secondary">{item.unit_size || '—'}</td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-secondary">
                      No items found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            loading={loading}
          >
            Start Delivery
          </Button>
        </div>
      </div>
    </Modal>
  );
}
