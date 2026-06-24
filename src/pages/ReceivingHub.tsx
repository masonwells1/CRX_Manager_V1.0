import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageCheck, Search, Truck, ArrowRight } from 'lucide-react';
import Card from '../components/ui/Card';
import { SkeletonCard } from '../components/ui/Skeleton';
import EmptyState from '../components/ui/EmptyState';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { useToast } from '../components/ui/Toast';
import type { InventoryPositionRow } from '../types';

// F5 — Receiving Hub: "To-Ship for inbound". Search a product and see every open
// purchase-order line for it across vendors (ordered − received), with a
// commitment snapshot from get_inventory_position(). v1 is READ-ONLY (open the PO
// to receive); the inline confirm-popup receive (reuse receive_po_items) lands in
// a follow-up tick and is review-gated + Mason-tested.

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
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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

        // get_inventory_position pulled out of any Promise.all so the assertRpcCoverage
        // regex sees the `= await supabase.rpc(...)` capture (it keys on `= await`).
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
  }, [toast]);

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
                            <td className="px-2 py-1.5 text-right">
                              <button
                                onClick={() => navigate(`/purchase-orders/${l.po_id}`)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-crx-green hover:underline"
                                title="Open the purchase order to receive"
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
        Receiving happens on the purchase order. An inline one-click receive is coming next.
      </p>
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
