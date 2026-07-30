import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: (data: unknown) => data,
}));

import {
  convertQuoteToOrderWithRowVersion,
  createQuoteVersionWithRowVersion,
  restoreQuoteVersionWithRowVersion,
} from './quoteLifecycleRpc';

describe('quote lifecycle row-version rollout bridge', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('falls back to the legacy create-version signature only when PostgREST says the new signature is missing', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.create_quote_version(p_expected_row_version, p_idempotency_key, p_method, p_performed_by, p_quote_id) in the schema cache',
        },
      })
      .mockResolvedValueOnce({ data: { status: 'created' }, error: null });

    const result = await createQuoteVersionWithRowVersion({
      p_quote_id: 'quote-1',
      p_performed_by: 'user-1',
      p_method: 'presented',
      p_idempotency_key: 'idem-1',
      p_expected_row_version: 7,
    });

    expect(result.error).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_expected_row_version: 7 });
    expect(mockRpc.mock.calls[1][1]).not.toHaveProperty('p_expected_row_version');
  });

  it('never falls back when the versioned lifecycle call reaches PostgreSQL and reports a stale write', async () => {
    const staleError = { code: 'P0001', message: 'QUOTE_STALE_WRITE' };
    mockRpc.mockResolvedValueOnce({ data: null, error: staleError });

    const result = await convertQuoteToOrderWithRowVersion({
      p_quote_id: 'quote-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'idem-1',
      p_expected_row_version: 7,
    });

    expect(result.error).toBe(staleError);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('does not treat another function name in a PGRST202 as a safe fallback', async () => {
    const mismatchError = {
      code: 'PGRST202',
      message: 'Could not find the function public.some_other_function() in the schema cache',
    };
    mockRpc.mockResolvedValueOnce({ data: null, error: mismatchError });

    const result = await convertQuoteToOrderWithRowVersion({
      p_quote_id: 'quote-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'idem-1',
      p_expected_row_version: 7,
    });

    expect(result.error).toBe(mismatchError);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('falls back to the legacy restore signature only for the exact missing restore function', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.restore_quote_version(p_expected_row_version, p_idempotency_key, p_performed_by, p_quote_id, p_version_id) in the schema cache',
        },
      })
      .mockResolvedValueOnce({ data: { status: 'restored' }, error: null });

    const result = await restoreQuoteVersionWithRowVersion({
      p_quote_id: 'quote-1',
      p_version_id: 'version-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'idem-1',
      p_expected_row_version: 7,
    });

    expect(result.error).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0][1]).toMatchObject({
      p_version_id: 'version-1',
      p_expected_row_version: 7,
    });
    expect(mockRpc.mock.calls[1][1]).not.toHaveProperty('p_expected_row_version');
  });

  it('never falls back when a restore reaches PostgreSQL and rejects a stale token', async () => {
    const staleError = { code: 'P0001', message: 'QUOTE_STALE_WRITE' };
    mockRpc.mockResolvedValueOnce({ data: null, error: staleError });

    const result = await restoreQuoteVersionWithRowVersion({
      p_quote_id: 'quote-1',
      p_version_id: 'version-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'idem-1',
      p_expected_row_version: 7,
    });

    expect(result.error).toBe(staleError);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
