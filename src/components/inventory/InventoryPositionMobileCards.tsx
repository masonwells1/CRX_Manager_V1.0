import { ArrowDownToLine, FileText, Pencil, Trash2 } from 'lucide-react';

export type MobileInventoryPosition = {
  id: string;
  product_id: string;
  product_name: string;
  inventory_unit: string | null;
  unit_size: string | null;
  location: string | null;
  total_on_floor: number;
  quantity_prebooked: number;
  net_position: number;
};

type Props = {
  rows: MobileInventoryPosition[];
  isAdmin: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onViewHistory: (row: MobileInventoryPosition) => void;
  onReceive: (id: string) => void;
  onAdjust: (id: string) => void;
  onDelete: (id: string) => void;
};

const formatQuantity = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

export default function InventoryPositionMobileCards({
  rows,
  isAdmin,
  selectedIds,
  onToggleSelect,
  onViewHistory,
  onReceive,
  onAdjust,
  onDelete,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="md:hidden px-4 py-10 text-center" data-testid="inventory-mobile-cards">
        <p className="font-medium text-nav-dark">No inventory records</p>
        <p className="mt-1 text-sm text-secondary">Inventory will appear as products are stocked</p>
      </div>
    );
  }

  return (
    <div className="md:hidden space-y-3 p-3" data-testid="inventory-mobile-cards">
      {rows.map((row) => {
        const shortfall = Math.max(0, -row.net_position);
        const unit = row.inventory_unit || row.unit_size || 'units';

        return (
          <article key={row.id} className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => onViewHistory(row)}
                  className="flex min-h-11 max-w-full items-center gap-2 text-left"
                  aria-label={`View transaction history for ${row.product_name}`}
                >
                  <span className="truncate font-semibold text-nav-dark">{row.product_name}</span>
                  <FileText className="h-4 w-4 shrink-0 text-secondary" />
                </button>
                <p className="truncate text-xs text-secondary">{row.location || 'No location'} · {unit}</p>
              </div>
              {isAdmin && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(row.id)}
                  onChange={() => onToggleSelect(row.id)}
                  aria-label={`Select ${row.product_name}`}
                  className="h-5 w-5 shrink-0 rounded border-gray-300"
                />
              )}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-gray-50 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-secondary">On hand</dt>
                <dd className="mt-1 text-lg font-semibold text-nav-dark">{formatQuantity(row.total_on_floor)}</dd>
              </div>
              <div className="rounded-lg bg-amber-50 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-amber-700">Reserved</dt>
                <dd className="mt-1 text-lg font-semibold text-amber-700">{formatQuantity(row.quantity_prebooked)}</dd>
              </div>
            </dl>

            <div className="mt-3 flex items-center justify-between gap-3">
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                  shortfall > 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                }`}
              >
                {shortfall > 0 ? `Shortfall ${formatQuantity(shortfall)}` : 'No shortfall'}
              </span>

              {isAdmin && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onReceive(row.id)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary hover:bg-gray-100"
                    aria-label={`Receive ${row.product_name}`}
                  >
                    <ArrowDownToLine className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onAdjust(row.id)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-secondary hover:bg-gray-100"
                    aria-label={`Adjust ${row.product_name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(row.id)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-red-600 hover:bg-red-50"
                    aria-label={`Delete ${row.product_name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
