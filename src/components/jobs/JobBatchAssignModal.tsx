import { useMemo, useState } from 'react';
import { Check, Plus, Settings2, Layers, XCircle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import type { JobBatch } from '../../types';

interface JobBatchAssignModalProps {
  open: boolean;
  onClose: () => void;
  /** Ids of the checkbox-selected jobs. */
  selectedJobIds: string[];
  /** The full batch catalog. */
  batches: JobBatch[];
  /** jobId -> its current batch_ref (or null). */
  batchByJob: Map<string, string | null>;
  /** Open the full batch manager (create/rename/delete) from here. */
  onManageBatches: () => void;
  /** Called after a successful apply so the parent can refetch (catalog + jobs). */
  onApplied: () => void;
}

// A job belongs to AT MOST ONE batch (jobs.batch_ref). So the bulk action is a
// single CHOICE applied to every selected job: assign to a chosen batch, OR
// remove from any batch. "__remove__" is the sentinel for un-batch.
const REMOVE = '__remove__';

/**
 * Field-app parity #3: bulk ADD TO BATCH / REMOVE FROM BATCH over the
 * checkbox-selected jobs. The office picks ONE target batch (or "Remove from
 * batch") and it applies to every selected job via a single jobs.batch_ref
 * update. A new batch can be created inline without leaving the modal.
 */
export default function JobBatchAssignModal({
  open,
  onClose,
  selectedJobIds,
  batches,
  batchByJob,
  onManageBatches,
  onApplied,
}: JobBatchAssignModalProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [choice, setChoice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // How many of the selected jobs already sit in each batch (for the hint).
  const coverage = useMemo(() => {
    const map: Record<string, number> = {};
    for (const jobId of selectedJobIds) {
      const ref = batchByJob.get(jobId);
      if (ref) map[ref] = (map[ref] ?? 0) + 1;
    }
    return map;
  }, [selectedJobIds, batchByJob]);

  // How many selected jobs are currently in NO batch (for the Remove hint).
  const unbatchedCount = useMemo(
    () => selectedJobIds.filter((id) => !batchByJob.get(id)).length,
    [selectedJobIds, batchByJob]
  );

  const createBatch = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const result = await supabase
        .from('job_batches')
        .insert({ name, created_by: profile?.id ?? null })
        .select();
      checkMutationResult(result, 'Create job batch');
      const created = (result.data?.[0] as JobBatch | undefined);
      toast('success', `Batch "${name}" created`);
      setNewName('');
      // Pre-select the freshly created batch as the target.
      if (created?.id) setChoice(created.id);
      onApplied(); // refetch the catalog so the new batch appears
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        toast('error', 'A batch with that name already exists');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobBatchAssignModal.createBatch' } });
        toast('error', sanitizeError(err));
      }
    }
    setCreating(false);
  };

  const apply = async () => {
    if (!choice) return;
    if (selectedJobIds.length === 0) {
      onClose();
      return;
    }
    setApplying(true);
    try {
      const newRef = choice === REMOVE ? null : choice;
      const result = await supabase
        .from('jobs')
        .update({ batch_ref: newRef })
        .in('id', selectedJobIds)
        .select('id');
      checkMutationResult(result, 'Assign jobs to batch');
      const verb = choice === REMOVE ? 'Removed from batch' : 'Added to batch';
      toast('success', `${verb}: ${selectedJobIds.length} job(s)`);
      setChoice(null);
      onApplied();
      onClose();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobBatchAssignModal.apply' } });
      toast('error', sanitizeError(err));
    }
    setApplying(false);
  };

  const handleClose = () => {
    setChoice(null);
    setNewName('');
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Add to" accent={`Batch (${selectedJobIds.length} selected)`} size="large">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Pick a batch to add all {selectedJobIds.length} selected job(s) to, or remove them from their
          current batch. A job belongs to one batch at a time.
        </p>

        {/* Remove-from-batch option (always available). */}
        <button
          type="button"
          onClick={() => setChoice(REMOVE)}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
            choice === REMOVE ? 'border-red-300 bg-red-50' : 'border-gray-200 hover:bg-gray-50'
          }`}
        >
          <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-nav-dark font-medium flex-1">Remove from batch</span>
          <span className="text-xs text-secondary">
            {unbatchedCount === selectedJobIds.length
              ? 'none batched'
              : `${selectedJobIds.length - unbatchedCount} batched`}
          </span>
          {choice === REMOVE && <Check className="w-4 h-4 text-red-600" aria-hidden="true" />}
        </button>

        {batches.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-gray-200 rounded-lg space-y-3">
            <p className="text-sm text-secondary">No batches exist yet. Create one below.</p>
          </div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {batches.map((b) => {
              const n = coverage[b.id] ?? 0;
              const hint =
                n === 0 ? 'on none' : n === selectedJobIds.length ? 'on all' : `on ${n} of ${selectedJobIds.length}`;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setChoice(b.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                    choice === b.id ? 'border-crx-green bg-crx-green/5' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <Layers className="w-4 h-4 text-crx-green flex-shrink-0" aria-hidden="true" />
                  <span className="text-sm text-nav-dark font-medium flex-1 min-w-0 truncate">
                    {b.name}
                    {b.description && <span className="text-secondary font-normal"> — {b.description}</span>}
                  </span>
                  <span className="text-xs text-secondary whitespace-nowrap">{hint}</span>
                  {choice === b.id && <Check className="w-4 h-4 text-crx-green" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Inline create-a-batch. */}
        <div className="border-t border-gray-100 pt-3">
          <label className="block text-xs font-medium text-secondary mb-1">New batch</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createBatch()}
              placeholder="Batch name"
              aria-label="New batch name"
              className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
            <Button
              variant="secondary"
              icon={<Plus className="w-4 h-4" />}
              onClick={createBatch}
              disabled={!newName.trim()}
              loading={creating}
              showChevron={false}
            >
              Create
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
          <Button variant="ghost" icon={<Settings2 className="w-4 h-4" />} onClick={onManageBatches} showChevron={false}>
            Manage Batches
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleClose} showChevron={false}>
              Cancel
            </Button>
            <Button
              icon={<Check className="w-4 h-4" />}
              onClick={apply}
              disabled={!choice}
              loading={applying}
              showChevron={false}
            >
              Apply
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
