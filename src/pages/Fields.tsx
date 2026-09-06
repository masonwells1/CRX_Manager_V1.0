import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, MapPin, List, Map as MapIcon, Upload, Download, FileText, Trash2, ChevronDown, ChevronRight, Link } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { billableAcres } from '../lib/fieldGeometry';
import type { Field } from '../types';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import FieldMarkerLayer from '../components/map/FieldMarkerLayer';
import BulkFieldImport from '../components/fields/BulkFieldImport';
import { useFitBounds } from '../hooks/useFitBounds';

import Modal from '../components/ui/Modal';
import { computeBounds } from '../hooks/useFitBounds';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';

type FieldWithCustomer = Field & { customer_name: string; parent_field_id?: string | null; child_count?: number; billable_acres?: number | null };

export default function Fields() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [fields, setFields] = useState<FieldWithCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [cropFilter, setCropFilter] = useState('');
  const [countyFilter, setCountyFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupParentId, setGroupParentId] = useState<string>('');
  const [grouping, setGrouping] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const { profile } = useAuth();
  const groupIdem = useIdempotencyKey('link_fields', profile?.id || '');

  // Collect unique values for filter dropdowns
  const cropTypes = [...new Set(fields.map((f) => f.crop_type).filter(Boolean))] as string[];
  const counties = [...new Set(fields.map((f) => f.county).filter(Boolean))] as string[];
  const customerNames = [...new Set(fields.map((f) => f.customer_name).filter(Boolean))].sort() as string[];

  /**
   * Reloads the field list. Resolves TRUE when the list on screen is now current, FALSE when
   * it is not — this function handles its own RPC error, so callers cannot learn that from a
   * rejection. The bulk import needs the difference: its results screen tells the operator to
   * look rows up in this list before re-importing them, and acting on a stale list is what
   * creates a duplicate field.
   */
  const fetchFields = useCallback(async (): Promise<boolean> => {
    // get_fields_with_geojson returns total_acres only; the two-acre model's
    // override/measured acres live on the fields table. Pull them alongside (the
    // fields_select RLS policy allows it) so the list shows the acres that actually
    // BILL — override ?? measured ?? legacy total — instead of the legacy total alone.
    const { data, error } = await supabase.rpc('get_fields_with_geojson');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_fields' } });
      toast('error', 'Failed to load fields. Please try again.');
      setLoading(false);
      return false;
    }

    // Pull the two-acre columns separately (kept sequential, not Promise.all, so the
    // assertRpcResult coverage check still pairs the rpc capture above with its assert).
    const acreRes = await supabase.from('fields').select('id, override_acres, measured_acres, acres_source');
    const acreMap = new Map<string, { override_acres: number | null; measured_acres: number | null; acres_source: Field['acres_source'] }>();
    if (!acreRes.error && acreRes.data) {
      for (const a of acreRes.data as Array<{ id: string; override_acres: number | null; measured_acres: number | null; acres_source: Field['acres_source'] }>) {
        acreMap.set(a.id, { override_acres: a.override_acres, measured_acres: a.measured_acres, acres_source: a.acres_source });
      }
    }

    const rows = assertRpcResult<FieldWithCustomer[]>(data, 'get_fields_with_geojson').map((f) => {
      const acre = acreMap.get(f.id);
      const override_acres = acre?.override_acres ?? null;
      const measured_acres = acre?.measured_acres ?? null;
      return {
        ...f,
        customer_name: (f.customer_name as string) || 'Unknown',
        override_acres,
        measured_acres,
        acres_source: acre?.acres_source,
        billable_acres: billableAcres(override_acres, measured_acres, f.total_acres),
      };
    });
    setFields(rows);
    setLoading(false);
    return true;
  }, [toast]);

  useEffect(() => {
    fetchFields();
  }, [fetchFields]);

  const filtered = fields.filter((f) => {
    if (cropFilter && f.crop_type !== cropFilter) return false;
    if (countyFilter && f.county !== countyFilter) return false;
    if (customerFilter && f.customer_name !== customerFilter) return false;
    if (statusFilter === 'active' && !f.is_active) return false;
    if (statusFilter === 'inactive' && f.is_active) return false;
    return true;
  });

  const totalAcres = filtered.reduce((sum, f) => sum + (f.billable_acres ?? f.total_acres ?? 0), 0);
  const withBoundary = filtered.filter((f) => f.boundary_geojson).length;

  // Compute map bounds from all filtered fields with geo data
  const geoStrings = useMemo(
    () => filtered.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]),
    [filtered]
  );
  const mapBounds = useFitBounds(geoStrings);

  // For click-to-zoom on map
  const selectedFieldBounds = useMemo(() => {
    if (!selectedFieldId) return null;
    const f = filtered.find((fld) => fld.id === selectedFieldId);
    if (!f) return null;
    return computeBounds([f.boundary_geojson, f.centroid_geojson]);
  }, [selectedFieldId, filtered]);

  // Tree view: group parent/child fields
  const displayRows = useMemo(() => {
    const childMap = new Map<string, FieldWithCustomer[]>();
    for (const f of filtered) {
      if (f.parent_field_id) {
        const siblings = childMap.get(f.parent_field_id) || [];
        siblings.push(f);
        childMap.set(f.parent_field_id, siblings);
      }
    }

    const rows: (FieldWithCustomer & { _isChild?: boolean; _isParent?: boolean })[] = [];
    for (const f of filtered) {
      if (f.parent_field_id) continue; // children shown under parent
      const hasChildren = (f.child_count && f.child_count > 0) || childMap.has(f.id);
      if (hasChildren) {
        rows.push({ ...f, _isParent: true });
        if (expandedParents.has(f.id)) {
          const children = childMap.get(f.id) || [];
          for (const c of children) {
            rows.push({ ...c, _isChild: true });
          }
        }
      } else {
        rows.push(f);
      }
    }
    return rows;
  }, [filtered, expandedParents]);

  const toggleExpand = (id: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: displayRows, getId: (f) => f.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<FieldWithCustomer>(selected, toggleSelect, (f) => f.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'field_name', header: 'Field Name' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'billable_acres', header: 'Acres' },
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
          { header: 'Acres', key: 'billable_acres', align: 'right', format: (v) => v ? Number(v).toLocaleString() : '-' },
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
      // A field that's still referenced by jobs / application records / blend
      // tickets is RESTRICT-protected by the DB (FK violation, code 23503).
      // sanitizeError would mislabel this as "references data that does not
      // exist" — the opposite of the truth — so handle it explicitly.
      const code = (err as { code?: string } | null)?.code;
      const msg = (err as { message?: string } | null)?.message ?? '';
      if (code === '23503' || /update or delete on table .* violates foreign key/i.test(msg)) {
        toast('error', 'Cannot delete: one or more selected fields are still in use by jobs, application records, blend tickets, or other records. Remove those references first.');
      } else {
        toast('error', sanitizeError(err));
      }
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const handleGroupFields = async () => {
    if (!groupParentId || selectedRows.length < 2) return;
    setGrouping(true);
    try {
      const childIds = selectedRows.filter((f) => f.id !== groupParentId).map((f) => f.id);
      const idemKey = groupIdem.getKey();
      // RETURNS void — use .throwOnError() (regex coverage skips fire-and-forget).
      await supabase.rpc('link_fields_to_parent', {
        p_parent_id: groupParentId,
        p_child_ids: childIds,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      }).throwOnError();
      groupIdem.resetKey();
      toast('success', `Grouped ${childIds.length} field(s) under parent`);
      clearSelection();
      setGroupModalOpen(false);
      fetchFields();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setGrouping(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    ...(selectedCount >= 2 ? [{ key: 'group', label: 'Group Fields', icon: <Link className="w-4 h-4" />, onClick: () => { setGroupParentId(selectedRows[0]?.id || ''); setGroupModalOpen(true); } }] : []),
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<FieldWithCustomer>[] = [
    {
      key: 'field_name',
      header: 'Field Name',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          {(row as FieldWithCustomer & { _isParent?: boolean })._isParent ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleExpand(row.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggleExpand(row.id); } }}
              className="p-0.5"
            >
              {expandedParents.has(row.id)
                ? <ChevronDown className="w-4 h-4 text-secondary" />
                : <ChevronRight className="w-4 h-4 text-secondary" />
              }
            </button>
          ) : (row as FieldWithCustomer & { _isChild?: boolean })._isChild ? (
            <span className="w-5 ml-2 border-l-2 border-gray-200 h-4" />
          ) : (
            <MapPin className="w-4 h-4 text-crx-green flex-shrink-0" />
          )}
          <span className="font-medium text-nav-dark">{row.field_name}</span>
          {(row as FieldWithCustomer & { _isParent?: boolean })._isParent && row.child_count != null && row.child_count > 0 && (
            <Badge variant="info" className="text-[10px]">{row.child_count} sub-fields</Badge>
          )}
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
      key: 'billable_acres',
      header: 'Acres',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <span>{row.billable_acres != null ? row.billable_acres.toLocaleString() : '-'}</span>
          {row.acres_source === 'override' && <Badge variant="warning" className="text-[10px]" >typed</Badge>}
          {row.acres_source === 'measured' && <Badge variant="success" className="text-[10px]">map</Badge>}
        </div>
      ),
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

  const filterSelect = "px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green";

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

      {/* Stats Bar */}
      <div className="flex gap-4 text-sm text-secondary">
        <span><strong className="text-nav-dark">{filtered.length}</strong> fields</span>
        <span><strong className="text-nav-dark">{totalAcres.toLocaleString()}</strong> billable acres</span>
        <span><strong className="text-nav-dark">{withBoundary}</strong> with boundaries</span>
      </div>

      {viewMode === 'map' ? (
        <Card>
          {/* Filters for map view */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="Filter by customer" className={filterSelect}>
              <option value="">All Customers</option>
              {customerNames.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)} aria-label="Filter by crop" className={filterSelect}>
              <option value="">All Crops</option>
              {cropTypes.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select value={countyFilter} onChange={(e) => setCountyFilter(e.target.value)} aria-label="Filter by county" className={filterSelect}>
              <option value="">All Counties</option>
              {counties.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')} aria-label="Filter by status" className={filterSelect}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All Status</option>
            </select>
          </div>

          <CRXMap className="h-[500px] w-full rounded-lg overflow-hidden" showLayerToggle showLocateMe bounds={selectedFieldBounds || mapBounds} boundsOptions={selectedFieldBounds ? { padding: 80, maxZoom: 16 } : undefined}>
            <FieldBoundaryLayer fields={filtered} onFieldClick={(id) => setSelectedFieldId(id)} />
            <FieldMarkerLayer fields={filtered} onFieldClick={(fieldId) => navigate(`/fields/${fieldId}/dashboard`)} />
          </CRXMap>

          {filtered.some((f) => f.centroid_geojson || f.boundary_geojson) ? (
            <p className="text-xs text-secondary mt-2">
              Showing {withBoundary} boundar{withBoundary === 1 ? 'y' : 'ies'} and {filtered.filter((f) => f.centroid_geojson && !f.boundary_geojson).length} marker(s) of {filtered.length} fields.
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
              data={displayRows}
              columns={columns}
              searchable
              searchPlaceholder="Search fields..."
              searchKeys={['field_name', 'customer_name', 'county', 'legal_description', 'crop_type']}
              onRowClick={(row) => navigate(`/fields/${row.id}/dashboard`)}
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
                  <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="Filter by customer" className={filterSelect}>
                    <option value="">All Customers</option>
                    {customerNames.map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                  <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)} aria-label="Filter by crop" className={filterSelect}>
                    <option value="">All Crops</option>
                    {cropTypes.map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                  <select value={countyFilter} onChange={(e) => setCountyFilter(e.target.value)} aria-label="Filter by county" className={filterSelect}>
                    <option value="">All Counties</option>
                    {counties.map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')} aria-label="Filter by status" className={filterSelect}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="all">All Status</option>
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

      {/* Group Fields Modal */}
      <Modal open={groupModalOpen} onClose={() => setGroupModalOpen(false)} title="Group Fields as Sub-fields">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Select which field becomes the parent. The other {selectedCount - 1} field(s) will become its sub-fields.
          </p>
          <div className="space-y-2">
            {selectedRows.map((f) => (
              <label key={f.id} className="flex items-center gap-2 p-2 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                <input
                  type="radio"
                  name="parent_field"
                  checked={groupParentId === f.id}
                  onChange={() => setGroupParentId(f.id)}
                  className="text-crx-green focus:ring-crx-green"
                />
                <span className="text-sm font-medium">{f.field_name}</span>
                <span className="text-xs text-secondary ml-auto">{f.customer_name}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setGroupModalOpen(false)}>Cancel</Button>
            <Button onClick={handleGroupFields} loading={grouping} disabled={!groupParentId}>
              <Link className="w-4 h-4 mr-1" /> Group Fields
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
