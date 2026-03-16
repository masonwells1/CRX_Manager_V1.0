import { useEffect, useState } from 'react';
import { Users, Truck, ClipboardList, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '../../lib/db';
import Badge from '../ui/Badge';

interface TeamMemberWorkload {
  id: string;
  full_name: string;
  role: string;
  open_tasks: number;
  overdue_tasks: number;
  today_deliveries: number;
  week_deliveries: number;
}

function getLoadColor(openTasks: number, overdueTasks: number): string {
  if (overdueTasks > 0) return 'bg-red-50 border-red-200';
  if (openTasks >= 6) return 'bg-red-50 border-red-200';
  if (openTasks >= 3) return 'bg-amber-50 border-amber-200';
  return 'bg-green-50 border-green-200';
}

function getLoadLabel(openTasks: number, overdueTasks: number): { text: string; variant: 'default' | 'warning' | 'error' } {
  if (overdueTasks > 0) return { text: 'Has overdue', variant: 'error' };
  if (openTasks >= 6) return { text: 'Heavy', variant: 'error' };
  if (openTasks >= 3) return { text: 'Moderate', variant: 'warning' };
  return { text: 'Light', variant: 'default' };
}

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  sales_rep: 'Sales Rep',
  driver: 'Driver',
};

export default function WorkloadView() {
  const [members, setMembers] = useState<TeamMemberWorkload[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.rpc('get_team_workload');
      if (data) setMembers(data as TeamMemberWorkload[]);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Sort: overdue first, then by open_tasks desc
  const sorted = [...members].sort((a, b) => {
    if (a.overdue_tasks !== b.overdue_tasks) return b.overdue_tasks - a.overdue_tasks;
    return b.open_tasks - a.open_tasks;
  });

  const totalOverdue = sorted.reduce((sum, m) => sum + m.overdue_tasks, 0);
  const totalOpen = sorted.reduce((sum, m) => sum + m.open_tasks, 0);

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Users className="w-4 h-4" />
          <span className="font-medium">{sorted.length} team members</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <ClipboardList className="w-4 h-4 text-crx-green" />
          <span>{totalOpen} open tasks</span>
        </div>
        {totalOverdue > 0 && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-medium">{totalOverdue} overdue</span>
          </div>
        )}
      </div>

      {/* Team member cards */}
      <div className="space-y-2">
        {sorted.map(member => {
          const load = getLoadLabel(member.open_tasks, member.overdue_tasks);
          const isExpanded = expandedId === member.id;

          return (
            <div
              key={member.id}
              className={`rounded-lg border transition-colors ${getLoadColor(member.open_tasks, member.overdue_tasks)}`}
            >
              <button
                onClick={() => setExpandedId(isExpanded ? null : member.id)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-white border flex items-center justify-center text-sm font-bold text-gray-600 shrink-0">
                    {member.full_name.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 truncate">{member.full_name}</span>
                      <span className="text-xs text-gray-500">{roleLabels[member.role] ?? member.role}</span>
                      <Badge variant={load.variant}>{load.text}</Badge>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  {member.role === 'driver' && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-600" title="Today's deliveries">
                      <Truck className="w-3.5 h-3.5" />
                      <span className="font-medium">{member.today_deliveries}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 text-xs text-gray-600" title="Open tasks">
                    <ClipboardList className="w-3.5 h-3.5" />
                    <span className="font-medium">{member.open_tasks}</span>
                  </div>
                  {member.overdue_tasks > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-red-600 font-medium" title="Overdue">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {member.overdue_tasks}
                    </div>
                  )}
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </div>
              </button>

              {isExpanded && (
                <div className="px-4 pb-3 border-t border-gray-200/50">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                    <div className="text-center">
                      <div className="text-lg font-bold text-gray-900">{member.open_tasks}</div>
                      <div className="text-xs text-gray-500">Open Tasks</div>
                    </div>
                    <div className="text-center">
                      <div className={`text-lg font-bold ${member.overdue_tasks > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                        {member.overdue_tasks}
                      </div>
                      <div className="text-xs text-gray-500">Overdue</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-bold text-gray-900">{member.today_deliveries}</div>
                      <div className="text-xs text-gray-500">Today's Deliveries</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-bold text-gray-900">{member.week_deliveries}</div>
                      <div className="text-xs text-gray-500">This Week</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
