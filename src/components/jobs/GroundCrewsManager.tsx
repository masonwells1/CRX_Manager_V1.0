import { useState, useEffect, useCallback } from 'react';
import { Plus, Save, Trash2, Users, UserPlus } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import type { GroundCrew, GroundCrewMember } from '../../types';

interface GroundCrewsManagerProps {
  open: boolean;
  onClose: () => void;
  crews: GroundCrew[];
  /** Called after any create / edit / delete so the parent can refetch. */
  onChanged: () => void;
}

/**
 * Field-app parity #6: the Ground Crews manager. ChemMan surfaces Ground Crews
 * as a job-list filter and (later) on the applied-info record. This managed list
 * is what makes the Ground Crew filter exercisable: create / rename / deactivate
 * a crew, and add / remove its members (crew has-many members). Plain Supabase
 * mutations guarded by checkMutationResult — no money/lifecycle/actor write, so
 * no RPC (mirrors JobTagsManager).
 */
export default function GroundCrewsManager({ open, onClose, crews, onChanged }: GroundCrewsManagerProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroundCrew | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Members of the currently-expanded crew.
  const [expandedCrewId, setExpandedCrewId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroundCrewMember[]>([]);
  const [newMemberName, setNewMemberName] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);

  const editFor = (crew: GroundCrew) => edits[crew.id] ?? crew.name;

  const loadMembers = useCallback(async (crewId: string) => {
    const { data, error } = await supabase
      .from('ground_crew_members')
      .select('*')
      .eq('crew_id', crewId)
      .order('name');
    if (error) {
      Sentry.captureException(error, { extra: { context: 'GroundCrewsManager.loadMembers' } });
      return;
    }
    setMembers((data || []) as GroundCrewMember[]);
  }, []);

  useEffect(() => {
    if (expandedCrewId) loadMembers(expandedCrewId);
    else setMembers([]);
  }, [expandedCrewId, loadMembers]);

  const createCrew = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const result = await supabase
        .from('ground_crews')
        .insert({ name, created_by: profile?.id ?? null })
        .select();
      checkMutationResult(result, 'Create ground crew');
      toast('success', `Crew "${name}" created`);
      setNewName('');
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') toast('error', 'A crew with that name already exists');
      else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'GroundCrewsManager.createCrew' } });
        toast('error', sanitizeError(err));
      }
    }
    setCreating(false);
  };

  const saveCrew = async (crew: GroundCrew) => {
    const name = editFor(crew).trim();
    if (!name) {
      toast('error', 'Crew name cannot be empty');
      return;
    }
    if (name === crew.name) return;
    setSavingId(crew.id);
    try {
      const result = await supabase
        .from('ground_crews')
        .update({ name })
        .eq('id', crew.id)
        .select();
      checkMutationResult(result, 'Update ground crew');
      toast('success', 'Crew updated');
      setEdits((prev) => {
        const copy = { ...prev };
        delete copy[crew.id];
        return copy;
      });
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') toast('error', 'A crew with that name already exists');
      else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'GroundCrewsManager.saveCrew' } });
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
        .from('ground_crews')
        .delete()
        .eq('id', deleteTarget.id)
        .select();
      checkMutationResult(result, 'Delete ground crew');
      toast('success', `Crew "${deleteTarget.name}" deleted`);
      if (expandedCrewId === deleteTarget.id) setExpandedCrewId(null);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'GroundCrewsManager.confirmDelete' } });
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
  };

  const addMember = async () => {
    const name = newMemberName.trim();
    if (!name || !expandedCrewId) return;
    setMemberBusy(true);
    try {
      const result = await supabase
        .from('ground_crew_members')
        .insert({ crew_id: expandedCrewId, name })
        .select();
      checkMutationResult(result, 'Add crew member');
      setNewMemberName('');
      loadMembers(expandedCrewId);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'GroundCrewsManager.addMember' } });
      toast('error', sanitizeError(err));
    }
    setMemberBusy(false);
  };

  const removeMember = async (member: GroundCrewMember) => {
    setMemberBusy(true);
    try {
      const result = await supabase
        .from('ground_crew_members')
        .delete()
        .eq('id', member.id)
        .select();
      checkMutationResult(result, 'Remove crew member');
      if (expandedCrewId) loadMembers(expandedCrewId);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'GroundCrewsManager.removeMember' } });
      toast('error', sanitizeError(err));
    }
    setMemberBusy(false);
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="Ground" accent="Crews" size="large">
        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-nav-dark mb-2">Crews</h3>
            {crews.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center border border-dashed border-gray-200 rounded-lg">
                No crews yet. Add your first crew below.
              </p>
            ) : (
              <div className="space-y-2">
                {crews.map((crew) => {
                  const name = editFor(crew);
                  const dirty = name.trim() !== crew.name;
                  const isExpanded = expandedCrewId === crew.id;
                  return (
                    <div key={crew.id} className="border border-gray-200 rounded-lg">
                      <div className="flex items-center gap-3 p-2.5">
                        <input
                          type="text"
                          value={name}
                          onChange={(ev) => setEdits((prev) => ({ ...prev, [crew.id]: ev.target.value }))}
                          aria-label={`Crew name for ${crew.name}`}
                          className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Users className="w-4 h-4" />}
                          onClick={() => setExpandedCrewId(isExpanded ? null : crew.id)}
                          showChevron={false}
                        >
                          Members
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Save className="w-4 h-4" />}
                          onClick={() => saveCrew(crew)}
                          disabled={!dirty || !name.trim()}
                          loading={savingId === crew.id}
                          showChevron={false}
                        >
                          Save
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          icon={<Trash2 className="w-4 h-4" />}
                          onClick={() => setDeleteTarget(crew)}
                          showChevron={false}
                        >
                          Delete
                        </Button>
                      </div>
                      {isExpanded && (
                        <div className="border-t border-gray-100 p-2.5 space-y-2 bg-gray-50/50">
                          {members.length === 0 ? (
                            <p className="text-xs text-secondary text-center py-2">No members yet.</p>
                          ) : (
                            members.map((m) => (
                              <div key={m.id} className="flex items-center gap-2 text-sm">
                                <span className="flex-1 text-nav-dark">{m.name}</span>
                                <button
                                  type="button"
                                  onClick={() => removeMember(m)}
                                  disabled={memberBusy}
                                  className="text-secondary hover:text-red-600 disabled:opacity-50"
                                  aria-label={`Remove ${m.name}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))
                          )}
                          <div className="flex items-center gap-2 pt-1">
                            <input
                              type="text"
                              value={newMemberName}
                              onChange={(ev) => setNewMemberName(ev.target.value)}
                              onKeyDown={(ev) => ev.key === 'Enter' && addMember()}
                              placeholder="Member name"
                              aria-label="New member name"
                              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<UserPlus className="w-4 h-4" />}
                              onClick={addMember}
                              disabled={!newMemberName.trim() || memberBusy}
                              showChevron={false}
                            >
                              Add
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-nav-dark mb-2 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-crx-green" />
              Add a crew
            </h3>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="text"
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onKeyDown={(ev) => ev.key === 'Enter' && createCrew()}
                placeholder="Crew name (e.g. Ground Crew A)"
                aria-label="New crew name"
                className="flex-1 min-w-[12rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <Button
                icon={<Plus className="w-4 h-4" />}
                onClick={createCrew}
                disabled={!newName.trim()}
                loading={creating}
                showChevron={false}
              >
                Add Crew
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
        title="Delete crew?"
        message={deleteTarget ? `"${deleteTarget.name}" and its members will be removed. Jobs tagged with this crew keep their other data; their crew is cleared. This cannot be undone.` : ''}
        confirmLabel="Delete crew"
        variant="danger"
        loading={deleting}
      />
    </>
  );
}
