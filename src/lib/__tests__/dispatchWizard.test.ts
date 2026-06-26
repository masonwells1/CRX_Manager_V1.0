import { describe, it, expect } from 'vitest';
import {
  toggleLocation,
  setAssignment,
  assignAll,
  pruneAssignments,
  canAdvanceToAssign,
  canAdvanceToFinish,
  unassignedCount,
  buildDispatchPayload,
  summarizeDispatch,
  aggregateAssignedTo,
  DISPATCH_STEPS,
  type AssignmentMap,
  type DispatchAssignee,
  type DispatchLocation,
} from '../dispatchWizard';

const APP1: DispatchAssignee = { kind: 'applicator', id: 'app-1', name: 'Bob Applicator' };
const APP2: DispatchAssignee = { kind: 'applicator', id: 'app-2', name: 'Carl Applicator' };
const CREW1: DispatchAssignee = { kind: 'crew', id: 'crew-1', name: 'North Crew' };

const LOCATIONS: DispatchLocation[] = [
  { jobFieldId: 'jf-a', jobId: 'job-1', jobNumber: 'JOB-1', customerName: 'Farm', fieldName: 'Field A', acres: 50 },
  { jobFieldId: 'jf-b', jobId: 'job-1', jobNumber: 'JOB-1', customerName: 'Farm', fieldName: 'Field B', acres: 40 },
  { jobFieldId: 'jf-c', jobId: 'job-2', jobNumber: 'JOB-2', customerName: 'Other', fieldName: 'Field C', acres: 30 },
];

describe('DISPATCH_STEPS', () => {
  it('is exactly the 3 ChemMan steps in order', () =>
    expect(DISPATCH_STEPS).toEqual(['select', 'assign', 'finish']));
});

describe('toggleLocation', () => {
  it('adds an unselected location', () => {
    expect([...toggleLocation(new Set(), 'jf-a')]).toEqual(['jf-a']);
  });
  it('removes an already-selected location', () => {
    expect([...toggleLocation(new Set(['jf-a', 'jf-b']), 'jf-a')]).toEqual(['jf-b']);
  });
  it('does not mutate the input set', () => {
    const input = new Set(['jf-a']);
    toggleLocation(input, 'jf-b');
    expect([...input]).toEqual(['jf-a']);
  });
});

describe('setAssignment / assignAll / pruneAssignments', () => {
  it('sets an assignee for one location', () => {
    const map = setAssignment({}, 'jf-a', APP1);
    expect(map['jf-a']).toEqual(APP1);
  });
  it('clears an assignee when passed undefined', () => {
    const map = setAssignment({ 'jf-a': APP1 }, 'jf-a', undefined);
    expect(map['jf-a']).toBeUndefined();
  });
  it('assignAll maps every selected location to one assignee', () => {
    const map = assignAll({}, new Set(['jf-a', 'jf-b']), APP1);
    expect(map).toEqual({ 'jf-a': APP1, 'jf-b': APP1 });
  });
  it('different locations can hold DIFFERENT assignees (multi-applicator split)', () => {
    let map: AssignmentMap = {};
    map = setAssignment(map, 'jf-a', APP1);
    map = setAssignment(map, 'jf-b', APP2);
    expect(map['jf-a']).toEqual(APP1);
    expect(map['jf-b']).toEqual(APP2);
  });
  it('pruneAssignments drops assignments no longer selected', () => {
    const map = { 'jf-a': APP1, 'jf-b': APP2 };
    expect(pruneAssignments(map, new Set(['jf-a']))).toEqual({ 'jf-a': APP1 });
  });
});

describe('step gates', () => {
  it('canAdvanceToAssign requires at least one selection', () => {
    expect(canAdvanceToAssign(new Set())).toBe(false);
    expect(canAdvanceToAssign(new Set(['jf-a']))).toBe(true);
  });
  it('canAdvanceToFinish requires every selected location assigned', () => {
    const sel = new Set(['jf-a', 'jf-b']);
    expect(canAdvanceToFinish(sel, { 'jf-a': APP1 })).toBe(false);
    expect(canAdvanceToFinish(sel, { 'jf-a': APP1, 'jf-b': APP2 })).toBe(true);
  });
  it('canAdvanceToFinish is false for an empty selection', () => {
    expect(canAdvanceToFinish(new Set(), {})).toBe(false);
  });
  it('unassignedCount counts only selected-but-unassigned locations', () => {
    expect(unassignedCount(new Set(['jf-a', 'jf-b', 'jf-c']), { 'jf-a': APP1 })).toBe(2);
  });
});

describe('buildDispatchPayload', () => {
  it('emits XOR rows (applicator OR crew) for the multi-applicator split', () => {
    const sel = new Set(['jf-a', 'jf-b']);
    const map = { 'jf-a': APP1, 'jf-b': APP2 };
    const payload = buildDispatchPayload(sel, map).sort((a, b) => a.job_field_id.localeCompare(b.job_field_id));
    expect(payload).toEqual([
      { job_field_id: 'jf-a', applicator_id: 'app-1', crew_id: null },
      { job_field_id: 'jf-b', applicator_id: 'app-2', crew_id: null },
    ]);
  });
  it('emits crew_id (not applicator_id) for a crew assignee', () => {
    const payload = buildDispatchPayload(new Set(['jf-a']), { 'jf-a': CREW1 });
    expect(payload).toEqual([{ job_field_id: 'jf-a', applicator_id: null, crew_id: 'crew-1' }]);
  });
  it('throws if a selected location is unassigned (defensive invariant)', () => {
    expect(() => buildDispatchPayload(new Set(['jf-a']), {})).toThrow();
  });
});

describe('summarizeDispatch', () => {
  it('groups locations by assignee for the Step 3 confirmation', () => {
    const sel = new Set(['jf-a', 'jf-b', 'jf-c']);
    const map = { 'jf-a': APP1, 'jf-b': APP2, 'jf-c': APP1 };
    const groups = summarizeDispatch(sel, map, LOCATIONS);
    // sorted by assignee name: Bob (jf-a, jf-c) then Carl (jf-b)
    expect(groups.map((g) => g.assignee.name)).toEqual(['Bob Applicator', 'Carl Applicator']);
    expect(groups[0].locations.map((l) => l.jobFieldId).sort()).toEqual(['jf-a', 'jf-c']);
    expect(groups[1].locations.map((l) => l.jobFieldId)).toEqual(['jf-b']);
  });
});

describe('aggregateAssignedTo', () => {
  it('shows BOTH names when a job is split between two applicators', () => {
    expect(aggregateAssignedTo(['Bob Applicator', 'Carl Applicator'], null)).toBe('Bob Applicator, Carl Applicator');
  });
  it('de-duplicates the same assignee across locations', () => {
    expect(aggregateAssignedTo(['Bob Applicator', 'Bob Applicator'], null)).toBe('Bob Applicator');
  });
  it('falls back to the whole-job applicator when there are no per-location dispatches', () => {
    expect(aggregateAssignedTo([], 'Carl Applicator')).toBe('Carl Applicator');
  });
  it('returns null when nothing is assigned', () => {
    expect(aggregateAssignedTo([null, undefined], null)).toBeNull();
  });
  it('sorts the distinct names for a stable label', () => {
    expect(aggregateAssignedTo(['Zed', 'Abe'], null)).toBe('Abe, Zed');
  });
});
