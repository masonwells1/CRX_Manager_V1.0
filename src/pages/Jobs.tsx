import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import type { Job, JobStatus } from '../types';

type JobRow = Job & {
  customer_name: string;
  applicator_name: string;
  vehicle_name: string;
  field_count: number;
};

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (preset) {
    case 'today':
      return { start: now.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    case 'this_week': {
      const dayOfWeek = now.getDay();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - dayOfWeek);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      return { start: startOfWeek.toISOString().split('T')[0], end: endOfWeek.toISOString().split('T')[0] };
    }
    case 'this_season':
      if (month >= 6) {
        return { start: `${year}-07-01`, end: `${year + 1}-06-30` };
      } else {
        return { start: `${year - 1}-07-01`, end: `${year}-06-30` };
      }
    default:
      return { start: '', end: '' };
  }
}

export default function Jobs() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<JobStatus | ''>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);

  useEffect(() => {
    fetchCustomers();
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [statusFilter, startDate, endDate, customerFilter]);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  };

  const fetchJobs = async () => {
    setLoading(true);
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name),
        applicator:profiles!jobs_applicator_id_fkey(full_name),
        vehicle:vehicles(vehicle_name),
        job_fields(id)
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(500);

    if (statusFilter) query = query.eq('status', statusFilter);
    if (startDate) query = query.gte('job_date', startDate);
    if (endDate) query = query.lte('job_date', endDate);
    if (customerFilter) query = query.eq('customer_id', customerFilter);

    const { data, error } = await query;

    if (error) {
      console.error('Failed to load jobs:', error.message);
      toast('error', 'Failed to load jobs');
      setLoading(false);
      return;
    }

    const rows: JobRow[] = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string }; applicator?: { full_name?: string }; vehicle?: { vehicle_name?: string } }>).map((j) => ({
      ...j,
      customer_name: j.customer?.farm_name || 'Unknown',
      applicator_name: j.applicator?.full_name || '-',
      vehicle_name: j.vehicle?.vehicle_name || '-',
      field_count: Array.isArray(j.job_fields) ? j.job_fields.length : 0,
    }));
    setJobs(rows);
    setLoading(false);
  };

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

  const columns: Column<JobRow>[] = [
    {
      key: 'job_number',
      header: 'Job #',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => navigate(`/jobs/${r.id}`)}
          className="font-medium text-nav-dark font-mono text-xs hover:text-crx-green transition-colors"
        >
          {r.job_number}
        </button>
      ),
    },
    {
      key: 'job_date',
      header: 'Date',
      sortable: true,
      render: (r) => new Date(r.job_date).toLocaleDateString(),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => <Badge variant={statusVariant[r.status]}>{r.status.replace('_', ' ')}</Badge>,
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (r) => <span className="font-medium">{r.customer_name}</span>,
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
    },
    {
      key: 'field_count',
      header: 'Fields',
      sortable: true,
      render: (r) => (
        <Badge variant={r.field_count > 0 ? 'info' : 'default'}>
          {r.field_count} field{r.field_count !== 1 ? 's' : ''}
        </Badge>
      ),
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (r) => r.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
    },
    {
      key: 'total_price_cents',
      header: 'Price',
      sortable: true,
      render: (r) => r.total_price_cents ? `$${(r.total_price_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '-',
    },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Job" accent="Schedule">
        <Button
          icon={<Plus className="w-4 h-4" />}
          onClick={() => navigate('/jobs/new')}
        >
          New Job
        </Button>
      </SplitHeading>

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
            <label className="block text-xs font-medium text-secondary mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as JobStatus | '')}
              aria-label="Filter by status"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="invoiced">Invoiced</option>
              <option value="cancelled">Cancelled</option>
            </select>
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
              { key: 'all', label: 'All' },
              { key: 'today', label: 'Today' },
              { key: 'this_week', label: 'This Week' },
              { key: 'this_season', label: 'This Season' },
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
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={jobs as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search jobs..."
            searchKeys={['job_number', 'customer_name', 'applicator_name']}
            emptyTitle="No jobs found"
            emptyDescription="Create your first job to get started with scheduling."
            loading={loading}
          />
        </div>
      </Card>
    </div>
  );
}
