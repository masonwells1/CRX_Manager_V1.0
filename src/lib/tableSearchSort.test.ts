import { describe, it, expect } from 'vitest';
import { applyTableSearchSort } from './tableSearchSort';

interface Row {
  job_number: string;
  customer: string;
  acres: number | null;
}

const rows: Row[] = [
  { job_number: 'FJOB-002', customer: 'Beta Farms', acres: 50 },
  { job_number: 'FJOB-001', customer: 'Acme Co', acres: 120 },
  { job_number: 'PUSE-9', customer: 'Acme Co', acres: null },
];

describe('applyTableSearchSort', () => {
  it('returns all rows unchanged when no search and no sort', () => {
    expect(applyTableSearchSort(rows, ['job_number'], '', null, 'asc')).toEqual(rows);
  });

  it('filters by a search term over the given keys (case-insensitive)', () => {
    const out = applyTableSearchSort(rows, ['customer'], 'acme', null, 'asc');
    expect(out.map((r) => r.job_number)).toEqual(['FJOB-001', 'PUSE-9']);
  });

  it('searches across multiple keys', () => {
    const out = applyTableSearchSort(rows, ['job_number', 'customer'], 'puse', null, 'asc');
    expect(out).toHaveLength(1);
    expect(out[0].job_number).toBe('PUSE-9');
  });

  it('returns nothing when the search matches no row', () => {
    expect(applyTableSearchSort(rows, ['job_number'], 'zzz', null, 'asc')).toEqual([]);
  });

  it('sorts strings ascending and descending', () => {
    const asc = applyTableSearchSort(rows, [], '', 'job_number', 'asc');
    expect(asc.map((r) => r.job_number)).toEqual(['FJOB-001', 'FJOB-002', 'PUSE-9']);
    const desc = applyTableSearchSort(rows, [], '', 'job_number', 'desc');
    expect(desc.map((r) => r.job_number)).toEqual(['PUSE-9', 'FJOB-002', 'FJOB-001']);
  });

  it('sorts numbers numerically (not lexically)', () => {
    const asc = applyTableSearchSort(rows, [], '', 'acres', 'asc');
    // null sorts last; 50 before 120.
    expect(asc.map((r) => r.acres)).toEqual([50, 120, null]);
  });

  it('pushes null values last regardless of direction', () => {
    const desc = applyTableSearchSort(rows, [], '', 'acres', 'desc');
    expect(desc[desc.length - 1].acres).toBe(null);
  });

  it('applies search THEN sort together (matches the displayed rows)', () => {
    const out = applyTableSearchSort(rows, ['customer'], 'acme', 'acres', 'asc');
    // Only Acme rows, sorted by acres asc (120 then null).
    expect(out.map((r) => r.job_number)).toEqual(['FJOB-001', 'PUSE-9']);
  });

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.job_number);
    applyTableSearchSort(rows, [], '', 'job_number', 'desc');
    expect(rows.map((r) => r.job_number)).toEqual(before);
  });
});
