/**
 * ToShip — Operations Command Center (Build A: read-only To-Ship core).
 *
 * Answers "how much more product do I owe customers, and to whom" on ONE screen
 * instead of opening every order. Demand comes from open order lines
 * (order_items.quantity_remaining > 0 on confirmed/partially_fulfilled orders);
 * supply (free stock + inbound-on-PO) comes from the get_inventory_position() RPC.
 *
 * Read-only. Frontend queries against existing data — zero DB changes.
 * Act-in-place buttons (schedule delivery / reorder) are a separate review-gated build.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Search, AlertTriangle, CheckCircle2, Truck, Users, DollarSign } from 'lucide-react';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import HelpTip from '../components/ui/HelpTip';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { InventoryPositionRow } from '../types';

const OPEN_STATUSES = ['confirmed', 'partially_fulfilled'];

interface OpenLine {
  id: string;
  order_id: string;
  order_number: string;
  order_date: string;
  customer_id: string;
  customer_name: string;
  tier: number;
  product_id: string;
  product_name: string;
  unit_size: string | null;
  price_per_unit: number;
  quantity_remaining: number;
}

interface Supply {
  available: number;
  prebooked: number;
  on_order: number;
}

type OrderRow = {
  id: string;
  order_number: string | null;
  order_date: string | null;
  customer_id: string | null;
  customer: { farm_name: string | null; assigned_tier: number | null } | { farm_name: string | null; assigned_tier: number | null }[] | null;
};

type ItemRow = {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  price_per_unit: number;
  quantity_remaining: number;
  unit_size: string | null;
};

const fmtUnits = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString();
const daysAgo = (d: string) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0);

export default function ToShip() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [lines, setLines] = useState<OpenLine[]>([]);
  const [supply, setSupply] = useState<Map<string, Supply>>(new Map());
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'product' | 'customer'>('product');
  const [search, setSearch] = useState('');
  const [shortOnly, setShortOnly] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // 1. Open orders (the booking still owes product)
    const { data: ordersRaw, error: oErr } = await supabase
      .from('orders')
      .select('id, order_number, order_date, customer_id, customer:customers(farm_name, assigned_tier)')
      .in('status', OPEN_STATUSES)
      .limit(2000);
    if (oErr) {
      Sentry.captureException(oErr, { tags: { source: 'fetch', action: 'load_to_ship_orders' } });
      toast('error', 'Failed to load open orders');
      setLoading(false);
      return;
    }
    const orders = (ordersRaw || []) as unknown as OrderRow[];
    const orderMap = new Map(orders.map((o) => [o.id, o]));
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length === 0) {
      setLines([]);
      setSupply(new Map());
      setLoading(false);
      return;
    }

    // 2. Open lines on those orders
    const { data: itemsRaw, error: iErr } = await supabase
      .from('order_items')
      .select('id, order_id, product_id, product_name, price_per_unit, quantity_remaining, unit_size')
      .in('order_id', orderIds)
      .gt('quantity_remaining', 0)
      .limit(5000);
    if (iErr) {
      Sentry.captureException(iErr, { tags: { source: 'fetch', action: 'load_to_ship_items' } });
      toast('error', 'Failed to load open order lines');
      setLoading(false);
      return;
    }
    const items = (itemsRaw || []) as unknown as ItemRow[];

    // 3. Supply position per product (optional — page still works without it)
    const supplyMap = new Map<string, Supply>();
    try {
      const { data: posRaw } = await supabase.rpc('get_inventory_position');
      const pos = (assertRpcResult<InventoryPositionRow[]>(posRaw, 'get_inventory_position') as InventoryPositionRow[]) || [];
      for (const r of pos) {
        const prev = supplyMap.get(r.product_id);
        if (prev) {
          prev.available += r.quantity_available;
          prev.prebooked += r.quantity_prebooked;
          prev.on_order += r.quantity_on_order;
        } else {
          supplyMap.set(r.product_id, {
            available: r.quantity_available,
            prebooked: r.quantity_prebooked,
            on_order: r.quantity_on_order,
          });
        }
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'to_ship_inventory_position' } });
    }

    const built: OpenLine[] = items.map((it) => {
      const o = orderMap.get(it.order_id);
      const cust = Array.isArray(o?.customer) ? o?.customer[0] : o?.customer;
      return {
        id: it.id,
        order_id: it.order_id,
        order_number: o?.order_number ?? '—',
        order_date: o?.order_date ?? '',
        customer_id: o?.customer_id ?? '',
        customer_name: cust?.farm_name ?? 'Unknown',
        tier: cust?.assigned_tier ?? 1,
        product_id: it.product_id,
        product_name: it.product_name,
        unit_size: it.unit_size,
        price_per_unit: it.price_per_unit,
        quantity_remaining: it.quantity_remaining,
      };
    });

    setLines(built);
    setSupply(supplyMap);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Shortfall classification for a product's owed quantity vs supply.
  const classify = useCallback(
    (productId: string, owed: number) => {
      const s = supply.get(productId);
      if (!s) return { status: 'unknown' as const, freeNow: null, inbound: null, shortBy: 0 };
      const freeNow = s.available - s.prebooked;
      const inbound = s.on_order;
      if (freeNow >= owed) return { status: 'ready' as const, freeNow, inbound, shortBy: 0 };
      if (freeNow + inbound >= owed) return { status: 'po' as const, freeNow, inbound, shortBy: 0 };
      return { status: 'short' as const, freeNow, inbound, shortBy: owed - freeNow - inbound };
    },
    [supply]
  );

  // Grouped by product
  const products = useMemo(() => {
    const map = new Map<string, { product_id: string; product_name: string; unit_size: string | null; owed: number; value: number; lines: OpenLine[] }>();
    for (const l of lines) {
      let g = map.get(l.product_id);
      if (!g) {
        g = { product_id: l.product_id, product_name: l.product_name, unit_size: l.unit_size, owed: 0, value: 0, lines: [] };
        map.set(l.product_id, g);
      }
      g.owed += l.quantity_remaining;
      g.value += l.quantity_remaining * l.price_per_unit;
      g.lines.push(l);
    }
    return [...map.values()]
      .map((g) => ({ ...g, ...classify(g.product_id, g.owed), lines: [...g.lines].sort((a, b) => b.quantity_remaining - a.quantity_remaining) }))
      .sort((a, b) => b.value - a.value);
  }, [lines, classify]);

  // Grouped by customer
  const customers = useMemo(() => {
    const map = new Map<string, { customer_id: string; customer_name: string; tier: number; value: number; lines: OpenLine[] }>();
    for (const l of lines) {
      let g = map.get(l.customer_id);
      if (!g) {
        g = { customer_id: l.customer_id, customer_name: l.customer_name, tier: l.tier, value: 0, lines: [] };
        map.set(l.customer_id, g);
      }
      g.value += l.quantity_remaining * l.price_per_unit;
      g.lines.push(l);
    }
    return [...map.values()]
      .map((g) => ({ ...g, lines: [...g.lines].sort((a, b) => b.quantity_remaining * b.price_per_unit - a.quantity_remaining * a.price_per_unit) }))
      .sort((a, b) => b.value - a.value);
  }, [lines]);

  // Stat strip
  const stats = useMemo(() => {
    const totalValue = lines.reduce((s, l) => s + l.quantity_remaining * l.price_per_unit, 0);
    const openOrders = new Set(lines.map((l) => l.order_id)).size;
    const productsOwed = new Set(lines.map((l) => l.product_id)).size;
    const shortProducts = products.filter((p) => p.status === 'short').length;
    return { totalValue, openOrders, productsOwed, shortProducts };
  }, [lines, products]);

  const q = search.trim().toLowerCase();
  const visibleProducts = products.filter(
    (p) => (!q || p.product_name.toLowerCase().includes(q)) && (!shortOnly || p.status === 'short')
  );
  const visibleCustomers = customers.filter((c) => !q || c.customer_name.toLowerCase().includes(q));

  const statusBadge = (status: string, shortBy: number) => {
    if (status === 'ready') return <Badge variant="success">Ready to ship</Badge>;
    if (status === 'po') return <Badge variant="warning">Short now · PO inbound</Badge>;
    if (status === 'short') return <Badge variant="error">Short {fmtUnits(shortBy)}</Badge>;
    return <Badge variant="default">Stock unknown</Badge>;
  };

  const tierChip = (tier: number) => (
    <span className="text-[10px] text-secondary border border-gray-200 rounded px-1 ml-1 align-middle">T{tier}</span>
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold font-heading text-nav-dark flex items-center">
          To-Ship
          <HelpTip text="Everything you still owe customers, in one place. Demand comes from open order lines (confirmed / partially fulfilled). Free stock and inbound-PO come from your live inventory position. Read-only." className="ml-1" />
        </h2>
        <p className="text-sm text-secondary mt-0.5">What you still owe customers — search a product to see who's waiting.</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <div className="flex items-center gap-2 mb-1 text-secondary text-sm"><DollarSign className="w-4 h-4" /> Dollars to ship</div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmtMoney(stats.totalValue)}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1 text-secondary text-sm"><Truck className="w-4 h-4" /> Open orders</div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{stats.openOrders}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1 text-secondary text-sm"><Package className="w-4 h-4" /> Products owed</div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{stats.productsOwed}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1 text-secondary text-sm"><AlertTriangle className="w-4 h-4" /> Short on stock</div>
          <p className="text-2xl font-semibold font-heading text-red-600">{stats.shortProducts}</p>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setView('product')}
            className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${view === 'product' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
          >
            <Package className="w-4 h-4" /> By product
          </button>
          <button
            onClick={() => setView('customer')}
            className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${view === 'customer' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
          >
            <Users className="w-4 h-4" /> By customer
          </button>
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === 'product' ? 'Search a product…' : 'Search a customer…'}
            aria-label="Search"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          />
        </div>
        {view === 'product' && (
          <button
            onClick={() => setShortOnly((v) => !v)}
            className={`px-3 py-2 text-sm font-medium rounded-lg border flex items-center gap-1.5 ${shortOnly ? 'bg-red-50 border-red-200 text-red-700' : 'bg-white border-gray-200 text-secondary hover:bg-gray-50'}`}
          >
            <AlertTriangle className="w-4 h-4" /> Short only
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
        </div>
      ) : lines.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <CheckCircle2 className="w-10 h-10 text-crx-green mx-auto mb-3" />
            <p className="font-medium text-nav-dark">Nothing left to ship</p>
            <p className="text-sm text-secondary mt-1">Every confirmed order has been fully delivered.</p>
          </div>
        </Card>
      ) : view === 'product' ? (
        <div className="space-y-3">
          {visibleProducts.map((p) => (
            <Card key={p.product_id}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="font-medium text-nav-dark">
                  {p.product_name}
                  {p.unit_size && <span className="text-secondary font-normal"> · {p.unit_size}</span>}
                  <span className="ml-2 align-middle">{statusBadge(p.status, p.shortBy)}</span>
                </div>
                <div className="text-sm text-secondary">{fmtMoney(p.value)} to ship</div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-secondary mt-2">
                <span><strong className="text-nav-dark font-medium">{fmtUnits(p.owed)}</strong> owed</span>
                {p.freeNow !== null && <span><strong className="text-nav-dark font-medium">{fmtUnits(p.freeNow)}</strong> free</span>}
                {p.inbound !== null && p.inbound > 0 && <span><strong className="text-amber-600 font-medium">{fmtUnits(p.inbound)}</strong> inbound</span>}
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b border-gray-100">
                      <th className="font-normal py-1.5">Customer</th>
                      <th className="font-normal">Order</th>
                      <th className="font-normal">Waiting</th>
                      <th className="font-normal text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.lines.map((l) => {
                      const age = daysAgo(l.order_date);
                      return (
                        <tr key={l.id} className="border-b border-gray-50 last:border-0">
                          <td className="py-1.5">
                            <button onClick={() => navigate(`/customers/${l.customer_id}`)} className="text-crx-green hover:underline font-medium">{l.customer_name}</button>
                            {tierChip(l.tier)}
                          </td>
                          <td>
                            <button onClick={() => navigate(`/orders/${l.order_id}`)} className="text-crx-green hover:underline">{l.order_number}</button>
                          </td>
                          <td className={age >= 14 ? 'text-red-600' : ''}>{age}d</td>
                          <td className="text-right font-medium">{fmtUnits(l.quantity_remaining)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          {visibleProducts.length === 0 && (
            <Card><p className="text-center text-secondary py-8 text-sm">No products match your filters.</p></Card>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleCustomers.map((c) => (
            <Card key={c.customer_id}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="font-medium text-nav-dark">
                  <button onClick={() => navigate(`/customers/${c.customer_id}`)} className="text-crx-green hover:underline">{c.customer_name}</button>
                  {tierChip(c.tier)}
                </div>
                <div className="text-sm text-secondary">{fmtMoney(c.value)} · {new Set(c.lines.map((l) => l.product_id)).size} products</div>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b border-gray-100">
                      <th className="font-normal py-1.5">Product</th>
                      <th className="font-normal">Order</th>
                      <th className="font-normal">Waiting</th>
                      <th className="font-normal text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l) => {
                      const age = daysAgo(l.order_date);
                      return (
                        <tr key={l.id} className="border-b border-gray-50 last:border-0">
                          <td className="py-1.5">{l.product_name}{l.unit_size && <span className="text-secondary"> · {l.unit_size}</span>}</td>
                          <td>
                            <button onClick={() => navigate(`/orders/${l.order_id}`)} className="text-crx-green hover:underline">{l.order_number}</button>
                          </td>
                          <td className={age >= 14 ? 'text-red-600' : ''}>{age}d</td>
                          <td className="text-right font-medium">{fmtUnits(l.quantity_remaining)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          {visibleCustomers.length === 0 && (
            <Card><p className="text-center text-secondary py-8 text-sm">No customers match your search.</p></Card>
          )}
        </div>
      )}
    </div>
  );
}
