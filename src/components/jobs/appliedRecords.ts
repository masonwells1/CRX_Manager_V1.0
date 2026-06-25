// Field-app parity #17 — pure helpers for as-applied entry records.
//
// These are intentionally side-effect-free so they can be unit-tested without
// the DB or React. The component (AppliedRecordsManager) handles I/O; the
// rules here decide the default vehicle, validate an entry, and build the
// persisted patch.

import type { JobAppliedRecord, JobAppliedRecordRow } from '../../types';

// Field-app parity #18: a per-location line inside an as-applied entry draft —
// which field was sprayed in this pass and how many acres on it. String-valued
// (form inputs). The persisted child table is job_applied_record_fields.
export interface AppliedFieldDraft {
  field_id: string;
  applied_acres: string;
}

export interface AppliedRecordDraft {
  applicator_id: string;
  vehicle_id: string;
  application_date: string; // 'YYYY-MM-DD'
  applied_acres: string;
  notes: string;
  // #18: per-location applied acres. When any line is present, the record's
  // applied_acres total is DERIVED from these (the manual applied_acres input is
  // hidden in favour of this detail). Empty list = no per-location detail.
  fields: AppliedFieldDraft[];
}

export function emptyAppliedRecordDraft(defaults?: Partial<AppliedRecordDraft>): AppliedRecordDraft {
  return {
    applicator_id: '',
    vehicle_id: '',
    application_date: '',
    applied_acres: '',
    notes: '',
    fields: [],
    ...defaults,
  };
}

// Turn a persisted row back into an editable draft (string-valued for inputs).
export function draftFromRecord(rec: JobAppliedRecord & { job_applied_record_fields?: { field_id: string; applied_acres: number }[] }): AppliedRecordDraft {
  return {
    applicator_id: rec.applicator_id ?? '',
    vehicle_id: rec.vehicle_id ?? '',
    application_date: rec.application_date ?? '',
    applied_acres: rec.applied_acres != null ? String(rec.applied_acres) : '',
    notes: rec.notes ?? '',
    fields: (rec.job_applied_record_fields ?? []).map((f) => ({
      field_id: f.field_id,
      applied_acres: f.applied_acres != null ? String(f.applied_acres) : '',
    })),
  };
}

// ── #18 per-location applied-acres math (pure, DB-free, unit-tested) ─────────

