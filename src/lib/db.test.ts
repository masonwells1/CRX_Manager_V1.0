import { describe, it, expect, vi } from 'vitest';

// Mock createClient so db.ts doesn't fail on missing env vars
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

import {
  checkMutationResult,
  assertRpcResult,
  hasRpcCode,
  describePostInvoiceBlock,
  rpcAuthErrorMessage,
  RpcErrorCodes,
} from './db';

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

  // Audit #14 (2026-05-12): `data: null` is a silent RLS denial when `.select()`
  // was chained — `.select()` returns `[]` or `[...rows]` on success, `null`
  // means the mutation was visible to RLS but no row matched. The convention
  // documented in CLAUDE.md is to always `.select()` after `.update()` /
  // `.delete()` so this guard catches the silent failure. Mutations without
  // `.select()` shouldn't go through `checkMutationResult` at all.
  it('throws when data is null (Audit #14 — silent RLS denial)', () => {
    expect(() =>
      checkMutationResult({ error: null, data: null, count: null }, 'insert')
    ).toThrow('insert failed: no rows were affected');
  });

  it('throws when data is undefined', () => {
    expect(() =>
      checkMutationResult({ error: null, data: undefined, count: null }, 'update')
    ).toThrow('update failed: no rows were affected');
  });

  it('does NOT throw when data is a non-empty array', () => {
    expect(() =>
      checkMutationResult({ error: null, data: [{ id: 'abc' }] }, 'update')
    ).not.toThrow();
  });

  it('includes operation name in error message', () => {
    try {
      checkMutationResult({ error: null, data: [], count: 0 }, 'delete invoice');
    } catch (e: unknown) {
      expect((e as Error).message).toContain('delete invoice');
      expect((e as Error).message).toContain('no rows were affected');
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
    } catch (e: unknown) {
      expect((e as Error).message).toContain('my_custom_rpc');
    }
  });
});

describe('hasRpcCode', () => {
  it('matches a real Error whose message starts with the token', () => {
    expect(hasRpcCode(new Error('LICENSE_EXPIRED: license expired 2020-01-01'), RpcErrorCodes.LICENSE_EXPIRED)).toBe(true);
  });
  it('matches a plain Supabase/PostgREST error OBJECT (not an Error instance)', () => {
    // This is the shape supabase.rpc() returns and the dispatch wizard throws —
    // it is NOT an Error, so reading only Error.message would miss the token.
    const pgErr = { code: 'P0001', message: 'LICENSE_EXPIRED: applicator x license expired 2020-01-01', details: null, hint: null };
    expect(hasRpcCode(pgErr, RpcErrorCodes.LICENSE_EXPIRED)).toBe(true);
  });
  it('matches the bare token and "TOKEN suffix" forms', () => {
    expect(hasRpcCode({ message: 'ACTOR_MISMATCH' }, RpcErrorCodes.ACTOR_MISMATCH)).toBe(true);
    expect(hasRpcCode({ message: 'INSUFFICIENT_ROLE admin or sales_rep required' }, RpcErrorCodes.INSUFFICIENT_ROLE)).toBe(true);
    expect(hasRpcCode({ message: 'QUOTE_STALE_WRITE: reload and review' }, RpcErrorCodes.QUOTE_STALE_WRITE)).toBe(true);
    expect(hasRpcCode({ message: 'CUSTOMER_STALE_WRITE: reload and review' }, RpcErrorCodes.CUSTOMER_STALE_WRITE)).toBe(true);
    expect(hasRpcCode({ message: 'COMMISSION_SPLIT_CONFLICT: reload and review' }, RpcErrorCodes.COMMISSION_SPLIT_CONFLICT)).toBe(true);
    expect(hasRpcCode(new Error('QUOTE_STALE_WRITE: reload and review'), RpcErrorCodes.QUOTE_STALE_WRITE)).toBe(true);
  });
  it('does NOT false-positive on the token mid-message', () => {
    expect(hasRpcCode({ message: 'note: LICENSE_EXPIRED appears here' }, RpcErrorCodes.LICENSE_EXPIRED)).toBe(false);
  });
  it('handles null/undefined/odd values without throwing', () => {
    expect(hasRpcCode(null, RpcErrorCodes.LICENSE_EXPIRED)).toBe(false);
    expect(hasRpcCode(undefined, RpcErrorCodes.LICENSE_EXPIRED)).toBe(false);
    expect(hasRpcCode(42, RpcErrorCodes.LICENSE_EXPIRED)).toBe(false);
  });
});

