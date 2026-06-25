import { describe, it, expect } from 'vitest';
import {
  defaultVehicleForApplicator,
  validateAppliedRecord,
  buildAppliedRecordPatch,
  buildAppliedFieldRows,
  buildWeatherSetPatch,
  computeTotalMinutes,
  formatTotalTime,
  weatherSetHasData,
  summarizeWeatherSet,
  computeNetTach,
  tachEndBelowBeginning,
  timeForInput,
  emptyWeatherSetDraft,
  sumDraftFieldAcres,
  sumRecordFieldAcres,
  effectiveRecordAcres,
  sumAppliedAcresAcrossRecords,
  computeRemainingAcres,
  draftFromRecord,
  emptyAppliedRecordDraft,
  type WeatherSetDraft,
} from './appliedRecords';
import type { JobAppliedRecord, JobAppliedRecordField, JobAppliedRecordRow } from '../../types';

// Null-filled #19 weather columns, so test records satisfy the JobAppliedRecord
// shape without every case spelling them out (override via `over` as needed).
const NULL_WEATHER = {
  start_weather_time: null,
  start_temp_f: null,
  start_wind_direction: null,
  start_wind_mph: null,
  start_humidity_pct: null,
  start_weather_source: null,
  end_weather_time: null,
  end_temp_f: null,
  end_wind_direction: null,
  end_wind_mph: null,
  end_humidity_pct: null,
  end_weather_source: null,
} as const;

// Null-filled #20 tach columns, same purpose as NULL_WEATHER.
const NULL_TACH = {
  beginning_tach: null,
  end_tach: null,
  net_tach: null,
} as const;

