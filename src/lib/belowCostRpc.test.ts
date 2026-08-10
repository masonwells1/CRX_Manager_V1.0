import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: vi.fn() },
}));

import { supabaseUntyped } from './db';
import { belowCostLinesFromRpcError, callBelowCostAwareRpc } from './belowCostRpc';

describe('belowCostLinesFromRpcError', () => {
  it('uses the server-locked price and cost in the approval line', () => {
    expect(belowCostLinesFromRpcError({
      message: 'BELOW_COST_REASON_REQUIRED:{"product_name":"Atrazine","unit_price_cents":900,"locked_unit_cost_cents":1200}',
    })).toEqual([{ productName: 'Atrazine', price: 9, cost: 12 }]);
  });

  it('does not turn an admin-required denial into an approval prompt', () => {
    expect(belowCostLinesFromRpcError({
      message: 'BELOW_COST_ADMIN_REQUIRED:{"product_name":"Atrazine"}',
    })).toBeNull();
  });
});

describe('callBelowCostAwareRpc', () => {
  it('falls back only when PostgREST reports the new signature is absent', async () => {
    const rpc = vi.mocked(supabaseUntyped.rpc);
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'public.draw_down_quote(p_below_cost_reason) not found',
        },
      } as never)
      .mockResolvedValueOnce({ data: { status: 'created' }, error: null } as never);

    const result = await callBelowCostAwareRpc('draw_down_quote', { p_quote_id: 'q' }, 'approved');

    expect(result.error).toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(1, 'draw_down_quote', {
      p_quote_id: 'q',
      p_below_cost_reason: 'approved',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'draw_down_quote', { p_quote_id: 'q' });
  });
});
