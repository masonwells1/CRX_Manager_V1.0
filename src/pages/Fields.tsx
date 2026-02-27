import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, MapPin, List, Map as MapIcon, Upload, Download, FileText, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import type { Field } from '../types';
import MapContainer from '../components/map/MapContainer';
import FieldMarkers from '../components/map/FieldMarkers';
import BulkFieldImport from '../components/fields/BulkFieldImport';

type FieldWithCustomer = Field & { customer_name: string };

export default function Fields() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [fields, setFields] = useState<FieldWithCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [cropFilter, setCropFilter] = useState('');
  const [countyFilter, setCountyFilter] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  // Collect unique values for filter dropdowns
  const cropTypes = [...new Set(fields.map((f) => f.crop_type).filter(Boolean))] as string[];
  const counties = [...new Set(fields.map((f) => f.county).filter(Boolean))] as string[];

  useEffect(() => {
    fetchFields();
  }, []);

  const fetchFields = async () => {
    const { data, error } = await supabase.rpc('get_fields_with_geojson');

    if (error) {
      console.error('Failed to load fields:', error.message);
      toast('error', 'Failed to load fields. Please try again.');
      setLoading(false);
      return;
    }

    const rows = (data || []).map((f: Record<string, unknown>) => ({
      ...f,
      customer_name: (f.customer_name as string) || 'Unknown',
    })) as unknown as FieldWithCustomer[];
    setFields(rows);
    setLoading(false);
  };

  const filtered = fields.filter((f) => {
    if (cropFilter && f.crop_type !== cropFilter) return false;
    if (countyFilter && f.county !== countyFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (f) => f.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<FieldWithCustomer>(selected, toggleSelect, (f) => f.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'field_name', header: 'Field Name' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'total_acres', header: 'Acres' },
      { key: 'crop_type', header: 'Crop' },
      { key: 'county', header: 'County' },
      { key: 'legal_description', header: 'Legal Description' },
    ], 'fields');
    toast('success', `Exported ${selectedRows.length} field(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await downloadReportPdf({
        title: 'Fields',
        subtitle: `${selectedRows.length} field(s) selected`,
        columns: [
          { header: 'Field', key: 'field_name' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Acres', key: 'total_acres', align: 'right', format: (v) => v ? Number(v).toLocaleString() : '-' },
          { header: 'Crop', key: 'crop_type', format: (v) => v ? String(v) : '-' },
          { header: 'County', key: 'county', format: (v) => v ? String(v) : '-' },
        ],
        data: selectedRows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} field(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((f) => f.id);
      const result = await supabase.from('fields').delete().in('id', ids).select();
      checkMutationResult(result, 'Delete fields');
      toast('success', `Deleted ${ids.length} field(s)`);
      clearSelection();
      fetchFields();
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

  const dataColumns: Column<FieldWithCustomer>[] = [
    {
      key: 'field_name',
      header: 'Field Name',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.field_name}</span>
        </div>
      ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/customers/${row.customer_id}`);
          }}
          className="text-crx-green hover:underline"
        >
          {row.customer_name}
        </button>
      ),
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (row) => row.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'crop_type',
      header: 'Crop',
      sortable: true,
      render: (row) => row.crop_type ? (
        <Badge variant="info">{row.crop_type}</Badge>
      ) : (
        <span className="text-secondary">-</span>
      ),
    },
    {
      key: 'county',
      header: 'County',
      sortable: true,
      render: (row) => row.county || '-',
    },
    {
      key: 'legal_description',
      header: 'Legal Desc.',
      render: (row) => (
        <span className="text-secondary text-xs truncate max-w-[200px] block">
          {row.legal_description || '-'}
        </span>
      ),
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

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
            >
              <List className="w-4 h-4" />
              List
            </button>
            <button
              onClick={() => setViewMode('map')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
                viewMode === 'map'
                  ? 'bg-crx-green text-white'
                  : 'bg-white text-secondary hover:bg-gray-50'
              }`}
            >
              <MapIcon className="w-4 h-4" />
              Map
            </button>
          </div>
          {canBulkAction && viewMode === 'list' && (
            <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setImportModalOpen(true)}
          >
            Import Fields
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/fields/new')}>
            Add Field
          </Button>
        </div>
      </div>

      {viewMode === 'map' ? (
        <Card>
          {/* Filters for map view */}
          <div className="flex gap-2 mb-4">
            <select
              value={cropFilter}
              onChange={(e) => setCropFilter(e.target.value)}
              aria-label="Filter by crop"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Crops</option>
              {cropTypes.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={countyFilter}
              onChange={(e) => setCountyFilter(e.target.value)}
              aria-label="Filter by county"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Counties</option>
              {counties.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <MapContainer className="h-[500px] w-full rounded-lg overflow-hidden">
            <FieldMarkers
              fields={filtered}
              onFieldClick={(fieldId) => navigate(`/fields/${fieldId}`)}
            />
          </MapContainer>

          {filtered.some((f) => f.centroid_geojson) ? (
            <p className="text-xs text-secondary mt-2">
              Showing {filtered.filter((f) => f.centroid_geojson).length} of {filtered.length} fields on map. Fields without location data are not shown.
            </p>
          ) : (
            <p className="text-xs text-secondary mt-2">
              No fields have location data yet. Open a field and draw a boundary to add it to the map.
            </p>
          )}
        </Card>
      ) : (
        <Card padding={false}>
          <div className="p-5">
            <DataTable<FieldWithCustomer>
              data={filtered}
              columns={columns}
              searchable
              searchPlaceholder="Search fields..."
              searchKeys={['field_name', 'customer_name', 'county', 'legal_description', 'crop_type']}
              onRowClick={(row) => navigate(`/fields/${row.id}`)}
              emptyTitle="No fields yet"
              emptyDescription="Add your first field to start tracking farm locations"
              emptyAction={
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/fields/new')}>
                  Add Field
                </Button>
              }
              loading={loading}
              filters={
                <>
                  <select
                    value={cropFilter}
                    onChange={(e) => setCropFilter(e.target.value)}
                    aria-label="Filter by crop"
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">All Crops</option>
                    {cropTypes.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    value={countyFilter}
                    onChange={(e) => setCountyFilter(e.target.value)}
                    aria-label="Filter by county"
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">All Counties</option>
                    {counties.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  {canBulkAction && filtered.length > 0 && (
                    <button
                      onClick={toggleAll}
                      className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                    >
                      {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </>
              }
            />
          </div>
        </Card>
      )}

      <BulkFieldImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchFields}
      />

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="field"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
