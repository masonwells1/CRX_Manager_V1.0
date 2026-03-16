import {
  CheckSquare, Square, Pin, PinOff, Clock, Pencil, Trash2,
  MessageCircle, AlertTriangle, Timer,
} from 'lucide-react';
import Badge from '../ui/Badge';
import EntityBadge from './EntityBadge';
import CustomerContextCard from './CustomerContextCard';
import { parseLocalDate } from '../../lib/dateUtils';
import type { TeamNote, NotePriority, ExtendedTeamNote, LinkedEntityType } from '../../types';

// ── Helper functions ──

const priorityVariant: Record<NotePriority, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

const isOverdue = (note: TeamNote) =>
  !note.is_completed && note.due_date && parseLocalDate(note.due_date) < new Date();

const getDaysUntilDue = (dueDate: string) => {
  const diff = parseLocalDate(dueDate).getTime() - new Date().getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};

const getName = (p: TeamNote['creator'] | { full_name: string } | null | undefined) =>
  (p as unknown as { full_name: string })?.full_name || '';

const formatDate = (d: string) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const formatDateTime = (d: string) =>
  new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const getTimeToComplete = (created: string, completed: string) => {
  const diffMs = new Date(completed).getTime() - new Date(created).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(diffMs / (1000 * 60));
  return `${mins}m`;
};

// ── Props ──

interface NoteCardProps {
  note: ExtendedTeamNote;
  showCheckbox: boolean;
  showCompletionDetails?: boolean;
  canEdit: boolean;
  onToggleComplete: (note: TeamNote) => void;
  onTogglePin: (note: TeamNote) => void;
  onEdit: (note: TeamNote) => void;
  onDelete: (noteId: string) => void;
  onClick: (note: ExtendedTeamNote) => void;
}

// ── Component ──

export default function NoteCard({
  note,
  showCheckbox,
  showCompletionDetails = false,
  canEdit,
  onToggleComplete,
  onTogglePin,
  onEdit,
  onDelete,
  onClick,
}: NoteCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`p-4 rounded-lg border transition-colors group cursor-pointer ${
        note.is_completed
          ? 'border-gray-100 bg-gray-50/50 opacity-75'
          : isOverdue(note)
            ? 'border-red-200 bg-red-50/30 hover:border-red-300'
            : 'border-gray-100 hover:border-gray-200'
      }`}
      onClick={() => onClick(note)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(note); } }}
    >
      <div className="flex items-start gap-3">
        {showCheckbox && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleComplete(note); }}
            className="mt-0.5 text-secondary hover:text-crx-green"
          >
            {note.is_completed ? <CheckSquare className="w-5 h-5 text-crx-green" /> : <Square className="w-5 h-5" />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {note.is_pinned && <Pin className="w-3.5 h-3.5 text-amber-500" />}
            <h4 className={`text-sm font-medium text-nav-dark ${note.is_completed ? 'line-through' : ''}`}>
              {note.title}
            </h4>
            <Badge variant={priorityVariant[note.priority]}>{note.priority}</Badge>
            {isOverdue(note) && (
              <Badge variant="error">
                <AlertTriangle className="w-3 h-3 mr-1" />
                Overdue {Math.abs(getDaysUntilDue(note.due_date!))}d
              </Badge>
            )}
            {!note.is_completed && note.due_date && !isOverdue(note) && getDaysUntilDue(note.due_date) <= 2 && (
              <Badge variant="warning">Due soon</Badge>
            )}
          </div>

          {note.linked_entity_type && note.linked_entity_id && (
            <>
              <EntityBadge
                entityType={note.linked_entity_type as LinkedEntityType}
                entityId={note.linked_entity_id}
              />
              {note.linked_entity_type === 'customer' && (
                <CustomerContextCard customerId={note.linked_entity_id} />
              )}
            </>
          )}

          {note.content && (
            <p className="text-xs text-secondary mt-1 line-clamp-2">{note.content}</p>
          )}
          {note.tags && note.tags.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {note.tags.map(tag => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}15`,
                    color: tag.color,
                    border: `1px solid ${tag.color}30`,
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 flex-wrap">
            {getName(note.creator) && <span>By {getName(note.creator)}</span>}
            {getName(note.assignee) && (
              <span className="text-crx-green font-medium">&rarr; {getName(note.assignee)}</span>
            )}
            {note.due_date && (
              <span className={`flex items-center gap-1 ${isOverdue(note) ? 'text-red-500 font-medium' : ''}`}>
                <Clock className="w-3 h-3" />
                {formatDate(note.due_date)}
              </span>
            )}
            {note.comment_count !== undefined && note.comment_count > 0 && (
              <span className="flex items-center gap-1 text-crx-green">
                <MessageCircle className="w-3 h-3" />
                {note.comment_count}
              </span>
            )}
          </div>

          {/* Completion details — shows who completed it and how long it took */}
          {showCompletionDetails && note.is_completed && note.completed_at && (
            <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1 text-crx-green font-medium">
                <CheckSquare className="w-3 h-3" />
                Completed by {getName(note.completer) || 'Unknown'}
              </span>
              <span className="text-gray-400">
                {formatDateTime(note.completed_at)}
              </span>
              <span className="flex items-center gap-1 text-gray-400" title="Time from creation to completion">
                <Timer className="w-3 h-3" />
                {getTimeToComplete(note.created_at, note.completed_at)}
              </span>
            </div>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePin(note); }}
              className="p-1.5 sm:p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-amber-500"
              title={note.is_pinned ? 'Unpin' : 'Pin'}
            >
              {note.is_pinned ? <PinOff className="w-4 h-4 sm:w-3.5 sm:h-3.5" /> : <Pin className="w-4 h-4 sm:w-3.5 sm:h-3.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(note); }}
              className="p-1.5 sm:p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-500"
              title="Edit"
            >
              <Pencil className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(note.id); }}
              className="p-1.5 sm:p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500"
              title="Delete"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
