import { useEffect, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Truck, RefreshCw, ArrowRightLeft,
  Pencil, Lock, Unlock, XCircle, Undo2, FlaskConical,
} from 'lucide-react';
import Modal from '../ui/Modal';
import { supabase, sanitizeError, assertRpcResult } from '../../lib/db';

interface Transaction {
  id: string;
  transaction_type: string;
  quantity: number;
  notes: string | null;
  created_at: string;
  performed_by: string | null;
  order_id: string | null;
  purchase_order_id: string | null;
  delivery_id: string | null;
  from_location: string | null;
  to_location: string | null;
  performer: { full_name: string } | null;
  order: { order_number: string; customer: { farm_name: string } | null } | null;
  purchase_order: { po_number: string } | null;
  delivery: { delivery_number: string } | null;
  requires_review: boolean;
}

interface InventoryPositionRow {
  product_id: string;
  quantity_available: number;
  quantity_prebooked: number;
}

interface InventoryPositionSummary {
  onFloor: number;
  prebooked: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  productId: string;
  productName: string;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  received:                    { label: 'Received',   color: 'text-crx-green',  icon: ArrowDownToLine },
  delivered:                   { label: 'Delivered',  color: 'text-blue-600',   icon: Truck },
  adjusted:                    { label: 'Adjusted',   color: 'text-amber-600',  icon: Pencil },
  returned:                    { label: 'Returned',   color: 'text-purple-600', icon: RefreshCw },
  transferred:                 { label: 'Transferred', color: 'text-teal-600',  icon: ArrowRightLeft },
  booked:                      { label: 'Booked',     color: 'text-gray-600',   icon: ArrowUpFromLine },
  prebooked:                   { label: 'Prebooked',  color: 'text-indigo-600', icon: Lock },
  released:                    { label: 'Released',   color: 'text-emerald-600', icon: Unlock },
  cancelled_delivery_reversal: { label: 'Cancelled Delivery', color: 'text-red-500', icon: XCircle },
  void_delivery_reversal:      { label: 'Void Delivery', color: 'text-red-500', icon: Undo2 },
  job_applied:                 { label: 'Job Applied', color: 'text-orange-600', icon: FlaskConical },
  prebook_reconciliation:      { label: 'Prebook Reconciliation', color: 'text-indigo-600', icon: Lock },
};

/**
 * Determine the signed delta for a transaction based on its type.
 * Convention matches reconciliation.ts:
 *   positive → adds to inventory (received, returned, released, reversals)
 *   negative → subtracts from inventory (delivered, booked, prebooked, job_applied)
 *   signed   → already has correct sign (adjusted, transferred)
 */
// eslint-disable-next-line react-refresh/only-export-components
export function signedQuantity(qty: number, type: string): number {
  switch (type) {
    case 'received':
    case 'returned':
    case 'released':
    case 'cancelled_delivery_reversal':
    case 'void_delivery_reversal':
      return Math.abs(qty);
    case 'delivered':
    case 'booked':
    case 'prebooked':
    case 'job_applied':
      return -Math.abs(qty);
    case 'adjusted':
    case 'transferred':
    case 'prebook_reconciliation':
      return qty; // already signed (prebook_reconciliation affects prebooked, shown as-is)
    default:
      return qty;
  }
}

/** Use the inventory table/RPC as current truth; the historical ledger can be incomplete. */
// eslint-disable-next-line react-refresh/only-export-components
export function summarizeInventoryPosition(
  rows: InventoryPositionRow[],
  productId: string,
): InventoryPositionSummary {
  return rows
    .filter((row) => row.product_id === productId)
    .reduce(
      (summary, row) => ({
        onFloor: summary.onFloor + Number(row.quantity_available || 0),
        prebooked: summary.prebooked + Number(row.quantity_prebooked || 0),
      }),
      { onFloor: 0, prebooked: 0 },
    );
}

/** Build a human-readable reference string from the transaction's linked entities */
function buildReference(t: Transaction): string {
  const parts: string[] = [];
  if (t.order?.order_number) parts.push(t.order.order_number);
  if (t.purchase_order?.po_number) parts.push(t.purchase_order.po_number);
  if (t.delivery?.delivery_number) parts.push(t.delivery.delivery_number);
  return parts.join(' · ');
}