function rec(over: Partial<JobAppliedRecordRow>): JobAppliedRecordRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    job_id: 'job-1',
    applicator_id: over.applicator_id ?? null,
    vehicle_id: over.vehicle_id ?? null,
    application_date: over.application_date ?? '2026-06-01',
    applied_acres: over.applied_acres ?? null,
    notes: over.notes ?? null,
    ...NULL_WEATHER,
    ...NULL_TACH,
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
      // #19: an empty draft persists every weather column as null (no source flag).
      start_weather_time: null, start_temp_f: null, start_wind_direction: null,
      start_wind_mph: null, start_humidity_pct: null, start_weather_source: null,
      end_weather_time: null, end_temp_f: null, end_wind_direction: null,
      end_wind_mph: null, end_humidity_pct: null, end_weather_source: null,
      // #20: an empty draft persists both tach readings as null.
      beginning_tach: null, end_tach: null,
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
      ...NULL_WEATHER,
      ...NULL_TACH,
      created_by: null, created_at: 'x', updated_at: 'y',
    };
    expect(draftFromRecord(row)).toEqual({
      applicator_id: 'a1', vehicle_id: 'v1', application_date: '2026-06-05',
      applied_acres: '33.5', notes: 'n', fields: [],
      startWeather: emptyWeatherSetDraft(), endWeather: emptyWeatherSetDraft(),
      beginningTach: '', endTach: '',
    });
  });

  it('handles null record fields', () => {
    const row: JobAppliedRecord = {
      id: 'r1', job_id: 'j1', applicator_id: null, vehicle_id: null,
      application_date: '2026-06-05', applied_acres: null, notes: null,
      ...NULL_WEATHER,
      ...NULL_TACH,
      created_by: null, created_at: 'x', updated_at: 'y',
    };
    expect(draftFromRecord(row)).toEqual({
      applicator_id: '', vehicle_id: '', application_date: '2026-06-05',
      applied_acres: '', notes: '', fields: [],
      startWeather: emptyWeatherSetDraft(), endWeather: emptyWeatherSetDraft(),
      beginningTach: '', endTach: '',
    });
  });

  it('maps persisted per-location child rows into the draft fields', () => {
    const row = {
      id: 'r1', job_id: 'j1', applicator_id: 'a1', vehicle_id: 'v1',
      application_date: '2026-06-05', applied_acres: 60, notes: null,
      ...NULL_WEATHER,
      ...NULL_TACH,
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

// ── #19 START + END weather pair ─────────────────────────────────────────────

function wset(over: Partial<WeatherSetDraft>): WeatherSetDraft {
  return { ...emptyWeatherSetDraft(), ...over };
}

describe('computeTotalMinutes / formatTotalTime', () => {
  it('computes end - start in whole minutes', () => {
    expect(computeTotalMinutes('08:00', '10:15')).toBe(135);
    expect(computeTotalMinutes('08:00', '08:45')).toBe(45);
  });

  it('handles a window that crosses midnight', () => {
    expect(computeTotalMinutes('23:00', '01:00')).toBe(120);
  });

  it('returns null when either time is missing or invalid', () => {
    expect(computeTotalMinutes('', '10:00')).toBeNull();
    expect(computeTotalMinutes('08:00', '')).toBeNull();
    expect(computeTotalMinutes('99:99', '10:00')).toBeNull();
  });

  it('accepts HH:MM:SS (DB time format)', () => {
    expect(computeTotalMinutes('08:00:00', '09:30:00')).toBe(90);
  });

  it('formats minutes as Hh Mm', () => {
    expect(formatTotalTime(135)).toBe('2h 15m');
    expect(formatTotalTime(45)).toBe('45m');
    expect(formatTotalTime(120)).toBe('2h');
    expect(formatTotalTime(null)).toBe('—');
  });
});

describe('timeForInput', () => {
  it('trims seconds from a DB time, leaves HH:MM, handles null', () => {
    expect(timeForInput('08:30:00')).toBe('08:30');
    expect(timeForInput('08:30')).toBe('08:30');
    expect(timeForInput(null)).toBe('');
    expect(timeForInput(undefined)).toBe('');
  });
});

describe('weatherSetHasData', () => {
  it('is false for an empty set and true once any field is filled', () => {
    expect(weatherSetHasData(emptyWeatherSetDraft())).toBe(false);
    expect(weatherSetHasData(wset({ temp_f: '72' }))).toBe(true);
    expect(weatherSetHasData(wset({ wind_direction: 'NNW' }))).toBe(true);
  });
});

describe('buildWeatherSetPatch', () => {
  it('maps a filled set, coercing numbers and keeping an explicit auto source', () => {
    const p = buildWeatherSetPatch(
      wset({ time: '08:30', temp_f: '72', wind_direction: 'NNW', wind_mph: '8.3', humidity_pct: '54', source: 'auto' }),
    );
    expect(p).toEqual({
      time: '08:30',
      temp_f: 72,
      wind_direction: 'NNW',
      wind_mph: 8.3,
      humidity_pct: 54,
      source: 'auto',
    });
  });

  it('nulls every column and source for a fully-empty set', () => {
    const p = buildWeatherSetPatch(emptyWeatherSetDraft());
    expect(p).toEqual({
      time: null, temp_f: null, wind_direction: null, wind_mph: null, humidity_pct: null, source: null,
    });
  });

  it('defaults a hand-entered set (no explicit flag) to manual', () => {
    const p = buildWeatherSetPatch(wset({ temp_f: '70' }));
    expect(p.source).toBe('manual');
  });
});

describe('validateAppliedRecord — weather bounds', () => {
  const base = emptyAppliedRecordDraft({ applicator_id: 'a1', application_date: '2026-06-01' });

  it('accepts valid weather and blank weather', () => {
    expect(validateAppliedRecord(base).ok).toBe(true);
    expect(
      validateAppliedRecord({ ...base, startWeather: wset({ temp_f: '72', wind_mph: '5', humidity_pct: '50' }) }).ok,
    ).toBe(true);
  });

  it('rejects negative wind speed', () => {
    const v = validateAppliedRecord({ ...base, startWeather: wset({ wind_mph: '-3' }) });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/wind speed/i);
  });

  it('rejects humidity outside 0–100', () => {
    expect(validateAppliedRecord({ ...base, endWeather: wset({ humidity_pct: '120' }) }).ok).toBe(false);
    expect(validateAppliedRecord({ ...base, endWeather: wset({ humidity_pct: '-1' }) }).ok).toBe(false);
  });

  it('rejects a non-numeric temperature', () => {
    expect(validateAppliedRecord({ ...base, startWeather: wset({ temp_f: 'hot' }) }).ok).toBe(false);
  });
});

describe('buildAppliedRecordPatch — weather columns', () => {
  it('flattens start + end weather into the persisted columns', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a1',
      application_date: '2026-06-01',
      startWeather: wset({ time: '08:00', temp_f: '68', wind_direction: 'N', wind_mph: '6', humidity_pct: '60', source: 'auto' }),
      endWeather: wset({ time: '10:00', temp_f: '74', wind_direction: 'NE', wind_mph: '9', humidity_pct: '48' }),
    });
    const p = buildAppliedRecordPatch(draft);
    expect(p.start_weather_time).toBe('08:00');
    expect(p.start_temp_f).toBe(68);
    expect(p.start_weather_source).toBe('auto');
    expect(p.end_temp_f).toBe(74);
    expect(p.end_weather_source).toBe('manual'); // hand-entered end set
  });
});

