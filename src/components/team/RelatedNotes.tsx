import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Plus, CheckCircle, Clock, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { sanitizeError } from '../../lib/errorSanitizer';
import { useToast } from '../ui/Toast';
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
  const { toast } = useToast();
  const [notes, setNotes] = useState<TeamNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState<boolean | null>(null); // null = not yet determined

  // Route reuse (job A → job B on the same page) must never show one entity's
  // notes under another, so the guard is on the CALL, not the entity id: only
  // the newest request may write state. `Try again` re-enters the same path.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const { data, error } = await supabase.rpc('get_notes_for_entity', {
        p_entity_type: entityType,
        p_entity_id: entityId,
      });
      if (seq !== requestSeq.current) return;
      if (error) throw error;
      const result = assertRpcResult<TeamNote[]>(data, 'get_notes_for_entity');
      setNotes(result);
      // Default expanded if notes exist, collapsed if empty
      setExpanded(result.length > 0);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      // A failed load must not read as "no notes": blank the list, flag the
      // failure, and open the card so the operator sees it rather than a
      // collapsed header claiming (0).
      setNotes([]);
      setLoadError(true);
      setExpanded(true);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'fetch', component: 'RelatedNotes', rpc: 'get_notes_for_entity' },
        extra: { context: 'RelatedNotes.load', entityType },
      });
      toast('error', sanitizeError(err));
    } finally {
      // In `finally` so no throw above can leave the card stuck on its skeleton.
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [entityType, entityId, toast]);

  useEffect(() => { void load(); }, [load]);

  const isExpanded = expanded ?? false;

  return (
    <Card padding={false}>
      {/* Header */}
      <div className="flex items-center p-4">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between text-left"
          onClick={() => setExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          <span className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-crx-green" />
            <span className="text-sm font-semibold text-nav-dark">
              Team Notes {!loading && !loadError && `(${notes.length})`}
            </span>
          </span>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          showChevron={false}
          onClick={onCreateTask}
        >
          Create Task
        </Button>
      </div>

      {/* Body */}
      {isExpanded && (
        <div className="border-t border-gray-100">
          {loading ? (
            /* Skeleton rows */
            <div className="divide-y divide-gray-50" data-testid="related-notes-loading">
              {[1, 2, 3].map((i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-3 animate-pulse">
                  <div className="h-4 w-48 bg-gray-200 rounded" />
                  <div className="h-4 w-16 bg-gray-100 rounded-full" />
                  <div className="ml-auto h-4 w-20 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : loadError ? (
            /* Load failed — distinct from "no notes", and retryable */
            <div className="px-4 py-6 text-center" data-testid="related-notes-error">
              <p className="text-sm text-secondary mb-3">Couldn&apos;t load related notes.</p>
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                showChevron={false}
                onClick={() => void load()}
              >
                Try again
              </Button>
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
