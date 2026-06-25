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
import { Plus, Pencil, Trash2, Truck, User, CalendarDays, MapPin, AlertTriangle, X } from 'lucide-react';
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
  buildAppliedFieldRows,
  sumDraftFieldAcres,
  effectiveRecordAcres,
  computeRemainingAcres,
  type AppliedRecordDraft,
} from './appliedRecords';

// The job's planned locations, passed from JobDetail (field_id + name + the
// planned acres_to_treat). Drives the per-location picker and the "X of Y
// remaining" counter. acres is the planned figure for that field.
export interface AppliedJobField {
  field_id: string;
  field_name: string;
  acres: number;
}

interface Props {
  jobId: string;
  applicators: Profile[];
  vehicles: Vehicle[];
  jobVehicleId: string | null;
  // #18: the job's planned locations + total planned acres, for per-location
  // applied-acres capture and the live remaining-acres counter.
  jobFields: AppliedJobField[];
  totalAcres: number;
  canEdit: boolean;
  performedBy: string | null;
}


// NOTE: do NOT embed `applicator:profiles!...` here. The `profiles` SELECT RLS
// is `is_admin() OR id = auth.uid()`, so that embed returns NULL for every
// non-admin viewer — a sales_rep (a primary audience) would then see EVERY
// entry as "(removed applicator)". Applicator names are resolved from the
// `applicators` prop instead (sourced from `profile_public_view`, which IS
// readable by sales_rep). The vehicle embed is kept and read directly so a
// valid-but-inactive vehicle (not in the active `vehicles` prop) still shows
// its name on the row.
// Pull the per-location child rows along with each entry (job_applied_record_fields)
// so the list shows each entry's own acres total and the remaining-acres math has
// everything it needs without a second round-trip. Kept as a single string literal
// so PostgREST can statically type the embedded result.
const RECORD_SELECT =
  '*, vehicle:vehicles!job_applied_records_vehicle_id_fkey(vehicle_name, vehicle_type), job_applied_record_fields(id, application_record_id, field_id, applied_acres, created_at, updated_at)';

