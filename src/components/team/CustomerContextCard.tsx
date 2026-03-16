import { useEffect, useState, useRef } from 'react';
import { DollarSign, ShoppingCart, Truck, Star } from 'lucide-react';
import { supabase } from '../../lib/db';

interface CustomerContext {
  farm_name: string;
  assigned_tier: number;
  credit_limit_cents: number;
  total_outstanding: number;
  open_orders: number;
  last_delivery_date: string | null;
}

// Session-level cache so we don't re-fetch for the same customer
const cache = new Map<string, CustomerContext>();

interface Props {
  customerId: string;
}

export default function CustomerContextCard({ customerId }: Props) {
  const [ctx, setCtx] = useState<CustomerContext | null>(cache.get(customerId) ?? null);
  const [loading, setLoading] = useState(!cache.has(customerId));
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (cache.has(customerId)) {
      setCtx(cache.get(customerId)!);
      setLoading(false);
      return;
    }
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    async function load() {
      try {
        // Parallel: customer info, AR aging, open orders count, last delivery
        const [custRes, arRes, ordersRes, delRes] = await Promise.all([
          supabase.from('customers').select('farm_name, assigned_tier, credit_limit_cents').eq('id', customerId).single(),
          supabase.rpc('get_ar_aging', { p_as_of_date: new Date().toISOString().slice(0, 10) }),
          supabase.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', customerId).in('status', ['confirmed', 'partially_fulfilled']),
          supabase.from('deliveries').select('completed_at').eq('customer_id', customerId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1),
        ]);

        if (!custRes.data) return;

        const arRow = (arRes.data as Record<string, unknown>[] | null)?.find(
          (r: Record<string, unknown>) => r.customer_id === customerId
        );

        const result: CustomerContext = {
          farm_name: custRes.data.farm_name,
          assigned_tier: custRes.data.assigned_tier ?? 1,
          credit_limit_cents: custRes.data.credit_limit_cents ?? 0,
          total_outstanding: Number((arRow as Record<string, unknown>)?.total_outstanding ?? 0),
          open_orders: ordersRes.count ?? 0,
          last_delivery_date: delRes.data?.[0]?.completed_at ?? null,
        };

        cache.set(customerId, result);
        setCtx(result);
      } catch {
        // Silently fail — context card is supplementary info
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [customerId]);

  if (loading) {
    return (
      <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
        <div className="w-3 h-3 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
        Loading context...
      </div>
    );
  }

  if (!ctx) return null;

  const tierLabel = `Tier ${ctx.assigned_tier}`;
  const arDisplay = ctx.total_outstanding > 0
    ? `$${ctx.total_outstanding.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '$0.00';
  const lastDel = ctx.last_delivery_date
    ? new Date(ctx.last_delivery_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'None';

  return (
    <div
      className="mt-1 px-2.5 py-1.5 rounded-md bg-purple-50 border border-purple-100 text-xs flex items-center gap-3 flex-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="flex items-center gap-1 text-purple-700 font-medium">
        <Star className="w-3 h-3" />
        {tierLabel}
      </span>
      <span className="flex items-center gap-1 text-gray-600">
        <DollarSign className="w-3 h-3" />
        AR: {arDisplay}
      </span>
      <span className="flex items-center gap-1 text-gray-600">
        <ShoppingCart className="w-3 h-3" />
        {ctx.open_orders} open order{ctx.open_orders !== 1 ? 's' : ''}
      </span>
      <span className="flex items-center gap-1 text-gray-600">
        <Truck className="w-3 h-3" />
        Last: {lastDel}
      </span>
    </div>
  );
}
