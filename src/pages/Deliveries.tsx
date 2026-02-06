import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { Delivery, Profile } from '../types';

interface DeliveryRow extends Delivery {
  customer_name: string;
  driver_name: string;
  item_count: number;
}

export default function Deliveries() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [drivers, setDrivers] = useState<Profile[]>([]);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchDeliveries();
    fetchDrivers();
  }, []);

  const fetchDrivers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'driver')
      .eq('is_active', true)
      .order('full_name');
    setDrivers((data || []) as Profile[]);
  };

  const fetchDeliveries = async () => {
    const { data: delData } = await supabase
      .from('deliveries')
      .select('*, customer:customers(farm_name), driver:profiles!deliveries_assigned_driver_fkey(full_name)')
      .order('scheduled_date', { ascending: false });

    const { data: itemCounts } = await supabase
      .from('delivery_items')
      .select('delivery_id');

    const countMap: Record<string, number> = {};
    (itemCounts || []).forEach((item) => {
      countMap[item.delivery_id] = (countMap[item.delivery_id] || 0) + 1;
    });

    const rows = ((delData || []) as Array<Delivery & {
      customer: { farm_name: string } | null;
      driver: { full_name: string } | null;
    }>).map((d) => ({
      ...d,
      customer_name: d.customer?.farm_name || 'Unknown',
      driver_name: d.driver?.full_name || 'Unassigned',
      item_count: countMap[d.id] || 0,
    }));

    setDeliveries(rows);
    setLoading(false);
  };

  const filtered = deliveries.filter((d) => {
    if (statusFilter && d.status !== statusFilter) return false;
    if (driverFilter && d.assigned_driver !== driverFilter) return false;
    if (dateFilter && d.scheduled_date !== dateFilter) return false;
    return true;
  });

  const columns: Column<DeliveryRow>[] = [
    {
      key: 'delivery_number',
      header: 'Delivery #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.delivery_number}</span>,
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
    },
    {
      key: 'driver_name',
      header: 'Driver',
      sortable: true,
    },
    {
      key: 'scheduled_date',
      header: 'Scheduled',
      sortable: true,
      render: (row) => new Date(row.scheduled_date).toLocaleDateString(),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'item_count',
      header: 'Items',
      sortable: true,
    },
  ];

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/deliveries/new')}>
            Schedule Delivery
          </Button>
        </div>
      )}

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search deliveries..."
            searchKeys={['delivery_number', 'customer_name', 'driver_name']}
            onRowClick={(row) => navigate(`/deliveries/${(row as unknown as DeliveryRow).id}`)}
            emptyTitle="No deliveries"
            emptyDescription="Schedule a delivery from an order"
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select
                  value={driverFilter}
                  onChange={(e) => setDriverFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Drivers</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.full_name}</option>
                  ))}
                </select>
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </>
            }
          />
        </div>
      </Card>
    </div>
  );
}
