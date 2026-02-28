import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Truck, Plane, Download, FileText, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import type { Vehicle, VehicleType, VehicleStatus } from '../types';

const statusVariant: Record<VehicleStatus, BadgeVariant> = {
  active: 'success',
  inactive: 'default',
  maintenance: 'warning',
};

export default function Vehicles() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<VehicleType | ''>('');
  const [statusFilter, setStatusFilter] = useState<VehicleStatus | ''>('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchVehicles = useCallback(async () => {
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
  }, [toast]);

  useEffect(() => {
    fetchVehicles();
  }, [fetchVehicles]);

  const filtered = vehicles.filter((v) => {
    if (typeFilter && v.vehicle_type !== typeFilter) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (v) => v.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Vehicle>(selected, toggleSelect, (v) => v.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'vehicle_name', header: 'Vehicle' },
      { key: 'vehicle_type', header: 'Type' },
      { key: 'category', header: 'Category' },
      { key: 'capacity_gallons', header: 'Capacity' },
      { key: 'registration', header: 'Registration' },
      { key: 'status', header: 'Status' },
    ], 'vehicles');
    toast('success', `Exported ${selectedRows.length} vehicle(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await downloadReportPdf({
        title: 'Vehicles & Equipment',
        subtitle: `${selectedRows.length} vehicle(s) selected`,
        columns: [
          { header: 'Vehicle', key: 'vehicle_name' },
          { header: 'Type', key: 'vehicle_type' },
          { header: 'Category', key: 'category' },
          { header: 'Capacity', key: 'capacity_gallons', align: 'right', format: (v) => v ? `${Number(v).toLocaleString()}` : '-' },
          { header: 'Registration', key: 'registration' },
          { header: 'Status', key: 'status' },
        ],
        data: selectedRows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} vehicle(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((v) => v.id);
      const result = await supabase.from('vehicles').delete().in('id', ids).select();
      checkMutationResult(result, 'Delete vehicles');
      toast('success', `Deleted ${ids.length} vehicle(s)`);
      clearSelection();
      fetchVehicles();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<Vehicle>[] = [
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

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <SplitHeading title="Vehicles" accent="& Equipment" />
          {canBulkAction && (
            <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />
          )}
        </div>
        <Button
          icon={<Plus className="w-4 h-4" />}
          onClick={() => navigate('/vehicles/new')}
        >
          Add Vehicle
        </Button>
      </div>

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
        {canBulkAction && filtered.length > 0 && (
          <button
            onClick={toggleAll}
            className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
          >
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<Vehicle>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search vehicles..."
            searchKeys={['vehicle_name', 'category', 'registration']}
            emptyTitle="No vehicles"
            emptyDescription="Add your first vehicle to get started."
            loading={loading}
          />
        </div>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="vehicle"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
