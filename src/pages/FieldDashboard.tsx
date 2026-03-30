import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Sprout,
  MapPin,
  Calendar,
  Droplets,
  Truck,
  Wind,
  Thermometer,
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
import { formatLocalDate } from '../lib/dateUtils';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import type {
  FieldDashboardResponse,
  FieldApplicationRecord,
  FieldActivityEntry,
} from '../types';

type Tab = 'overview' | 'applications' | 'billing' | 'details';

export default function FieldDashboard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [data, setData] = useState<FieldDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

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
    } catch (err) {
      Sentry.captureException(err);
      toast({ title: 'Error', description: 'Failed to load field dashboard', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  // Map center from centroid
  const mapCenter = useMemo<[number, number] | undefined>(() => {
    if (!data?.field.centroid_geojson) return undefined;
    try {
      const geo = JSON.parse(data.field.centroid_geojson);
      if (geo?.type === 'Point') return [geo.coordinates[0], geo.coordinates[1]];
    } catch { /* use default */ }
    return undefined;
  }, [data]);

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
    exportToCSV(rows, `field-${data.field.field_name}-applications`);
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
            center={mapCenter}
            zoom={mapCenter ? 14 : 7}
            showLayerToggle
            className="h-[300px] w-full"
          >
            <FieldBoundaryLayer fields={[field]} showLabels={false} />
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
              <Badge variant={field.irrigation ? 'success' : 'secondary'}>
                {field.irrigation ? 'Yes' : 'No'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Status</span>
              <Badge variant={field.is_active ? 'success' : 'secondary'}>
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
        <OverviewTab
          summary={season_summary}
          activity={recent_activity}
        />
      )}

      {activeTab === 'applications' && (
        <ApplicationsTab
          records={application_records}
          expandedRow={expandedRow}
          onToggleExpand={(id) => setExpandedRow(expandedRow === id ? null : id)}
          onExport={handleExportCSV}
        />
      )}

      {activeTab === 'billing' && (
        <BillingTab billingDefaults={field.billing_defaults} />
      )}

      {activeTab === 'details' && (
        <DetailsTab field={field} activity={recent_activity} />
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
      {/* Season Summary Cards */}
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

      {/* Recent Activity Timeline */}
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
  expandedRow,
  onToggleExpand,
  onExport,
}: {
  records: FieldApplicationRecord[];
  expandedRow: string | null;
  onToggleExpand: (id: string) => void;
  onExport: () => void;
}) {
  const columns: Column<FieldApplicationRecord>[] = useMemo(
    () => [
      {
        key: 'application_date',
        label: 'Date',
        sortable: true,
        render: (row) => (
          <span className="whitespace-nowrap">
            {formatLocalDate(new Date(row.application_date))}
          </span>
        ),
      },
      {
        key: 'record_number',
        label: 'Record #',
        render: (row) => (
          <span className="font-mono text-xs">{row.record_number}</span>
        ),
      },
      {
        key: 'product_data',
        label: 'Products',
        render: (row) => {
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
        label: 'Acres',
        sortable: true,
        render: (row) => row.total_acres?.toLocaleString() ?? '—',
      },
      {
        key: 'applicator_name',
        label: 'Applicator',
        sortable: true,
      },
      {
        key: 'vehicle_name',
        label: 'Vehicle',
        render: (row) => row.vehicle_name ?? '—',
      },
      {
        key: 'weather_conditions',
        label: 'Weather',
        render: (row) => {
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
        label: 'Source',
        render: (row) => (
          <Badge variant={row.source_type === 'job' ? 'info' : 'secondary'}>
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
        <DataTable
          columns={columns}
          data={records}
          defaultSort={{ key: 'application_date', direction: 'desc' }}
          onRowClick={(row) => onToggleExpand(row.id)}
          expandedRowRender={
            expandedRow
              ? (row) =>
                  row.id === expandedRow ? (
                    <ExpandedAppRecord record={row} />
                  ) : null
              : undefined
          }
        />
      )}
    </div>
  );
}

function ExpandedAppRecord({ record }: { record: FieldApplicationRecord }) {
  const w = record.weather_conditions;
  return (
    <div className="p-4 bg-gray-50 rounded-lg space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {w?.temperature !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <Thermometer className="w-4 h-4 text-orange-500" />
            <span>{w.temperature}°F</span>
          </div>
        )}
        {w?.wind_speed !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <Wind className="w-4 h-4 text-blue-500" />
            <span>
              {w.wind_speed} mph {w.wind_direction ?? ''}
            </span>
          </div>
        )}
        {w?.humidity !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <Droplets className="w-4 h-4 text-blue-400" />
            <span>{w.humidity}% RH</span>
          </div>
        )}
        {record.total_volume && (
          <div className="flex items-center gap-2 text-sm">
            <Truck className="w-4 h-4 text-gray-500" />
            <span>
              {record.total_volume} {record.total_volume_unit ?? 'gal'}
            </span>
          </div>
        )}
      </div>
      {record.notes && (
        <p className="text-sm text-secondary border-t pt-2">{record.notes}</p>
      )}
      {record.product_data?.length > 0 && (
        <div className="border-t pt-2">
          <p className="text-xs font-medium text-secondary mb-1">All Products:</p>
          <div className="space-y-1">
            {record.product_data.map((p, i) => (
              <div key={i} className="text-xs flex gap-4">
                <span className="font-medium">{p.product_name || 'Unknown'}</span>
                {p.rate && <span>{p.rate} {p.rate_unit}</span>}
                {p.quantity && <span>{p.quantity} {p.unit}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Billing Tab ───────────────────────────────────────────────── */

function BillingTab({
  billingDefaults,
}: {
  billingDefaults: FieldDashboardResponse['field']['billing_defaults'];
}) {
  if (!billingDefaults || billingDefaults.length === 0) {
    return (
      <Card className="p-8 text-center">
        <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No billing splits configured for this field.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-secondary">Billing Splits</h3>

      {/* Visual Split Bar */}
      <div className="h-6 rounded-full overflow-hidden flex bg-gray-100">
        {billingDefaults.map((bd, i) => {
          const colors = [
            'bg-crx-green',
            'bg-blue-500',
            'bg-orange-500',
            'bg-purple-500',
            'bg-yellow-500',
          ];
          return (
            <div
              key={bd.customer_id}
              className={`${colors[i % colors.length]} flex items-center justify-center text-xs text-white font-medium`}
              style={{ width: `${bd.split_pct}%` }}
              title={`${bd.customer_name}: ${bd.split_pct}%`}
            >
              {bd.split_pct >= 10 ? `${bd.split_pct}%` : ''}
            </div>
          );
        })}
      </div>

      {/* Split Details */}
      <div className="space-y-2">
        {billingDefaults.map((bd) => (
          <Card key={bd.customer_id} className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{bd.customer_name}</span>
                {bd.is_primary && (
                  <Badge variant="success">Primary</Badge>
                )}
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
      {/* FSA Numbers */}
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

      {/* Legal Description */}
      {field.legal_description && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-secondary mb-2">Legal Description</h3>
          <p className="text-sm">{field.legal_description}</p>
        </Card>
      )}

      {/* Notes */}
      {field.notes && (
        <Card className="p-4">
          <h3 className="text-sm font-medium text-secondary mb-2">Notes</h3>
          <p className="text-sm whitespace-pre-wrap">{field.notes}</p>
        </Card>
      )}

      {/* Timestamps */}
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

      {/* Activity Log */}
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
                  <>
                    <ChevronUp className="w-3 h-3" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" /> Show all {activity.length} entries
                  </>
                )}
              </button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
