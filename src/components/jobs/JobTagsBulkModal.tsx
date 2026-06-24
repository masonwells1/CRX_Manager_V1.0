import { useMemo, useState } from 'react';
import { Check, Minus, Plus, Settings2 } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import type { JobTag } from '../../types';

/** Per-tag bulk intent: leave as-is, add to all selected, or remove from all. */
type BulkOp = 'none' | 'add' | 'remove';

interface JobTagsBulkModalProps {
  open: boolean;
  onClose: () => void;
  /** Ids of the checkbox-selected jobs. */
  selectedJobIds: string[];
  /** The full tag catalog. */
  tags: JobTag[];
  /** jobId -> set of tag ids currently assigned. */
  assignmentsByJob: Map<string, Set<string>>;
  /** Open the full tag manager (create/edit/delete) from here. */
  onManageTags: () => void;
  /** Called after a successful apply so the parent can refetch. */
  onApplied: () => void;
}

/**
 * Field-app parity #4: bulk EDIT JOB TAGS over the checkbox-selected jobs.
 * For each tag the user picks Add (assign to every selected job) or Remove
 * (clear from every selected job); untouched tags are left exactly as they are
 * per job. Shows a tri-state hint (all / some / none of the selection already
 * carry the tag) so the office can see the starting point.
 */
export default function JobTagsBulkModal({
  open,
  onClose,
  selectedJobIds,
  tags,
  assignmentsByJob,
  onManageTags,
  onApplied,
}: JobTagsBulkModalProps) {
  const { toast } = useToast();
  const [ops, setOps] = useState<Record<string, BulkOp>>({});
  const [applying, setApplying] = useState(false);

  // How many of the selected jobs already carry each tag (for the hint chip).
  const coverage = useMemo(() => {
    const map: Record<string, number> = {};
    for (const tag of tags) {
      let n = 0;
      for (const jobId of selectedJobIds) {
        if (assignmentsByJob.get(jobId)?.has(tag.id)) n++;
      }
      map[tag.id] = n;
    }
    return map;
  }, [tags, selectedJobIds, assignmentsByJob]);

  const cycleOp = (tagId: string) => {
    setOps((prev) => {
      const cur = prev[tagId] ?? 'none';
      const next: BulkOp = cur === 'none' ? 'add' : cur === 'add' ? 'remove' : 'none';
      return { ...prev, [tagId]: next };
    });
  };

  const pendingCount = Object.values(ops).filter((o) => o !== 'none').length;

  const apply = async () => {
    const adds = tags.filter((t) => ops[t.id] === 'add');
    const removes = tags.filter((t) => ops[t.id] === 'remove');
    if (adds.length === 0 && removes.length === 0) {
      onClose();
      return;
    }
    setApplying(true);
    try {
      // Add: insert (job_id, tag_id) for every selected job that lacks the tag.
      // Ignore-on-conflict via the PK so re-adding is a no-op.
      const rows: { job_id: string; tag_id: string }[] = [];
      for (const tag of adds) {
        for (const jobId of selectedJobIds) {
          if (!assignmentsByJob.get(jobId)?.has(tag.id)) {
            rows.push({ job_id: jobId, tag_id: tag.id });
          }
        }
      }
      if (rows.length > 0) {
        const result = await supabase
          .from('job_tag_assignments')
          .upsert(rows, { onConflict: 'job_id,tag_id', ignoreDuplicates: true })
          .select();
        checkMutationResult(result, 'Add job tags (bulk)');
      }

      // Remove: delete the link rows for the selected jobs.
      for (const tag of removes) {
        const result = await supabase
          .from('job_tag_assignments')
          .delete()
          .eq('tag_id', tag.id)
          .in('job_id', selectedJobIds)
          .select();
        checkMutationResult(result, 'Remove job tags (bulk)');
      }

      toast('success', `Updated tags on ${selectedJobIds.length} job(s)`);
      setOps({});
      onApplied();
      onClose();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobTagsBulkModal.apply' } });
      toast('error', sanitizeError(err));
    }
    setApplying(false);
  };

  const handleClose = () => {
    setOps({});
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Edit Job Tags" accent={`(${selectedJobIds.length} selected)`} size="large">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Tap a tag to cycle <span className="font-medium text-nav-dark">Add</span> →{' '}
          <span className="font-medium text-nav-dark">Remove</span> → off. Only the tags you change are
          applied to all {selectedJobIds.length} selected job(s).
        </p>

        {tags.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-gray-200 rounded-lg space-y-3">
            <p className="text-sm text-secondary">No tags exist yet.</p>
            <Button variant="secondary" icon={<Settings2 className="w-4 h-4" />} onClick={onManageTags} showChevron={false}>
              Manage Tags
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {tags.map((tag) => {
              const op = ops[tag.id] ?? 'none';
              const n = coverage[tag.id] ?? 0;
              const hint =
                n === 0 ? 'on none' : n === selectedJobIds.length ? 'on all' : `on ${n} of ${selectedJobIds.length}`;
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => cycleOp(tag.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                    op === 'add'
                      ? 'border-crx-green bg-crx-green/5'
                      : op === 'remove'
                      ? 'border-red-300 bg-red-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                  <span className="text-sm text-nav-dark font-medium flex-1">{tag.name}</span>
                  <span className="text-xs text-secondary">{hint}</span>
                  <span className="w-20 text-right text-xs font-semibold">
                    {op === 'add' && (
                      <span className="inline-flex items-center gap-1 text-crx-green">
                        <Plus className="w-3.5 h-3.5" /> Add
                      </span>
                    )}
                    {op === 'remove' && (
                      <span className="inline-flex items-center gap-1 text-red-600">
                        <Minus className="w-3.5 h-3.5" /> Remove
                      </span>
                    )}
                    {op === 'none' && <span className="text-gray-400">—</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
          <Button variant="ghost" icon={<Settings2 className="w-4 h-4" />} onClick={onManageTags} showChevron={false}>
            Manage Tags
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleClose} showChevron={false}>
              Cancel
            </Button>
            <Button
              icon={<Check className="w-4 h-4" />}
              onClick={apply}
              disabled={pendingCount === 0}
              loading={applying}
              showChevron={false}
            >
              Apply{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
