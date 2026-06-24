import { describe, it, expect } from 'vitest';
import { resolveFieldCustomerId, allFieldsAssigned, type AssignableField } from './fieldImportCustomers';

const fields: AssignableField[] = [
  { index: 1, name: 'North 80', acres: 80 },
  { index: 2, name: 'South 40', acres: 40 },
];

describe('resolveFieldCustomerId', () => {
  it('uses the field-specific assignment when present', () => {
    expect(resolveFieldCustomerId(1, { 1: 'cust-a' }, 'fallback')).toBe('cust-a');
  });

  it('falls back to the apply-to-all customer when the field is unassigned', () => {
    expect(resolveFieldCustomerId(2, { 1: 'cust-a' }, 'fallback')).toBe('fallback');
  });

  it('returns null when neither an assignment nor a fallback exists', () => {
    expect(resolveFieldCustomerId(2, {}, '')).toBeNull();
    expect(resolveFieldCustomerId(2, {}, null)).toBeNull();
    expect(resolveFieldCustomerId(2, {}, undefined)).toBeNull();
  });
});

describe('allFieldsAssigned', () => {
  it('true when an apply-to-all fallback covers every field', () => {
    expect(allFieldsAssigned(fields, {}, 'fallback')).toBe(true);
  });

  it('true when every field is individually assigned (no fallback)', () => {
    expect(allFieldsAssigned(fields, { 1: 'cust-a', 2: 'cust-b' }, '')).toBe(true);
  });

  it('false when a field has neither an assignment nor a fallback', () => {
    expect(allFieldsAssigned(fields, { 1: 'cust-a' }, '')).toBe(false);
  });

  it('vacuously true for an empty field list', () => {
    expect(allFieldsAssigned([], {}, '')).toBe(true);
  });
});
