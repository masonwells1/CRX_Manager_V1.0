import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Plus, CheckCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '../../lib/db';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import type { LinkedEntityType, TeamNote, NotePriority } from '../../types';
import type { BadgeVariant } from '../ui/Badge';

interface RelatedNotesProps {
  entityType: LinkedEntityType;
  entityId: string;
  onCreateTask: () => void;
}

const priorityVariant: Record<NotePriority, BadgeVariant> = {
  low: 'default',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

const formatDate = (d: string) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function RelatedNotes({ entityType, entityId, onCreateTask }: RelatedNotesProps) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<TeamNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<boolean | null>(null); // null = not yet determined

  useEffect(() => {
    let cancelled = false;

    async function fetchNotes() {
      setLoading(true);
      const { data } = await supabase.rpc('get_notes_for_entity', {
        p_entity_type: entityType,
        p_entity_id: entityId,
      });
      if (cancelled) return;
      const result = (data as TeamNote[] | null) ?? [];
      setNotes(result);
      // Default expanded if notes exist, collapsed if empty
      setExpanded(result.length > 0);
      setLoading(false);
    }

    fetchNotes();
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  const isExpanded = expanded ?? false;

  return (
    <Card padding={false}>
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 text-left"
        onClick={() => setExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-crx-green" />
          <h3 className="text-sm font-semibold text-nav-dark">
            Team Notes {!loading && `(${notes.length})`}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            showChevron={false}
            onClick={(e) => { e.stopPropagation(); onCreateTask(); }}
          >
            Create Task
          </Button>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Body */}
      {isExpanded && (
        <div className="border-t border-gray-100">
          {loading ? (
            /* Skeleton rows */
            <div className="divide-y divide-gray-50">
              {[1, 2, 3].map((i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-3 animate-pulse">
                  <div className="h-4 w-48 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-100 rounded-full" />
                  <div className="ml-auto h-4 w-20 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : notes.length === 0 ? (
            /* Empty state */
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-secondary mb-3">No related notes</p>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                showChevron={false}
                onClick={onCreateTask}
              >
                Create Task
              </Button>
            </div>
          ) : (
            /* Note rows */
            <div className="divide-y divide-gray-50">
              {notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
                  onClick={() => navigate(`/team-board?note=${note.id}`)}
                >
                  {/* Completion status */}
                  {note.is_completed ? (
                    <CheckCircle className="w-4 h-4 text-crx-green shrink-0" />
                  ) : (
                    <Clock className="w-4 h-4 text-gray-300 shrink-0" />
                  )}

                  {/* Title */}
                  <span
                    className={`text-sm truncate min-w-0 flex-1 ${
                      note.is_completed ? 'text-secondary line-through' : 'text-nav-dark'
                    }`}
                  >
                    {note.title}
                  </span>

                  {/* Priority badge */}
                  <Badge variant={priorityVariant[note.priority]}>{note.priority}</Badge>

                  {/* Assignee */}
                  {note.assignee?.full_name && (
                    <span className="text-xs text-secondary hidden sm:inline truncate max-w-[120px]">
                      {note.assignee.full_name}
                    </span>
                  )}

                  {/* Created date */}
                  <span className="text-xs text-gray-400 shrink-0">
                    {formatDate(note.created_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
