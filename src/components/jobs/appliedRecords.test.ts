import { describe, it, expect } from 'vitest';
import {
  defaultVehicleForApplicator,
  validateAppliedRecord,
  buildAppliedRecordPatch,
  buildAppliedFieldRows,
  sumDraftFieldAcres,
  sumRecordFieldAcres,
  effectiveRecordAcres,
  sumAppliedAcresAcrossRecords,
  computeRemainingAcres,
  draftFromRecord,
  emptyAppliedRecordDraft,
} from './appliedRecords';
import type { JobAppliedRecord, JobAppliedRecordField, JobAppliedRecordRow } from '../../types';

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

// Build a saved record with per-location child rows (#18).
function recWithFields(id: string, acresByField: Record<string, number>): JobAppliedRecordRow {
  const fields: JobAppliedRecordField[] = Object.entries(acresByField).map(([field_id, applied_acres], i) => ({
    id: `${id}-f${i}`,
    application_record_id: id,
    field_id,
    applied_acres,
    created_at: 'x',
    updated_at: 'y',
  }));
  return rec({ id, job_applied_record_fields: fields });
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
      applied_acres: '33.5', notes: 'n', fields: [],
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
      applied_acres: '', notes: '', fields: [],
    });
  });

  it('maps persisted per-location child rows into the draft fields', () => {
    const row = {
      id: 'r1', job_id: 'j1', applicator_id: 'a1', vehicle_id: 'v1',
      application_date: '2026-06-05', applied_acres: 60, notes: null,
      created_by: null, created_at: 'x', updated_at: 'y',
      job_applied_record_fields: [
        { field_id: 'f1', applied_acres: 40 },
        { field_id: 'f2', applied_acres: 20 },
      ],
    };
    expect(draftFromRecord(row).fields).toEqual([
      { field_id: 'f1', applied_acres: '40' },
      { field_id: 'f2', applied_acres: '20' },
    ]);
  });
});

// ── #18 per-location applied acres + remaining-acres tracking ───────────────

describe('#18 sumDraftFieldAcres', () => {
  it('sums per-location draft lines, ignoring blanks and non-numerics', () => {
    expect(sumDraftFieldAcres([
      { field_id: 'f1', applied_acres: '40' },
      { field_id: 'f2', applied_acres: '20' },
      { field_id: 'f3', applied_acres: '' },
      { field_id: 'f4', applied_acres: 'abc' },
    ])).toBe(60);
  });
  it('returns 0 for an empty list', () => {
    expect(sumDraftFieldAcres([])).toBe(0);
  });
});

describe('#18 sumRecordFieldAcres', () => {
  it("sums a saved record's child rows", () => {
    expect(sumRecordFieldAcres(recWithFields('r1', { f1: 40, f2: 20 }))).toBe(60);
  });
  it('is 0 when a record has no per-location rows', () => {
    expect(sumRecordFieldAcres(rec({ id: 'r1' }))).toBe(0);
  });
});

describe('#18 sumAppliedAcresAcrossRecords', () => {
  const records = [
    recWithFields('r1', { f1: 40, f2: 20 }), // 60
    recWithFields('r2', { f3: 30 }),         // 30
  ];
  it('sums every record across the job', () => {
    expect(sumAppliedAcresAcrossRecords(records)).toBe(90);
  });
  it('excludes the record being edited (no double-count)', () => {
    expect(sumAppliedAcresAcrossRecords(records, 'r1')).toBe(30);
  });
});

