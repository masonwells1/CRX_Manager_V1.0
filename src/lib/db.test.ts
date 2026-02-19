import { describe, it, expect, vi } from 'vitest';

// Mock createClient so db.ts doesn't fail on missing env vars
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

import { checkMutationResult, assertRpcResult } from './db';

describe('checkMutationResult', () => {
  it('does nothing when result has data and no error', () => {
    expect(() =>
      checkMutationResult({ error: null, data: [{ id: 1 }], count: 1 }, 'update')
    ).not.toThrow();
  });

  it('throws the Supabase error when present', () => {
    const error = { message: 'RLS blocked', code: '42501' };
    expect(() =>
      checkMutationResult({ error, data: null, count: null }, 'delete')
    ).toThrow();
  });

  it('throws when data is an empty array (silent RLS failure)', () => {
    expect(() =>
      checkMutationResult({ error: null, data: [], count: 0 }, 'update customer')
    ).toThrow('update customer failed: no rows were affected');
  });

  it('does NOT throw when data is null (no select() chained)', () => {
    // This is normal for mutations without .select() — data is null, no error
    expect(() =>
      checkMutationResult({ error: null, data: null, count: null }, 'insert')
    ).not.toThrow();
  });

  it('does NOT throw when data is a non-empty array', () => {
    expect(() =>
      checkMutationResult({ error: null, data: [{ id: 'abc' }] }, 'update')
    ).not.toThrow();
  });

  it('includes operation name in error message', () => {
    try {
      checkMutationResult({ error: null, data: [], count: 0 }, 'delete invoice');
    } catch (e: any) {
      expect(e.message).toContain('delete invoice');
      expect(e.message).toContain('no rows were affected');
    }
  });
});

describe('assertRpcResult', () => {
  it('returns data when non-null', () => {
    const result = assertRpcResult<{ id: string }>({ id: 'abc' }, 'test_rpc');
    expect(result).toEqual({ id: 'abc' });
  });

  it('throws when data is null (silent RLS denial)', () => {
    expect(() => assertRpcResult(null, 'save_quote')).toThrow('save_quote returned no data');
  });

  it('throws when data is undefined', () => {
    expect(() => assertRpcResult(undefined, 'allocate_payment')).toThrow('allocate_payment returned no data');
  });

  it('passes through falsy but valid values (0, false, empty string)', () => {
    expect(assertRpcResult(0, 'test')).toBe(0);
    expect(assertRpcResult(false, 'test')).toBe(false);
    expect(assertRpcResult('', 'test')).toBe('');
  });

  it('includes RPC name in error message', () => {
    try {
      assertRpcResult(null, 'my_custom_rpc');
    } catch (e: any) {
      expect(e.message).toContain('my_custom_rpc');
    }
  });
});
