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
import { Package, Search, AlertTriangle, CheckCircle2, Truck, Users, DollarSign, Inbox } from 'lucide-react';
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
  product_name: string;
  available: number;
  prebooked: number;
  on_order: number;
  net: number;
  reorder: number;
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

type DeliveryRow = {
  id: string;
  delivery_number: string | null;
  scheduled_date: string | null;
  status: string;
  assigned_driver: string | null;
  customer: { farm_name: string | null } | { farm_name: string | null }[] | null;
  order: { order_number: string | null } | { order_number: string | null }[] | null;
};

type POItem = { id: string; product_name: string | null; product_id: string; quantity_ordered: number; quantity_received: number; unit_size: string | null };
type PORow = {
  id: string;
  po_number: string | null;
  vendor: string | null;
  status: string;
  expected_delivery_date: string | null;
  items: POItem[] | null;
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
  const [view, setView] = useState<'product' | 'customer'>(() => (localStorage.getItem('toship.view') === 'customer' ? 'customer' : 'product'));
  const [search, setSearch] = useState('');
  const [shortOnly, setShortOnly] = useState(() => localStorage.getItem('toship.shortOnly') === '1');
  const [section, setSection] = useState<'to-ship' | 'low-stock' | 'deliveries' | 'inbound'>(() => {
    const s = localStorage.getItem('toship.section');
    return s === 'low-stock' || s === 'deliveries' || s === 'inbound' ? s : 'to-ship';
  });
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [pos, setPos] = useState<PORow[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // 0. Open deliveries (scheduled / in progress) — independent of order demand
    const { data: delivRaw } = await supabase
      .from('deliveries')
      .select('id, delivery_number, scheduled_date, status, assigned_driver, customer:customers(farm_name), order:orders(order_number)')
      .in('status', ['scheduled', 'in_progress'])
      .order('scheduled_date', { ascending: true })
      .limit(500);
    setDeliveries((delivRaw || []) as unknown as DeliveryRow[]);

    // 0b. Open purchase orders (inbound stock on the way)
    const { data: poRaw } = await supabase
      .from('purchase_orders')
      .select('id, po_number, vendor, status, expected_delivery_date, items:purchase_order_items(id, product_name, product_id, quantity_ordered, quantity_received, unit_size)')
      .in('status', ['submitted', 'partially_received'])
      .order('expected_delivery_date', { ascending: true, nullsFirst: false })
      .limit(500);
    setPos((poRaw || []) as unknown as PORow[]);

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
          prev.net += r.net_position;
          prev.reorder += r.reorder_point;
        } else {
          supplyMap.set(r.product_id, {
            product_name: r.product_name,
            available: r.quantity_available,
            prebooked: r.quantity_prebooked,
            on_order: r.quantity_on_order,
            net: r.net_position,
            reorder: r.reorder_point,
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

  // Remember the user's last view + short-only filter across visits.
  useEffect(() => { localStorage.setItem('toship.view', view); }, [view]);
  useEffect(() => { localStorage.setItem('toship.shortOnly', shortOnly ? '1' : '0'); }, [shortOnly]);
  useEffect(() => { localStorage.setItem('toship.section', section); }, [section]);

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

  // Low-stock / inventory pressure: products at/below reorder point OR where open
  // demand exceeds free stock. Reuses the inventory position already fetched.
  const lowStock = useMemo(() => {
    const owedByProduct = new Map<string, number>();
    for (const l of lines) owedByProduct.set(l.product_id, (owedByProduct.get(l.product_id) || 0) + l.quantity_remaining);
    return [...supply.entries()]
      .map(([pid, s]) => ({ product_id: pid, ...s, owed: owedByProduct.get(pid) || 0 }))
      .filter((p) => p.net <= p.reorder || (p.owed > 0 && p.net < p.owed))
      .sort((a, b) => (a.net - Math.max(a.reorder, a.owed)) - (b.net - Math.max(b.reorder, b.owed)));
  }, [supply, lines]);
  const visibleLowStock = lowStock.filter((p) => !q || p.product_name.toLowerCase().includes(q));

  const visibleDeliveries = deliveries
    .map((d) => {
      const cust = Array.isArray(d.customer) ? d.customer[0] : d.customer;
      const ord = Array.isArray(d.order) ? d.order[0] : d.order;
      return {
        id: d.id,
        delivery_number: d.delivery_number ?? '—',
        scheduled_date: d.scheduled_date ?? '',
        status: d.status,
        unassigned: !d.assigned_driver,
        customer_name: cust?.farm_name ?? 'Unknown',
        order_number: ord?.order_number ?? null,
      };
    })
    .filter((d) => !q || d.customer_name.toLowerCase().includes(q));

  const visiblePOs = pos
    .map((po) => {
      const openItems = (po.items || []).filter((it) => it.quantity_ordered > it.quantity_received);
      return { id: po.id, po_number: po.po_number ?? '—', vendor: po.vendor ?? 'Unknown', expected_delivery_date: po.expected_delivery_date ?? '', openItems };
    })
    .filter((po) => po.openItems.length > 0)
    .filter((po) => !q || po.vendor.toLowerCase().includes(q) || po.po_number.toLowerCase().includes(q) || po.openItems.some((it) => (it.product_name || '').toLowerCase().includes(q)));

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

      {/* Section switcher */}
      <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
        <button
          onClick={() => setSection('to-ship')}
          className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${section === 'to-ship' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
        >
          <Truck className="w-4 h-4" /> To-Ship
        </button>
        <button
          onClick={() => setSection('low-stock')}
          className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${section === 'low-stock' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
        >
          <AlertTriangle className="w-4 h-4" /> Low stock
        </button>
        <button
          onClick={() => setSection('deliveries')}
          className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${section === 'deliveries' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
        >
          <Truck className="w-4 h-4" /> Deliveries
        </button>
        <button
          onClick={() => setSection('inbound')}
          className={`px-3 py-1.5 text-sm font-medium flex items-center gap-1.5 ${section === 'inbound' ? 'bg-crx-green text-white' : 'bg-white text-secondary hover:bg-gray-50'}`}
        >
          <Inbox className="w-4 h-4" /> Inbound
        </button>
      </div>

      {section === 'to-ship' && (
        <>
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
                      <th className="font-normal"></th>
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
                          <td className="text-right">
                            <button
                              onClick={() => navigate(`/deliveries/new?order=${l.order_id}`)}
                              title="Schedule a delivery for this order (pre-fills the remaining items)"
                              className="text-xs font-medium px-2.5 py-1 rounded-md bg-crx-green text-white hover:bg-crx-green-hover transition-colors"
                            >
                              Schedule
                            </button>
                          </td>
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
        </>
      )}

      {section === 'low-stock' && (
        loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="relative max-w-md">
              <Search className="w-4 h-4 text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search a product…"
                aria-label="Search low stock"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <p className="text-sm text-secondary">Products at or below reorder point, or where open orders exceed free stock.</p>
            <Card padding={false}>
              <div className="overflow-x-auto p-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b border-gray-100">
                      <th className="font-normal py-1.5">Product</th>
                      <th className="font-normal text-right">Free (net)</th>
                      <th className="font-normal text-right">On order</th>
                      <th className="font-normal text-right">Reorder pt</th>
                      <th className="font-normal text-right">Owed</th>
                      <th className="font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLowStock.map((p) => (
                      <tr key={p.product_id} className="border-b border-gray-50 last:border-0">
                        <td className="py-2">{p.product_name}</td>
                        <td className={`text-right font-medium ${p.net < 0 ? 'text-red-600' : ''}`}>{fmtUnits(p.net)}</td>
                        <td className="text-right">{p.on_order > 0 ? fmtUnits(p.on_order) : '—'}</td>
                        <td className="text-right text-secondary">{p.reorder > 0 ? fmtUnits(p.reorder) : '—'}</td>
                        <td className="text-right">{p.owed > 0 ? fmtUnits(p.owed) : '—'}</td>
                        <td className="text-right">{p.owed > p.net ? <Badge variant="error">Reorder</Badge> : <Badge variant="warning">Low</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleLowStock.length === 0 && (
                  <p className="text-center text-secondary py-8 text-sm">No low-stock products. Inventory is keeping up with demand.</p>
                )}
              </div>
            </Card>
          </>
        )
      )}

      {section === 'deliveries' && (
        loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="relative max-w-md">
              <Search className="w-4 h-4 text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search a customer…"
                aria-label="Search deliveries"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <p className="text-sm text-secondary">Open deliveries (scheduled or in progress). Overdue and unassigned are flagged.</p>
            <Card padding={false}>
              <div className="overflow-x-auto p-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b border-gray-100">
                      <th className="font-normal py-1.5">Date</th>
                      <th className="font-normal">Customer</th>
                      <th className="font-normal">Delivery</th>
                      <th className="font-normal">Order</th>
                      <th className="font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDeliveries.map((d) => {
                      const overdue = daysAgo(d.scheduled_date) > 0 && d.status === 'scheduled';
                      return (
                        <tr key={d.id} className="border-b border-gray-50 last:border-0">
                          <td className="py-2">
                            {d.scheduled_date ? new Date(d.scheduled_date).toLocaleDateString() : '—'}
                            {overdue && <span className="ml-2 align-middle"><Badge variant="error">Overdue</Badge></span>}
                          </td>
                          <td>{d.customer_name}{d.unassigned && <span className="text-amber-600 text-xs ml-1">· unassigned</span>}</td>
                          <td><button onClick={() => navigate(`/deliveries/${d.id}`)} className="text-crx-green hover:underline">{d.delivery_number}</button></td>
                          <td className="text-secondary">{d.order_number || '—'}</td>
                          <td className="text-right"><Badge variant={d.status === 'in_progress' ? 'info' : 'default'}>{d.status.replace('_', ' ')}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {visibleDeliveries.length === 0 && (
                  <p className="text-center text-secondary py-8 text-sm">No open deliveries.</p>
                )}
              </div>
            </Card>
          </>
        )
      )}

      {section === 'inbound' && (
        loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="relative max-w-md">
              <Search className="w-4 h-4 text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search vendor or product…"
                aria-label="Search inbound"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <p className="text-sm text-secondary">Open purchase orders — stock on the way, soonest arrival first. Overdue arrivals flagged.</p>
            <div className="space-y-3">
              {visiblePOs.map((po) => {
                const overdue = daysAgo(po.expected_delivery_date) > 0;
                return (
                  <Card key={po.id}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="font-medium text-nav-dark">
                        {po.vendor} <span className="text-secondary font-normal">· PO {po.po_number}</span>
                      </div>
                      <div className="text-sm text-secondary">
                        {po.expected_delivery_date ? `arrives ${new Date(po.expected_delivery_date).toLocaleDateString()}` : 'no arrival date'}
                        {overdue && <span className="ml-2 align-middle"><Badge variant="error">Overdue</Badge></span>}
                      </div>
                    </div>
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-secondary border-b border-gray-100">
                            <th className="font-normal py-1.5">Product</th>
                            <th className="font-normal text-right">Ordered</th>
                            <th className="font-normal text-right">Received</th>
                            <th className="font-normal text-right">Remaining</th>
                          </tr>
                        </thead>
                        <tbody>
                          {po.openItems.map((it) => (
                            <tr key={it.id} className="border-b border-gray-50 last:border-0">
                              <td className="py-1.5">{it.product_name || '—'}{it.unit_size && <span className="text-secondary"> · {it.unit_size}</span>}</td>
                              <td className="text-right">{fmtUnits(it.quantity_ordered)}</td>
                              <td className="text-right text-secondary">{fmtUnits(it.quantity_received)}</td>
                              <td className="text-right font-medium text-amber-600">{fmtUnits(it.quantity_ordered - it.quantity_received)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                );
              })}
              {visiblePOs.length === 0 && (
                <Card><p className="text-center text-secondary py-8 text-sm">No inbound purchase orders.</p></Card>
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}
