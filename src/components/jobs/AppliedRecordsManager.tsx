// Field-app parity #17 — Applied Info tab manager.
//
// Renders the list of as-applied entry records for a job and lets a user add /
// edit / delete each one independently. Each entry captures Applicator (real
// profile reference), Vehicle (real vehicle reference, auto-defaults from the
// chosen applicator's last machine, editable), and Application Date. A job can
// have MANY of these (several passes, days, applicators).
//
// This is the Phase-2 foundation. #18/#19/#20/#21 extend each record off its id:
//   - #18 per-location applied acres -> a child table keyed on record id;
//          drives applied_acres -> jobs.applied_acres -> remaining_acres.
//   - #19 start/end weather pair, #20 tach hours -> new columns/child on record.
//   - #21 ground crew -> a record_id -> ground_crew_members link.
// When adding those, render their fields inside the add/edit modal below and
// extend AppliedRecordDraft/buildAppliedRecordPatch in appliedRecords.ts.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Truck, User, CalendarDays } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import type { Profile, Vehicle, JobAppliedRecordRow } from '../../types';
import {
  emptyAppliedRecordDraft,
  draftFromRecord,
  defaultVehicleForApplicator,
  validateAppliedRecord,
  buildAppliedRecordPatch,
  type AppliedRecordDraft,
} from './appliedRecords';

interface Props {
  jobId: string;
  applicators: Profile[];
  vehicles: Vehicle[];
  jobVehicleId: string | null;
  canEdit: boolean;
  performedBy: string | null;
}

const RECORD_SELECT =
  '*, applicator:profiles!job_applied_records_applicator_id_fkey(full_name), vehicle:vehicles!job_applied_records_vehicle_id_fkey(vehicle_name, vehicle_type)';

