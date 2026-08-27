import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageCheck, Search, Truck, ArrowRight, PackagePlus, AlertTriangle } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { SkeletonCard } from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import { supabase, assertRpcResult } from '../../lib/db';
import { runCriticalAction } from '../../lib/criticalAction';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import {
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  useUncertainMutationIntent,
} from '../../hooks/useUncertainMutationIntent';
import { getIdempotencyMismatchResult } from '../../lib/idempotency';
import type { InventoryPositionRow } from '../../types';

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

export type POLine = {
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

export default function ReceivingHubPanel() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed initial load must show an ERROR state, not the empty "Nothing on
  // order" board — otherwise an RLS/drift/network failure reads as "no inbound
  // POs" (Codex P2). The throw on poRes.error lands in the catch below.
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  // F5 inline receive (confirm-popup write, reuses receive_po_items).
  const receiveIntent = useUncertainMutationIntent<{
    items: Array<{ po_item_id: string; quantity: number; condition: 'good' }>;
    performedBy: string;
    productName: string;
    target: { line: POLine; product_name: string };
  }>({
    operation: 'receive_po_items',
    userId: profile?.id || '',
    surface: 'receiving-hub',
    getIntentIdentity: (intent) => ({
      p_items: intent.items,
      p_performed_by: intent.performedBy,
      p_allow_over_receive: false,
    }),
  });
  const [receiveTarget, setReceiveTarget] = useState<{ line: POLine; product_name: string } | null>(null);
  const [receiveQty, setReceiveQty] = useState('');
  const [receiving, setReceiving] = useState(false);

  useEffect(() => {
    const recovered = receiveIntent.unresolvedIntent;
    if (!recovered) return;
    setReceiveTarget(recovered.target);
    setReceiveQty(String(recovered.items[0]?.quantity || ''));
  }, [receiveIntent.unresolvedIntent]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const poRes = await supabase
          .from('purchase_orders')
          .select('id, po_number, vendor, status, expected_delivery_date, items:purchase_order_items(id, product_name, product_id, quantity_ordered, quantity_received, unit_size)')
          .in('status', ['submitted', 'partially_received'])
          .order('expected_delivery_date', { ascending: true, nullsFirst: false })
          .limit(500);
        // A failed PO load must NOT look like "nothing on order" — surface it.
        // (Codex P2: poRes.data || [] below would silently swallow an RLS/drift
        // error and render an empty board.)
        if (poRes.error) throw poRes.error;

        // get_inventory_position is its own `= await supabase.rpc(...)` (not inside a
        // Promise.all) so the assert-rpc-result lint rule tracks the destructured `data`.
        const { data: posRaw } = await supabase.rpc('get_inventory_position');
        const pos = assertRpcResult<InventoryPositionRow[]>(posRaw, 'get_inventory_position') || [];
        // get_inventory_position returns one row per (product, location). On-Floor
        // (quantity_available) + Spoken-For (quantity_prebooked) are per-location →
        // SUM them; On-Order / On-Hold are product-level (identical on every row) →
        // keep. Net = available − prebooked + on_order, recomputed off the totals.
        const posByProduct = new Map<string, InventoryPositionRow>();
        for (const p of pos) {
          const existing = posByProduct.get(p.product_id);
          if (!existing) {
            posByProduct.set(p.product_id, { ...p });
          } else {
            existing.quantity_available += p.quantity_available;
            existing.quantity_prebooked += p.quantity_prebooked;
            existing.net_position = existing.quantity_available - existing.quantity_prebooked + existing.quantity_on_order;
          }
        }

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
        if (!cancelled) { setLoadError(true); toast('error', 'Failed to load inbound purchase orders.'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, refreshKey]);

  const handleReceiveConfirm = async () => {
    if (receiveIntent.isForeignIntentLocked) {
      toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
      return;
    }
    if (receiveIntent.isRetryExpired) {
      toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
      return;
    }
    if (!receiveTarget || !profile) return;
    const qty = Number(receiveQty);
    if (!qty || qty <= 0) {
      toast('error', 'Enter a quantity greater than 0');
      return;
    }
    // Quick receive is FULL-receipt-only by design — a short/partial or damaged
    // receipt must go through the PO detail flow that captures that context + the
    // printed receipt (Codex P1/P2: don't let a partial silently post here as
    // condition 'good'). The input is read-only at `remaining`; this is the backstop.
    if (qty !== receiveTarget.line.remaining) {
      toast('error', `Quick receive records the full ${fmtUnits(receiveTarget.line.remaining)} remaining. For a partial or damaged receipt, open the PO.`);
      return;
    }
    const request = await receiveIntent.beginIntent({
      items: [{ po_item_id: receiveTarget.line.po_item_id, quantity: qty, condition: 'good' }],
      performedBy: profile.id,
      productName: receiveTarget.product_name,
      target: receiveTarget,
    });
    const idemKey = receiveIntent.getIdempotencyKey();
    await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('receive_po_items', {
          p_items: request.items,
          p_performed_by: request.performedBy,
          p_idempotency_key: idemKey,
          p_allow_over_receive: false,
        });
        if (error) {
          const receipt = getIdempotencyMismatchResult(error, 'receive_po_items');
          const recordIds = receipt?.receiving_record_ids;
          if (Array.isArray(recordIds) && recordIds.every((id) => typeof id === 'string')) {
            toast('warning', 'The earlier receipt already completed. Refreshing the receiving board instead of receiving it twice.');
          } else {
            const disposition = await receiveIntent.classifyFailure(error);
            if (disposition === 'resolved') {
              toast('warning', 'This receipt completed in another tab. Refreshing the receiving board instead of receiving it twice.');
            } else if (disposition === 'definitive') {
              throw error;
            } else {
              throw new Error('The receipt may already be recorded. Retry the locked request unchanged to reconcile it.');
            }
          }
        } else {
          assertRpcResult(data, 'receive_po_items');
        }
        await receiveIntent.resolveIntent();
      },
      toast,
      setLoading: setReceiving,
      successMessage: `Received ${fmtUnits(request.items[0].quantity)} of ${request.productName}`,
      sentryTag: 'receive_po_items',
      onSuccess: () => {
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

  // A failed load is NOT an empty board — show an explicit error so an RLS / drift
  // / network failure never reads as "no inbound POs" (Codex P2).
  if (loadError) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Receiving Hub</h2>
        <EmptyState
          icon={<AlertTriangle className="w-6 h-6" />}
          title="Couldn't load inbound purchase orders"
          description="Something went wrong loading the data — this does NOT mean there are no open POs. Please refresh to try again."
        />
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
                      <div className="grid w-full grid-cols-3 gap-2 text-xs md:flex md:w-auto md:items-center md:gap-3">
                        <Snapshot label="On Floor" value={p.quantity_available} />
                        <Snapshot label="On Hold" value={p.holds_qty} tone="amber" />
                        <Snapshot label="On Order" value={p.quantity_on_order} tone="teal" />
                        <Snapshot label="Spoken-For" value={p.quantity_prebooked} tone="amber" />
                        <Snapshot label="Net" value={p.net_position} tone={p.net_position < 0 ? 'red' : 'green'} />
                      </div>
                    )}
                  </div>

                  <ReceivingHubLineCards
                    lines={g.lines}
                    productName={g.product_name}
                    onReceive={(line) => {
                      setReceiveTarget({ line, product_name: g.product_name });
                      setReceiveQty(String(line.remaining));
                    }}
                    onOpen={(line) => navigate(`/purchase-orders/${line.po_id}`)}
                  />

                  <div className="mt-3 hidden overflow-x-auto md:block" data-testid="receiving-hub-desktop-table">
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
        onClose={() => {
          if (receiveIntent.isIntentLocked) return;
          setReceiveTarget(null);
          setReceiveQty('');
        }}
        title="Receive Stock"
      >
        <div className="space-y-4">
          {receiveIntent.isIntentLocked && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {receiveIntent.isForeignIntentLocked
                ? UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE
                : receiveIntent.isRetryExpired
                ? UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE
                : 'The last response was uncertain. This receiving request is locked so stock cannot be received twice. Retry it unchanged to reconcile the result.'}
            </div>
          )}
          <p className="text-sm text-secondary">
            Receive <span className="font-medium text-nav-dark">{receiveTarget?.product_name}</span> on PO{' '}
            <span className="font-medium text-nav-dark">{receiveTarget?.line.po_number}</span> from{' '}
            <span className="font-medium text-nav-dark">{receiveTarget?.line.vendor}</span>.{' '}
            {receiveTarget ? fmtUnits(receiveTarget.line.remaining) : '0'} units remaining.
          </p>
          <div>
            <label htmlFor="receive-qty" className="block text-xs font-medium text-secondary mb-1">Quantity to receive (full receipt)</label>
            <input
              id="receive-qty"
              type="number"
              inputMode="decimal"
              value={receiveQty}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-gray-50 text-secondary cursor-not-allowed"
            />
            <p className="text-[11px] text-secondary mt-1">Receives the full remaining quantity to Main Warehouse in good condition. For a partial/damaged receipt or a printed receipt, open the PO.</p>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" disabled={receiveIntent.isIntentLocked} onClick={() => { setReceiveTarget(null); setReceiveQty(''); }}>Cancel</Button>
            <Button
              icon={<PackagePlus className="w-4 h-4" />}
              onClick={handleReceiveConfirm}
              loading={receiving}
              disabled={receiveIntent.isForeignIntentLocked || receiveIntent.isRetryExpired || !receiveQty || Number(receiveQty) <= 0}
            >
              {receiveIntent.isIntentLocked ? 'Retry Exact Receiving' : 'Receive'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function ReceivingHubLineCards({
  lines,
  productName,
  onReceive,
  onOpen,
}: {
  lines: POLine[];
  productName: string;
  onReceive: (line: POLine) => void;
  onOpen: (line: POLine) => void;
}) {
  return (
    <div className="mt-3 space-y-3 md:hidden" data-testid="receiving-hub-mobile-cards">
      {lines.map((line) => (
        <article key={line.po_item_id} className="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-nav-dark">{line.vendor}</p>
              <p className="mt-0.5 text-xs text-secondary">
                PO <span className="font-semibold text-crx-green">{line.po_number}</span>
                {' · '}{line.expected_date ? new Date(line.expected_date + 'T00:00:00').toLocaleDateString() : 'Arrival unknown'}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
              {fmtUnits(line.remaining)} remaining
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-xs text-secondary">Ordered</dt>
              <dd className="font-mono font-medium text-nav-dark">{fmtUnits(line.ordered)}</dd>
            </div>
            <div>
              <dt className="text-xs text-secondary">Received</dt>
              <dd className="font-mono font-medium text-nav-dark">{fmtUnits(line.received)}</dd>
            </div>
          </dl>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onReceive(line)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-crx-green px-3 text-sm font-medium text-white"
              aria-label={`Receive ${productName} from ${line.vendor}`}
            >
              <PackagePlus className="h-4 w-4" />
              Receive
            </button>
            <button
              type="button"
              onClick={() => onOpen(line)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-crx-green"
              aria-label={`Open purchase order ${line.po_number}`}
            >
              Open PO
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </article>
      ))}
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
