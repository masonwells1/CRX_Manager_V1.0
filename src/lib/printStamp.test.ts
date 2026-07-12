import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data as T;
  },
}));

import { stampJobPrinted } from './printStamp';

beforeEach(() => vi.clearAllMocks());

describe('stampJobPrinted', () => {
  it('calls the RPC with the job id and resolves on success', async () => {
    mockRpc.mockResolvedValue({ data: { success: true, job_id: 'job-1' }, error: null });

    await expect(stampJobPrinted('job-1')).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith('stamp_job_printed', { p_job_id: 'job-1' });
  });

  it('throws the RPC payload error when the RPC reports failure', async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: 'Job not found or not visible' }, error: null });

    await expect(stampJobPrinted('job-1')).rejects.toThrow('Job not found or not visible');
  });

  it('throws when the RPC returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('rpc unavailable') });

    await expect(stampJobPrinted('job-1')).rejects.toThrow('rpc unavailable');
  });

  it('throws through assertRpcResult when the RPC returns null data', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await expect(stampJobPrinted('job-1')).rejects.toThrow(
      'stamp_job_printed returned no data — operation may have been denied'
    );
  });
});
