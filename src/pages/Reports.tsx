import { useEffect, useState } from 'react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import SplitHeading from '../components/ui/SplitHeading';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

type TabKey = 'customer' | 'product' | 'commission' | 'revenue';

interface CustomerProfit {
  farm_name: string;
  total_revenue: number;
  total_profit: number;
  margin_pct: number;
  order_count: number;
}

interface ProductProfit {
  product_name: string;
  total_revenue: number;
  total_profit: number;
  units_sold: number;
  margin_pct: number;
}

interface CommissionRow {
  id: string;
  recipient: string;
  order_id: string;
  commission_amount: number;
  split_percentage: number;
  order_profit: number;
  order_date: string;
  status: string;
}

interface RevenueSummary {
  month: string;
  revenue: number;
  profit: number;
  orders: number;
}

export default function Reports() {
  const { role, profile } = useAuth();
  const [tab, setTab] = useState<TabKey>('customer');
  const [customerData, setCustomerData] = useState<CustomerProfit[]>([]);
  const [productData, setProductData] = useState<ProductProfit[]>([]);
  const [commissionData, setCommissionData] = useState<CommissionRow[]>([]);
  const [revenueData, setRevenueData] = useState<RevenueSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchData();
  }, [tab]);

  const fetchData = async () => {
    setLoading(true);
    if (tab === 'customer') await fetchCustomerProfitability();
    if (tab === 'product') await fetchProductProfitability();
    if (tab === 'commission') await fetchCommissions();
    if (tab === 'revenue') await fetchRevenue();
    setLoading(false);
  };

  const fetchCustomerProfitability = async () => {
    const { data } = await supabase
      .from('orders')
      .select('total_price, total_profit, total_margin_pct, customer:customers(farm_name)');
    const grouped: Record<string, CustomerProfit> = {};
    ((data || []) as Array<{ total_price: number; total_profit: number; total_margin_pct: number; customer: { farm_name: string }[] | null }>).forEach((o) => {
      const name = o.customer?.[0]?.farm_name || 'Unknown';
      if (!grouped[name]) {
        grouped[name] = { farm_name: name, total_revenue: 0, total_profit: 0, margin_pct: 0, order_count: 0 };
      }
      grouped[name].total_revenue += o.total_price || 0;
      grouped[name].total_profit += o.total_profit || 0;
      grouped[name].order_count += 1;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setCustomerData(result);
  };

  const fetchProductProfitability = async () => {
    const { data } = await supabase
      .from('order_items')
      .select('product_name, total_price, profit, total_units_needed');
    const grouped: Record<string, ProductProfit> = {};
    ((data || []) as Array<{ product_name: string; total_price: number; profit: number; total_units_needed: number }>).forEach((i) => {
      const name = i.product_name;
      if (!grouped[name]) {
        grouped[name] = { product_name: name, total_revenue: 0, total_profit: 0, units_sold: 0, margin_pct: 0 };
      }
      grouped[name].total_revenue += i.total_price || 0;
      grouped[name].total_profit += i.profit || 0;
      grouped[name].units_sold += i.total_units_needed || 0;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setProductData(result);
  };

  const fetchCommissions = async () => {
    let query = supabase.from('commissions').select('*').order('order_date', { ascending: false });
    if (!isAdmin && profile) {
      query = query.eq('recipient', profile.id);
    }
    const { data } = await query;
    setCommissionData((data || []) as CommissionRow[]);
  };

  const fetchRevenue = async () => {
    const { data } = await supabase
      .from('orders')
      .select('order_date, total_price, total_profit')
      .order('order_date');
    const grouped: Record<string, RevenueSummary> = {};
    ((data || []) as Array<{ order_date: string; total_price: number; total_profit: number }>).forEach((o) => {
      const month = o.order_date.substring(0, 7);
      if (!grouped[month]) {
        grouped[month] = { month, revenue: 0, profit: 0, orders: 0 };
      }
      grouped[month].revenue += o.total_price || 0;
      grouped[month].profit += o.total_profit || 0;
      grouped[month].orders += 1;
    });
    setRevenueData(Object.values(grouped).sort((a, b) => b.month.localeCompare(a.month)));
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'customer', label: 'By Customer' },
    { key: 'product', label: 'By Product' },
    { key: 'commission', label: 'Commissions' },
    { key: 'revenue', label: 'Revenue Summary' },
  ];

  const customerCols: Column<CustomerProfit>[] = [
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.farm_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
    { key: 'order_count', header: 'Orders', sortable: true },
  ];

  const productCols: Column<ProductProfit>[] = [
    { key: 'product_name', header: 'Product', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.product_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'units_sold', header: 'Units Sold', sortable: true },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
  ];

  const commissionCols: Column<CommissionRow>[] = [
    { key: 'order_date', header: 'Date', sortable: true, render: (r) => new Date(r.order_date).toLocaleDateString() },
    { key: 'commission_amount', header: 'Commission', sortable: true, render: (r) => <span className="font-mono font-medium">{fmt(r.commission_amount)}</span> },
    { key: 'split_percentage', header: 'Split %', sortable: true, render: (r) => `${r.split_percentage}%` },
    { key: 'order_profit', header: 'Order Profit', sortable: true, render: (r) => <span className="font-mono">{fmt(r.order_profit)}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge variant={statusToBadgeVariant[r.status] || 'default'}>{r.status}</Badge> },
  ];

  const revenueCols: Column<RevenueSummary>[] = [
    { key: 'month', header: 'Month', sortable: true },
    { key: 'revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.revenue)}</span> },
    { key: 'profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.profit)}</span> },
    { key: 'orders', header: 'Orders', sortable: true },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Reports" accent="& Analytics" />

      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key
                ? 'bg-white text-nav-dark shadow-sm'
                : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card padding={false}>
        <div className="p-5">
          {tab === 'customer' && (
            <DataTable
              data={customerData as unknown as Record<string, unknown>[]}
              columns={customerCols as unknown as Column<Record<string, unknown>>[]}
              searchable
              searchPlaceholder="Search customers..."
              searchKeys={['farm_name']}
              emptyTitle="No customer data"
              loading={loading}
            />
          )}
          {tab === 'product' && (
            <DataTable
              data={productData as unknown as Record<string, unknown>[]}
              columns={productCols as unknown as Column<Record<string, unknown>>[]}
              searchable
              searchPlaceholder="Search products..."
              searchKeys={['product_name']}
              emptyTitle="No product data"
              loading={loading}
            />
          )}
          {tab === 'commission' && (
            <DataTable
              data={commissionData as unknown as Record<string, unknown>[]}
              columns={commissionCols as unknown as Column<Record<string, unknown>>[]}
              emptyTitle="No commissions"
              loading={loading}
            />
          )}
          {tab === 'revenue' && (
            <DataTable
              data={revenueData as unknown as Record<string, unknown>[]}
              columns={revenueCols as unknown as Column<Record<string, unknown>>[]}
              emptyTitle="No revenue data"
              loading={loading}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
