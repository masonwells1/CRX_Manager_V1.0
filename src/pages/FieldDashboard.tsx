import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Sprout,
  MapPin,
  Calendar,
  Droplets,
  FileText,
  Clock,
  Download,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { computeBounds } from '../hooks/useFitBounds';
import { formatLocalDate } from '../lib/dateUtils';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import type {
  FieldDashboardResponse,
  FieldDashboardBillingDefault,
  FieldApplicationRecord,
  FieldActivityEntry,
} from '../types';

type Tab = 'overview' | 'applications' | 'billing' | 'details' | 'crop_history';

interface CropHistoryRecord {
  [k: string]: unknown;
  id: string;
  season: number;
  crop_type: string;
  variety: string | null;
  planting_date: string | null;
  harvest_date: string | null;
  yield_per_acre: number | null;
  yield_unit: string | null;
  notes: string | null;
}

export default function FieldDashboard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [data, setData] = useState<FieldDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [cropHistory, setCropHistory] = useState<CropHistoryRecord[]>([]);
  const [children, setChildren] = useState<Array<{ id: string; field_name: string; total_acres: number | null; boundary_geojson?: string; centroid_geojson?: string }>>([]);

  const fetchDashboard = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const { data: result, error } = await supabase.rpc('get_field_dashboard', {
        p_field_id: id,
      });
      if (error) throw error;
      const dashboard = assertRpcResult<FieldDashboardResponse>(result, 'get_field_dashboard');
      setData(dashboard);

      // Fetch crop history
      const { data: histData } = await supabase
        .from('field_crop_history')
        .select('*')
        .eq('field_id', id)
        .order('season', { ascending: false });
      setCropHistory((histData || []) as CropHistoryRecord[]);

      // Fetch child fields if this is a parent
      const { data: allFields, error: childErr } = await supabase.rpc('get_fields_with_geojson');
      if (!childErr) {
        const allRows = assertRpcResult<Array<{ id: string; field_name: string; total_acres: number | null; boundary_geojson?: string; centroid_geojson?: string; parent_field_id?: string }>>(allFields, 'get_fields_with_geojson');
        const childFields = allRows.filter((f) => f.parent_field_id === id);
        setChildren(childFields);
      }
    } catch (err) {
      Sentry.captureException(err);
      toast('error', 'Failed to load field dashboard');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const mapBounds = useMemo(() => {
    if (!data) return null;
    const allFields = [data.field, ...children];
    const geoStrings = allFields.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]).filter(Boolean);
    return computeBounds(geoStrings as string[]);
  }, [data, children]);

  const handleExportCSV = useCallback(() => {
    if (!data) return;
    const rows = data.application_records.map((r) => ({
      Date: fmtDateCSV(r.application_date),
      'Record #': r.record_number,
      Products: (r.product_data || []).map((p) => p.product_name || '').join(', '),
      'Acres Treated': r.total_acres ?? '',
      Applicator: r.applicator_name,
      Vehicle: r.vehicle_name ?? '',
      Source: r.source_type,
      Notes: r.notes ?? '',
    }));
    exportToCSV(rows as unknown as Record<string, unknown>[], [
      { key: 'Date', header: 'Date' },
      { key: 'Record #', header: 'Record #' },
      { key: 'Products', header: 'Products' },
      { key: 'Acres Treated', header: 'Acres Treated' },
      { key: 'Applicator', header: 'Applicator' },
      { key: 'Vehicle', header: 'Vehicle' },
      { key: 'Source', header: 'Source' },
      { key: 'Notes', header: 'Notes' },
    ], `field-${data.field.field_name}-applications`);
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-crx-green" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Field not found</p>
        <Button variant="ghost" onClick={() => navigate('/fields')} className="mt-4">
          Back to Fields
        </Button>
      </div>
    );
  }

  const { field, season_summary, application_records, recent_activity } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/fields')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-nav-dark">{field.field_name}</h1>
          <p className="text-sm text-secondary">{field.customer_name}</p>
        </div>
        <Button variant="secondary" onClick={() => navigate(`/fields/${id}`)}>
          <Pencil className="w-4 h-4 mr-2" />
          Edit Field
        </Button>
      </div>

      {/* Top Section: Map + Key Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <CRXMap
            bounds={mapBounds}
            showLayerToggle
            className="h-[300px] w-full"
          >
            <FieldBoundaryLayer fields={[field, ...children as unknown as typeof field[]]} showLabels={children.length > 0} />
          </CRXMap>
        </div>
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4 text-crx-green" />
            <span className="text-secondary">Location</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-secondary">Acres</span>
              <span className="font-medium">{field.total_acres?.toLocaleString() ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Crop</span>
              <span className="font-medium capitalize">{field.crop_type ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">County</span>
              <span className="font-medium">{field.county ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">State</span>
              <span className="font-medium">{field.state ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Soil Type</span>
              <span className="font-medium">{field.soil_type ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Irrigation</span>
              <Badge variant={field.irrigation ? 'success' : 'default'}>
                {field.irrigation ? 'Yes' : 'No'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Status</span>
              <Badge variant={field.is_active ? 'success' : 'default'}>
                {field.is_active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
          </div>
        </Card>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6 overflow-x-auto" aria-label="Field dashboard tabs">
          {([
            { key: 'overview', label: 'Overview', icon: Sprout },
            { key: 'applications', label: 'Applications', icon: Droplets },
            { key: 'billing', label: 'Billing', icon: FileText },
            { key: 'details', label: 'Details', icon: MapPin },
            { key: 'crop_history', label: 'Crop History', icon: Calendar },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === key
                  ? 'border-crx-green text-crx-green'
                  : 'border-transparent text-secondary hover:text-nav-dark hover:border-gray-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <>
          <OverviewTab summary={season_summary} activity={recent_activity} />
          {children.length > 0 && (
            <Card className="p-4 mt-6">
              <h3 className="text-sm font-medium text-secondary mb-3">Sub-fields ({children.length})</h3>
              <div className="space-y-2">
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => navigate(`/fields/${child.id}/dashboard`)}
                    className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-crx-green" />
                      <span className="text-sm font-medium">{child.field_name}</span>
                    </div>
                    <span className="text-xs text-secondary">{child.total_acres?.toLocaleString() ?? '—'} ac</span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
      {activeTab === 'applications' && (
        <ApplicationsTab records={application_records} onExport={handleExportCSV} />
      )}
      {activeTab === 'billing' && (
        <BillingTab billingDefaults={field.billing_defaults} />
      )}
      {activeTab === 'details' && (
        <DetailsTab field={field} activity={recent_activity} />
      )}
      {activeTab === 'crop_history' && (
        <CropHistoryTab history={cropHistory} currentCrop={field.crop_type} />
      )}
    </div>
  );
}

/* ─── Overview Tab ──────────────────────────────────────────────── */

function OverviewTab({
  summary,
  activity,
}: {
  summary: FieldDashboardResponse['season_summary'];
  activity: FieldActivityEntry[];
}) {
  const stats = [
    { label: 'Total Applications', value: summary.total_applications, icon: Droplets },
    { label: 'Acres Treated', value: summary.total_acres_treated.toLocaleString(), icon: MapPin },
    { label: 'Products Applied', value: summary.distinct_products, icon: Sprout },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-secondary mb-3">
          Season {summary.season} Summary
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {stats.map(({ label, value, icon: Icon }) => (
            <Card key={label} className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-crx-green/10 rounded-lg">
                  <Icon className="w-5 h-5 text-crx-green" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-nav-dark">{value}</p>
                  <p className="text-xs text-secondary">{label}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Card className="p-4">
        <h3 className="text-sm font-medium text-secondary mb-4">Recent Activity</h3>
        {activity.length === 0 ? (
          <p className="text-sm text-gray-400">No activity recorded for this field yet.</p>
        ) : (
          <div className="space-y-3">
            {activity.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3">
                <div className="mt-1 p-1 bg-gray-100 rounded-full">
                  <Clock className="w-3 h-3 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-nav-dark">{entry.description}</p>
                  <p className="text-xs text-secondary">
                    {entry.performed_by_name} &middot;{' '}
                    {formatLocalDate(new Date(entry.created_at))}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─── Applications Tab ──────────────────────────────────────────── */

function ApplicationsTab({
  records,
  onExport,
}: {
  records: FieldApplicationRecord[];
  onExport: () => void;
}) {
  const columns: Column<FieldApplicationRecord>[] = useMemo(
    () => [
      {
        key: 'application_date',
        header: 'Date',
        sortable: true,
        render: (row: FieldApplicationRecord) => (
          <span className="whitespace-nowrap">
            {formatLocalDate(new Date(row.application_date))}
          </span>
        ),
      },
      {
        key: 'record_number',
        header: 'Record #',
        render: (row: FieldApplicationRecord) => (
          <span className="font-mono text-xs">{row.record_number}</span>
        ),
      },
      {
        key: 'product_data',
        header: 'Products',
        render: (row: FieldApplicationRecord) => {
          const products = row.product_data || [];
          if (products.length === 0) return <span className="text-gray-400">—</span>;
          return (
            <div className="space-y-0.5">
              {products.slice(0, 3).map((p, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">{p.product_name || 'Unknown'}</span>
                  {p.rate && p.rate_unit && (
                    <span className="text-secondary ml-1">
                      {p.rate} {p.rate_unit}
                    </span>
                  )}
                </div>
              ))}
              {products.length > 3 && (
                <span className="text-xs text-secondary">+{products.length - 3} more</span>
              )}
            </div>
          );
        },
      },
      {
        key: 'total_acres',
        header: 'Acres',
        sortable: true,
        render: (row: FieldApplicationRecord) => row.total_acres?.toLocaleString() ?? '—',
      },
      {
        key: 'applicator_name',
        header: 'Applicator',
        sortable: true,
      },
      {
        key: 'vehicle_name',
        header: 'Vehicle',
        render: (row: FieldApplicationRecord) => row.vehicle_name ?? '—',
      },
      {
        key: 'weather_conditions',
        header: 'Weather',
        render: (row: FieldApplicationRecord) => {
          const w = row.weather_conditions;
          if (!w) return <span className="text-gray-400">—</span>;
          const parts: string[] = [];
          if (w.temperature !== undefined) parts.push(`${w.temperature}°F`);
          if (w.wind_speed !== undefined) parts.push(`${w.wind_speed} mph ${w.wind_direction || ''}`);
          if (w.humidity !== undefined) parts.push(`${w.humidity}% RH`);
          return <span className="text-xs">{parts.join(' · ') || '—'}</span>;
        },
      },
      {
        key: 'source_type',
        header: 'Source',
        render: (row: FieldApplicationRecord) => (
          <Badge variant={row.source_type === 'job' ? 'info' : 'default'}>
            {row.source_type === 'job' ? 'Job' : 'Blend Ticket'}
          </Badge>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-secondary">
          {records.length} Application{records.length !== 1 ? 's' : ''}
        </h3>
        <Button variant="ghost" size="sm" onClick={onExport} disabled={records.length === 0}>
          <Download className="w-4 h-4 mr-1" />
          Export CSV
        </Button>
      </div>

      {records.length === 0 ? (
        <Card className="p-8 text-center">
          <Droplets className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No application records for this field this season.</p>
        </Card>
      ) : (
        <DataTable columns={columns} data={records} />
      )}
    </div>
  );
}

/* ─── Billing Tab ───────────────────────────────────────────────── */

function BillingTab({
  billingDefaults,
}: {
  billingDefaults: FieldDashboardBillingDefault[];
}) {
  if (!billingDefaults || billingDefaults.length === 0) {
    return (
      <Card className="p-8 text-center">
        <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No billing splits configured for this field.</p>
      </Card>
    );
  }

  const colors = ['bg-crx-green', 'bg-blue-500', 'bg-orange-500', 'bg-purple-500', 'bg-yellow-500'];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-secondary">Billing Splits</h3>

      <div className="h-6 rounded-full overflow-hidden flex bg-gray-100">
        {billingDefaults.map((bd, i) => (
          <div
            key={bd.customer_id}
            className={`${colors[i % colors.length]} flex items-center justify-center text-xs text-white font-medium`}
            style={{ width: `${bd.split_pct}%` }}
            title={`${bd.customer_name}: ${bd.split_pct}%`}
          >
            {bd.split_pct >= 10 ? `${bd.split_pct}%` : ''}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        {billingDefaults.map((bd) => (
          <Card key={bd.customer_id} className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{bd.customer_name}</span>
                {bd.is_primary && <Badge variant="success">Primary</Badge>}
              </div>
              <span className="font-bold text-crx-green">{bd.split_pct}%</span>
            </div>
            {(bd.price_override_cents || bd.pricing_note) && (
              <div className="mt-1 text-xs text-secondary space-x-4">
                {bd.price_override_cents && (
                  <span>${(bd.price_override_cents / 100).toFixed(2)}/ac override</span>
                )}
                {bd.pricing_note && <span>{bd.pricing_note}</span>}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ─── Details Tab ───────────────────────────────────────────────── */

function DetailsTab({
  field,
  activity,
}: {
  field: FieldDashboardResponse['field'];
  activity: FieldActivityEntry[];
}) {
  const [showAllActivity, setShowAllActivity] = useState(false);
  const displayedActivity = showAllActivity ? activity : activity.slice(0, 5);

  return (
    <div className="space-y-6">
      {(field.fsa_farm_number || field.fsa_tract_number || field.fsa_field_number) && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-secondary mb-3">FSA Numbers</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-secondary">Farm #</p>
              <p className="font-medium">{field.fsa_farm_number || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-secondary">Tract #</p>
              <p className="font-medium">{field.fsa_tract_number || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-secondary">Field #</p>
              <p className="font-medium">{field.fsa_field_number || '—'}</p>
            </div>
          </div>
        </Card>
      )}

      {field.legal_description && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-secondary mb-2">Legal Description</h3>
          <p className="text-sm">{field.legal_description}</p>
        </Card>
      )}

      {field.notes && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-secondary mb-2">Notes</h3>
          <p className="text-sm whitespace-pre-wrap">{field.notes}</p>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="text-sm font-medium text-secondary mb-3">Record Info</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-secondary">Created</p>
            <p className="font-medium">{formatLocalDate(new Date(field.created_at))}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Last Updated</p>
            <p className="font-medium">{formatLocalDate(new Date(field.updated_at))}</p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-medium text-secondary mb-3">Activity Log</h3>
        {activity.length === 0 ? (
          <p className="text-sm text-gray-400">No activity recorded.</p>
        ) : (
          <>
            <div className="space-y-2">
              {displayedActivity.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 text-sm">
                  <Calendar className="w-3.5 h-3.5 mt-0.5 text-gray-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-nav-dark">{entry.description}</p>
                    <p className="text-xs text-secondary">
                      {entry.performed_by_name} &middot;{' '}
                      {formatLocalDate(new Date(entry.created_at))}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {activity.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllActivity(!showAllActivity)}
                className="mt-3 text-xs text-crx-green hover:underline flex items-center gap-1"
              >
                {showAllActivity ? (
                  <><ChevronUp className="w-3 h-3" /> Show less</>
                ) : (
                  <><ChevronDown className="w-3 h-3" /> Show all {activity.length} entries</>
                )}
              </button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/* ─── Crop History Tab ─────────────────────────────────────────── */

function CropHistoryTab({ history, currentCrop }: { history: CropHistoryRecord[]; currentCrop: string | null }) {
  const columns: Column<CropHistoryRecord>[] = [
    {
      key: 'season',
      header: 'Season',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.season - 1}–{r.season}</span>,
    },
    {
      key: 'crop_type',
      header: 'Crop',
      sortable: true,
      render: (r) => <Badge variant="default">{r.crop_type}</Badge>,
    },
    { key: 'variety', header: 'Variety', render: (r) => r.variety || '—' },
    { key: 'planting_date', header: 'Planted', render: (r) => r.planting_date || '—' },
    { key: 'harvest_date', header: 'Harvested', render: (r) => r.harvest_date || '—' },
    {
      key: 'yield_per_acre',
      header: 'Yield/Acre',
      render: (r) => r.yield_per_acre != null ? `${r.yield_per_acre.toLocaleString()} ${r.yield_unit || ''}` : '—',
    },
    { key: 'notes', header: 'Notes', render: (r) => r.notes || '—' },
  ];

  return (
    <div className="space-y-4">
      {currentCrop && (
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <Sprout className="w-5 h-5 text-crx-green" />
            <div>
              <p className="text-sm font-medium text-nav-dark">Current Crop</p>
              <p className="text-lg font-semibold text-crx-green">{currentCrop}</p>
            </div>
          </div>
        </Card>
      )}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<CropHistoryRecord>
            columns={columns}
            data={history}
            searchable
            searchPlaceholder="Search crop history..."
            searchKeys={['crop_type', 'variety', 'notes']}
            emptyTitle="No crop history"
            emptyDescription="Crop history is auto-recorded when the field's crop type changes between seasons."
          />
        </div>
      </Card>
    </div>
  );
}