describe('summarizeWeatherSet', () => {
  it('joins the present parts into a compact line', () => {
    expect(summarizeWeatherSet({ time: '08:30:00', temp_f: 72, wind_direction: 'NNW', wind_mph: 8, humidity_pct: 54 }))
      .toBe('08:30 · 72°F · NNW 8mph · 54%');
  });

  it('omits missing parts and returns empty for a blank set', () => {
    expect(summarizeWeatherSet({ time: null, temp_f: 70, wind_direction: null, wind_mph: null, humidity_pct: null }))
      .toBe('70°F');
    expect(summarizeWeatherSet({ time: null, temp_f: null, wind_direction: null, wind_mph: null, humidity_pct: null }))
      .toBe('');
  });
});

describe('draftFromRecord — weather round-trip', () => {
  it('reads start/end weather columns back into the draft (trimming time seconds)', () => {
    const r = rec({
      start_weather_time: '08:30:00',
      start_temp_f: 70,
      start_wind_direction: 'SSW',
      start_wind_mph: 7,
      start_humidity_pct: 55,
      start_weather_source: 'auto',
      end_weather_time: '11:00:00',
      end_temp_f: 78,
    });
    const d = draftFromRecord(r);
    expect(d.startWeather).toEqual({
      time: '08:30', temp_f: '70', wind_direction: 'SSW', wind_mph: '7', humidity_pct: '55', source: 'auto',
    });
    expect(d.endWeather.time).toBe('11:00');
    expect(d.endWeather.temp_f).toBe('78');
  });
});

// ── #20 tach (engine-hour meter) hours ──────────────────────────────────────

describe('#20 computeNetTach', () => {
  it('computes Net = End - Beginning for the spec example (1200.0 / 1206.5 -> 6.5)', () => {
    expect(computeNetTach('1200.0', '1206.5')).toBe(6.5);
  });
  it('returns null when beginning is blank (partial entry)', () => {
    expect(computeNetTach('', '1206.5')).toBeNull();
  });
  it('returns null when end is blank (partial entry)', () => {
    expect(computeNetTach('1200.0', '')).toBeNull();
  });
  it('returns null when both blank', () => {
    expect(computeNetTach('', '')).toBeNull();
  });
  it('returns null on a non-numeric reading', () => {
    expect(computeNetTach('abc', '10')).toBeNull();
    expect(computeNetTach('10', 'xyz')).toBeNull();
  });
  it('clamps a negative difference to 0 (mirrors GREATEST(.., 0))', () => {
    expect(computeNetTach('1206.5', '1200.0')).toBe(0);
  });
  it('handles whole-number readings', () => {
    expect(computeNetTach('100', '108')).toBe(8);
  });
});

