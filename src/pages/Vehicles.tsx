import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Truck, Plane } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import type { Vehicle, VehicleType, VehicleStatus } from '../types';

const statusVariant: Record<VehicleStatus, BadgeVariant> = {
  active: 'success',
  inactive: 'default',
  maintenance: 'warning',
};

export default function Vehicles() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<VehicleType | ''>('');
  const [statusFilter, setStatusFilter] = useState<VehicleStatus | ''>('');

  useEffect(() => {
    fetchVehicles();
  }, []);

  const fetchVehicles = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .order('vehicle_name');

    if (error) {
      console.error('Failed to load vehicles:', error.message);
      toast('error', 'Failed to load vehicles');
      setLoading(false);
      return;
    }
    setVehicles((data || []) as Vehicle[]);
    setLoading(false);
  };

  const filtered = vehicles.filter((v) => {
    if (typeFilter && v.vehicle_type !== typeFilter) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    return true;
  });

  const columns: Column<Vehicle>[] = [
    {
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => navigate(`/vehicles/${r.id}`)}
          className="flex items-center gap-2 font-medium text-nav-dark hover:text-crx-green transition-colors"
        >
          {r.vehicle_type === 'air' ? <Plane className="w-4 h-4 text-blue-500" /> : <Truck className="w-4 h-4 text-gray-500" />}
          {r.vehicle_name}
        </button>
      ),
    },
    {
      key: 'vehicle_type',
      header: 'Type',
      sortable: true,
      render: (r) => (
        <Badge variant={r.vehicle_type === 'air' ? 'info' : 'default'}>
          {r.vehicle_type === 'air' ? 'Air' : 'Ground'}
        </Badge>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      render: (r) => r.category || '-',
    },
    {
      key: 'capacity_gallons',
      header: 'Capacity',
      sortable: true,
      render: (r) =>
        r.capacity_gallons
          ? `${r.capacity_gallons.toLocaleString()} ${r.capacity_unit || 'gal'}`
          : '-',
    },
    {
      key: 'registration',
      header: 'Registration',
      sortable: true,
      render: (r) => r.registration || '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <Badge variant={statusVariant[r.status]}>{r.status}</Badge>,
    },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Vehicles" accent="& Equipment">
        <Button
          icon={<Plus className="w-4 h-4" />}
          onClick={() => navigate('/vehicles/new')}
        >
          Add Vehicle
        </Button>
      </SplitHeading>

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as VehicleType | '')}
          aria-label="Filter by vehicle type"
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">All Types</option>
          <option value="ground">Ground</option>
          <option value="air">Air</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as VehicleStatus | '')}
          aria-label="Filter by vehicle status"
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="maintenance">Maintenance</option>
        </select>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search vehicles..."
            searchKeys={['vehicle_name', 'category', 'registration']}
            emptyTitle="No vehicles"
            emptyDescription="Add your first vehicle to get started."
            loading={loading}
          />
        </div>
      </Card>
    </div>
  );
}
