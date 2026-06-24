import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageCheck, Search, Truck, ArrowRight, PackagePlus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import { SkeletonCard } from '../components/ui/Skeleton';
import EmptyState from '../components/ui/EmptyState';
import { supabase, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import type { InventoryPositionRow } from '../types';

// F5 — Receiving Hub: "To-Ship for inbound". Search a product and see every open
// purchase-order line for it across vendors (ordered − received), with a
// commitment snapshot from get_inventory_position(). A per-line "Receive" button
// records receipt in place via the existing receive_po_items RPC (in-full qty,
// condition 'good', Main Warehouse); partial/damaged receiving + printed receipts
// stay on the PO detail page. Built + compliance-reviewed but NOT fired against
// live — Mason click-tests it.

type POItemRaw = {
  id: string;
  product_name: string | null;
  product_id: string | null;
  quantity_ordered: number;
  quantity_received: number;
  unit_size: string | null;
};
type PORaw = {
  id: string;
  po_number: string | null;
  vendor: string | null;
  status: string;
  expected_delivery_date: string | null;
  items: POItemRaw[] | null;
};

type POLine = {
  po_id: string;
  po_item_id: string;
  po_number: string;
  vendor: string;
  expected_date: string | null;
  ordered: number;
  received: number;
  remaining: number;
  unit_size: string | null;
};
type ProductGroup = {
  product_id: string;
  product_name: string;
  lines: POLine[];
  total_remaining: number;
  pos: InventoryPositionRow | null;
};

const fmtUnits = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n || 0);

