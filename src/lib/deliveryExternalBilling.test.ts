import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseUntyped } from './db';
import { fetchBilledOutsideCrxDeliveryIds } from './deliveryExternalBilling';

vi.mock('./db', () => ({
  supabaseUntyped: { from: vi.fn() },
}));

function queryReturning(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'order']) chain[method] = vi.fn(() => chain);
  chain.range = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('fetchBilledOutsideCrxDeliveryIds', () => {
  beforeEach(() => {
    vi.mocked(supabaseUntyped.from).mockReset();
  });

  it('pages past a server row cap smaller than the requested page', async () => {
    const pages = [
      { data: [{ delivery_id: 'd1' }, { delivery_id: 'd2' }], error: null },
      { data: [{ delivery_id: 'd3' }], error: null },
      { data: [], error: null },
    ];
    const queries = pages.map(queryReturning);
    queries.forEach((q) => vi.mocked(supabaseUntyped.from).mockReturnValueOnce(q as never));

    const result = await fetchBilledOutsideCrxDeliveryIds();

    expect(result.error).toBeNull();
    expect([...(result.data ?? [])]).toEqual(['d1', 'd2', 'd3']);
    // Each page starts where the rows actually returned ended.
    expect(queries[0].range).toHaveBeenCalledWith(0, 999);
    expect(queries[1].range).toHaveBeenCalledWith(2, 1001);
    expect(queries[2].range).toHaveBeenCalledWith(3, 1002);
  });

  it('returns the error instead of a partial set', async () => {
    vi.mocked(supabaseUntyped.from)
      .mockReturnValueOnce(queryReturning({ data: [{ delivery_id: 'd1' }], error: null }) as never)
      .mockReturnValueOnce(queryReturning({ data: null, error: { message: 'boom' } }) as never);

    const result = await fetchBilledOutsideCrxDeliveryIds();

    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: 'boom' });
  });
});
