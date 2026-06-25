// Field-app parity #17 — pure helpers for as-applied entry records.
//
// These are intentionally side-effect-free so they can be unit-tested without
// the DB or React. The component (AppliedRecordsManager) handles I/O; the
// rules here decide the default vehicle, validate an entry, and build the
// persisted patch.

import type { JobAppliedRecord, JobAppliedRecordRow } from '../../types';

export interface AppliedRecordDraft {
  applicator_id: string;
  vehicle_id: string;
  application_date: string; // 'YYYY-MM-DD'
  applied_acres: string;
  notes: string;
}

export function emptyAppliedRecordDraft(defaults?: Partial<AppliedRecordDraft>): AppliedRecordDraft {
  return {
    applicator_id: '',
    vehicle_id: '',
    application_date: '',
    applied_acres: '',
    notes: '',
    ...defaults,
  };
}

// Turn a persisted row back into an editable draft (string-valued for inputs).
export function draftFromRecord(rec: JobAppliedRecord): AppliedRecordDraft {
  return {
    applicator_id: rec.applicator_id ?? '',
    vehicle_id: rec.vehicle_id ?? '',
    application_date: rec.application_date ?? '',
    applied_acres: rec.applied_acres != null ? String(rec.applied_acres) : '',
    notes: rec.notes ?? '',
  };
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
// to a non-negative number (mirrors the DB CHECK).
export function validateAppliedRecord(draft: AppliedRecordDraft): AppliedRecordValidation {
  if (!draft.applicator_id) return { ok: false, error: 'Select an applicator.' };
  if (!draft.application_date) return { ok: false, error: 'Pick an application date.' };
  if (draft.applied_acres.trim() !== '') {
    const n = Number(draft.applied_acres);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'Applied acres must be a number of 0 or more.' };
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

// Build the exact object persisted to job_applied_records. Empty strings become
// null (so an un-picked vehicle / blank notes store as NULL, not ''). Assumes
// the draft already passed validateAppliedRecord.
export function buildAppliedRecordPatch(draft: AppliedRecordDraft): AppliedRecordPatch {
  const acres = draft.applied_acres.trim();
  return {
    applicator_id: draft.applicator_id,
    vehicle_id: draft.vehicle_id || null,
    application_date: draft.application_date,
    applied_acres: acres === '' ? null : Number(acres),
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
  };
}
