import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryGenericInvoiceCutover } from './genericInvoiceCutoverRetry';

const refusal = (token: string, code = '40001') => ({
  data: null, error: { code, message: `GENERIC_FIELD_CUTOVER_${token}: nothing changed` },
});

afterEach(() => vi.useRealTimers());

describe('retryGenericInvoiceCutover', () => {
  it.each(['IN_PROGRESS', 'ISOLATION', 'STALE_CALL'])('uses fresh requests for %s with unchanged intent', async (token) => {
    vi.useFakeTimers();
    const intent = { p_invoice: { id: 'inv-1' }, p_items: [], p_idempotency_key: 'same-key' };
    const rpc = vi.fn().mockResolvedValueOnce(refusal(token)).mockResolvedValueOnce({ data: 'inv-1', error: null });
    const pending = retryGenericInvoiceCutover(() => rpc(intent));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ data: 'inv-1', error: null });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.every(([payload]) => payload === intent)).toBe(true);
  });

  it('waits before retrying a busy cutover and stops after three requests', async () => {
    vi.useFakeTimers();
    const response = refusal('IN_PROGRESS');
    const rpc = vi.fn().mockResolvedValue(response);
    const pending = retryGenericInvoiceCutover(rpc);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(149);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(response);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it.each([
    refusal('IN_PROGRESS', 'P0001'), refusal('ACTIVE_RECEIPTS'), refusal('STALE_CALL_EXTRA'),
    { data: null, error: { code: '40001', message: 'ordinary serialization failure' } },
    { data: null, error: { code: 'ETIMEDOUT', message: 'request outcome unknown' } },
  ])('does not retry any other response', async (response) => {
    const rpc = vi.fn().mockResolvedValue(response);
    expect(await retryGenericInvoiceCutover(rpc)).toBe(response);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('does not retry a thrown transport failure', async () => {
    const error = new Error('connection lost');
    const rpc = vi.fn().mockRejectedValue(error);
    await expect(retryGenericInvoiceCutover(rpc)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledOnce();
  });
});
