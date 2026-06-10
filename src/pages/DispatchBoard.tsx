/**
 * DispatchBoard.tsx — Map-based dispatch view for job scheduling
 *
 * Split-screen layout: map on left (60%), job list on right (40%)
 * Color-coded by status, filterable by status/date/applicator/customer
 * Applicator assignment from sidebar
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Filter, Users, Clock, AlertTriangle, ChevronRight } from 'lucide-react';
import CRXMap from '../components/map/CRXMap';
import FieldBoundaryLayer from '../components/map/FieldBoundaryLayer';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Skeleton from '../components/ui/Skeleton';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { localToday } from '../lib/dateUtils';
import type { Job, Profile, Field } from '../types';

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
type PriorityFilter = 'all' | 'low' | 'normal' | 'high' | 'urgent';

interface DispatchJob extends Job {
  customer_name?: string;
  applicator_name?: string;
  field_names?: string;
  field_ids?: string[];
}

export default function DispatchBoard() {
  usePageMeta();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [applicators, setApplicators] = useState<Pick<Profile, 'id' | 'full_name' | 'role'>[]>([]);
  const [allFields, setAllFields] = useState<Field[]>([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [dateFilter, setDateFilter] = useState(localToday());
  const [applicatorFilter, setApplicatorFilter] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, applicatorsRes, fieldsRes] = await Promise.all([
        // PR-07 follow-up: dropped applicator FK embed; resolved via the
        // applicators list returned in the same Promise.all (already a view
        // read) — pivot to a map after the fetch.
        supabase
          .from('jobs')
          .select(`
            *,
            customer:customers(farm_name),
            job_fields(field_id, acres_to_treat, field:fields(id, field_name, boundary_geojson, centroid_lat, centroid_lng, total_acres, crop_type, customer_id))
          `)
          .is('deleted_at', null)
          .gte('job_date', dateFilter)
          .lte('job_date', dateFilter)
          .order('scheduled_time', { ascending: true, nullsFirst: false }),
        // PR-07 follow-up: profile_public_view exposes only id/full_name/role/is_active.
        supabase
          .from('profile_public_view')
          .select('id, full_name, role')
          .in('role', ['applicator', 'driver', 'admin'])
          .eq('is_active', true)
          .order('full_name'),
        supabase
          .from('fields')
          .select('id, field_name, boundary_geojson, centroid_lat, centroid_lng, total_acres, crop_type, customer_id, customer:customers(farm_name)')
          .eq('is_active', true),
      ]);

      if (jobsRes.error) throw jobsRes.error;

      // Build applicator name map from the parallel applicators fetch above
      // so we don't need a second profile_public_view round-trip.
      const applicatorNameMap: Record<string, string> = {};
      ((applicatorsRes.data || []) as Array<{ id: string; full_name: string }>).forEach((a) => {
        applicatorNameMap[a.id] = a.full_name;
      });

      const mapped: DispatchJob[] = (jobsRes.data || []).map((j: Record<string, unknown>) => ({
        ...j,
        customer_name: (j.customer as { farm_name?: string })?.farm_name || 'Unknown',
        applicator_name: j.applicator_id ? applicatorNameMap[j.applicator_id as string] || null : null,
        field_names: ((j.job_fields as { field?: { field_name?: string } }[]) || [])
          .map(jf => jf.field?.field_name)
          .filter(Boolean)
          .join(', ') || null,
        field_ids: ((j.job_fields as { field_id?: string }[]) || []).map(jf => jf.field_id).filter(Boolean),
      })) as DispatchJob[];

      setJobs(mapped);
      setApplicators((applicatorsRes.data || []) as Pick<Profile, 'id' | 'full_name' | 'role'>[]);
      setAllFields((fieldsRes.data || []) as unknown as Field[]);
    } catch (err) {
      Sentry.captureException(err);
      toast('error', 'Failed to load dispatch data');
    }
    setLoading(false);
  }, [dateFilter, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredJobs = useMemo(() => {
    return jobs.filter(j => {
      if (statusFilter !== 'all' && j.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && j.priority !== priorityFilter) return false;
      if (applicatorFilter && j.applicator_id !== applicatorFilter) return false;
      return true;
    });
  }, [jobs, statusFilter, priorityFilter, applicatorFilter]);

  // Get fields for jobs that are visible on the map
  const jobFields = useMemo(() => {
    const fieldIds = new Set(filteredJobs.flatMap(j => j.field_ids || []));
    return allFields.filter(f => fieldIds.has(f.id));
  }, [filteredJobs, allFields]);

  const statusColor: Record<string, string> = {
    scheduled: 'bg-yellow-500',
    in_progress: 'bg-blue-500',
    completed: 'bg-gray-400',
    cancelled: 'bg-red-400',
    invoiced: 'bg-green-500',
  };

  const priorityBadge: Record<string, { variant: 'default' | 'warning' | 'error'; label: string }> = {
    low: { variant: 'default', label: 'Low' },
    normal: { variant: 'default', label: 'Normal' },
    high: { variant: 'warning', label: 'High' },
    urgent: { variant: 'error', label: 'Urgent' },
  };

  async function handleAssign(jobId: string, applicatorId: string) {
    try {
      const result = await supabase
        .from('jobs')
        .update({ applicator_id: applicatorId || null, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .select();
      checkMutationResult(result, 'Assign applicator');

      if (profile) {
        const app = applicators.find(a => a.id === applicatorId);
        logActivity({
          event: 'job_assigned',
          description: `Job assigned to ${app?.full_name || 'unassigned'}`,
          performedBy: profile.id,
          entityType: 'job',
          entityId: jobId,
        });
      }

      toast('success', 'Applicator assigned');
      fetchData();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'action', action: 'assign_applicator' } });
      toast('error', 'Failed to assign applicator. Please try again.');
    }
  }

  // Stats
  const scheduled = jobs.filter(j => j.status === 'scheduled').length;
  const inProgress = jobs.filter(j => j.status === 'in_progress').length;
  const completed = jobs.filter(j => j.status === 'completed').length;
  const totalAcres = jobs.reduce((sum, j) => sum + (j.total_acres || 0), 0);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-[600px]" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark flex items-center gap-2">
          <MapPin className="w-5 h-5 text-crx-green" /> Dispatch Board
        </h2>
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-yellow-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{scheduled}</p>
              <p className="text-xs text-secondary">Scheduled</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{inProgress}</p>
              <p className="text-xs text-secondary">In Progress</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
              <Filter className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{completed}</p>
              <p className="text-xs text-secondary">Completed</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <Users className="w-5 h-5 text-crx-green" />
            </div>
            <div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">{totalAcres.toLocaleString()}</p>
              <p className="text-xs text-secondary">Total Acres</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Split Screen: Map + Job List */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4" style={{ minHeight: '600px' }}>
        {/* Map Panel (60%) */}
        <div className="lg:col-span-3 rounded-lg overflow-hidden border border-gray-200">
          <CRXMap className="h-full min-h-[500px]" showLayerToggle interactive>
            <FieldBoundaryLayer
              fields={jobFields as (Field & { customer_name?: string })[]}
              showLabels
              onFieldClick={(fieldId) => {
                const job = filteredJobs.find(j => j.field_ids?.includes(fieldId));
                if (job) setSelectedJobId(job.id);
              }}
            />
          </CRXMap>
        </div>

        {/* Job List Panel (40%) */}
        <div className="lg:col-span-2 space-y-3 overflow-y-auto" style={{ maxHeight: '700px' }}>
          {/* Filters */}
          <Card className="p-3">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5"
              >
                <option value="all">All Statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5"
              >
                <option value="all">All Priorities</option>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
              <select
                value={applicatorFilter}
                onChange={(e) => setApplicatorFilter(e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 col-span-2"
              >
                <option value="">All Applicators</option>
                {applicators.filter(a => a.role === 'applicator').map(a => (
                  <option key={a.id} value={a.id}>{a.full_name}</option>
                ))}
              </select>
            </div>
          </Card>

          {/* Job Cards */}
          {filteredJobs.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-secondary text-sm">No jobs for {dateFilter}</p>
            </Card>
          ) : (
            filteredJobs.map(job => (
              <Card
                key={job.id}
                className={`p-4 cursor-pointer hover:border-crx-green transition-colors ${
                  selectedJobId === job.id ? 'border-crx-green ring-1 ring-crx-green/30' : ''
                }`}
                onClick={() => setSelectedJobId(job.id === selectedJobId ? null : job.id)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${statusColor[job.status] || 'bg-gray-300'}`} />
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${job.id}`); }}
                      className="font-medium text-sm text-crx-green hover:underline"
                    >
                      {job.job_number}
                    </button>
                    {job.priority !== 'normal' && (
                      <Badge variant={priorityBadge[job.priority]?.variant || 'default'} size="sm">
                        {job.priority === 'urgent' && <AlertTriangle className="w-3 h-3 mr-0.5" />}
                        {priorityBadge[job.priority]?.label}
                      </Badge>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300" />
                </div>

                <p className="text-sm text-nav-dark font-medium">{job.customer_name}</p>
                {job.field_names && (
                  <p className="text-xs text-secondary mt-0.5">{job.field_names}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-secondary">
                  {job.total_acres && <span>{job.total_acres} ac</span>}
                  {job.scheduled_time && <span>{job.scheduled_time}</span>}
                  {job.estimated_hours && <span>{job.estimated_hours}h est</span>}
                </div>

                {/* Applicator Assignment */}
                <div className="mt-3 flex items-center gap-2">
                  <Users className="w-3.5 h-3.5 text-secondary" />
                  <select
                    value={job.applicator_id || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => handleAssign(job.id, e.target.value)}
                    className="text-xs border border-gray-200 rounded px-2 py-1 flex-1 focus:outline-none focus:ring-1 focus:ring-crx-green/30"
                  >
                    <option value="">Unassigned</option>
                    {applicators.filter(a => a.role === 'applicator').map(a => (
                      <option key={a.id} value={a.id}>{a.full_name}</option>
                    ))}
                  </select>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
