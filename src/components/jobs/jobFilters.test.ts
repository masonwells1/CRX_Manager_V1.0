import { describe, it, expect } from 'vitest';
import {
  type JobFilters,
  type JobFilterFacts,
  emptyJobFilters,
  isJobFiltersEmpty,
  activeJobFilterCount,
  jobMatchesClientFilters,
} from './jobFilters';

// A job that satisfies every client-side dimension, so each test can flip one
// thing and assert the AND-combination.
const facts = (over: Partial<JobFilterFacts> = {}): JobFilterFacts => ({
  tagIds: new Set(['tag-fungicide']),
  crops: ['Corn', 'Soybean'],
  counties: ['Story'],
  states: ['IA'],
  chemicals: ['Roundup', 'Atrazine'],
  fieldNames: ['North 80', 'East 40'],
  ...over,
});

const filters = (over: Partial<JobFilters> = {}): JobFilters => ({
  ...emptyJobFilters,
  ...over,
});

describe('emptyJobFilters / isJobFiltersEmpty', () => {
  it('the empty preset is detected as empty', () => {
    expect(isJobFiltersEmpty(emptyJobFilters)).toBe(true);
  });

  it('any single active dimension makes it non-empty', () => {
    expect(isJobFiltersEmpty(filters({ crop: 'corn' }))).toBe(false);
    expect(isJobFiltersEmpty(filters({ customerIds: ['c1'] }))).toBe(false);
    expect(isJobFiltersEmpty(filters({ startDate: '2026-01-01' }))).toBe(false);
    expect(isJobFiltersEmpty(filters({ tagIds: ['t1'] }))).toBe(false);
  });

  it('whitespace-only text filters are still empty', () => {
    expect(isJobFiltersEmpty(filters({ crop: '   ', jobNumber: ' ' }))).toBe(true);
  });
});

describe('activeJobFilterCount', () => {
  it('counts zero for the empty preset', () => {
    expect(activeJobFilterCount(emptyJobFilters)).toBe(0);
  });

  it('counts each distinct active dimension once', () => {
    const f = filters({
      jobNumber: '230',
      customerIds: ['c1', 'c2'], // still ONE dimension
      crop: 'corn',
      tagIds: ['t1'],
      startDate: '2026-01-01',
    });
    expect(activeJobFilterCount(f)).toBe(5);
  });

  it('ignores whitespace-only text dimensions', () => {
    expect(activeJobFilterCount(filters({ county: '   ' }))).toBe(0);
  });
});

describe('jobMatchesClientFilters — inert when empty', () => {
  it('an all-empty filter passes every job (inert)', () => {
    expect(jobMatchesClientFilters(facts(), emptyJobFilters)).toBe(true);
  });
});

describe('jobMatchesClientFilters — tag filter (OR within tags)', () => {
  it('passes when the job carries at least one selected tag', () => {
    expect(jobMatchesClientFilters(facts(), filters({ tagIds: ['tag-fungicide', 'tag-foliar'] }))).toBe(true);
  });

  it('fails when the job carries none of the selected tags', () => {
    expect(jobMatchesClientFilters(facts(), filters({ tagIds: ['tag-foliar'] }))).toBe(false);
  });

  it('fails a job with no tags when a tag is required', () => {
    expect(jobMatchesClientFilters(facts({ tagIds: new Set() }), filters({ tagIds: ['tag-fungicide'] }))).toBe(false);
  });
});

describe('jobMatchesClientFilters — substring text filters (case-insensitive)', () => {
  it('crop matches case-insensitively and on a substring', () => {
    expect(jobMatchesClientFilters(facts(), filters({ crop: 'corn' }))).toBe(true);
    expect(jobMatchesClientFilters(facts(), filters({ crop: 'SOY' }))).toBe(true);
  });

  it('crop fails when no field has it', () => {
    expect(jobMatchesClientFilters(facts(), filters({ crop: 'wheat' }))).toBe(false);
  });

  it('chemical / field name / county / state each narrow independently', () => {
    expect(jobMatchesClientFilters(facts(), filters({ chemical: 'roundup' }))).toBe(true);
    expect(jobMatchesClientFilters(facts(), filters({ chemical: 'dicamba' }))).toBe(false);
    expect(jobMatchesClientFilters(facts(), filters({ fieldName: 'north' }))).toBe(true);
    expect(jobMatchesClientFilters(facts(), filters({ fieldName: 'south' }))).toBe(false);
    expect(jobMatchesClientFilters(facts(), filters({ county: 'story' }))).toBe(true);
    expect(jobMatchesClientFilters(facts(), filters({ county: 'polk' }))).toBe(false);
    expect(jobMatchesClientFilters(facts(), filters({ state: 'ia' }))).toBe(true);
    expect(jobMatchesClientFilters(facts(), filters({ state: 'mn' }))).toBe(false);
  });
});

describe('jobMatchesClientFilters — AND-combination across dimensions', () => {
  it('passes only when EVERY active dimension matches', () => {
    const f = filters({ crop: 'corn', chemical: 'atrazine', tagIds: ['tag-fungicide'] });
    expect(jobMatchesClientFilters(facts(), f)).toBe(true);
  });

  it('fails when one of several active dimensions does not match', () => {
    // crop + chemical match, but the tag does not -> AND fails.
    const f = filters({ crop: 'corn', chemical: 'atrazine', tagIds: ['tag-foliar'] });
    expect(jobMatchesClientFilters(facts(), f)).toBe(false);
  });

  it('fails when a single text dimension among many does not match', () => {
    const f = filters({ crop: 'corn', chemical: 'roundup', county: 'polk' });
    expect(jobMatchesClientFilters(facts(), f)).toBe(false);
  });
});