export default function ReceivingHub() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  // F5 inline receive (confirm-popup write, reuses receive_po_items).
  const receiveIdem = useIdempotencyKey('receive_po_items', profile?.id || '');
  const [receiveTarget, setReceiveTarget] = useState<{ line: POLine; product_name: string } | null>(null);
  const [receiveQty, setReceiveQty] = useState('');
  const [receiving, setReceiving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const poRes = await supabase
          .from('purchase_orders')
          .select('id, po_number, vendor, status, expected_delivery_date, items:purchase_order_items(id, product_name, product_id, quantity_ordered, quantity_received, unit_size)')
          .in('status', ['submitted', 'partially_received'])
          .order('expected_delivery_date', { ascending: true, nullsFirst: false })
          .limit(500);

        // get_inventory_position is its own `= await supabase.rpc(...)` (not inside a
        // Promise.all) so the assert-rpc-result lint rule tracks the destructured `data`.
        const { data: posRaw } = await supabase.rpc('get_inventory_position');
        const pos = assertRpcResult<InventoryPositionRow[]>(posRaw, 'get_inventory_position') || [];
        const posByProduct = new Map<string, InventoryPositionRow>();
        for (const p of pos) if (!posByProduct.has(p.product_id)) posByProduct.set(p.product_id, p);

        const byProduct = new Map<string, ProductGroup>();
        for (const po of ((poRes.data || []) as unknown as PORaw[])) {
          for (const it of po.items || []) {
            const remaining = (it.quantity_ordered || 0) - (it.quantity_received || 0);
            if (remaining <= 0 || !it.product_id) continue;
            const key = it.product_id;
            let g = byProduct.get(key);
            if (!g) {
              g = {
                product_id: key,
                product_name: it.product_name || 'Unknown product',
                lines: [],
                total_remaining: 0,
                pos: posByProduct.get(key) ?? null,
              };
              byProduct.set(key, g);
            }
            g.lines.push({
              po_id: po.id,
              po_item_id: it.id,
              po_number: po.po_number ?? '—',
              vendor: po.vendor ?? 'Unknown',
              expected_date: po.expected_delivery_date,
              ordered: it.quantity_ordered || 0,
              received: it.quantity_received || 0,
              remaining,
              unit_size: it.unit_size,
            });
            g.total_remaining += remaining;
          }
        }

        const list = [...byProduct.values()].sort((a, b) => a.product_name.localeCompare(b.product_name));
        if (!cancelled) setGroups(list);
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', page: 'receiving-hub' } });
        if (!cancelled) toast('error', 'Failed to load inbound purchase orders.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, refreshKey]);

  const handleReceiveConfirm = async () => {
    if (!receiveTarget || !profile) return;
    const qty = Number(receiveQty);
    if (!qty || qty <= 0) {
      toast('error', 'Enter a quantity greater than 0');
      return;
    }
    if (qty > receiveTarget.line.remaining) {
      toast('error', `Can't receive more than the ${fmtUnits(receiveTarget.line.remaining)} remaining`);
      return;
    }
    const line = receiveTarget.line;
    const name = receiveTarget.product_name;
    const idemKey = receiveIdem.getKey();
    await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('receive_po_items', {
          p_items: [{ po_item_id: line.po_item_id, quantity: qty, condition: 'good' }],
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_allow_over_receive: false,
        });
        if (error) throw error;
        assertRpcResult(data, 'receive_po_items');
      },
      toast,
      setLoading: setReceiving,
      successMessage: `Received ${fmtUnits(qty)} of ${name}`,
      sentryTag: 'receive_po_items',
      onSuccess: () => {
        receiveIdem.resetKey();
        setReceiveTarget(null);
        setReceiveQty('');
        setRefreshKey((k) => k + 1);
      },
    });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.product_name.toLowerCase().includes(q) ||
        g.lines.some((l) => l.vendor.toLowerCase().includes(q) || l.po_number.toLowerCase().includes(q))
    );
  }, [groups, search]);

  const totalRemaining = groups.reduce((s, g) => s + g.total_remaining, 0);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Receiving Hub</h2>
          <p className="text-xs text-secondary mt-0.5">
            Search a product to see every open purchase order for it across vendors. {groups.length} product
            {groups.length !== 1 ? 's' : ''} on order · {fmtUnits(totalRemaining)} units inbound.
          </p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by product, vendor, or PO #…"
          className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<PackageCheck className="w-6 h-6" />}
          title={groups.length === 0 ? 'Nothing on order' : 'No matches'}
          description={
            groups.length === 0
              ? 'No open purchase orders. Create a PO from Supplier POs or the low-stock Reorder button.'
              : 'No products match your search.'
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((g) => {
            const p = g.pos;
            return (
              <Card key={g.product_id} padding={false}>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-semibold text-nav-dark">{g.product_name}</p>
                      <p className="text-xs text-secondary mt-0.5">
                        <span className="font-medium text-amber-600">{fmtUnits(g.total_remaining)}</span> units still to receive
                        {' '}across {g.lines.length} PO line{g.lines.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                    {/* Commitment snapshot from get_inventory_position */}
                    {p && (
                      <div className="flex items-center gap-3 text-xs">
                        <Snapshot label="On Floor" value={p.quantity_available} />
                        <Snapshot label="On Hold" value={p.holds_qty} tone="amber" />
                        <Snapshot label="On Order" value={p.quantity_on_order} tone="teal" />
                        <Snapshot label="Spoken-For" value={p.quantity_prebooked} tone="amber" />
                        <Snapshot label="Net" value={p.net_position} tone={p.net_position < 0 ? 'red' : 'green'} />
                      </div>
                    )}
                  </div>

                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-secondary border-b border-gray-100">
                          <th className="px-2 py-1.5 text-left font-medium">Vendor</th>
                          <th className="px-2 py-1.5 text-left font-medium">PO #</th>
                          <th className="px-2 py-1.5 text-left font-medium">Arrival</th>
                          <th className="px-2 py-1.5 text-right font-medium">Ordered</th>
                          <th className="px-2 py-1.5 text-right font-medium">Received</th>
                          <th className="px-2 py-1.5 text-right font-medium">Remaining</th>
                          <th className="px-2 py-1.5"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l, i) => (
                          <tr key={`${l.po_id}-${i}`} className="border-b border-gray-50 hover:bg-gray-50/50">
                            <td className="px-2 py-1.5">{l.vendor}</td>
                            <td className="px-2 py-1.5 font-medium text-crx-green">{l.po_number}</td>
                            <td className="px-2 py-1.5">
                              {l.expected_date ? new Date(l.expected_date + 'T00:00:00').toLocaleDateString() : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">{fmtUnits(l.ordered)}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-secondary">{fmtUnits(l.received)}</td>
                            <td className="px-2 py-1.5 text-right font-mono font-semibold text-amber-600">{fmtUnits(l.remaining)}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <button
                                onClick={() => { setReceiveTarget({ line: l, product_name: g.product_name }); setReceiveQty(String(l.remaining)); }}
                                className="inline-flex items-center gap-1 px-2 py-1 mr-2 rounded-lg bg-crx-green text-white text-xs font-medium hover:bg-crx-green/90 transition-colors"
                                title="Receive this line"
                              >
                                <PackagePlus className="w-3.5 h-3.5" />
                                Receive
                              </button>
                              <button
                                onClick={() => navigate(`/purchase-orders/${l.po_id}`)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-crx-green hover:underline"
                                title="Open the purchase order"
                              >
                                Open PO
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-secondary flex items-center gap-1.5">
        <Truck className="w-3.5 h-3.5" />
        Receive a line in place, or open the PO for partial/damaged receiving and a printed receipt.
      </p>

      <Modal
        open={!!receiveTarget}
        onClose={() => { setReceiveTarget(null); setReceiveQty(''); }}
        title="Receive Stock"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Receive <span className="font-medium text-nav-dark">{receiveTarget?.product_name}</span> on PO{' '}
            <span className="font-medium text-nav-dark">{receiveTarget?.line.po_number}</span> from{' '}
            <span className="font-medium text-nav-dark">{receiveTarget?.line.vendor}</span>.{' '}
            {receiveTarget ? fmtUnits(receiveTarget.line.remaining) : '0'} units remaining.
          </p>
          <div>
            <label htmlFor="receive-qty" className="block text-xs font-medium text-secondary mb-1">Quantity to receive</label>
            <input
              id="receive-qty"
              type="number"
              min={0}
              max={receiveTarget?.line.remaining}
              value={receiveQty}
              onChange={(e) => setReceiveQty(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <p className="text-[11px] text-secondary mt-1">Goes to Main Warehouse in good condition. For partial/damaged or a printed receipt, open the PO.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => { setReceiveTarget(null); setReceiveQty(''); }}>Cancel</Button>
            <Button
              icon={<PackagePlus className="w-4 h-4" />}
              onClick={handleReceiveConfirm}
              loading={receiving}
              disabled={!receiveQty || Number(receiveQty) <= 0}
            >
              Receive
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Snapshot({ label, value, tone = 'gray' }: { label: string; value: number; tone?: 'gray' | 'green' | 'amber' | 'teal' | 'red' }) {
  const toneClass =
    tone === 'green' ? 'text-crx-green' :
    tone === 'amber' ? 'text-amber-600' :
    tone === 'teal' ? 'text-teal-600' :
    tone === 'red' ? 'text-red-600' :
    'text-nav-dark';
  return (
    <div className="text-center">
      <p className="text-[10px] text-secondary uppercase tracking-wide">{label}</p>
      <p className={`font-semibold ${toneClass}`}>{fmtUnits(value)}</p>
    </div>
  );
}
