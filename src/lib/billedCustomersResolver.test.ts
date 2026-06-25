/**
 * billedCustomersResolver.test.ts — the shared safe billed-customer resolver.
 *
 * This is the frontend half of the #11 split-bill compliance fix. The DB behaviour
 * of get_job_billed_customers (precedence, self-gate, anon revoke) is proven by the
 * rolled-back local smoke; this suite pins the resolver's contract: it calls the
 * exact RPC name+arg, dedups by customer_id preserving RPC order (NOT by name, so two
 * distinct customers sharing a name are both kept), and — critically —
 * reports `complete=false` whenever a billed customer fails to resolve to a name (so
 * the caller refuses to print a silently-partial compliance document) or the RPC
 * returns no rows at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('./db', () => ({
  supabase: { rpc: mockRpc },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data as T;
  },
}));

import { resolveBilledCustomers } from './billedCustomersResolver';

beforeEach(() => vi.clearAllMocks());

describe('resolveBilledCustomers', () => {
  it('calls the RPC with the exact name + p_job_id arg', async () => {
    mockRpc.mockResolvedValue({
      data: [{ customer_id: 'c1', farm_name: 'Farm A', account_number: 'A-1', is_primary: true }],
      error: null,
    });
    await resolveBilledCustomers('job-1');
    expect(mockRpc).toHaveBeenCalledWith('get_job_billed_customers', { p_job_id: 'job-1' });
  });

  it('INCLUDES every co-billed customer the RPC returns (the split-bill fix)', async () => {
    // A split-billed job: primary + two co-billed customers. The OLD embed path would
    // drop the co-billed ones (RLS-hidden); the RPC returns them and the resolver keeps
    // all three.
    mockRpc.mockResolvedValue({
      data: [
        { customer_id: 'c1', farm_name: 'Parity Test Farm', account_number: 'PTF-11', is_primary: true },
        { customer_id: 'c2', farm_name: 'Sunrise Ag LLC', account_number: 'CUST-1002', is_primary: false },
        { customer_id: 'c3', farm_name: 'Green Acres Farm', account_number: 'CUST-1001', is_primary: false },
      ],
      error: null,
    });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(true);
    expect(customers).toEqual([
      { customer_name: 'Parity Test Farm', account_number: 'PTF-11' },
      { customer_name: 'Sunrise Ag LLC', account_number: 'CUST-1002' },
      { customer_name: 'Green Acres Farm', account_number: 'CUST-1001' },
    ]);
  });

  it('handles the field_billing_defaults fallback row like any other (name resolves)', async () => {
    // A field with no saved share resolves via field_billing_defaults — the RPC returns
    // that customer with a real name, so the resolver includes it and stays complete.
    mockRpc.mockResolvedValue({
      data: [
        { customer_id: 'c1', farm_name: 'Parity Test Farm', account_number: 'PTF-11', is_primary: true },
        { customer_id: 'c4', farm_name: 'Filter Farm Alpha', account_number: 'FFA-1', is_primary: false },
      ],
      error: null,
    });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(true);
    expect(customers).toContainEqual({ customer_name: 'Filter Farm Alpha', account_number: 'FFA-1' });
  });

  it('handles the primary-only fallback (single row, is_primary)', async () => {
    mockRpc.mockResolvedValue({
      data: [{ customer_id: 'c1', farm_name: 'Parity Test Farm', account_number: 'PTF-11', is_primary: true }],
      error: null,
    });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(true);
    expect(customers).toEqual([{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }]);
  });

  it('dedups by customer_id (same id twice → one), preserving the RPC order', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { customer_id: 'c1', farm_name: 'Farm A', account_number: 'A-1', is_primary: true },
        { customer_id: 'c1', farm_name: 'Farm A', account_number: 'A-1', is_primary: false }, // dup id
        { customer_id: 'c2', farm_name: 'Farm B', account_number: 'B-1', is_primary: false },
      ],
      error: null,
    });
    const { customers } = await resolveBilledCustomers('job-1');
    expect(customers).toEqual([
      { customer_name: 'Farm A', account_number: 'A-1' },
      { customer_name: 'Farm B', account_number: 'B-1' },
    ]);
  });

  it('KEEPS two DISTINCT customers that share the same name+account (no name-based collapse)', async () => {
    // Two genuinely different co-billed customers (distinct customer_id) that happen to
    // share a farm_name+account_number must BOTH appear — a name-based dedup would
    // silently drop one billed party (Codex MED).
    mockRpc.mockResolvedValue({
      data: [
        { customer_id: 'c1', farm_name: 'Smith Farms', account_number: 'SF-1', is_primary: true },
        { customer_id: 'c2', farm_name: 'Smith Farms', account_number: 'SF-1', is_primary: false },
      ],
      error: null,
    });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(true);
    expect(customers).toHaveLength(2);
  });

  it('reports INCOMPLETE when a billed customer has a blank name (refuse-to-print)', async () => {
    // A resolved billed customer whose name could not be resolved → complete=false. The
    // caller MUST abort the compliance PDF and not stamp printed_at.
    mockRpc.mockResolvedValue({
      data: [
        { customer_id: 'c1', farm_name: 'Parity Test Farm', account_number: 'PTF-11', is_primary: true },
        { customer_id: 'c2', farm_name: null, account_number: null, is_primary: false }, // unresolved
      ],
      error: null,
    });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(false);
    // The named one is still surfaced, but `complete` is false so the caller refuses.
    expect(customers).toEqual([{ customer_name: 'Parity Test Farm', account_number: 'PTF-11' }]);
  });

  it('treats whitespace-only names as unresolved (INCOMPLETE)', async () => {
    mockRpc.mockResolvedValue({
      data: [{ customer_id: 'c2', farm_name: '   ', account_number: null, is_primary: true }],
      error: null,
    });
    const { complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(false);
  });

  it('reports INCOMPLETE (not complete) when the RPC returns NO rows', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { customers, complete } = await resolveBilledCustomers('job-1');
    expect(complete).toBe(false);
    expect(customers).toEqual([]);
  });

  it('throws when the RPC errors (e.g. caller not authorized to view the job)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('Not authorized to view this job\'s billed customers') });
    await expect(resolveBilledCustomers('job-1')).rejects.toThrow('Not authorized');
  });

  it('throws via assertRpcResult when data is null (denied / no data)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(resolveBilledCustomers('job-1')).rejects.toThrow(/get_job_billed_customers returned no data/);
  });
});
