/**
 * lotRpc.test.ts — B1 Lot Capture & Trace typed-shim contract (2026-06-23, Phase 5)
 *
 * src/lib/lotRpc.ts bridges the PARKED migration 20260622170000 (table
 * application_record_lots + the 3 RPCs) into the typed client using `as never`
 * casts on the RPC name/args and an `as unknown as` cast on the table read. Those
 * casts SUPPRESS type-checking of the RPC name string and the table name — so a
 * typo there compiles clean and only fails at runtime against prod. This suite is
 * the regression guard: it pins the EXACT rpc name + argument shape each shim
 * function sends, the table/select/eq the read builds, error propagation, the
 * assertRpcResult "no data" guard, and the null -> [] read default. (The DB
 * behaviour of the RPCs themselves is proven by the rolled-back migration smoke;
 * this is the frontend-contract half.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockEq, mockSelect, mockFrom } = vi.hoisted(() => {
  const eq = vi.fn();
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { mockRpc: vi.fn(), mockEq: eq, mockSelect: select, mockFrom: from };
});

// Mock ./db's supabase only; replicate the real (trivial) assertRpcResult so the
// shim's "throw when no data" guard is genuinely exercised rather than stubbed away.
vi.mock('./db', () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data as T;
  },
}));

import {
  fetchRecordLots,
  fetchRecentLots,
  saveRecordLots,
  traceLot,
  type SaveRecordLotsArgs,
} from './lotRpc';

beforeEach(() => vi.clearAllMocks());

describe('lotRpc shim — fetchRecordLots (parked-table read)', () => {
  it('builds the exact from/select/eq chain and returns the rows', async () => {
    const rows = [
      { product_id: 'p1', lot_number: 'L1', source_receiving_record_id: null, quantity_from_lot: null, unit: null },
    ];
    mockEq.mockResolvedValue({ data: rows, error: null });

    const result = await fetchRecordLots('rec-1');

    expect(mockFrom).toHaveBeenCalledWith('application_record_lots');
    expect(mockSelect).toHaveBeenCalledWith(
      'product_id, lot_number, source_receiving_record_id, quantity_from_lot, unit'
    );
    expect(mockEq).toHaveBeenCalledWith('application_record_id', 'rec-1');
    expect(result).toEqual(rows);
  });

  it('returns [] when the read yields null data', async () => {
    mockEq.mockResolvedValue({ data: null, error: null });
    expect(await fetchRecordLots('rec-1')).toEqual([]);
  });

  it('throws when the read returns an error', async () => {
    mockEq.mockResolvedValue({ data: null, error: new Error('rls denied') });
    await expect(fetchRecordLots('rec-1')).rejects.toThrow('rls denied');
  });
});

describe('lotRpc shim — fetchRecentLots', () => {
  it('calls supabase.rpc with the exact name + arg and returns the rows', async () => {
    const rows = [
      { lot_number: 'L1', last_received_at: '2026-05-01', receiving_record_id: 'r1', source: 'receiving' },
    ];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await fetchRecentLots('prod-1');

    expect(mockRpc).toHaveBeenCalledWith('get_recent_lots_for_product', { p_product_id: 'prod-1' });
    expect(result).toEqual(rows);
  });

  it('throws when the rpc returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('boom') });
    await expect(fetchRecentLots('prod-1')).rejects.toThrow('boom');
  });

  it('throws via assertRpcResult when data is null (denied / no data)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchRecentLots('prod-1')).rejects.toThrow(
      /get_recent_lots_for_product returned no data/
    );
  });
});

describe('lotRpc shim — saveRecordLots', () => {
  const args: SaveRecordLotsArgs = {
    p_application_record_id: 'rec-1',
    p_lots: [{ product_id: 'p1', lot_number: 'L1' }],
    p_performed_by: 'user-1',
    p_idempotency_key: 'idem-1',
  };

  it('calls supabase.rpc with the exact name + full args object and returns the result', async () => {
    mockRpc.mockResolvedValue({ data: { success: true, count: 1 }, error: null });

    const result = await saveRecordLots(args);

    expect(mockRpc).toHaveBeenCalledWith('set_application_record_lots', args);
    expect(result).toEqual({ success: true, count: 1 });
  });

  it('throws when the rpc returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('ACTOR_MISMATCH') });
    await expect(saveRecordLots(args)).rejects.toThrow('ACTOR_MISMATCH');
  });
});

describe('lotRpc shim — traceLot', () => {
  it('calls supabase.rpc with the exact name + arg and returns the rows', async () => {
    const rows = [{ application_record_id: 'r1', lot_number: 'L1' }];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await traceLot('L1');

    expect(mockRpc).toHaveBeenCalledWith('get_lot_application_trace', { p_lot_number: 'L1' });
    expect(result).toEqual(rows);
  });

  it('throws when the rpc returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('relation does not exist') });
    await expect(traceLot('L1')).rejects.toThrow('relation does not exist');
  });
});