export default function TransactionLedgerModal({ open, onClose, productId, productName }: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState<InventoryPositionSummary | null>(null);

  useEffect(() => {
    if (!open || !productId) return;
    setLoading(true);
    setError('');
    setPosition(null);

    // PR-07 follow-up: dropped performer FK embed; resolved via profile_public_view.
    (async () => {
      const { data, error: err } = await supabase
        .from('inventory_transactions')
        .select(`
          *,
          order:orders!inventory_transactions_order_id_fkey(order_number, customer:customers(farm_name)),
          purchase_order:purchase_orders!inventory_transactions_purchase_order_id_fkey(po_number),
          delivery:deliveries!inventory_transactions_delivery_id_fkey(delivery_number)
        `)
        .eq('product_id', productId)
        .order('created_at', { ascending: true });
      if (err) {
        setError(sanitizeError(err));
        setLoading(false);
        return;
      }
      const { data: positionData, error: positionError } = await supabase.rpc('get_inventory_position');
      if (positionError) {
        setError(sanitizeError(positionError));
        setLoading(false);
        return;
      }
      const positionRows = assertRpcResult<InventoryPositionRow[]>(positionData, 'get_inventory_position');
      setPosition(summarizeInventoryPosition(positionRows, productId));
      const performerIds = [...new Set(
        ((data || []) as Array<{ performed_by?: string | null }>)
          .map((t) => t.performed_by)
          .filter(Boolean) as string[]
      )];
      const performerMap: Record<string, { full_name: string }> = {};
      if (performerIds.length > 0) {
        const { data: performers } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', performerIds);
        (performers || []).forEach((p: { id: string | null; full_name: string | null }) => {
          if (p.id) performerMap[p.id] = { full_name: p.full_name ?? '' };
        });
      }
      const enriched = (data || []).map((t) => ({
        ...t,
        performer: t.performed_by ? performerMap[t.performed_by] || null : null,
      }));
      setTransactions(enriched as Transaction[]);
      setLoading(false);
    })();
  }, [open, productId]);

  const reviewCount = transactions.filter((transaction) => transaction.requires_review).length;

  return (
    <Modal open={open} onClose={onClose} title="Transaction" accent="Ledger" maxWidth="max-w-6xl">
      <p className="text-sm text-secondary mb-4">{productName}</p>

      {loading && <p className="text-sm text-secondary py-8 text-center">Loading transactions...</p>}
      {error && <p className="text-sm text-red-600 py-4">{error}</p>}

      {!loading && !error && position && (
        <div className="flex flex-wrap gap-4 mb-3 text-xs text-secondary">
          <span>{transactions.length} transaction{transactions.length !== 1 ? 's' : ''}</span>
          <span>On floor: <strong className="text-nav-dark font-mono">{position.onFloor}</strong></span>
          <span>Prebooked: <strong className="text-nav-dark font-mono">{position.prebooked}</strong></span>
          {reviewCount > 0 && (
            <span className="font-medium text-amber-700">{reviewCount} transaction{reviewCount !== 1 ? 's' : ''} need review</span>
          )}
        </div>
      )}

      {!loading && !error && transactions.length === 0 && (
        <p className="text-sm text-secondary py-8 text-center">No transactions found for this product.</p>
      )}

      {!loading && transactions.length > 0 && (
        <>
          <div className="max-h-[65vh] overflow-y-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b z-10">
                <tr className="text-left text-xs text-secondary font-medium">
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3 text-right">Qty</th>
                  <th className="py-2.5 px-3">Customer</th>
                  <th className="py-2.5 px-3">Reference</th>
                  <th className="py-2.5 px-3">By</th>
                  <th className="py-2.5 px-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => {
                  const config = TYPE_CONFIG[t.transaction_type] || {
                    label: t.transaction_type,
                    color: 'text-gray-600',
                    icon: Pencil,
                  };
                  const Icon = config.icon;
                  const displayQty = signedQuantity(t.quantity, t.transaction_type);
                  const isPositive = displayQty > 0;
                  const ref = buildReference(t);
                  const customerName = t.order?.customer?.farm_name || '';

                  return (
                    <tr key={t.id} className={`border-b border-gray-100 hover:bg-gray-50/70 align-top ${t.requires_review ? 'bg-amber-50/60' : ''}`}>
                      <td className="py-2 px-3 text-xs text-secondary whitespace-nowrap">
                        {new Date(t.created_at).toLocaleDateString()}{' '}
                        <span className="text-gray-400">
                          {new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${config.color}`}>
                          <Icon className="w-3 h-3 flex-shrink-0" />
                          {config.label}
                        </span>
                        {t.requires_review && (
                          <span className="ml-2 inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                            Review required
                          </span>
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right font-mono font-medium whitespace-nowrap ${isPositive ? 'text-crx-green' : displayQty === 0 ? 'text-gray-500' : 'text-red-600'}`}>
                        {isPositive ? '+' : ''}{displayQty}
                      </td>
                      <td className="py-2 px-3 text-xs text-secondary">
                        {customerName || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2 px-3 text-xs whitespace-nowrap">
                        {ref ? (
                          <span className="text-blue-600 font-medium">{ref}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs text-secondary whitespace-nowrap">
                        {t.performer?.full_name || '-'}
                      </td>
                      <td className="py-2 px-3 text-xs text-secondary break-words min-w-[200px]">
                        {t.notes || '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
