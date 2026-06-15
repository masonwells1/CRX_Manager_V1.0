import { useEffect, useState , useCallback } from 'react';


import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import SplitHeading from '../components/ui/SplitHeading';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { Sentry } from '../lib/sentry';
import { Download } from 'lucide-react';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from '../utils/season';
import { formatLocalDate, parseLocalDate } from '../lib/dateUtils';
import type { ApplicationRecord } from '../types';

type AppRecordRow = ApplicationRecord & {
  customer_name: string;
  applicator_name: string;
  field_name: string;
  vehicle_name: string;
  product_count: number;
};

// Crop season = October 1 to September 30
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();

  switch (preset) {
    case 'this_season':
      return getSeasonDates(now);
    case 'last_season': {
      const s = computeSeason(now) - 1;
      return { start: seasonStartDate(s), end: seasonEndDate(s) };
    }
    case 'last30': {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { start: formatLocalDate(d), end: formatLocalDate(now) };
    }
    default:
      return { start: '', end: '' };
  }
}

export default function ApplicationRecords() {
  const { toast } = useToast();
  const [records, setRecords] = useState<AppRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  };

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped applicator FK embed; resolve via profile_public_view.
    let query = supabase
      .from('application_records')
      .select(`
        *,
        customer:customers(farm_name),
        field:fields(field_name),
        vehicle:vehicles(vehicle_name)
      `)
      .order('application_date', { ascending: false })
      .limit(500);

    if (startDate) query = query.gte('application_date', startDate);
    if (endDate) query = query.lte('application_date', endDate);
    if (customerFilter) query = query.eq('customer_id', customerFilter);

    const { data, error } = await query;

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_application_records' } });
      toast('error', 'Failed to load application records');
      setLoading(false);
      return;
    }

    const applicatorIds = [...new Set(
      ((data || []) as Array<{ applicator_id?: string | null }>)
        .map((r) => r.applicator_id)
        .filter(Boolean) as string[]
    )];
    const applicatorMap: Record<string, string> = {};
    if (applicatorIds.length > 0) {
      const { data: applicators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', applicatorIds);
      (applicators || []).forEach((a: { id: string | null; full_name: string | null }) => { if (a.id) applicatorMap[a.id] = a.full_name || '-'; });
    }

    const rows: AppRecordRow[] = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string }; field?: { field_name?: string }; vehicle?: { vehicle_name?: string }; applicator_id?: string | null }>).map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      applicator_name: r.applicator_id ? applicatorMap[r.applicator_id] || '-' : '-',
      field_name: r.field?.field_name || '-',
      vehicle_name: r.vehicle?.vehicle_name || '-',
      product_count: Array.isArray(r.product_data) ? r.product_data.length : 0,
    })) as AppRecordRow[];
    setRecords(rows);
    setLoading(false);
  }, [startDate, endDate, customerFilter, toast]);

  useEffect(() => {
    fetchCustomers();
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [startDate, endDate, customerFilter, fetchRecords]);

  const applyPreset = (preset: string) => {
    if (preset === 'all') {
      setStartDate('');
      setEndDate('');
    } else {
      const { start, end } = getPresetDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  const handleExport = () => {
    exportToCSV(
      records as unknown as Record<string, unknown>[],
      [
        { key: 'record_number', header: 'Record #' },
        { key: 'application_date', header: 'Date', format: fmtDateCSV },
        { key: 'customer_name', header: 'Customer' },
        { key: 'field_name', header: 'Field' },
        { key: 'applicator_name', header: 'Applicator' },
        { key: 'total_acres', header: 'Acres' },
        { key: 'product_count', header: 'Products' },
        { key: 'vehicle_name', header: 'Vehicle' },
        { key: 'source_type', header: 'Source' },
      ],
      'application_records'
    );
    toast('success', 'Application records exported');
  };

  const columns: Column<AppRecordRow>[] = [
    {
      key: 'record_number',
      header: 'Record #',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark font-mono text-xs">{r.record_number}</span>,
    },
    {
      key: 'application_date',
      header: 'Date',
      sortable: true,
      render: (r) => parseLocalDate(r.application_date).toLocaleDateString(),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (r) => <span className="font-medium">{r.customer_name}</span>,
    },
    {
      key: 'field_name',
      header: 'Field',
      sortable: true,
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (r) => r.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'product_count',
      header: 'Products',
      sortable: true,
      render: (r) => (
        <Badge variant={r.product_count > 0 ? 'info' : 'default'}>
          {r.product_count} product{r.product_count !== 1 ? 's' : ''}
        </Badge>
      ),
    },
    {
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
    },
    {
      key: 'source_type',
      header: 'Source',
      sortable: true,
      render: (r) => (
        <Badge variant={r.source_type === 'job' ? 'success' : 'warning'}>
          {r.source_type === 'job' ? 'Job' : 'Blend Ticket'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Application" accent="Records" />

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              aria-label="Filter by customer"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-1.5">
            {[
              { key: 'all', label: 'All Time' },
              { key: 'this_season', label: 'This Season' },
              { key: 'last_season', label: 'Last Season' },
              { key: 'last30', label: 'Last 30 Days' },
            ].map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.key)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={handleExport}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={records as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search records..."
            searchKeys={['record_number', 'customer_name', 'field_name', 'applicator_name']}
            emptyTitle="No application records"
            emptyDescription="Application records are created from completed jobs or approved blend tickets."
            loading={loading}
          />
        </div>
      </Card>
    </div>
  );
}
