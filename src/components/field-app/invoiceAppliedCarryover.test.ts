import { describe, it, expect } from 'vitest';
import {
  applicatorNameFor,
  realApplicatorName,
  formatNetTach,
  carryoverRowFromRecord,
  carryoverRowsFromRecords,
} from './invoiceAppliedCarryover';
import type { JobAppliedRecordRow } from '../../types';

function baseRecord(overrides: Partial<JobAppliedRecordRow> = {}): JobAppliedRecordRow {
  return {
    id: 'rec-1',
    job_id: 'job-1',
    applicator_id: 'app-1',
    vehicle_id: 'veh-1',
    application_date: '2026-06-20',
    applied_acres: 80,
    notes: null,
    start_weather_time: '08:00',
    start_temp_f: 72,
    start_wind_direction: 'NW',
    start_wind_mph: 6,
    start_humidity_pct: 54,
    start_weather_source: 'auto',
    end_weather_time: '10:30',
    end_temp_f: 78,
    end_wind_direction: 'NNW',
    end_wind_mph: 8,
    end_humidity_pct: 48,
    end_weather_source: 'auto',
    beginning_tach: 1200.5,
    end_tach: 1207.0,
    net_tach: 6.5,
    created_by: 'app-1',
    created_at: '2026-06-20T12:00:00Z',
    updated_at: '2026-06-20T12:00:00Z',
    vehicle: { vehicle_name: 'Sprayer A', vehicle_type: 'sprayer' },
    job_applied_record_fields: [],
    job_applied_record_crew: [],
    ...overrides,
  };
}

describe('applicatorNameFor', () => {
  it('resolves a known id from the name map', () => {
    const names = new Map([['app-1', 'Jane Doe']]);
    expect(applicatorNameFor('app-1', names)).toBe('Jane Doe');
  });

  it('returns an em-dash for a null id', () => {
    expect(applicatorNameFor(null, new Map())).toBe('—');
  });

  it('returns a clear placeholder for an unknown id (never blank)', () => {
    expect(applicatorNameFor('ghost', new Map())).toBe('(removed applicator)');
  });
});

describe('realApplicatorName (money-lens LOW#1 — no placeholder on the legal PDF)', () => {
  it('returns a real name unchanged (trimmed)', () => {
    expect(realApplicatorName('Jane Doe')).toBe('Jane Doe');
    expect(realApplicatorName('  Jane Doe  ')).toBe('Jane Doe');
  });

  it('maps the em-dash placeholder back to null', () => {
    expect(realApplicatorName('—')).toBeNull();
  });

  it('maps the "(removed applicator)" placeholder back to null', () => {
    expect(realApplicatorName('(removed applicator)')).toBeNull();
  });

  it('treats null / undefined / blank as no value', () => {
    expect(realApplicatorName(null)).toBeNull();
    expect(realApplicatorName(undefined)).toBeNull();
    expect(realApplicatorName('   ')).toBeNull();
  });

  it('an inactive/unmapped applicator still prints when an unfiltered map resolves a real name', () => {
    // Active-only picker map would MISS the id and yield a placeholder -> blank on the PDF.
    const activeOnly = new Map<string, string>();
    expect(realApplicatorName(applicatorNameFor('inactive-1', activeOnly))).toBeNull();
    // Unfiltered map (active AND inactive) resolves the real legal name -> prints.
    const unfiltered = new Map([['inactive-1', 'Retired Rick']]);
    expect(realApplicatorName(applicatorNameFor('inactive-1', unfiltered))).toBe('Retired Rick');
  });
});

describe('formatNetTach', () => {
  it('formats a numeric net tach', () => {
    expect(formatNetTach(6.5)).toBe('6.5 hr');
  });
  it('returns an em-dash when null (missing reading)', () => {
    expect(formatNetTach(null)).toBe('—');
  });
});

describe('carryoverRowFromRecord', () => {
  it('produces display strings for a full record', () => {
    const names = new Map([['app-1', 'Jane Doe']]);
    const row = carryoverRowFromRecord(baseRecord(), names);
    expect(row.applicator_id).toBe('app-1');
    expect(row.applicator_name).toBe('Jane Doe');
    expect(row.vehicle_name).toBe('Sprayer A');
    expect(row.application_date).toBe('2026-06-20');
    expect(row.start_weather).toBe('08:00 · 72°F · NW 6mph · 54%');
    expect(row.end_weather).toBe('10:30 · 78°F · NNW 8mph · 48%');
    expect(row.total_time).toBe('2h 30m');
    expect(row.net_tach).toBe('6.5 hr');
    expect(row.crew_members).toEqual([]);
  });

  it('falls back to em-dashes when weather / vehicle / tach are missing', () => {
    const rec = baseRecord({
      vehicle: null,
      vehicle_id: null,
      start_weather_time: null,
      start_temp_f: null,
      start_wind_direction: null,
      start_wind_mph: null,
      start_humidity_pct: null,
      end_weather_time: null,
      end_temp_f: null,
      end_wind_direction: null,
      end_wind_mph: null,
      end_humidity_pct: null,
      net_tach: null,
    });
    const row = carryoverRowFromRecord(rec, new Map());
    expect(row.vehicle_name).toBe('—');
    expect(row.start_weather).toBe('—');
    expect(row.end_weather).toBe('—');
    expect(row.total_time).toBe('—');
    expect(row.net_tach).toBe('—');
  });

  it('resolves crew member names via the live name, snapshot fallback', () => {
    const rec = baseRecord({
      job_applied_record_crew: [
        {
          id: 'c1', application_record_id: 'rec-1', member_id: 'm1',
          member_name_snapshot: 'Old Name', crew_id_snapshot: null, crew_name_snapshot: 'Crew A',
          created_at: '2026-06-20T12:00:00Z', member: { name: 'Live Name', is_active: true },
        },
        {
          id: 'c2', application_record_id: 'rec-1', member_id: null,
          member_name_snapshot: 'Deleted Member', crew_id_snapshot: null, crew_name_snapshot: 'Crew A',
          created_at: '2026-06-20T12:00:00Z', member: null,
        },
      ],
    });
    const row = carryoverRowFromRecord(rec, new Map());
    // live name when the member still exists, snapshot once member_id is NULL
    expect(row.crew_members).toEqual(['Live Name', 'Deleted Member']);
  });
});

describe('carryoverRowsFromRecords', () => {
  it('maps multiple records preserving order', () => {
    const rows = carryoverRowsFromRecords(
      [baseRecord({ id: 'a' }), baseRecord({ id: 'b' })],
      new Map(),
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