export default function AppliedRecordsManager({
  jobId,
  applicators,
  vehicles,
  jobVehicleId,
  canEdit,
  performedBy,
}: Props) {
  const { toast } = useToast();
  const [records, setRecords] = useState<JobAppliedRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AppliedRecordDraft>(emptyAppliedRecordDraft());

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const vehicleLabel = useMemo(() => {
    const map = new Map(vehicles.map((v) => [v.id, v.vehicle_name]));
    return (id: string | null) => (id ? map.get(id) ?? '(removed vehicle)' : '—');
  }, [vehicles]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('job_applied_records')
      .select(RECORD_SELECT)
      .eq('job_id', jobId)
      .order('application_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) {
      toast('error', 'Failed to load applied-info records.');
      setLoading(false);
      return;
    }
    setRecords((data as JobAppliedRecordRow[]) ?? []);
    setLoading(false);
  }, [jobId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setEditingId(null);
    setDraft(emptyAppliedRecordDraft());
    setModalOpen(true);
  }

  function openEdit(rec: JobAppliedRecordRow) {
    setEditingId(rec.id);
    setDraft(draftFromRecord(rec));
    setModalOpen(true);
  }

  // When the applicator changes, default the vehicle to that applicator's last
  // machine (editable). Only auto-fill when the vehicle field is empty so we
  // never stomp an explicit choice the user already made on this entry.
  function onApplicatorChange(applicatorId: string) {
    setDraft((d) => {
      const next = { ...d, applicator_id: applicatorId };
      if (!d.vehicle_id) {
        next.vehicle_id = defaultVehicleForApplicator(applicatorId, records, jobVehicleId);
      }
      return next;
    });
  }

  async function handleSave() {
    const check = validateAppliedRecord(draft);
    if (!check.ok) {
      toast('error', check.error ?? 'Fix the entry before saving.');
      return;
    }
    setSaving(true);
    const patch = buildAppliedRecordPatch(draft);
    try {
      if (editingId) {
        const result = await supabase
          .from('job_applied_records')
          .update(patch)
          .eq('id', editingId)
          .select(RECORD_SELECT);
        checkMutationResult(result, 'Update applied-info record');
      } else {
        const result = await supabase
          .from('job_applied_records')
          .insert({ ...patch, job_id: jobId, created_by: performedBy })
          .select(RECORD_SELECT);
        checkMutationResult(result, 'Add applied-info record');
      }
      if (performedBy) {
        logActivity({
          event: editingId ? 'job_applied_record_updated' : 'job_applied_record_added',
          description: `Applied-info entry ${editingId ? 'updated' : 'added'} for job`,
          performedBy,
          entityType: 'job',
          entityId: jobId,
        });
      }
      setModalOpen(false);
      await load();
      toast('success', editingId ? 'Applied-info entry updated.' : 'Applied-info entry added.');
    } catch {
      toast('error', 'Could not save the applied-info entry.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const result = await supabase.from('job_applied_records').delete().eq('id', deleteId).select();
      checkMutationResult(result, 'Delete applied-info record');
      if (performedBy) {
        logActivity({
          event: 'job_applied_record_deleted',
          description: 'Applied-info entry removed from job',
          performedBy,
          entityType: 'job',
          entityId: jobId,
        });
      }
      setDeleteId(null);
      await load();
      toast('success', 'Applied-info entry removed.');
    } catch {
      toast('error', 'Could not remove the applied-info entry.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-nav-dark">As-Applied Entries</h3>
          <p className="text-xs text-secondary">
            Who applied, with what vehicle, and on what date. Add one entry per pass / day.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={openAdd}>
            <Plus className="w-4 h-4" /> Add Applied Info
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-secondary py-3">Loading applied-info entries...</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-secondary py-3">
          No applied-info entries yet.{canEdit ? ' Use "Add Applied Info" to record the first pass.' : ''}
        </p>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-secondary">
              <tr>
                <th className="text-left font-medium px-3 py-2">
                  <CalendarDays className="w-3.5 h-3.5 inline mr-1" />Date
                </th>
                <th className="text-left font-medium px-3 py-2">
                  <User className="w-3.5 h-3.5 inline mr-1" />Applicator
                </th>
                <th className="text-left font-medium px-3 py-2">
                  <Truck className="w-3.5 h-3.5 inline mr-1" />Vehicle
                </th>
                <th className="text-right font-medium px-3 py-2">Applied Acres</th>
                <th className="text-left font-medium px-3 py-2">Notes</th>
                {canEdit && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => (
                <tr key={rec.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 whitespace-nowrap">{rec.application_date}</td>
                  <td className="px-3 py-2">{rec.applicator?.full_name ?? '(removed applicator)'}</td>
                  <td className="px-3 py-2">{vehicleLabel(rec.vehicle_id)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {rec.applied_acres != null ? rec.applied_acres : '—'}
                  </td>
                  <td className="px-3 py-2 text-secondary">{rec.notes ?? ''}</td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(rec)}
                          aria-label="Edit entry"
                          className="p-1.5 text-secondary hover:text-crx-green rounded"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteId(rec.id)}
                          aria-label="Delete entry"
                          className="p-1.5 text-secondary hover:text-red-600 rounded"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? 'Edit Applied Info' : 'Add Applied Info'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Applicator <span className="text-red-500">*</span>
            </label>
            <select
              value={draft.applicator_id}
              onChange={(e) => onApplicatorChange(e.target.value)}
              aria-label="Applicator"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select applicator...</option>
              {applicators.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Vehicle</label>
            <select
              value={draft.vehicle_id}
              onChange={(e) => setDraft({ ...draft, vehicle_id: e.target.value })}
              aria-label="Vehicle"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select vehicle...</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.vehicle_name} ({v.vehicle_type})
                </option>
              ))}
            </select>
            <p className="text-xs text-secondary mt-1">
              Defaults from the applicator&apos;s last machine when picked &mdash; change it for this pass.
            </p>
          </div>

          <Input
            label="Application Date"
            type="date"
            required
            value={draft.application_date}
            onChange={(e) => setDraft({ ...draft, application_date: e.target.value })}
          />

          <Input
            label="Applied Acres (optional)"
            type="number"
            min="0"
            step="0.1"
            value={draft.applied_acres}
            onChange={(e) => setDraft({ ...draft, applied_acres: e.target.value })}
            placeholder="Acres covered in this pass"
          />

          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
              placeholder="Optional notes about this pass..."
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>
              {editingId ? 'Save Entry' : 'Add Entry'}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Remove applied-info entry?"
        message="This permanently removes this as-applied entry from the job."
        confirmLabel="Remove"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
