import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import { supabase } from '../lib/supabase';
import type { Customer } from '../types';

export default function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('');

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('*')
      .order('farm_name');
    setCustomers((data || []) as Customer[]);
    setLoading(false);
  };

  const filtered = customers.filter((c) => {
    if (tierFilter && c.assigned_tier !== parseInt(tierFilter)) return false;
    return true;
  });

  const columns: Column<Customer>[] = [
    {
      key: 'farm_name',
      header: 'Farm Name',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.farm_name}</span>,
    },
    { key: 'contact_name', header: 'Contact', sortable: true },
    { key: 'phone', header: 'Phone' },
    {
      key: 'assigned_tier',
      header: 'Tier',
      sortable: true,
      render: (row) => (
        <Badge variant={row.assigned_tier === 1 ? 'success' : row.assigned_tier === 2 ? 'info' : 'warning'}>
          Tier {row.assigned_tier}
        </Badge>
      ),
    },
    {
      key: 'total_acres',
      header: 'Total Acres',
      sortable: true,
      render: (row) => row.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
          Add Customer
        </Button>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search customers..."
            searchKeys={['farm_name', 'contact_name', 'phone', 'email']}
            onRowClick={(row) => navigate(`/customers/${(row as unknown as Customer).id}`)}
            emptyTitle="No customers yet"
            emptyDescription="Add your first customer to start quoting"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
                Add Customer
              </Button>
            }
            loading={loading}
            filters={
              <select
                value={tierFilter}
                onChange={(e) => setTierFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Tiers</option>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
              </select>
            }
          />
        </div>
      </Card>
    </div>
  );
}
