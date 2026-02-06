import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Truck } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { supabase } from '../lib/supabase';
import type { Order, OrderItem, Customer } from '../types';

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) fetchOrder();
  }, [id]);

  const fetchOrder = async () => {
    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (orderData) {
      setOrder(orderData as Order);
      const { data: custData } = await supabase
        .from('customers')
        .select('*')
        .eq('id', orderData.customer_id)
        .maybeSingle();
      setCustomer(custData as Customer | null);

      const { data: itemsData } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', id!)
        .order('section_name');
      setItems((itemsData || []) as OrderItem[]);
    }
    setLoading(false);
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Order not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/orders')}>
          Back to Orders
        </Button>
      </div>
    );
  }

  const sections = [...new Set(items.map((i) => i.section_name || 'General'))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/orders')}
          className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Orders
        </button>
        <Button
          icon={<Truck className="w-4 h-4" />}
          onClick={() => navigate(`/deliveries/new?order=${order.id}`)}
        >
          Schedule Delivery
        </Button>
      </div>

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              {order.order_number}
            </h2>
            <p className="text-sm text-secondary mt-1">
              {customer?.farm_name || 'Unknown Customer'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={statusToBadgeVariant[order.status] || 'default'} size="md">
              {order.status.replace('_', ' ')}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Order Date</p>
            <p className="text-sm font-medium text-nav-dark">
              {new Date(order.order_date).toLocaleDateString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary">Total Price</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(order.total_price)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Profit</p>
            <p className="text-sm font-medium text-crx-green">{fmt(order.total_profit)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Margin</p>
            <p className="text-sm font-medium text-nav-dark">
              {order.total_margin_pct.toFixed(1)}%
            </p>
          </div>
        </div>
      </Card>

      {sections.map((section) => (
        <Card key={section} padding={false}>
          <div className="p-5">
            <CardHeader title={section} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Price/Unit</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Units Needed</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Delivered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Remaining</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary w-40">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {items
                    .filter((i) => (i.section_name || 'General') === section)
                    .map((item) => {
                      const pct =
                        item.total_units_needed > 0
                          ? Math.round((item.quantity_delivered / item.total_units_needed) * 100)
                          : 0;
                      return (
                        <tr key={item.id} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-nav-dark">
                            {item.product_name}
                          </td>
                          <td className="px-4 py-3 font-mono">{fmt(item.price_per_unit)}</td>
                          <td className="px-4 py-3">{item.total_units_needed}</td>
                          <td className="px-4 py-3">{item.quantity_delivered}</td>
                          <td className="px-4 py-3">{item.quantity_remaining}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-crx-green rounded-full transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-secondary w-8">{pct}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
