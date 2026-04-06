import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckSquare, ChevronDown, ChevronRight } from 'lucide-react';
import Card from '../components/ui/Card';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';

// Money safety: invoiced_amount_cents is bigint cents, display / 100
const fmtDollars = (cents: number) =>
  '$' + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface ProgramRow {
  customer_id: string;
  customer_name: string;
  quote_id: string;
  quote_number: string;
  section_id: string;
  program_name: string;
  needed_by_date: string | null;
  planned_acres: number;
  completed_acres: number;
  completion_pct: number;
  status: 'not_started' | 'in_progress' | 'completed';
  job_count: number;
  blend_ticket_count: number;
  invoiced_amount_cents: number;
}

const statusBadge: Record<string, BadgeVariant> = { not_started: 'default', in_progress: 'warning', completed: 'success' };
const statusLabel: Record<string, string> = { not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' };

function currentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

export default function ProgramTracker() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState(currentSeason());
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const fetchPrograms = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_program_completion', { p_season: season });
      if (error) throw error;
      const result = assertRpcResult<ProgramRow[]>(data, 'get_program_completion');
      setPrograms(result);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      toast('error', 'Failed to load program data');
    }
    setLoading(false);
  }, [season, toast]);

  useEffect(() => { fetchPrograms(); }, [fetchPrograms]);

  const filtered = programs.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (customerFilter && p.customer_id !== customerFilter) return false;
    return true;
  });

  const uniqueCustomers = [...new Map(programs.map((p) => [p.customer_id, p.customer_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const total = filtered.length;
  const avgPct = total > 0 ? Math.round(filtered.reduce((s, p) => s + p.completion_pct, 0) / total) : 0;
  const inProgress = filtered.filter((p) => p.status === 'in_progress').length;
  const notStarted = filtered.filter((p) => p.status === 'not_started').length;

  const toggleRow = (sectionId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <SplitHeading title="Program" accent="Tracker" />

      <div className="flex gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-secondary mb-1">Season</label>
          <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
            {[currentSeason() - 1, currentSeason(), currentSeason() + 1].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-secondary mb-1">Customer</label>
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
            <option value="">All Customers</option>
            {uniqueCustomers.map(([cid, name]) => <option key={cid} value={cid}>{name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-secondary mb-1">Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
            <option value="">All</option>
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><div className="text-center"><p className="text-2xl font-bold text-nav-dark">{total}</p><p className="text-xs text-secondary">Total Programs</p></div></Card>
        <Card><div className="text-center"><p className="text-2xl font-bold text-crx-green">{avgPct}%</p><p className="text-xs text-secondary">Avg Completion</p></div></Card>
        <Card><div className="text-center"><p className="text-2xl font-bold text-amber-600">{inProgress}</p><p className="text-xs text-secondary">In Progress</p></div></Card>
        <Card><div className="text-center"><p className="text-2xl font-bold text-gray-500">{notStarted}</p><p className="text-xs text-secondary">Not Started</p></div></Card>
      </div>

      <Card padding={false}>
        <div className="p-5">
          {loading ? (
            <div className="space-y-3">{[1,2,3].map((i) => <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />)}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <CheckSquare className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-lg font-medium text-gray-500">No planned programs found</p>
              <p className="text-sm text-secondary mt-1">Create a planned quote to start tracking programs.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-secondary border-b border-gray-100">
                  <th className="pb-2 pr-3 w-6"></th>
                  <th className="pb-2 pr-3">Customer</th>
                  <th className="pb-2 pr-3">Program</th>
                  <th className="pb-2 pr-3 text-right">Planned</th>
                  <th className="pb-2 pr-3 text-right">Completed</th>
                  <th className="pb-2 pr-3 w-40">Progress</th>
                  <th className="pb-2 pr-3 text-center">Jobs</th>
                  <th className="pb-2 pr-3 text-right">Invoiced</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((p) => (
                  <tr key={p.section_id} className="hover:bg-gray-50 cursor-pointer" onClick={() => toggleRow(p.section_id)}>
                    <td className="py-2.5 pr-3">{expandedRows.has(p.section_id) ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}</td>
                    <td className="py-2.5 pr-3 font-medium text-nav-dark">{p.customer_name}</td>
                    <td className="py-2.5 pr-3">
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/quotes/${p.quote_id}`); }} className="text-crx-green hover:underline">{p.program_name}</button>
                      {p.needed_by_date && <span className="ml-2 text-xs text-secondary">by {p.needed_by_date}</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono">{p.planned_acres.toLocaleString()} ac</td>
                    <td className="py-2.5 pr-3 text-right font-mono">{p.completed_acres.toLocaleString()} ac</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${p.completion_pct >= 100 ? 'bg-crx-green' : p.completion_pct > 0 ? 'bg-amber-400' : 'bg-gray-300'}`} style={{ width: `${Math.min(p.completion_pct, 100)}%` }} />
                        </div>
                        <span className="text-xs font-medium w-10 text-right">{p.completion_pct}%</span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-center">{p.job_count}</td>
                    <td className="py-2.5 pr-3 text-right font-mono">{p.invoiced_amount_cents > 0 ? fmtDollars(p.invoiced_amount_cents) : '-'}</td>
                    <td className="py-2.5"><Badge variant={statusBadge[p.status]}>{statusLabel[p.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
