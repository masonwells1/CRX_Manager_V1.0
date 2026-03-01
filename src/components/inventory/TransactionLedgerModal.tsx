import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Truck, RefreshCw, ArrowRightLeft, Pencil } from 'lucide-react';
import Modal from '../ui/Modal';
import { supabase, sanitizeError } from '../../lib/db';

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
}

interface Props {
  open: boolean;
  onClose: () => void;
  productId: string;
  productName: string;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  received: { label: 'Received', color: 'text-crx-green', icon: ArrowDownToLine },
  delivered: { label: 'Delivered', color: 'text-blue-600', icon: Truck },
  adjusted: { label: 'Adjusted', color: 'text-amber-600', icon: Pencil },
  returned: { label: 'Returned', color: 'text-purple-600', icon: RefreshCw },
  transferred: { label: 'Transferred', color: 'text-teal-600', icon: ArrowRightLeft },
  booked: { label: 'Booked', color: 'text-gray-600', icon: ArrowUpFromLine },
};

/** Exported for testing */
export function computeRunningBalance(txns: Array<{ quantity: number }>): number[] {
  const balances: number[] = [];
  let running = 0;
  for (const t of txns) {
    running += t.quantity;
    balances.push(running);
  }
  return balances;
}

export default function TransactionLedgerModal({ open, onClose, productId, productName }: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !productId) return;
    setLoading(true);
    setError('');

    supabase
      .from('inventory_transactions')
      .select('*, performer:profiles!inventory_transactions_performed_by_fkey(full_name)')
      .eq('product_id', productId)
      .order('created_at', { ascending: true })
      .then(({ data, error: err }) => {
        if (err) {
          setError(sanitizeError(err));
        } else {
          setTransactions((data || []) as Transaction[]);
        }
        setLoading(false);
      });
  }, [open, productId]);

  const balances = computeRunningBalance(transactions);

  return (
    <Modal open={open} onClose={onClose} title="Transaction" accent="Ledger" size="large">
      <p className="text-sm text-secondary mb-4">{productName}</p>

      {loading && <p className="text-sm text-secondary py-8 text-center">Loading transactions...</p>}
      {error && <p className="text-sm text-red-600 py-4">{error}</p>}

      {!loading && !error && transactions.length === 0 && (
        <p className="text-sm text-secondary py-8 text-center">No transactions found for this product.</p>
      )}

      {!loading && transactions.length > 0 && (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white border-b">
              <tr className="text-left text-xs text-secondary">
                <th className="py-2 px-2">Date</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2 text-right">Qty</th>
                <th className="py-2 px-2 text-right">Balance</th>
                <th className="py-2 px-2">By</th>
                <th className="py-2 px-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, i) => {
                const config = TYPE_CONFIG[t.transaction_type] || {
                  label: t.transaction_type,
                  color: 'text-gray-600',
                  icon: Pencil,
                };
                const Icon = config.icon;
                const isPositive = t.quantity > 0;

                return (
                  <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-2 text-xs text-secondary whitespace-nowrap">
                      {new Date(t.created_at).toLocaleDateString()}{' '}
                      <span className="text-gray-400">
                        {new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${config.color}`}>
                        <Icon className="w-3 h-3" />
                        {config.label}
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-mono font-medium ${isPositive ? 'text-crx-green' : 'text-red-600'}`}>
                      {isPositive ? '+' : ''}{t.quantity}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-nav-dark">
                      {balances[i]}
                    </td>
                    <td className="py-2 px-2 text-xs text-secondary truncate max-w-[120px]">
                      {t.performer?.full_name || '-'}
                    </td>
                    <td className="py-2 px-2 text-xs text-secondary truncate max-w-[180px]">
                      {t.notes || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
