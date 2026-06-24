import { useState } from 'react';
import { Plus, Save, Trash2, Layers } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import type { JobBatch } from '../../types';

interface JobBatchesManagerProps {
  open: boolean;
  onClose: () => void;
  batches: JobBatch[];
  /** jobId count per batch (for the "N job(s)" hint). */
  memberCounts: Record<string, number>;
  /** Called after any create / rename / delete so the parent can refetch. */
  onChanged: () => void;
}

/**
 * Field-app parity #3: the JOB BATCHES manager modal — the batch catalog.
 * Create a named batch (name + optional description), rename / re-describe an
 * existing batch, delete a batch (the FK ON DELETE SET NULL un-batches its jobs
 * — the jobs survive). Mirrors the JobTagsManager pattern: plain Supabase
 * mutations guarded by checkMutationResult, no RPC.
 */
export default function JobBatchesManager({ open, onClose, batches, memberCounts, onChanged }: JobBatchesManagerProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // Per-batch in-flight edit state, keyed by batch id.
  const [edits, setEdits] = useState<Record<string, { name: string; description: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobBatch | null>(null);
  const [deleting, setDeleting] = useState(false);

  const editFor = (b: JobBatch) => edits[b.id] ?? { name: b.name, description: b.description ?? '' };

  const setEdit = (id: string, patch: Partial<{ name: string; description: string }>) => {
    setEdits((prev) => {
      const src = batches.find((b) => b.id === id);
      const base = prev[id] ?? { name: src?.name ?? '', description: src?.description ?? '' };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };

  const createBatch = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const result = await supabase
        .from('job_batches')
        .insert({ name, description: newDesc.trim() || null, created_by: profile?.id ?? null })
        .select();
      checkMutationResult(result, 'Create job batch');
      toast('success', `Batch "${name}" created`);
      setNewName('');
      setNewDesc('');
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        toast('error', 'A batch with that name already exists');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobBatchesManager.createBatch' } });
        toast('error', sanitizeError(err));
      }
    }
    setCreating(false);
  };

  const saveBatch = async (b: JobBatch) => {
    const next = editFor(b);
    const name = next.name.trim();
    if (!name) {
      toast('error', 'Batch name cannot be empty');
      return;
    }
    const desc = next.description.trim();
    if (name === b.name && desc === (b.description ?? '')) return; // nothing changed
    setSavingId(b.id);
    try {
      const result = await supabase
        .from('job_batches')
        .update({ name, description: desc || null })
        .eq('id', b.id)
        .select();
      checkMutationResult(result, 'Update job batch');
      toast('success', 'Batch updated');
      setEdits((prev) => {
        const copy = { ...prev };
        delete copy[b.id];
        return copy;
      });
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        toast('error', 'A batch with that name already exists');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobBatchesManager.saveBatch' } });
        toast('error', sanitizeError(err));
      }
    }
    setSavingId(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await supabase
        .from('job_batches')
        .delete()
        .eq('id', deleteTarget.id)
        .select();
      checkMutationResult(result, 'Delete job batch');
      toast('success', `Batch "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobBatchesManager.confirmDelete' } });
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
  };

  const memberHint = (b: JobBatch) => {
    const n = memberCounts[b.id] ?? 0;
    return `${n} job${n !== 1 ? 's' : ''}`;
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="Job" accent="Batches" size="large">
        <div className="space-y-5">
          {/* Existing batches */}
          <div>
            <h3 className="text-sm font-semibold text-nav-dark mb-2">Batches</h3>
            {batches.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center border border-dashed border-gray-200 rounded-lg">
                No batches yet. Add your first batch below.
              </p>
            ) : (
              <div className="space-y-2">
                {batches.map((b) => {
                  const e = editFor(b);
                  const dirty = e.name.trim() !== b.name || e.description.trim() !== (b.description ?? '');
                  return (
                    <div key={b.id} className="flex items-start gap-3 p-2.5 border border-gray-200 rounded-lg">
                      <Layers className="w-4 h-4 text-crx-green flex-shrink-0 mt-2" aria-hidden="true" />
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <input
                          type="text"
                          value={e.name}
                          onChange={(ev) => setEdit(b.id, { name: ev.target.value })}
                          aria-label={`Batch name for ${b.name}`}
                          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                        />
                        <input
                          type="text"
                          value={e.description}
                          onChange={(ev) => setEdit(b.id, { description: ev.target.value })}
                          placeholder="Description (optional)"
                          aria-label={`Batch description for ${b.name}`}
                          className="w-full px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                        />
                      </div>
                      <span className="text-xs text-secondary whitespace-nowrap mt-2">{memberHint(b)}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Save className="w-4 h-4" />}
                        onClick={() => saveBatch(b)}
                        disabled={!dirty || !e.name.trim()}
                        loading={savingId === b.id}
                        showChevron={false}
                      >
                        Save
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="w-4 h-4" />}
                        onClick={() => setDeleteTarget(b)}
                        showChevron={false}
                      >
                        Delete
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add new batch */}
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-nav-dark mb-2 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-crx-green" />
              Add a batch
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="text"
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onKeyDown={(ev) => ev.key === 'Enter' && createBatch()}
                placeholder="Batch name (e.g. Tuesday corn run)"
                aria-label="New batch name"
                className="flex-1 min-w-[12rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <input
                type="text"
                value={newDesc}
                onChange={(ev) => setNewDesc(ev.target.value)}
                onKeyDown={(ev) => ev.key === 'Enter' && createBatch()}
                placeholder="Description (optional)"
                aria-label="New batch description"
                className="flex-1 min-w-[10rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <Button
                icon={<Plus className="w-4 h-4" />}
                onClick={createBatch}
                disabled={!newName.trim()}
                loading={creating}
                showChevron={false}
              >
                Add Batch
              </Button>
            </div>
          </div>

          <div className="flex justify-end pt-2 border-t border-gray-100">
            <Button variant="secondary" onClick={onClose} showChevron={false}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete batch?"
        message={deleteTarget ? `"${deleteTarget.name}" will be removed. The ${memberCounts[deleteTarget.id] ?? 0} job(s) in it stay — they just lose their batch. This cannot be undone.` : ''}
        confirmLabel="Delete batch"
        variant="danger"
        loading={deleting}
      />
    </>
  );
}
