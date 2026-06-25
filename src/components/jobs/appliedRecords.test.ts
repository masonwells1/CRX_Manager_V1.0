import { describe, it, expect } from 'vitest';
import {
  defaultVehicleForApplicator,
  validateAppliedRecord,
  buildAppliedRecordPatch,
  draftFromRecord,
  emptyAppliedRecordDraft,
} from './appliedRecords';
import type { JobAppliedRecord, JobAppliedRecordRow } from '../../types';

function rec(over: Partial<JobAppliedRecordRow>): JobAppliedRecordRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    job_id: 'job-1',
    applicator_id: over.applicator_id ?? null,
    vehicle_id: over.vehicle_id ?? null,
    application_date: over.application_date ?? '2026-06-01',
    applied_acres: over.applied_acres ?? null,
    notes: over.notes ?? null,
    created_by: null,
    created_at: over.created_at ?? '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

describe('defaultVehicleForApplicator', () => {
  it('returns empty when no applicator chosen', () => {
    expect(defaultVehicleForApplicator('', [], 'job-veh')).toBe('');
  });

  it("falls back to the job's vehicle when the applicator has no prior record", () => {
    expect(defaultVehicleForApplicator('app-1', [], 'job-veh')).toBe('job-veh');
  });

  it("falls back to '' when there is no job vehicle either", () => {
    expect(defaultVehicleForApplicator('app-1', [], null)).toBe('');
    expect(defaultVehicleForApplicator('app-1', [], undefined)).toBe('');
  });

  it("uses the applicator's MOST RECENT prior vehicle, not another applicator's", () => {
    const records: JobAppliedRecordRow[] = [
      rec({ applicator_id: 'app-1', vehicle_id: 'veh-old', application_date: '2026-05-01' }),
      rec({ applicator_id: 'app-1', vehicle_id: 'veh-new', application_date: '2026-06-10' }),
      rec({ applicator_id: 'app-2', vehicle_id: 'veh-other', application_date: '2026-06-20' }),
    ];
    expect(defaultVehicleForApplicator('app-1', records, 'job-veh')).toBe('veh-new');
  });

  it('breaks a same-date tie by created_at (newest wins)', () => {
    const records: JobAppliedRecordRow[] = [
      rec({ applicator_id: 'app-1', vehicle_id: 'veh-a', application_date: '2026-06-10', created_at: '2026-06-10T08:00:00Z' }),
      rec({ applicator_id: 'app-1', vehicle_id: 'veh-b', application_date: '2026-06-10', created_at: '2026-06-10T12:00:00Z' }),
    ];
    expect(defaultVehicleForApplicator('app-1', records, null)).toBe('veh-b');
  });

  it('ignores prior records that have no vehicle', () => {
    const records: JobAppliedRecordRow[] = [
      rec({ applicator_id: 'app-1', vehicle_id: null, application_date: '2026-06-20' }),
    ];
    expect(defaultVehicleForApplicator('app-1', records, 'job-veh')).toBe('job-veh');
  });
});

describe('validateAppliedRecord', () => {
  it('requires an applicator', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({ application_date: '2026-06-01' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/applicator/i);
  });

  it('requires an application date', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({ applicator_id: 'app-1' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/date/i);
  });

  it('rejects negative or non-numeric applied acres', () => {
    expect(validateAppliedRecord(emptyAppliedRecordDraft({ applicator_id: 'a', application_date: '2026-06-01', applied_acres: '-5' })).ok).toBe(false);
    expect(validateAppliedRecord(emptyAppliedRecordDraft({ applicator_id: 'a', application_date: '2026-06-01', applied_acres: 'abc' })).ok).toBe(false);
  });

  it('accepts a valid entry (acres optional)', () => {
    expect(validateAppliedRecord(emptyAppliedRecordDraft({ applicator_id: 'a', application_date: '2026-06-01' })).ok).toBe(true);
    expect(validateAppliedRecord(emptyAppliedRecordDraft({ applicator_id: 'a', application_date: '2026-06-01', applied_acres: '12.5' })).ok).toBe(true);
  });
});

describe('buildAppliedRecordPatch', () => {
  it('nulls empty vehicle / acres / notes', () => {
    const patch = buildAppliedRecordPatch(emptyAppliedRecordDraft({ applicator_id: 'a', application_date: '2026-06-01' }));
    expect(patch).toEqual({
      applicator_id: 'a',
      vehicle_id: null,
      application_date: '2026-06-01',
      applied_acres: null,
      notes: null,
    });
  });

  it('coerces acres to a number and trims notes', () => {
    const patch = buildAppliedRecordPatch(emptyAppliedRecordDraft({
      applicator_id: 'a', vehicle_id: 'v', application_date: '2026-06-01', applied_acres: '40', notes: '  pass 1  ',
    }));
    expect(patch.applied_acres).toBe(40);
    expect(patch.notes).toBe('pass 1');
    expect(patch.vehicle_id).toBe('v');
  });
});

describe('draftFromRecord round-trip', () => {
  it('maps a persisted row back to string-valued inputs', () => {
    const row: JobAppliedRecord = {
      id: 'r1', job_id: 'j1', applicator_id: 'a1', vehicle_id: 'v1',
      application_date: '2026-06-05', applied_acres: 33.5, notes: 'n',
      created_by: null, created_at: 'x', updated_at: 'y',
    };
    expect(draftFromRecord(row)).toEqual({
      applicator_id: 'a1', vehicle_id: 'v1', application_date: '2026-06-05',
      applied_acres: '33.5', notes: 'n',
    });
  });

  it('handles null record fields', () => {
    const row: JobAppliedRecord = {
      id: 'r1', job_id: 'j1', applicator_id: null, vehicle_id: null,
      application_date: '2026-06-05', applied_acres: null, notes: null,
      created_by: null, created_at: 'x', updated_at: 'y',
    };
    expect(draftFromRecord(row)).toEqual({
      applicator_id: '', vehicle_id: '', application_date: '2026-06-05',
      applied_acres: '', notes: '',
    });
  });
});