describe('rpcAuthErrorMessage', () => {
  const friendlyMessage = 'Your sign-in could not be verified. Refresh the page and try again.';

  it('maps authentication and actor-binding failures to a friendly recovery message', () => {
    expect(rpcAuthErrorMessage(new Error('AUTH_REQUIRED'))).toBe(friendlyMessage);
    expect(rpcAuthErrorMessage({ code: 'P0001', message: 'ACTOR_MISMATCH' })).toBe(friendlyMessage);
  });

  it('leaves unrelated RPC failures available for their normal handling', () => {
    expect(rpcAuthErrorMessage({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' })).toBeNull();
    expect(rpcAuthErrorMessage({ message: 'Billing splits must total 100%' })).toBeNull();
    expect(rpcAuthErrorMessage(null)).toBeNull();
  });
});

describe('describePostInvoiceBlock', () => {
  // The three sentences below are copied verbatim from the RAISE EXCEPTION
  // lines in 20260813060000_require_completed_delivery_before_invoice_post.sql
  // (lines 776, 779, 786) with the % placeholders filled in. Two of them are
  // DELIVERY_NOT_COMPLETED but prescribe OPPOSITE actions — void vs complete —
  // so the mapper must pass the database's own sentence through rather than
  // collapse both to one canned string.
  const DELETED_DELIVERY =
    'DELIVERY_NOT_COMPLETED: delivery D-42 for invoice INV-1002 has been deleted, so nothing was delivered against this bill. Void this invoice instead of posting it.';
  const CANCELLED_DELIVERY =
    'DELIVERY_NOT_COMPLETED: delivery D-43 for invoice INV-1003 is "cancelled", not completed. Complete the delivery first — that same step also corrects this invoice to the quantities actually delivered. If the delivery was cancelled or voided, void this invoice rather than posting it.';
  const MISSING_DELIVERY =
    'DELIVERY_MISSING: invoice INV-1001 points at delivery 77, which no longer exists. A bill whose delivery record is gone must not be posted.';

  it('tells the operator to VOID when the delivery was deleted', () => {
    expect(describePostInvoiceBlock({ code: 'P0001', message: DELETED_DELIVERY })).toMatchInlineSnapshot(`"delivery D-42 for invoice INV-1002 has been deleted, so nothing was delivered against this bill. Void this invoice instead of posting it."`);
  });

  it('tells the operator to COMPLETE when the delivery is merely unfinished', () => {
    expect(describePostInvoiceBlock({ code: 'P0001', message: CANCELLED_DELIVERY })).toMatchInlineSnapshot(`"delivery D-43 for invoice INV-1003 is "cancelled", not completed. Complete the delivery first — that same step also corrects this invoice to the quantities actually delivered. If the delivery was cancelled or voided, void this invoice rather than posting it."`);
  });

  it('explains a missing delivery record', () => {
    expect(describePostInvoiceBlock(new Error(MISSING_DELIVERY))).toMatchInlineSnapshot(`"invoice INV-1001 points at delivery 77, which no longer exists. A bill whose delivery record is gone must not be posted."`);
  });

  it('falls back to a canned sentence when the token is raised bare', () => {
    expect(describePostInvoiceBlock({ message: 'DELIVERY_NOT_COMPLETED' })).toMatchInlineSnapshot(`"complete the delivery first"`);
    expect(describePostInvoiceBlock({ message: 'DELIVERY_MISSING' })).toMatchInlineSnapshot(`"its delivery record is missing — void this draft"`);
  });

  it('maps the pricing gate', () => {
    expect(describePostInvoiceBlock(new Error('PRICING_INCOMPLETE: 3 lines unpriced'))).toMatchInlineSnapshot(`"needs pricing first"`);
  });

  it('returns null for anything that is not a deliberate billing gate', () => {
    expect(describePostInvoiceBlock(new Error('some unrelated database failure'))).toBeNull();
    expect(describePostInvoiceBlock(null)).toBeNull();
  });
});
