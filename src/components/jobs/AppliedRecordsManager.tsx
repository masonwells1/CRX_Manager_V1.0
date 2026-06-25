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
import { Plus, Pencil, Trash2, Truck, User, CalendarDays, MapPin, AlertTriangle, X, CloudSun, Clock, Wind, Thermometer, Droplets, Gauge, Users, Filter } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { fetchWeatherForDateTime } from '../../lib/weatherCapture';
import GroundCrewsManager from './GroundCrewsManager';
import type { Profile, Vehicle, JobAppliedRecordRow, GroundCrew, GroundCrewMember } from '../../types';
import {
  emptyAppliedRecordDraft,
  draftFromRecord,
  defaultVehicleForApplicator,
  validateAppliedRecord,
  buildAppliedRecordPatch,
  buildAppliedFieldRows,
  buildAppliedCrewRows,
  recordCrewNames,
  crewMemberDisplayName,
  recordHasCrewMember,
  sumDraftFieldAcres,
  effectiveRecordAcres,
  computeRemainingAcres,
  computeTotalMinutes,
  formatTotalTime,
  summarizeWeatherSet,
  computeNetTach,
  tachEndBelowBeginning,
  type AppliedRecordDraft,
  type WeatherSetDraft,
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
  // #19: the job's first field centroid (lat/lng), resolved by JobDetail via
  // get_field_geojson. Drives the "Get Weather" Open-Meteo auto-pull. Null when
  // the job has no mapped field — the button is then disabled and manual entry
  // is the only path (still fully supported).
  fieldCentroid: { lat: number; lng: number } | null;
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
// #21: embed the crew links AND the live catalog member (ground_crew_members has
// SELECT RLS `USING(true)`, so this embed is readable by every viewer — unlike a
// `profiles` embed). The live member name lets a renamed member show its current
// name; the row's own member_name_snapshot is the fallback once the member is
// deleted from the catalog (member_id -> NULL).
const RECORD_SELECT =
  '*, vehicle:vehicles!job_applied_records_vehicle_id_fkey(vehicle_name, vehicle_type), job_applied_record_fields(id, application_record_id, field_id, applied_acres, created_at, updated_at), job_applied_record_crew(id, application_record_id, member_id, member_name_snapshot, crew_id_snapshot, crew_name_snapshot, created_at, member:ground_crew_members(name, is_active))';

export default function AppliedRecordsManager({
  jobId,
  applicators,
  vehicles,
  jobVehicleId,
  jobFields,
  totalAcres,
  fieldCentroid,
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
  // #19: which weather set (if any) is currently auto-pulling, to show a spinner
  // on the right Get Weather button without blocking the other.
  const [fetchingWeather, setFetchingWeather] = useState<null | 'start' | 'end'>(null);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // #21: the ground-crew catalog (crews + all members) for the modal picker, the
  // "Manage Crews" sub-modal, and the member filter. Loaded once; refetched when
  // the manager edits the catalog.
  const [crews, setCrews] = useState<GroundCrew[]>([]);
  const [allMembers, setAllMembers] = useState<GroundCrewMember[]>([]);
  const [manageCrewsOpen, setManageCrewsOpen] = useState(false);
  // Filter the entry list to passes that included a given crew member (parity
  // with ChemMan's Ground Crew Member report filter). '' = no filter.
  const [memberFilter, setMemberFilter] = useState('');

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

  // #21: load the ground-crew catalog (crews + their members). Catalog SELECT RLS
  // is `USING(true)`, so any viewer can read it for the picker/filter. Members are
  // loaded for ALL crews so the filter dropdown and a saved entry's roster resolve
  // without a per-crew round-trip.
  const loadCrews = useCallback(async () => {
    const [crewRes, memberRes] = await Promise.all([
      supabase.from('ground_crews').select('*').order('name'),
      supabase.from('ground_crew_members').select('*').order('name'),
    ]);
    if (!crewRes.error) setCrews((crewRes.data as GroundCrew[]) ?? []);
    if (!memberRes.error) setAllMembers((memberRes.data as GroundCrewMember[]) ?? []);
    // Surface a catalog-load failure. If this is swallowed and the member fetch
    // failed, allMembers stays [] — and an edit-save would then resolve ZERO
    // crew rows and silently clear the entry's live crew. The save path also
    // guards against this (skips the crew mutation when the catalog is empty but
    // members are still selected), but the user needs to know the picker is stale.
    if (crewRes.error || memberRes.error) {
      toast('error', 'Failed to load the ground-crew catalog — crew edits are disabled until it reloads.');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCrews();
  }, [loadCrews]);

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
    // #21: resolve the selected crew members into link rows with name snapshots
    // (durable legal record) from the catalog at save time.
    const crewRows = buildAppliedCrewRows(draft, allMembers, crews);
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

        // #21: replace the entry's ground-crew member links. Same delete-then-
        // insert pattern as the per-location rows, with TWO critical guards:
        //
        // 1) LEGAL-RECORD PRESERVATION: only delete rows that still point at a
        //    LIVE catalog member (member_id IS NOT NULL). A member later deleted
        //    from the catalog leaves a row with member_id -> NULL (FK ON DELETE
        //    SET NULL) but a kept member_name_snapshot — that is the durable proof
        //    of "who was on the crew that day" (regulatory). An UNCONDITIONAL
        //    delete here would wipe those NULL-member legal rows on ANY edit-save.
        //    The re-insert only adds live members, and the UNIQUE constraint
        //    (application_record_id, member_id) is NULLS DISTINCT, so live rows
        //    never collide with the preserved NULL rows.
        //
        // 2) CATALOG-FETCH-FAILURE GUARD: if loadCrews failed (allMembers stays
        //    []), buildAppliedCrewRows resolves ZERO rows even though the user has
        //    members selected — clearing the entry's live crew with no real intent.
        //    Skip the whole crew mutation in that case (catalog empty AND members
        //    selected). The legitimate "user removed all members" case has the
        //    catalog loaded (allMembers non-empty), so it still clears live rows.
        const catalogUnavailable = allMembers.length === 0 && draft.member_ids.length > 0;
        if (catalogUnavailable) {
          toast('error', 'Ground-crew catalog unavailable — crew left unchanged for this entry.');
        } else {
          const delCrew = await supabase
            .from('job_applied_record_crew')
            .delete()
            .eq('application_record_id', recordId)
            .not('member_id', 'is', null);
          if (delCrew.error) throw delCrew.error;
          if (crewRows.length > 0) {
            const insCrew = await supabase
              .from('job_applied_record_crew')
              .insert(crewRows.map((c) => ({ ...c, application_record_id: recordId })))
              .select();
            checkMutationResult(insCrew, 'Add applied-info crew');
          }
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

  // ── #21 ground-crew picker + filter derived data ─────────────────────────
  const activeCrews = useMemo(() => {
    // Active crews, plus the draft's chosen crew if it was since deactivated (so
    // editing an entry on an old crew never silently drops the crew on save).
    const opts = crews.filter((c) => c.is_active);
    if (draft.crew_id && !opts.some((c) => c.id === draft.crew_id)) {
      const cur = crews.find((c) => c.id === draft.crew_id);
      if (cur) opts.unshift(cur);
    }
    return opts;
  }, [crews, draft.crew_id]);

  // Members offered in the picker for the draft's selected crew. Active members
  // of that crew, plus any already-selected member that was since deactivated
  // (kept checked so an edit doesn't silently drop them).
  const crewMemberOptions = useMemo(() => {
    if (!draft.crew_id) return [] as GroundCrewMember[];
    const inCrew = allMembers.filter((m) => m.crew_id === draft.crew_id);
    const active = inCrew.filter((m) => m.is_active);
    const selectedInactive = inCrew.filter(
      (m) => !m.is_active && draft.member_ids.includes(m.id),
    );
    return [...active, ...selectedInactive];
  }, [allMembers, draft.crew_id, draft.member_ids]);

  function toggleMember(memberId: string) {
    setDraft((d) => {
      const has = d.member_ids.includes(memberId);
      return {
        ...d,
        member_ids: has ? d.member_ids.filter((id) => id !== memberId) : [...d.member_ids, memberId],
      };
    });
  }

  // When the crew changes, drop any selected members that no longer belong to it.
  function onCrewChange(crewId: string) {
    setDraft((d) => {
      const keep = new Set(allMembers.filter((m) => m.crew_id === crewId).map((m) => m.id));
      return { ...d, crew_id: crewId, member_ids: d.member_ids.filter((id) => keep.has(id)) };
    });
  }

  // Member-filter dropdown options: members that actually appear on at least one
  // saved entry of THIS job (resolved by live member_id), so the filter only
  // offers members the tester can actually narrow by. Labelled with crew name.
  const filterableMembers = useMemo(() => {
    const present = new Map<string, string>(); // member_id -> "Name (Crew)"
    for (const rec of records) {
      for (const link of rec.job_applied_record_crew ?? []) {
        if (!link.member_id) continue; // deleted member — not selectable
        const name = link.member?.name ?? link.member_name_snapshot;
        const crew = link.crew_name_snapshot ? ` (${link.crew_name_snapshot})` : '';
        present.set(link.member_id, `${name}${crew}`);
      }
    }
    return [...present.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [records]);

  // Apply the member filter (pure predicate; '' = no filter -> all records).
  const visibleRecords = useMemo(
    () => records.filter((r) => recordHasCrewMember(r, memberFilter)),
    [records, memberFilter],
  );

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

  // ── #19 weather pair handlers ────────────────────────────────────────────
  // Edit one field of a weather set. Any manual edit flips source -> 'manual' so
  // the badge reflects that the crew corrected the value (legal record integrity).
  function updateWeather(set: 'start' | 'end', key: keyof WeatherSetDraft, value: string) {
    setDraft((d) => {
      const cur = set === 'start' ? d.startWeather : d.endWeather;
      const next: WeatherSetDraft = { ...cur, [key]: value, source: 'manual' };
      return set === 'start' ? { ...d, startWeather: next } : { ...d, endWeather: next };
    });
  }

  // NOW button: stamp the current local clock time (HH:MM) into a set's time.
  function stampNow(set: 'start' | 'end') {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    updateWeather(set, 'time', hhmm);
  }

  // Get Weather: auto-pull from Open-Meteo for the application date + the set's
  // time (falls back to a midday reading when the time is blank) at the field
  // centroid. On success the five values fill and source -> 'auto'; on failure
  // (offline / no data / no coordinates) the user gets a clear message and can
  // still type the readings manually — auto-pull failure never blocks saving.
  async function getWeather(set: 'start' | 'end') {
    if (!fieldCentroid) {
      toast('error', 'No mapped field location for this job — enter weather manually.');
      return;
    }
    if (!draft.application_date) {
      toast('error', 'Pick an application date first, then Get Weather.');
      return;
    }
    const cur = set === 'start' ? draft.startWeather : draft.endWeather;
    setFetchingWeather(set);
    const w = await fetchWeatherForDateTime(fieldCentroid.lat, fieldCentroid.lng, draft.application_date, cur.time || null);
    setFetchingWeather(null);
    if (!w) {
      toast('error', 'Could not fetch weather — enter conditions manually.');
      return;
    }
    setDraft((d) => {
      const prev = set === 'start' ? d.startWeather : d.endWeather;
      const filled: WeatherSetDraft = {
        ...prev,
        temp_f: String(w.temperature_f),
        wind_direction: w.wind_direction,
        wind_mph: String(w.wind_speed_mph),
        humidity_pct: String(w.humidity_pct),
        source: 'auto',
      };
      return set === 'start' ? { ...d, startWeather: filled } : { ...d, endWeather: filled };
    });
    toast('success', 'Weather filled from Open-Meteo — adjust if needed.');
  }

  // Total Time = end - start (whole minutes), shown in the modal once both times
  // are set. Pure helper so the display can never disagree with what's persisted.
  const totalMinutes = computeTotalMinutes(draft.startWeather.time, draft.endWeather.time);

  // #20 tach: live Net = End - Beginning (mirrors the GENERATED net_tach column),
  // and an end<beginning warning so the user sees a friendly flag before save
  // rather than a raw DB CHECK error.
  const netTach = computeNetTach(draft.beginningTach, draft.endTach);
  const tachEndLow = tachEndBelowBeginning(draft.beginningTach, draft.endTach);

  // Render one weather set (START or END): Time + NOW, Get Weather, then Temp /
  // Wind Dir / Wind mph / Humidity — all editable. A badge shows whether the set
  // was last auto-pulled or hand-entered.
  function renderWeatherSet(set: 'start' | 'end', label: string) {
    const w = set === 'start' ? draft.startWeather : draft.endWeather;
    const busy = fetchingWeather === set;
    return (
      <div className="rounded-lg border border-gray-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-nav-dark">{label} Weather</span>
            {w.source === 'auto' && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green">Auto</span>
            )}
            {w.source === 'manual' && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-secondary">Manual</span>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => getWeather(set)}
            loading={busy}
            disabled={!fieldCentroid || fetchingWeather !== null}
            title={fieldCentroid ? 'Auto-fill from Open-Meteo' : 'No mapped field location for this job'}
          >
            <CloudSun className="w-3.5 h-3.5" /> Get Weather
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-secondary mb-1">
              <Clock className="w-3 h-3 inline mr-1" />Time
            </label>
            <div className="flex items-center gap-1">
              <input
                type="time"
                value={w.time}
                onChange={(e) => updateWeather(set, 'time', e.target.value)}
                aria-label={`${label} weather time`}
                className="flex-1 px-2 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <Button type="button" size="sm" variant="secondary" onClick={() => stampNow(set)} title="Stamp the current time">
                Now
              </Button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">
              <Thermometer className="w-3 h-3 inline mr-1" />Temp (&deg;F)
            </label>
            <input
              type="number"
              step="1"
              value={w.temp_f}
              onChange={(e) => updateWeather(set, 'temp_f', e.target.value)}
              aria-label={`${label} temperature`}
              placeholder="degrees F"
              className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">
              <Wind className="w-3 h-3 inline mr-1" />Wind Dir
            </label>
            <input
              type="text"
              value={w.wind_direction}
              onChange={(e) => updateWeather(set, 'wind_direction', e.target.value)}
              aria-label={`${label} wind direction`}
              placeholder="e.g. NNW"
              className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">
              <Wind className="w-3 h-3 inline mr-1" />Wind (mph)
            </label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={w.wind_mph}
              onChange={(e) => updateWeather(set, 'wind_mph', e.target.value)}
              aria-label={`${label} wind speed`}
              placeholder="mph"
              className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs text-secondary mb-1">
              <Droplets className="w-3 h-3 inline mr-1" />Humidity (%)
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              value={w.humidity_pct}
              onChange={(e) => updateWeather(set, 'humidity_pct', e.target.value)}
              aria-label={`${label} humidity`}
              placeholder="%"
              className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
        </div>
      </div>
    );
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

      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-nav-dark">As-Applied Entries</h3>
          <p className="text-xs text-secondary">
            Who applied, with what vehicle, and on what date. Add one entry per pass / day.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* #21 Ground Crew Member filter — parity with ChemMan's report filter.
              Only offers members that appear on this job's saved entries. */}
          {filterableMembers.length > 0 && (
            <div className="flex items-center gap-1">
              <Filter className="w-3.5 h-3.5 text-secondary" />
              <select
                value={memberFilter}
                onChange={(e) => setMemberFilter(e.target.value)}
                aria-label="Filter by crew member"
                className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All crew members</option>
                {filterableMembers.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setManageCrewsOpen(true)}>
              <Users className="w-4 h-4" /> Manage Crews
            </Button>
          )}
          {canEdit && (
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4" /> Add Applied Info
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-secondary py-3">Loading applied-info entries...</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-secondary py-3">
          No applied-info entries yet.{canEdit ? ' Use "Add Applied Info" to record the first pass.' : ''}
        </p>
      ) : visibleRecords.length === 0 ? (
        <p className="text-sm text-secondary py-3">
          No entries match the selected crew member.{' '}
          <button type="button" onClick={() => setMemberFilter('')} className="text-crx-green hover:underline">
            Clear filter
          </button>
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
                <th className="text-left font-medium px-3 py-2">
                  <CloudSun className="w-3.5 h-3.5 inline mr-1" />Weather (Start / End)
                </th>
                <th className="text-right font-medium px-3 py-2">
                  <Gauge className="w-3.5 h-3.5 inline mr-1" />Tach (Beg / End / Net)
                </th>
                <th className="text-left font-medium px-3 py-2">
                  <Users className="w-3.5 h-3.5 inline mr-1" />Ground Crew
                </th>
                <th className="text-left font-medium px-3 py-2">Notes</th>
                {canEdit && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {visibleRecords.map((rec) => {
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
                  <td className="px-3 py-2 text-xs text-secondary whitespace-nowrap">
                    {(() => {
                      const startSummary = summarizeWeatherSet({
                        time: rec.start_weather_time,
                        temp_f: rec.start_temp_f,
                        wind_direction: rec.start_wind_direction,
                        wind_mph: rec.start_wind_mph,
                        humidity_pct: rec.start_humidity_pct,
                      });
                      const endSummary = summarizeWeatherSet({
                        time: rec.end_weather_time,
                        temp_f: rec.end_temp_f,
                        wind_direction: rec.end_wind_direction,
                        wind_mph: rec.end_wind_mph,
                        humidity_pct: rec.end_humidity_pct,
                      });
                      const totalMin = computeTotalMinutes(
                        rec.start_weather_time ?? '',
                        rec.end_weather_time ?? '',
                      );
                      if (!startSummary && !endSummary) return '—';
                      return (
                        <div className="space-y-0.5">
                          {startSummary && (
                            <div><span className="font-medium text-nav-dark">Start</span> {startSummary}</div>
                          )}
                          {endSummary && (
                            <div><span className="font-medium text-nav-dark">End</span> {endSummary}</div>
                          )}
                          {totalMin != null && (
                            <div className="text-[11px]">Total Time: {formatTotalTime(totalMin)}</div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap tabular-nums">
                    {rec.beginning_tach == null && rec.end_tach == null ? (
                      '—'
                    ) : (
                      <div className="space-y-0.5 text-secondary">
                        {rec.beginning_tach != null && (
                          <div>Beg {rec.beginning_tach.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                        )}
                        {rec.end_tach != null && (
                          <div>End {rec.end_tach.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                        )}
                        {rec.net_tach != null && (
                          <div className="font-medium text-nav-dark">Net {rec.net_tach.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {(() => {
                      const links = rec.job_applied_record_crew ?? [];
                      if (links.length === 0) return <span className="text-secondary">—</span>;
                      const crewNames = recordCrewNames(rec);
                      return (
                        <div className="space-y-0.5">
                          {crewNames.length > 0 && (
                            <div className="font-medium text-nav-dark">{crewNames.join(', ')}</div>
                          )}
                          <ul className="text-secondary">
                            {links.map((link) => (
                              <li key={link.id} className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                <span>{crewMemberDisplayName(link)}</span>
                                {!link.member_id && (
                                  <span className="text-[10px] text-gray-400">(removed)</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
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

          {/* #19 START + END weather pair (the spray window). Each set has Time
              (+ NOW), Temp, Wind Direction, Wind mph, Humidity, all editable. The
              Get Weather button auto-pulls from free Open-Meteo by application
              date + field location. Total Time = end - start. Weather is a legal
              compliance record; a failed/wrong pull can always be hand-corrected. */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-nav-dark">
                <CloudSun className="w-3.5 h-3.5 inline mr-1" />Weather (Start &amp; End)
              </label>
              {totalMinutes != null && (
                <span className="text-xs text-secondary">
                  Total Time: <span className="font-semibold text-nav-dark tabular-nums">{formatTotalTime(totalMinutes)}</span>
                </span>
              )}
            </div>
            {!fieldCentroid && (
              <p className="text-xs text-amber-700 mb-2">
                This job has no mapped field location, so Get Weather is unavailable — enter conditions manually.
              </p>
            )}
            <div className="space-y-2">
              {renderWeatherSet('start', 'Start')}
              {renderWeatherSet('end', 'End')}
            </div>
          </div>

          {/* #20 tach (engine-hour meter) hours. Beginning + End are optional
              numeric readings; Net = End - Beginning is computed (read-only) and
              shown live. An end below the beginning is flagged as a likely typo
              before save (the DB also rejects it). */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-nav-dark">
                <Gauge className="w-3.5 h-3.5 inline mr-1" />Tach Hours (engine hours)
              </label>
              <span className="text-xs text-secondary">
                Net: <span className="font-semibold text-nav-dark tabular-nums">
                  {netTach != null ? netTach.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                </span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-secondary mb-1">Beginning Tach</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.beginningTach}
                  onChange={(e) => setDraft({ ...draft, beginningTach: e.target.value })}
                  aria-label="Beginning tach"
                  placeholder="e.g. 1200.0"
                  className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">End Tach</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.endTach}
                  onChange={(e) => setDraft({ ...draft, endTach: e.target.value })}
                  aria-label="End tach"
                  placeholder="e.g. 1206.5"
                  className="w-full px-2 py-2 text-sm border border-gray-200 rounded-lg text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs text-secondary mb-1">Net Tach</label>
                <div
                  aria-label="Net tach"
                  className="w-full px-2 py-2 text-sm border border-gray-100 bg-gray-50 rounded-lg text-right tabular-nums text-nav-dark"
                >
                  {netTach != null ? netTach.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                </div>
              </div>
            </div>
            <p className="text-xs text-secondary mt-1">
              Optional. Net is End &minus; Beginning (computed). Leave blank if not tracking engine hours.
            </p>
            {tachEndLow && (
              <div className="mt-1 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>End tach is lower than beginning tach &mdash; this is usually a typo. Check the readings before saving.</span>
              </div>
            )}
          </div>

          {/* #21 ground crew + members on this pass. Pick a crew, then check the
              members who were present (zero, one, or many). Members reference the
              managed catalog (renamed crew/member updates everywhere); a member
              later removed from the catalog still shows on this saved record via a
              name snapshot. Use "Manage Crews" to add a crew/member if missing. */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-nav-dark">
                <Users className="w-3.5 h-3.5 inline mr-1" />Ground Crew
              </label>
              <Button type="button" size="sm" variant="secondary" onClick={() => setManageCrewsOpen(true)}>
                Manage Crews
              </Button>
            </div>
            <select
              value={draft.crew_id}
              onChange={(e) => onCrewChange(e.target.value)}
              aria-label="Ground crew"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">No ground crew</option>
              {activeCrews.map((c) => (
                <option key={c.id} value={c.id}>{c.is_active ? c.name : `${c.name} (inactive)`}</option>
              ))}
            </select>

            {draft.crew_id && (
              crewMemberOptions.length === 0 ? (
                <p className="text-xs text-secondary mt-2">
                  This crew has no members yet. Use &ldquo;Manage Crews&rdquo; to add some.
                </p>
              ) : (
                <div className="mt-2">
                  <p className="text-xs text-secondary mb-1">Members present on this pass:</p>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto rounded-lg border border-gray-200 p-2">
                    {crewMemberOptions.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.member_ids.includes(m.id)}
                          onChange={() => toggleMember(m.id)}
                          aria-label={`Member ${m.name}`}
                          className="rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
                        />
                        <span className="text-nav-dark">{m.name}</span>
                        {!m.is_active && <span className="text-[10px] text-gray-400">(inactive)</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>

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

      {/* #21: reuse the #6 ground-crew catalog manager (create/rename/deactivate
          crews + add/remove members). On any change, refetch the catalog AND the
          records (a renamed member resolves live on saved entries via the embed). */}
      <GroundCrewsManager
        open={manageCrewsOpen}
        onClose={() => setManageCrewsOpen(false)}
        crews={crews}
        onChanged={() => { void loadCrews(); void load(); }}
      />
    </div>
  );
}
