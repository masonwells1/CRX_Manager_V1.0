import { describe, it, expect } from 'vitest';
import {
  type MassEditDraft,
  emptyMassEditDraft,
  MASS_EDIT_STATUS_OPTIONS,
  isStatusBulkSafe,
  allowedSourceStatuses,
  partitionByStatusLegality,
  buildFieldPatch,
  hasAnyChange,
  describeChanges,
} from './jobMassEdit';
import type { JobStatus } from '../../types';

const draft = (over: Partial<MassEditDraft> = {}): MassEditDraft => ({
  ...emptyMassEditDraft,
  ...over,
});

const job = (id: string, status: JobStatus) => ({ id, job_number: id, status });

describe('jobMassEdit — buildFieldPatch (only set filled fields)', () => {
  it('returns null when no section is enabled', () => {
    expect(buildFieldPatch(emptyMassEditDraft)).toBeNull();
  });

  it('omits a section that is enabled but left blank (job date)', () => {
    // setJobDate on but no date chosen -> nothing to write.
    expect(buildFieldPatch(draft({ setJobDate: true, jobDate: '' }))).toBeNull();
  });

  it('includes only the enabled job_date, leaving other columns untouched', () => {
    const patch = buildFieldPatch(draft({ setJobDate: true, jobDate: '2026-07-01' }));
    expect(patch).toEqual({ job_date: '2026-07-01' });
    // critically: no status / applicator / batch keys leak in
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('applicator_id');
    expect(patch).not.toHaveProperty('batch_ref');
  });

  it('sets schedule_date to null when the planning section is on but cleared', () => {
    expect(buildFieldPatch(draft({ setScheduleDate: true, scheduleDate: '' }))).toEqual({
      schedule_date: null,
    });
  });

  it('clears applicator when the applicator section is on with null', () => {
    expect(buildFieldPatch(draft({ setApplicator: true, applicatorId: null }))).toEqual({
      applicator_id: null,
    });
  });

  it('sets applicator + batch together when both sections are on', () => {
    const patch = buildFieldPatch(
      draft({ setApplicator: true, applicatorId: 'appl-1', setBatch: true, batchRef: 'batch-9' })
    );
    expect(patch).toEqual({ applicator_id: 'appl-1', batch_ref: 'batch-9' });
  });

  it('removes from batch (null) when the batch section is on with no batch', () => {
    expect(buildFieldPatch(draft({ setBatch: true, batchRef: null }))).toEqual({ batch_ref: null });
  });

  it('NEVER includes status (status is handled separately, never as a raw column write)', () => {
    const patch = buildFieldPatch(
      draft({ setStatus: true, status: 'cancelled', setJobDate: true, jobDate: '2026-07-01' })
    );
    expect(patch).toEqual({ job_date: '2026-07-01' });
    expect(patch).not.toHaveProperty('status');
  });
});

describe('jobMassEdit — hasAnyChange', () => {
  it('false for an empty draft', () => {
    expect(hasAnyChange(emptyMassEditDraft)).toBe(false);
  });
  it('false when a section is enabled but blank (job date)', () => {
    expect(hasAnyChange(draft({ setJobDate: true, jobDate: '' }))).toBe(false);
  });
  it('true when only a status change is requested', () => {
    expect(hasAnyChange(draft({ setStatus: true, status: 'cancelled' }))).toBe(true);
  });
  it('true when only an applicator clear is requested', () => {
    expect(hasAnyChange(draft({ setApplicator: true, applicatorId: null }))).toBe(true);
  });
});

describe('jobMassEdit — status safety mirrors the lifecycle trigger', () => {
  it('only cancelled is bulk-safe', () => {
    expect(isStatusBulkSafe('cancelled')).toBe(true);
    for (const s of ['scheduled', 'in_progress', 'completed', 'invoiced'] as JobStatus[]) {
      expect(isStatusBulkSafe(s)).toBe(false);
    }
  });

  it('the option list flags exactly one safe target', () => {
    const safe = MASS_EDIT_STATUS_OPTIONS.filter((o) => o.bulkSafe).map((o) => o.value);
    expect(safe).toEqual(['cancelled']);
  });

  it('allowedSourceStatuses matches _enforce_job_status_transition', () => {
    expect(allowedSourceStatuses('in_progress')).toEqual(['scheduled']);
    expect(allowedSourceStatuses('completed')).toEqual(['in_progress']);
    expect(allowedSourceStatuses('invoiced')).toEqual(['completed']);
    expect(allowedSourceStatuses('cancelled').sort()).toEqual(['in_progress', 'scheduled']);
    expect(allowedSourceStatuses('scheduled')).toEqual([]);
  });
});

describe('jobMassEdit — partitionByStatusLegality (partial-failure handling)', () => {
  it('cancel: scheduled/in_progress are eligible, others blocked, already-cancelled unchanged', () => {
    const jobs = [
      job('a', 'scheduled'),
      job('b', 'in_progress'),
      job('c', 'completed'),
      job('d', 'invoiced'),
      job('e', 'cancelled'),
    ];
    const { eligible, unchanged, blocked } = partitionByStatusLegality(jobs, 'cancelled');
    expect(eligible.map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect(unchanged.map((j) => j.id)).toEqual(['e']);
    expect(blocked.map((j) => j.id).sort()).toEqual(['c', 'd']);
  });

  it('every selected job is accounted for exactly once', () => {
    const jobs = [job('a', 'scheduled'), job('b', 'completed'), job('c', 'cancelled')];
    const p = partitionByStatusLegality(jobs, 'cancelled');
    const total = p.eligible.length + p.unchanged.length + p.blocked.length;
    expect(total).toBe(jobs.length);
  });

  it('a same-status target is unchanged (no-op), not a failure', () => {
    const jobs = [job('a', 'cancelled'), job('b', 'cancelled')];
    const p = partitionByStatusLegality(jobs, 'cancelled');
    expect(p.eligible).toHaveLength(0);
    expect(p.blocked).toHaveLength(0);
    expect(p.unchanged.map((j) => j.id)).toEqual(['a', 'b']);
  });
});

describe('jobMassEdit — describeChanges (confirm copy)', () => {
  it('lists only the enabled sections, with friendly names', () => {
    const lines = describeChanges(
      draft({
        setJobDate: true,
        jobDate: '2026-07-01',
        setStatus: true,
        status: 'cancelled',
        setApplicator: true,
        applicatorId: 'appl-1',
        setBatch: true,
        batchRef: 'batch-9',
      }),
      { applicatorName: 'Jane Doe', batchName: 'North Run' }
    );
    expect(lines).toContain('Schedule Date → 2026-07-01');
    expect(lines).toContain('Status → Cancelled');
    expect(lines).toContain('Applicator → Jane Doe');
    expect(lines).toContain('Batch → North Run');
  });

  it('shows (cleared)/(removed) for cleared sections and nothing for off sections', () => {
    const lines = describeChanges(
      draft({ setApplicator: true, applicatorId: null, setBatch: true, batchRef: null }),
      {}
    );
    expect(lines).toEqual(['Applicator → (cleared)', 'Batch → (removed)']);
  });

  it('returns an empty list for an empty draft', () => {
    expect(describeChanges(emptyMassEditDraft, {})).toEqual([]);
  });
});
