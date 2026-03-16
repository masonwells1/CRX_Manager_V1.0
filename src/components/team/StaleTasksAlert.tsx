import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Clock, User } from 'lucide-react';
import { Link } from 'react-router-dom';
import Badge from '../ui/Badge';
import { parseLocalDate } from '../../lib/dateUtils';
import type { ExtendedTeamNote } from '../../types';

interface Props {
  notes: ExtendedTeamNote[];
  onClickNote: (note: ExtendedTeamNote) => void;
}

function getDaysOverdue(dueDate: string): number {
  const diff = new Date().getTime() - parseLocalDate(dueDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getEscalationLevel(daysOverdue: number): 'amber' | 'red' | 'critical' {
  if (daysOverdue >= 7) return 'critical';
  if (daysOverdue >= 3) return 'red';
  return 'amber';
}

const escalationStyles = {
  amber: 'bg-amber-50 border-amber-200 text-amber-800',
  red: 'bg-red-50 border-red-200 text-red-800',
  critical: 'bg-red-100 border-red-300 text-red-900 animate-pulse',
};

const entityRoutes: Record<string, (id: string) => string> = {
  delivery: (id) => `/deliveries/${id}`,
  order: (id) => `/orders/${id}`,
  customer: (id) => `/customers/${id}`,
  job: (id) => `/jobs/${id}`,
  purchase_order: (id) => `/purchase-orders/${id}`,
  quote: (id) => `/quotes/${id}`,
};

export default function StaleTasksAlert({ notes, onClickNote }: Props) {
  const [expanded, setExpanded] = useState(true);

  // Filter to overdue, incomplete, non-deleted notes with due dates
  const staleTasks = notes
    .filter(n => !n.is_completed && !n.deleted_at && n.due_date && parseLocalDate(n.due_date) < new Date())
    .map(n => ({
      ...n,
      daysOverdue: getDaysOverdue(n.due_date!),
      level: getEscalationLevel(getDaysOverdue(n.due_date!)),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  if (staleTasks.length === 0) return null;

  const criticalCount = staleTasks.filter(t => t.level === 'critical').length;
  const redCount = staleTasks.filter(t => t.level === 'red').length;

  return (
    <div className="bg-red-50 border border-red-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-red-100/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          <span className="font-semibold text-red-800">
            {staleTasks.length} Overdue Task{staleTasks.length !== 1 ? 's' : ''}
          </span>
          {criticalCount > 0 && (
            <Badge variant="error">{criticalCount} critical (7d+)</Badge>
          )}
          {redCount > 0 && (
            <Badge variant="warning">{redCount} escalated (3d+)</Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-red-600" /> : <ChevronDown className="w-4 h-4 text-red-600" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {staleTasks.map(task => (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              onClick={() => onClickNote(task)}
              onKeyDown={(e) => { if (e.key === 'Enter') onClickNote(task); }}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors hover:opacity-80 ${escalationStyles[task.level]}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{task.title}</span>
                  <span className="flex items-center gap-1 text-xs font-bold">
                    <Clock className="w-3 h-3" />
                    {task.daysOverdue}d overdue
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs opacity-75">
                  {(task.assignee as { full_name: string } | null)?.full_name && (
                    <span className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {(task.assignee as { full_name: string }).full_name}
                    </span>
                  )}
                  {task.linked_entity_type && task.linked_entity_id && (
                    <Link
                      to={entityRoutes[task.linked_entity_type]?.(task.linked_entity_id) ?? '#'}
                      onClick={(e) => e.stopPropagation()}
                      className="underline hover:no-underline"
                    >
                      {task.linked_entity_type.replace('_', ' ')}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
