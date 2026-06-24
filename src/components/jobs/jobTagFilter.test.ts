import { describe, it, expect } from 'vitest';
import { jobMatchesTagFilter } from './jobTagFilter';

describe('jobMatchesTagFilter', () => {
  it('passes everything when no tags are selected (inert filter)', () => {
    expect(jobMatchesTagFilter(['a', 'b'], [])).toBe(true);
    expect(jobMatchesTagFilter([], [])).toBe(true);
    expect(jobMatchesTagFilter(undefined, [])).toBe(true);
  });

  it('matches a job that carries at least one selected tag (OR within the filter)', () => {
    expect(jobMatchesTagFilter(['a', 'c'], ['a', 'b'])).toBe(true); // shares 'a'
    expect(jobMatchesTagFilter(['b'], ['a', 'b'])).toBe(true);
  });

  it('rejects a job that carries none of the selected tags', () => {
    expect(jobMatchesTagFilter(['x', 'y'], ['a', 'b'])).toBe(false);
    expect(jobMatchesTagFilter([], ['a'])).toBe(false);
    expect(jobMatchesTagFilter(undefined, ['a'])).toBe(false);
  });

  it('accepts a Set as well as an array of job tag ids', () => {
    expect(jobMatchesTagFilter(new Set(['a', 'b']), ['b'])).toBe(true);
    expect(jobMatchesTagFilter(new Set(['c']), ['a', 'b'])).toBe(false);
  });

  it('AND-composition: a job already filtered out by another predicate is not re-included', () => {
    // Simulate: status/customer filter already removed this job; we only ever
    // call this on jobs that survived. A single-tag selection still narrows.
    const survivors = [
      { id: '1', tagIds: ['fungicide'] },
      { id: '2', tagIds: ['ydrop'] },
      { id: '3', tagIds: [] },
    ];
    const selected = ['fungicide'];
    const result = survivors.filter((j) => jobMatchesTagFilter(j.tagIds, selected));
    expect(result.map((j) => j.id)).toEqual(['1']);
  });
});