describe('#20 tachEndBelowBeginning (warn flag)', () => {
  it('flags end < beginning when both present', () => {
    expect(tachEndBelowBeginning('1206.5', '1200.0')).toBe(true);
  });
  it('does NOT flag end >= beginning', () => {
    expect(tachEndBelowBeginning('1200.0', '1206.5')).toBe(false);
    expect(tachEndBelowBeginning('1200.0', '1200.0')).toBe(false);
  });
  it('does NOT flag a partial/blank entry (never nags a half-filled form)', () => {
    expect(tachEndBelowBeginning('1200.0', '')).toBe(false);
    expect(tachEndBelowBeginning('', '1206.5')).toBe(false);
    expect(tachEndBelowBeginning('', '')).toBe(false);
  });
  it('does NOT flag a non-numeric entry', () => {
    expect(tachEndBelowBeginning('abc', '10')).toBe(false);
  });
});

describe('#20 validateAppliedRecord — tach rules', () => {
  const base = emptyAppliedRecordDraft({ applicator_id: 'a1', application_date: '2026-06-01' });
  it('accepts no tach (optional — a job without tach still saves)', () => {
    expect(validateAppliedRecord(base).ok).toBe(true);
  });
  it('accepts a valid beg/end pair', () => {
    expect(validateAppliedRecord({ ...base, beginningTach: '1200.0', endTach: '1206.5' }).ok).toBe(true);
  });
  it('accepts partial entry (beginning only)', () => {
    expect(validateAppliedRecord({ ...base, beginningTach: '1200.0' }).ok).toBe(true);
  });
  it('accepts partial entry (end only)', () => {
    expect(validateAppliedRecord({ ...base, endTach: '1206.5' }).ok).toBe(true);
  });
  it('rejects a negative beginning tach', () => {
    const r = validateAppliedRecord({ ...base, beginningTach: '-5' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/beginning tach/i);
  });
  it('rejects a negative end tach', () => {
    const r = validateAppliedRecord({ ...base, endTach: '-1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/end tach/i);
  });
  it('rejects end below beginning when both present', () => {
    const r = validateAppliedRecord({ ...base, beginningTach: '1206.5', endTach: '1200.0' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lower than beginning/i);
  });
});

describe('#20 buildAppliedRecordPatch — tach columns', () => {
  it('writes beginning_tach and end_tach; net_tach is NOT in the patch (GENERATED)', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a1', application_date: '2026-06-01',
      beginningTach: '1200.0', endTach: '1206.5',
    });
    const p = buildAppliedRecordPatch(draft);
    expect(p.beginning_tach).toBe(1200);
    expect(p.end_tach).toBe(1206.5);
    expect('net_tach' in p).toBe(false);
  });
  it('nulls a blank tach reading (partial / none stores NULL, not 0)', () => {
    const draft = emptyAppliedRecordDraft({
      applicator_id: 'a1', application_date: '2026-06-01',
      beginningTach: '1200.0', endTach: '',
    });
    const p = buildAppliedRecordPatch(draft);
    expect(p.beginning_tach).toBe(1200);
    expect(p.end_tach).toBeNull();
  });
  it('nulls both when no tach entered', () => {
    const draft = emptyAppliedRecordDraft({ applicator_id: 'a1', application_date: '2026-06-01' });
    const p = buildAppliedRecordPatch(draft);
    expect(p.beginning_tach).toBeNull();
    expect(p.end_tach).toBeNull();
  });
});

describe('#20 draftFromRecord — tach round-trip', () => {
  it('reads beginning_tach / end_tach back into the draft as strings', () => {
    const r = rec({ beginning_tach: 1200, end_tach: 1206.5, net_tach: 6.5 });
    const d = draftFromRecord(r);
    expect(d.beginningTach).toBe('1200');
    expect(d.endTach).toBe('1206.5');
  });
  it('leaves tach blank when the record has none', () => {
    const d = draftFromRecord(rec({}));
    expect(d.beginningTach).toBe('');
    expect(d.endTach).toBe('');
  });
});