export default function AppliedRecordsManager({
  jobId,
  applicators,
  vehicles,
  jobVehicleId,
  jobFields,
  totalAcres,
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

  // Resolve the applicator name from the `applicators` prop (sourced from
  // profile_public_view, readable by sales_rep) — NOT from a profiles embed,
  // which RLS would null out for non-admins.
  const applicatorLabel = useMemo(() => {
    const map = new Map(applicators.map((a) => [a.id, a.full_name]));
    return (id: string | null) => (id ? map.get(id) ?? '(removed applicator)' : '—');
  }, [applicators]);

  // Resolve the vehicle name. The active `vehicles` prop is filtered to
  // status='active', so a vehicle later set inactive/maintenance (both valid)
  // wouldn't be in it — fall back to the record's own joined vehicle row so a
  // valid-but-inactive vehicle still shows its name instead of "(removed)".
  const vehicleLabel = useMemo(() => {
    const map = new Map(vehicles.map((v) => [v.id, v.vehicle_name]));
    return (rec: JobAppliedRecordRow) => {
      if (!rec.vehicle_id) return '—';
      return map.get(rec.vehicle_id) ?? rec.vehicle?.vehicle_name ?? '(removed vehicle)';
    };
  }, [vehicles]);

  // Resolve a field name from the job's planned locations. A field later removed
  // from the job still shows a name if it's in jobFields; otherwise "(field)".
  const fieldName = useMemo(() => {
    const map = new Map(jobFields.map((f) => [f.field_id, f.field_name]));
    return (id: string) => map.get(id) ?? '(field)';
  }, [jobFields]);

  // Job-level Total / Applied / Remaining across every SAVED entry (this is what
  // the DB trigger writes to jobs.applied_acres -> jobs.remaining_acres).
  const jobSummary = useMemo(
    () => computeRemainingAcres(totalAcres, records),
    [totalAcres, records],
  );

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
    // Per-location mode is active whenever the job has planned locations (the UI
    // then captures per-field acres instead of a single manual figure). In that
    // mode the record's applied_acres is the field sum (0 when cleared), so it
    // never drifts from the DB trigger's roll-up.
    const perLocationMode = jobFields.length > 0;
    const patch = buildAppliedRecordPatch(draft, perLocationMode);
    const fieldRows = buildAppliedFieldRows(draft);
    try {
      let recordId = editingId;
      if (editingId) {
        const result = await supabase
          .from('job_applied_records')
          .update(patch)
          .eq('id', editingId)
          .select('id');
        checkMutationResult(result, 'Update applied-info record');
      } else {
        const result = await supabase
          .from('job_applied_records')
          .insert({ ...patch, job_id: jobId, created_by: performedBy })
          .select('id');
        checkMutationResult(result, 'Add applied-info record');
        recordId = (result.data?.[0] as { id: string } | undefined)?.id ?? null;
      }

      // #18: replace the entry's per-location detail. Delete-then-insert keeps
      // the set authoritative (handles added/removed/edited rows in one path).
      // The DB trigger then recomputes the entry's applied_acres roll-up and the
      // job's applied_acres -> remaining_acres from the resulting child rows.
      if (recordId) {
        // Clear any existing per-location rows first. NOTE: a fresh record (add
        // path) or an entry that had no locations matches ZERO rows, which is
        // legitimate — so only surface a real error here, not a 0-rows-affected
        // "denial" (checkMutationResult treats [] as denied, which would wrongly
        // abort every first save). RLS still protects the delete via the parent.
        const del = await supabase
          .from('job_applied_record_fields')
          .delete()
          .eq('application_record_id', recordId);
        if (del.error) throw del.error;
        if (fieldRows.length > 0) {
          const ins = await supabase
            .from('job_applied_record_fields')
            .insert(fieldRows.map((f) => ({ ...f, application_record_id: recordId })))
            .select();
          checkMutationResult(ins, 'Add applied-info locations');
        }
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

  // The active `applicators` / `vehicles` props are filtered to active-only,
  // so editing a record whose applicator/vehicle was later deactivated would
  // leave its <select> with NO matching <option> — touching the field would
  // then silently null the original value on save. Inject the record's current
  // value as an extra option (kept selected) when it isn't in the active list.
  const editingRecord = editingId ? records.find((r) => r.id === editingId) ?? null : null;

  const applicatorOptions = useMemo(() => {
    const opts = applicators.map((a) => ({ id: a.id, label: a.full_name }));
    const current = draft.applicator_id;
    if (current && !opts.some((o) => o.id === current)) {
      opts.unshift({ id: current, label: '(deactivated applicator)' });
    }
    return opts;
  }, [applicators, draft.applicator_id]);

  const vehicleOptions = useMemo(() => {
    const opts = vehicles.map((v) => ({ id: v.id, label: `${v.vehicle_name} (${v.vehicle_type})` }));
    const current = draft.vehicle_id;
    if (current && !opts.some((o) => o.id === current)) {
      const name = editingRecord?.vehicle?.vehicle_name ?? null;
      opts.unshift({ id: current, label: name ? `${name} (inactive)` : '(inactive vehicle)' });
    }
    return opts;
  }, [vehicles, draft.vehicle_id, editingRecord]);

  // ── #18 per-location draft handlers ──────────────────────────────────────
  function addFieldRow() {
    setDraft((d) => ({ ...d, fields: [...d.fields, { field_id: '', applied_acres: '' }] }));
  }
  function updateFieldRow(idx: number, key: 'field_id' | 'applied_acres', value: string) {
    setDraft((d) => {
      const next = d.fields.map((f, i) => (i === idx ? { ...f, [key]: value } : f));
      return { ...d, fields: next };
    });
  }
  function removeFieldRow(idx: number) {
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== idx) }));
  }
  // Pre-fill a per-location row's acres with that field's PLANNED acres when the
  // user picks a field and hasn't typed an acres value yet (the common "applied
  // the whole field" case). They can still override it.
  function onFieldPicked(idx: number, fieldId: string) {
    setDraft((d) => {
      const planned = jobFields.find((f) => f.field_id === fieldId);
      const next = d.fields.map((f, i) => {
        if (i !== idx) return f;
        const acres = f.applied_acres.trim() === '' && planned ? String(planned.acres) : f.applied_acres;
        return { field_id: fieldId, applied_acres: acres };
      });
      return { ...d, fields: next };
    });
  }

  // Live "X of Y remaining" preview while editing: replace the entry being
  // edited (excludeId) with the current draft's per-location sum so the counter
  // reflects what saving WOULD make the job total, without double-counting.
  const draftFieldSum = sumDraftFieldAcres(draft.fields);
  const livePreview = useMemo(
    () => computeRemainingAcres(totalAcres, records, { excludeId: editingId, draftSum: draftFieldSum }),
    [totalAcres, records, editingId, draftFieldSum],
  );

  // Locations not yet on this entry (so the picker doesn't offer a duplicate).
  function availableFieldsFor(currentFieldId: string) {
    const chosen = new Set(draft.fields.map((f) => f.field_id).filter((id) => id && id !== currentFieldId));
    return jobFields.filter((f) => !chosen.has(f.field_id));
  }

  return (
    <div>
      {/* #18 job-level acres summary: Total planned vs Applied (sum of every
          entry's per-location acres) vs Remaining. Mirrors jobs.applied_acres /
          jobs.remaining_acres. Over-application is flagged, never silently hidden. */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-gray-200 px-3 py-2">
          <p className="text-xs text-secondary">Total Acres</p>
          <p className="text-lg font-semibold text-nav-dark tabular-nums">
            {jobSummary.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 px-3 py-2">
          <p className="text-xs text-secondary">Applied Acres</p>
          <p className="text-lg font-semibold text-nav-dark tabular-nums">
            {jobSummary.applied.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${jobSummary.isOver ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
          <p className="text-xs text-secondary">Remaining Acres</p>
          <p className={`text-lg font-semibold tabular-nums ${jobSummary.isOver ? 'text-amber-700' : 'text-crx-green'}`}>
            {jobSummary.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>
      {jobSummary.isOver && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            Over-applied by {jobSummary.over.toLocaleString(undefined, { maximumFractionDigits: 2 })} ac
            &mdash; applied acres ({jobSummary.applied.toLocaleString(undefined, { maximumFractionDigits: 2 })})
            exceed the planned total ({jobSummary.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}).
            Check the per-location entries.
          </span>
        </div>
      )}

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
              {records.map((rec) => {
                const locs = rec.job_applied_record_fields ?? [];
                // Effective acres = child-sum when per-location, else the manual
                // figure — the SAME rule the job summary and the DB use, so this
                // cell can never contradict the Applied/Remaining totals above.
                const recAcres = effectiveRecordAcres(rec);
                const hasManual = locs.length === 0 && rec.applied_acres != null;
                return (
                <tr key={rec.id} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{rec.application_date}</td>
                  <td className="px-3 py-2">{applicatorLabel(rec.applicator_id)}</td>
                  <td className="px-3 py-2">{vehicleLabel(rec)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {locs.length > 0 ? (
                      <div>
                        <span className="font-medium">{recAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                        <ul className="mt-1 text-xs text-secondary text-left">
                          {locs.map((l) => (
                            <li key={l.id} className="flex items-center gap-1 justify-end">
                              <MapPin className="w-3 h-3" />
                              <span>{fieldName(l.field_id)}:</span>
                              <span className="tabular-nums">{l.applied_acres.toLocaleString(undefined, { maximumFractionDigits: 2 })} ac</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : hasManual ? (
                      <span className="font-medium">{recAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    ) : (
                      '—'
                    )}
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
                );
              })}
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
              {applicatorOptions.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
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
              {vehicleOptions.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
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

          {/* #18 per-location applied acres. When the job has planned locations,
              record which fields this pass covered and how many acres on each.
              The entry's applied total is the sum of these lines; the DB trigger
              rolls every entry's sum into the job's applied/remaining acres. */}
          {jobFields.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-nav-dark">
                  <MapPin className="w-3.5 h-3.5 inline mr-1" />Applied Acres by Location
                </label>
                <Button type="button" size="sm" variant="secondary" onClick={addFieldRow}>
                  <Plus className="w-3.5 h-3.5" /> Add Location
                </Button>
              </div>

              {draft.fields.length === 0 ? (
                <p className="text-xs text-secondary py-1">
                  Add a location to record how many acres of each field this pass covered.
                </p>
              ) : (
                <div className="space-y-2">
                  {draft.fields.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={row.field_id}
                        onChange={(e) => onFieldPicked(idx, e.target.value)}
                        aria-label={`Location ${idx + 1}`}
                        className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                      >
                        <option value="">Select location...</option>
                        {availableFieldsFor(row.field_id).map((f) => (
                          <option key={f.field_id} value={f.field_id}>
                            {f.field_name} ({f.acres.toLocaleString(undefined, { maximumFractionDigits: 2 })} ac planned)
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={row.applied_acres}
                        onChange={(e) => updateFieldRow(idx, 'applied_acres', e.target.value)}
                        aria-label={`Applied acres for location ${idx + 1}`}
                        placeholder="Acres"
                        className="w-28 px-3 py-2 text-sm border border-gray-200 rounded-lg text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                      />
                      <button
                        type="button"
                        onClick={() => removeFieldRow(idx)}
                        aria-label={`Remove location ${idx + 1}`}
                        className="p-1.5 text-secondary hover:text-red-600 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Live "X of Y remaining" counter — previews what saving this entry
                  would make the job total. Over-application is flagged here too. */}
              <div className={`mt-2 flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${livePreview.isOver ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-200 text-secondary'}`}>
                <span>
                  This entry: <span className="font-medium tabular-nums">{draftFieldSum.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> ac
                </span>
                <span className="flex items-center gap-1">
                  {livePreview.isOver && <AlertTriangle className="w-4 h-4" />}
                  Remaining after save:{' '}
                  <span className="font-semibold tabular-nums">
                    {livePreview.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>{' '}
                  of {livePreview.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  {livePreview.isOver && (
                    <span className="ml-1">(over by {livePreview.over.toLocaleString(undefined, { maximumFractionDigits: 2 })})</span>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <Input
              label="Applied Acres (optional)"
              type="number"
              min="0"
              step="0.1"
              value={draft.applied_acres}
              onChange={(e) => setDraft({ ...draft, applied_acres: e.target.value })}
              placeholder="Acres covered in this pass"
            />
          )}

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