// MED 1 + MED 3: each record's EFFECTIVE acres must mirror the DB exactly —
// child-sum when per-location, the manual figure when there are no child rows —
// so manual-only #17 records are counted and a record whose last child is gone
// reads 0 (never a stale value), and the per-row cell can't contradict the total.
describe('#18 effectiveRecordAcres (manual fallback + last-child-zero)', () => {
  it("uses the child-row sum when a record has per-location rows", () => {
    expect(effectiveRecordAcres(recWithFields('r1', { f1: 40, f2: 20 }))).toBe(60);
  });
  it("falls back to the manual applied_acres for a #17-era record with no child rows", () => {
    expect(effectiveRecordAcres(rec({ id: 'm1', applied_acres: 30 }))).toBe(30);
  });
  it('reads 0 for a per-location record whose last child was removed (no stale value)', () => {
    // applied_acres still carries the old figure, but with zero child rows the
    // effective value is the (now-empty) child-sum = 0, matching the DB after the
    // last-child delete zeroes the record.
    expect(effectiveRecordAcres(recWithFields('r1', {}))).toBe(0);
  });
  it('reads 0 for a record with neither child rows nor a manual figure', () => {
    expect(effectiveRecordAcres(rec({ id: 'e1', applied_acres: null }))).toBe(0);
  });
});

// A mixed job: one #17-era manual-only record + one #18 per-location record. The
// job summary must sum BOTH (this is the exact MED-3 bug — manual records were
// previously ignored, so the summary read low on mixed jobs).
describe('#18 mixed job (manual-only + per-location) sums both', () => {
  it('counts the manual record AND the per-location child-sum in the job total', () => {
    const manual = rec({ id: 'man', applied_acres: 30 });          // #17-era, no children
    const perLoc = recWithFields('loc', { f1: 148.5, f2: 50 });    // 198.5
    const v = computeRemainingAcres(245.4, [manual, perLoc]);
    expect(v.applied).toBeCloseTo(228.5, 5);
    expect(v.remaining).toBeCloseTo(16.9, 5);
    expect(v.isOver).toBe(false);
  });

  it('deleting the last child of the per-location record zeroes it AND the job drops to the manual figure', () => {
    const manual = rec({ id: 'man', applied_acres: 30 });
    const perLocEmptied = recWithFields('loc', {}); // last child removed -> 0 effective
    const v = computeRemainingAcres(245.4, [manual, perLocEmptied]);
    expect(effectiveRecordAcres(perLocEmptied)).toBe(0);
    expect(v.applied).toBe(30);                  // only the manual record remains
    expect(v.remaining).toBeCloseTo(215.4, 5);
  });
});

// LOW: float false-positive over-application. Raw JS floats make {0.1,0.2} sum to
// 0.30000000000000004, which must NOT flag "over by 0.00 ac" against a 0.3 total.
describe('#18 computeRemainingAcres float-safe over check', () => {
  it('does NOT flag over-application for {0.1, 0.2} vs total 0.3', () => {
    const records = [recWithFields('r1', { f1: 0.1, f2: 0.2 })];
    const v = computeRemainingAcres(0.3, records);
    expect(v.isOver).toBe(false);
    expect(v.over).toBe(0);
  });
  it('still flags a genuine over-application beyond the epsilon', () => {
    const records = [recWithFields('r1', { f1: 0.1, f2: 0.25 })]; // 0.35 vs 0.3
    const v = computeRemainingAcres(0.3, records);
    expect(v.isOver).toBe(true);
    expect(v.over).toBeCloseTo(0.05, 5);
  });
});

describe('#18 buildAppliedFieldRows', () => {
  it('drops blank rows and coerces acres to numbers', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a', application_date: '2026-06-01',
      fields: [
        { field_id: 'f1', applied_acres: '40' },
        { field_id: '', applied_acres: '99' },   // no field -> dropped
        { field_id: 'f2', applied_acres: '' },    // no acres -> dropped
        { field_id: 'f3', applied_acres: '20.5' },
      ],
    });
    expect(buildAppliedFieldRows(draft)).toEqual([
      { field_id: 'f1', applied_acres: 40 },
      { field_id: 'f3', applied_acres: 20.5 },
    ]);
  });
});