// Sum the per-location lines of a single entry draft (blank/invalid -> 0). This
// is the entry's own applied-acres total when per-location detail is present.
export function sumDraftFieldAcres(fields: AppliedFieldDraft[]): number {
  return fields.reduce((sum, f) => {
    const n = Number(f.applied_acres);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

// Sum the persisted per-location rows of an already-saved entry.
export function sumRecordFieldAcres(rec: JobAppliedRecordRow): number {
  return (rec.job_applied_record_fields ?? []).reduce(
    (sum, f) => sum + (Number.isFinite(f.applied_acres) ? f.applied_acres : 0),
    0,
  );
}

// The job's total APPLIED acres across every saved entry's per-location rows.
// This mirrors what the DB trigger writes to jobs.applied_acres. `excludeId`
// drops the entry currently being edited so the live counter can preview the
// new total = (others) + (this draft's current sum) without double-counting.
export function sumAppliedAcresAcrossRecords(
  records: JobAppliedRecordRow[],
  excludeId?: string | null,
): number {
  return records
    .filter((r) => !excludeId || r.id !== excludeId)
    .reduce((sum, r) => sum + sumRecordFieldAcres(r), 0);
}

export interface RemainingAcresView {
  total: number; // planned (jobs.total_acres)
  applied: number; // sum of every entry's per-location acres
  remaining: number; // GREATEST(total - applied, 0) — mirrors the GENERATED col
  over: number; // how far applied exceeds total (0 when within plan)
  isOver: boolean; // applied > total -> show the over-application warning
}

// Compute the Total / Applied / Remaining view for a job, optionally previewing
// an in-progress edit (excludeId + draftSum replaces that entry's saved acres).
// remaining clamps at 0 to mirror the GENERATED jobs.remaining_acres column; the
// `over` amount is surfaced separately so the UI can warn without the column
// going negative.
export function computeRemainingAcres(
  totalAcres: number,
  records: JobAppliedRecordRow[],
  opts?: { excludeId?: string | null; draftSum?: number },
): RemainingAcresView {
  const others = sumAppliedAcresAcrossRecords(records, opts?.excludeId);
  const applied = others + (opts?.draftSum ?? 0);
  const total = Number.isFinite(totalAcres) ? totalAcres : 0;
  const remaining = Math.max(total - applied, 0);
  const over = applied > total ? applied - total : 0;
  return { total, applied, remaining, over, isOver: over > 0 };
}

// "Vehicle defaults from the chosen applicator/vehicle but is editable":
// when an applicator is picked, default the vehicle to the one that applicator
// most recently used (its newest prior record), so a repeat applicator gets
// their usual machine pre-filled. Falls back to the job's vehicle_id. Returns
// '' when there is nothing to default to. Newest is decided by application_date
// then created_at (string-comparable ISO/date values).
export function defaultVehicleForApplicator(
  applicatorId: string,
  existingRecords: JobAppliedRecordRow[],
  jobVehicleId: string | null | undefined,
): string {
  if (!applicatorId) return '';
  const prior = existingRecords
    .filter((r) => r.applicator_id === applicatorId && r.vehicle_id)
    .sort((a, b) => {
      const byDate = (b.application_date ?? '').localeCompare(a.application_date ?? '');
      if (byDate !== 0) return byDate;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  if (prior.length > 0 && prior[0].vehicle_id) return prior[0].vehicle_id;
  return jobVehicleId ?? '';
}

export interface AppliedRecordValidation {
  ok: boolean;
  error?: string;
}

// An applied record is the legal proof of who sprayed, with what, on what day.
// The non-negotiable fields are Applicator and Application Date (a record with
// neither is not usable). Vehicle is recommended but not strictly required (a
// hand-applied pass may have no machine). applied_acres, if entered, must parse
// to a non-negative number (mirrors the DB CHECK). #18: each per-location line,
// if a field is picked, must carry a non-negative acres value, and a field can
// only appear once per entry (the DB has UNIQUE(record, field)).
export function validateAppliedRecord(draft: AppliedRecordDraft): AppliedRecordValidation {
  if (!draft.applicator_id) return { ok: false, error: 'Select an applicator.' };
  if (!draft.application_date) return { ok: false, error: 'Pick an application date.' };
  if (draft.applied_acres.trim() !== '') {
    const n = Number(draft.applied_acres);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Applied acres must be a number of 0 or more.' };
    }
  }
  const seen = new Set<string>();
  for (const f of draft.fields) {
    if (!f.field_id) continue; // a blank row a user hasn't filled in yet is dropped on save
    if (seen.has(f.field_id)) {
      return { ok: false, error: 'Each location can only be listed once per entry.' };
    }
    seen.add(f.field_id);
    if (f.applied_acres.trim() === '') {
      return { ok: false, error: 'Enter applied acres for each location, or remove the row.' };
    }
    const n = Number(f.applied_acres);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Location applied acres must be a number of 0 or more.' };
    }
  }
  return { ok: true };
}

export interface AppliedRecordPatch {
  applicator_id: string;
  vehicle_id: string | null;
  application_date: string;
  applied_acres: number | null;
  notes: string | null;
}

// The persisted per-location child rows for an entry (job_applied_record_fields,
// minus the application_record_id which the caller stamps after the parent saves).
export interface AppliedFieldRow {
  field_id: string;
  applied_acres: number;
}

// Build the exact object persisted to job_applied_records. Empty strings become
// null (so an un-picked vehicle / blank notes store as NULL, not ''). Assumes
// the draft already passed validateAppliedRecord.
//
// applied_acres resolution (#18):
//   - perLocationMode = true (the job has planned locations, so the UI captures
//     per-location acres): the record's applied_acres ALWAYS equals the sum of
//     its per-location lines — including 0 when every line was removed. This
//     keeps the per-entry display in lock-step with what the DB trigger rolls
//     into the job total (no stale "60" left on a record whose locations were
//     all cleared). The DB trigger also recomputes it, so the two agree.
//   - perLocationMode = false (a job with no planned locations, the #17-style
//     fallback): the manual applied_acres input is used as-is.
export function buildAppliedRecordPatch(
  draft: AppliedRecordDraft,
  perLocationMode = false,
): AppliedRecordPatch {
  const manual = draft.applied_acres.trim();
  const applied = perLocationMode
    ? sumDraftFieldAcres(draft.fields)
    : (manual === '' ? null : Number(manual));
  return {
    applicator_id: draft.applicator_id,
    vehicle_id: draft.vehicle_id || null,
    application_date: draft.application_date,
    applied_acres: applied,
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
  };
}

// Extract the per-location child rows to persist (dropping blank rows). Assumes
// the draft already passed validateAppliedRecord (so no dup fields / bad acres).
export function buildAppliedFieldRows(draft: AppliedRecordDraft): AppliedFieldRow[] {
  return draft.fields
    .filter((f) => f.field_id && f.applied_acres.trim() !== '')
    .map((f) => ({ field_id: f.field_id, applied_acres: Number(f.applied_acres) }));
}
