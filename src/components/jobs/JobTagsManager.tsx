import { useState } from 'react';
import { Plus, Save, Trash2, Tag as TagIcon } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import type { JobTag } from '../../types';
import { JOB_TAG_COLORS, DEFAULT_JOB_TAG_COLOR } from './jobTagColors';

interface JobTagsManagerProps {
  open: boolean;
  onClose: () => void;
  tags: JobTag[];
  /** Called after any create / edit / delete so the parent can refetch. */
  onChanged: () => void;
}

/** Inline swatch picker shared by the add-row and each edit-row. */
function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {JOB_TAG_COLORS.map((c) => (
        <button
          key={c.hex}
          type="button"
          onClick={() => onChange(c.hex)}
          aria-label={c.label}
          title={c.label}
          className={`w-6 h-6 rounded-full transition-transform ${
            value.toLowerCase() === c.hex.toLowerCase()
              ? 'ring-2 ring-offset-1 ring-gray-500 scale-110'
              : 'hover:scale-105'
          }`}
          style={{ backgroundColor: c.hex }}
        />
      ))}
    </div>
  );
}

/**
 * Field-app parity #4: the EDIT JOB TAGS manager modal — the tag catalog.
 * Create a tag (name + color), rename / recolor an existing tag, delete a tag
 * (cascades off every job via the DB FK). Mirrors the team-note TagsManager
 * pattern: plain Supabase mutations guarded by checkMutationResult, no RPC.
 */
export default function JobTagsManager({ open, onClose, tags, onChanged }: JobTagsManagerProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_JOB_TAG_COLOR);
  const [creating, setCreating] = useState(false);
  // Per-tag in-flight edit state, keyed by tag id.
  const [edits, setEdits] = useState<Record<string, { name: string; color: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobTag | null>(null);
  const [deleting, setDeleting] = useState(false);

  const editFor = (tag: JobTag) => edits[tag.id] ?? { name: tag.name, color: tag.color };

  const setEdit = (id: string, patch: Partial<{ name: string; color: string }>) => {
    setEdits((prev) => {
      const base = prev[id] ?? { name: tags.find((t) => t.id === id)?.name ?? '', color: tags.find((t) => t.id === id)?.color ?? DEFAULT_JOB_TAG_COLOR };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };

  const createTag = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const result = await supabase
        .from('job_tags')
        .insert({ name, color: newColor, created_by: profile?.id ?? null })
        .select();
      checkMutationResult(result, 'Create job tag');
      toast('success', `Tag "${name}" created`);
      setNewName('');
      setNewColor(DEFAULT_JOB_TAG_COLOR);
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        toast('error', 'A tag with that name already exists');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobTagsManager.createTag' } });
        toast('error', sanitizeError(err));
      }
    }
    setCreating(false);
  };

  const saveTag = async (tag: JobTag) => {
    const next = editFor(tag);
    const name = next.name.trim();
    if (!name) {
      toast('error', 'Tag name cannot be empty');
      return;
    }
    if (name === tag.name && next.color === tag.color) return; // nothing changed
    setSavingId(tag.id);
    try {
      const result = await supabase
        .from('job_tags')
        .update({ name, color: next.color })
        .eq('id', tag.id)
        .select();
      checkMutationResult(result, 'Update job tag');
      toast('success', 'Tag updated');
      setEdits((prev) => {
        const copy = { ...prev };
        delete copy[tag.id];
        return copy;
      });
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        toast('error', 'A tag with that name already exists');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobTagsManager.saveTag' } });
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
        .from('job_tags')
        .delete()
        .eq('id', deleteTarget.id)
        .select();
      checkMutationResult(result, 'Delete job tag');
      toast('success', `Tag "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'JobTagsManager.confirmDelete' } });
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="Edit Job" accent="Tags" size="large">
        <div className="space-y-5">
          {/* Existing tags */}
          <div>
            <h3 className="text-sm font-semibold text-nav-dark mb-2">Tags</h3>
            {tags.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center border border-dashed border-gray-200 rounded-lg">
                No tags yet. Add your first tag below.
              </p>
            ) : (
              <div className="space-y-2">
                {tags.map((tag) => {
                  const e = editFor(tag);
                  const dirty = e.name.trim() !== tag.name || e.color !== tag.color;
                  return (
                    <div key={tag.id} className="flex items-center gap-3 p-2.5 border border-gray-200 rounded-lg">
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: e.color }}
                        aria-hidden="true"
                      />
                      <input
                        type="text"
                        value={e.name}
                        onChange={(ev) => setEdit(tag.id, { name: ev.target.value })}
                        aria-label={`Tag name for ${tag.name}`}
                        className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                      />
                      <ColorPicker value={e.color} onChange={(hex) => setEdit(tag.id, { color: hex })} />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Save className="w-4 h-4" />}
                        onClick={() => saveTag(tag)}
                        disabled={!dirty || !e.name.trim()}
                        loading={savingId === tag.id}
                        showChevron={false}
                      >
                        Save
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="w-4 h-4" />}
                        onClick={() => setDeleteTarget(tag)}
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

          {/* Add new tag */}
          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-nav-dark mb-2 flex items-center gap-1.5">
              <TagIcon className="w-4 h-4 text-crx-green" />
              Add a tag
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="text"
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onKeyDown={(ev) => ev.key === 'Enter' && createTag()}
                placeholder="Tag name (e.g. Fungicide)"
                aria-label="New tag name"
                className="flex-1 min-w-[12rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <ColorPicker value={newColor} onChange={setNewColor} />
              <Button
                icon={<Plus className="w-4 h-4" />}
                onClick={createTag}
                disabled={!newName.trim()}
                loading={creating}
                showChevron={false}
              >
                Add Tag
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
        title="Delete tag?"
        message={deleteTarget ? `"${deleteTarget.name}" will be removed from the catalog and from every job that carries it. This cannot be undone.` : ''}
        confirmLabel="Delete tag"
        variant="danger"
        loading={deleting}
      />
    </>
  );
}