describe('#18 buildAppliedRecordPatch derives applied_acres from locations', () => {
  it("uses the sum of per-location lines in per-location mode (manual input ignored)", () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a', application_date: '2026-06-01', applied_acres: '999',
      fields: [
        { field_id: 'f1', applied_acres: '40' },
        { field_id: 'f2', applied_acres: '20' },
      ],
    });
    expect(buildAppliedRecordPatch(draft, true).applied_acres).toBe(60);
  });
  it('sets applied_acres to 0 when per-location lines are all cleared (no stale value)', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a', application_date: '2026-06-01', applied_acres: '60', fields: [],
    });
    // per-location mode active but no locations -> 0, never the stale manual 60
    expect(buildAppliedRecordPatch(draft, true).applied_acres).toBe(0);
  });
  it('uses the manual figure when NOT in per-location mode (#17 fallback)', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a', application_date: '2026-06-01', applied_acres: '75',
    });
    expect(buildAppliedRecordPatch(draft).applied_acres).toBe(75);
    expect(buildAppliedRecordPatch(draft, false).applied_acres).toBe(75);
  });
});

describe('#18 validateAppliedRecord per-location rules', () => {
  const base = { applicator_id: 'a', application_date: '2026-06-01' };
  it('rejects a duplicate location in one entry', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({
      ...base,
      fields: [
        { field_id: 'f1', applied_acres: '10' },
        { field_id: 'f1', applied_acres: '5' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/once per entry/i);
  });
  it('rejects a location row with a field but no acres', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({
      ...base, fields: [{ field_id: 'f1', applied_acres: '' }],
    }));
    expect(r.ok).toBe(false);
  });
  it('rejects negative location acres', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({
      ...base, fields: [{ field_id: 'f1', applied_acres: '-3' }],
    }));
    expect(r.ok).toBe(false);
  });
  it('ignores an entirely blank row (field not yet picked)', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({
      ...base, fields: [{ field_id: '', applied_acres: '' }],
    }));
    expect(r.ok).toBe(true);
  });
  it('accepts valid per-location lines', () => {
    const r = validateAppliedRecord(emptyAppliedRecordDraft({
      ...base, fields: [{ field_id: 'f1', applied_acres: '40' }, { field_id: 'f2', applied_acres: '20' }],
    }));
    expect(r.ok).toBe(true);
  });
});

describe('#18 computeRemainingAcres (Total / Applied / Remaining)', () => {
  it('computes remaining = total - applied across saved records', () => {
    const records = [recWithFields('r1', { f1: 40, f2: 20 })]; // 60 applied
    const v = computeRemainingAcres(100, records);
    expect(v).toEqual({ total: 100, applied: 60, remaining: 40, over: 0, isOver: false });
  });

  it('drives remaining full -> partial -> zero across a multi-day split', () => {
    const r1 = recWithFields('r1', { f1: 148.5 }); // partial
    expect(computeRemainingAcres(245.4, [r1]).remaining).toBeCloseTo(96.9, 5);
    const r2 = recWithFields('r2', { f2: 96.9 });  // the rest
    expect(computeRemainingAcres(245.4, [r1, r2]).remaining).toBeCloseTo(0, 5);
  });

  it('clamps remaining at 0 and flags over-application', () => {
    const records = [recWithFields('r1', { f1: 80 }), recWithFields('r2', { f2: 50 })]; // 130 on a 100-ac job
    const v = computeRemainingAcres(100, records);
    expect(v.remaining).toBe(0);
    expect(v.applied).toBe(130);
    expect(v.over).toBe(30);
    expect(v.isOver).toBe(true);
  });

  it('previews a draft edit without double-counting the edited entry', () => {
    const records = [recWithFields('r1', { f1: 40, f2: 20 }), recWithFields('r2', { f3: 30 })]; // 90 saved
    // Editing r1 (currently 60) down to a draft of 10 -> applied becomes 30 + 10 = 40
    const v = computeRemainingAcres(100, records, { excludeId: 'r1', draftSum: 10 });
    expect(v.applied).toBe(40);
    expect(v.remaining).toBe(60);
  });
});
