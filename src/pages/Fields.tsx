import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, MapPin, List, Map as MapIcon, Upload } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import type { Field } from '../types';
import MapContainer from '../components/map/MapContainer';
import FieldMarkers from '../components/map/FieldMarkers';
import BulkFieldImport from '../components/fields/BulkFieldImport';

type FieldWithCustomer = Field & { customer_name: string };

export default function Fields() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [fields, setFields] = useState<FieldWithCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [cropFilter, setCropFilter] = useState('');
  const [countyFilter, setCountyFilter] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Collect unique values for filter dropdowns
  const cropTypes = [...new Set(fields.map((f) => f.crop_type).filter(Boolean))] as string[];
  const counties = [...new Set(fields.map((f) => f.county).filter(Boolean))] as string[];

  useEffect(() => {
    fetchFields();
  }, []);

  const fetchFields = async () => {
    // Use RPC to get fields with centroid/boundary as GeoJSON text
    const { data, error } = await supabase.rpc('get_fields_with_geojson');

    if (error) {
      console.error('Failed to load fields:', error.message);
      toast('error', 'Failed to load fields. Please try again.');
      setLoading(false);
      return;
    }

    const rows = ((data || []) as any[]).map((f) => ({
      ...f,
      customer_name: f.customer_name || 'Unknown',
    }));
    setFields(rows);
    setLoading(false);
  };

  const filtered = fields.filter((f) => {
    if (cropFilter && f.crop_type !== cropFilter) return false;
    if (countyFilter && f.county !== countyFilter) return false;
    return true;
  });

  const columns: Column<FieldWithCustomer>[] = [
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

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
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
              fields={filtered as any}
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
                <div className="flex gap-2">
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
    </div>
  );
}
