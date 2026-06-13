import { describe, it, expect } from 'vitest';
import {
  overrideSaveApplicatorId,
  shouldReassignApplicatorAfterSave,
  canGenerateWpsNotice,
} from './jobSaveHelpers';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // newly-selected (e.g. expired) applicator
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // already-persisted applicator

describe('overrideSaveApplicatorId (#4 — save_job never receives the changed applicator under override)', () => {
  it('no override -> the form applicator', () => {
    expect(overrideSaveApplicatorId({ licenseOverride: false, isNew: false, applicatorId: A, savedApplicatorId: B })).toBe(A);
  });
  it('no override, empty applicator -> null', () => {
    expect(overrideSaveApplicatorId({ licenseOverride: false, isNew: true, applicatorId: '', savedApplicatorId: null })).toBeNull();
  });
  it('override + new job -> null (create unassigned, assign after)', () => {
    expect(overrideSaveApplicatorId({ licenseOverride: true, isNew: true, applicatorId: A, savedApplicatorId: null })).toBeNull();
  });
  it('override + existing job -> the PERSISTED applicator, never the changed one', () => {
    expect(overrideSaveApplicatorId({ licenseOverride: true, isNew: false, applicatorId: A, savedApplicatorId: B })).toBe(B);
  });
  it('override + existing job with no prior applicator -> null', () => {
    expect(overrideSaveApplicatorId({ licenseOverride: true, isNew: false, applicatorId: A, savedApplicatorId: null })).toBeNull();
  });
});

describe('shouldReassignApplicatorAfterSave (#4 — reassign runs AFTER the save commits)', () => {
  it('override + changed applicator -> true', () => {
    expect(shouldReassignApplicatorAfterSave({ licenseOverride: true, applicatorId: A, savedApplicatorId: B })).toBe(true);
  });
  it('override + new applicator (none persisted) -> true', () => {
    expect(shouldReassignApplicatorAfterSave({ licenseOverride: true, applicatorId: A, savedApplicatorId: null })).toBe(true);
  });
  it('override + unchanged applicator -> false', () => {
    expect(shouldReassignApplicatorAfterSave({ licenseOverride: true, applicatorId: A, savedApplicatorId: A })).toBe(false);
  });
  it('no override -> false', () => {
    expect(shouldReassignApplicatorAfterSave({ licenseOverride: false, applicatorId: A, savedApplicatorId: B })).toBe(false);
  });
  it('override + no applicator selected -> false', () => {
    expect(shouldReassignApplicatorAfterSave({ licenseOverride: true, applicatorId: '', savedApplicatorId: B })).toBe(false);
  });
});

describe('canGenerateWpsNotice (#5 — block WPS while the form is dirty)', () => {
  it('blocks while the form has unsaved edits', () => {
    expect(canGenerateWpsNotice({ isDirty: true })).toBe(false);
  });
  it('allows when the form is saved/clean', () => {
    expect(canGenerateWpsNotice({ isDirty: false })).toBe(true);
  });
});
