import { Camera } from 'lucide-react';
import type { ReceivingRecord } from '../../types';
import Badge from '../ui/Badge';

const conditionVariant = (condition: string): 'success' | 'error' | 'warning' | 'default' => {
  if (condition === 'good') return 'success';
  if (condition === 'damaged' || condition === 'wrong_product') return 'error';
  if (condition === 'short' || condition === 'mixed') return 'warning';
  return 'default';
};

const conditionLabel = (condition: string) =>
  condition.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export default function ReceivingLogMobileCards({
  records,
  canSelect,
  selected,
  onToggleSelect,
  onOpen,
}: {
  records: ReceivingRecord[];
  canSelect: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (record: ReceivingRecord) => void;
}) {
  if (records.length === 0) {
    return (
      <div className="md:hidden px-4 py-10 text-center" data-testid="receiving-log-mobile-cards">
        <p className="font-medium text-nav-dark">No receiving records</p>
        <p className="mt-1 text-sm text-secondary">Items received on purchase orders will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 md:hidden" data-testid="receiving-log-mobile-cards">
      {records.map((record) => {
        const receivedAt = new Date(record.received_at);
        return (
          <article key={record.id} className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex min-w-0 items-start gap-3">
              {canSelect && (
                <input
                  type="checkbox"
                  checked={selected.has(record.id)}
                  onChange={() => onToggleSelect(record.id)}
                  aria-label={`Select ${record.product_name || 'receiving record'}`}
                  className="mt-1 h-5 w-5 shrink-0 rounded border-gray-300"
                />
              )}
              <button type="button" onClick={() => onOpen(record)} className="min-w-0 flex-1 text-left">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-nav-dark">{record.product_name || 'Unknown product'}</p>
                    <p className="mt-0.5 truncate text-xs text-secondary">{record.vendor || 'Unknown vendor'} · PO {record.po_number || '—'}</p>
                  </div>
                  <Badge variant={conditionVariant(record.condition)}>{conditionLabel(record.condition)}</Badge>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-secondary">Received</dt>
                    <dd className="font-mono font-semibold text-nav-dark">
                      {record.quantity_received.toLocaleString()}{record.unit_size ? ` ${record.unit_size}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-secondary">Date</dt>
                    <dd className="font-medium text-nav-dark">{receivedAt.toLocaleDateString()}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-secondary">Received by</dt>
                    <dd className="truncate text-nav-dark">{record.received_by_name || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-secondary">Lot / Tote #</dt>
                    <dd className="truncate font-mono text-nav-dark">{record.lot_number || '—'}</dd>
                  </div>
                </dl>

                {((record.photo_count ?? 0) > 0 || record.is_non_returnable) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {(record.photo_count ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-secondary">
                        <Camera className="h-3.5 w-3.5" />
                        {record.photo_count} photo{record.photo_count === 1 ? '' : 's'}
                      </span>
                    )}
                    {record.is_non_returnable && <Badge variant="warning">Non-Returnable</Badge>}
                  </div>
                )}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
