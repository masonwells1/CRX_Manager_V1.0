import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingAction } from './offlineQueue';

const mockRpc = vi.fn();

vi.mock('./db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  assertRpcResult: <T,>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data as T;
  },
  RpcErrorCodes: {
    OFFLINE_STAGE_RATE_LIMIT: 'OFFLINE_STAGE_RATE_LIMIT',
    OFFLINE_STAGE_DAILY_CAP: 'OFFLINE_STAGE_DAILY_CAP',
    OFFLINE_STAGE_REVIEW_BACKLOG: 'OFFLINE_STAGE_REVIEW_BACKLOG',
    OFFLINE_ACTION_NEEDS_REVIEW: 'OFFLINE_ACTION_NEEDS_REVIEW',
  },
  hasRpcCode: (error: unknown, code: string) => {
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    return message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `);
  },
}));

import {
  buildOfflineReceiptPayload,
  DAILY_CAP_RETRY_DELAY_MS,
  executeDurableOfflineAction,
  OfflineReceiptSyncError,
  REVIEW_BACKLOG_RETRY_DELAY_MS,
} from './offlineReceipts';

const RECEIVED = {
  client_action_id: '11111111-1111-4111-8111-111111111111',
  operation: 'complete_delivery',
  entity_id: '22222222-2222-4222-8222-222222222222',
  schema_version: 1,
  status: 'received',
  result: null,
  failure_code: null,
  failure_summary: null,
  attempt_count: 0,
  updated_at: '2026-07-14T12:00:00.000Z',
} as const;

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 1,
    operation: 'complete_delivery',
    params: {
      p_delivery_id: RECEIVED.entity_id,
      p_signed_by: 'Customer Name',
      p_performed_by: '33333333-3333-4333-8333-333333333333',
      p_idempotency_key: 'complete_delivery:user:test',
      p_completed_at: '2026-07-14T11:59:00.000Z',
    },
    createdAt: '2026-07-14T11:59:00.000Z',
    retryCount: 0,
    ownerUserId: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    clientActionId: RECEIVED.client_action_id,
    idempotencyKey: 'complete_delivery:user:test',
    schemaVersion: 1,
    entityId: RECEIVED.entity_id,
    snapshotAt: '2026-07-14T11:58:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildOfflineReceiptPayload', () => {
  it('keeps only the server-approved delivery fields', () => {
    expect(buildOfflineReceiptPayload('complete_delivery', makeAction().params)).toEqual({
      signed_by: 'Customer Name',
      completed_at: '2026-07-14T11:59:00.000Z',
    });
  });

  it('uses the applied-info object for job completion', () => {
    expect(buildOfflineReceiptPayload('complete_job', {
      p_job_id: 'job-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'key',
      p_applied_info: { wind_speed: '8', notes: 'done' },
    })).toEqual({ wind_speed: '8', notes: 'done' });
  });
});

describe('executeDurableOfflineAction', () => {
  it('stages then processes and returns only permanent success proof', async () => {
    const succeeded = { ...RECEIVED, status: 'succeeded', result: { delivery_id: RECEIVED.entity_id } };
    mockRpc
      .mockResolvedValueOnce({ data: RECEIVED, error: null })
      .mockResolvedValueOnce({ data: succeeded, error: null });

    await expect(executeDurableOfflineAction(makeAction())).resolves.toEqual(succeeded);
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'stage_offline_action', expect.objectContaining({
      p_client_action_id: RECEIVED.client_action_id,
      p_entity_id: RECEIVED.entity_id,
      p_entity_snapshot_at: '2026-07-14T11:58:00.000Z',
      p_payload: {
        signed_by: 'Customer Name',
        completed_at: '2026-07-14T11:59:00.000Z',
      },
    }));
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'process_offline_action', {
      p_client_action_id: RECEIVED.client_action_id,
      p_idempotency_key: 'complete_delivery:user:test',
    });
  });

  it('recovers a lost response from an already-succeeded stage replay without processing twice', async () => {
    const succeeded = { ...RECEIVED, status: 'succeeded', result: { delivery_id: RECEIVED.entity_id } };
    mockRpc.mockResolvedValue({ data: succeeded, error: null });

    await expect(executeDurableOfflineAction(makeAction())).resolves.toEqual(succeeded);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('stage_offline_action', expect.any(Object));
  });

  it('keeps a daily-cap action local and schedules a later retry', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'OFFLINE_STAGE_DAILY_CAP: 250 actions reached' },
    });

    const error = await executeDurableOfflineAction(makeAction()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OfflineReceiptSyncError);
    expect(error).toMatchObject({
      disposition: 'retry_later',
      retryAfterMs: DAILY_CAP_RETRY_DELAY_MS,
    });
  });

  it('keeps a backlog-blocked action local and retries after the office has time to clear it', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'OFFLINE_STAGE_REVIEW_BACKLOG: 500 unresolved actions' },
    });

    const error = await executeDurableOfflineAction(makeAction()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OfflineReceiptSyncError);
    expect(error).toMatchObject({
      disposition: 'retry_later',
      retryAfterMs: REVIEW_BACKLOG_RETRY_DELAY_MS,
    });
  });

  it('retains a server needs-review result with its sanitized explanation', async () => {
    const needsReview = {
      ...RECEIVED,
      status: 'needs_review',
      failure_code: 'TARGET_STATE_CONFLICT',
      failure_summary: 'The delivery changed while offline.',
    };
    mockRpc
      .mockResolvedValueOnce({
        data: {
          client_action_id: RECEIVED.client_action_id,
          operation: RECEIVED.operation,
          entity_id: RECEIVED.entity_id,
          status: 'needs_review',
          failure_code: 'TARGET_STATE_CONFLICT',
          failure_summary: 'The delivery changed while offline.',
          attempt_count: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: needsReview,
        error: null,
      });

    const error = await executeDurableOfflineAction(makeAction()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OfflineReceiptSyncError);
    expect(error).toMatchObject({
      disposition: 'needs_attention',
      message: 'The delivery changed while offline.',
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'get_offline_action_status', {
      p_client_action_id: RECEIVED.client_action_id,
    });
  });

  it('discovers an office resolution when an exact stage replay returns the legacy base shape', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: {
          client_action_id: RECEIVED.client_action_id,
          operation: RECEIVED.operation,
          entity_id: RECEIVED.entity_id,
          status: 'needs_review',
          failure_code: 'TARGET_STATE_CONFLICT',
          failure_summary: 'The delivery changed while offline.',
          attempt_count: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ...RECEIVED,
          status: 'needs_review',
          failure_code: 'TARGET_STATE_CONFLICT',
          failure_summary: 'The delivery changed while offline.',
          review_resolution: 'already_completed',
          review_note: 'Dispatch verified the delivery was already completed.',
          resolved_at: '2026-07-14T12:05:00.000Z',
          resolved_by: '44444444-4444-4444-8444-444444444444',
        },
        error: null,
      });

    const error = await executeDurableOfflineAction(makeAction()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OfflineReceiptSyncError);
    expect(error).toMatchObject({
      disposition: 'office_resolved',
      receipt: expect.objectContaining({ review_resolution: 'already_completed' }),
    });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'get_offline_action_status', {
      p_client_action_id: RECEIVED.client_action_id,
    });
  });

  it('retains an office-resolved item until the original device acknowledges it', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: RECEIVED, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'OFFLINE_ACTION_NEEDS_REVIEW' } })
      .mockResolvedValueOnce({
        data: {
          ...RECEIVED,
          status: 'needs_review',
          failure_code: 'TARGET_STATE_CONFLICT',
          failure_summary: 'The delivery changed while offline.',
          review_resolution: 'abandoned',
          review_note: 'Customer cancelled this delivery with the office.',
          resolved_at: '2026-07-14T12:05:00.000Z',
          resolved_by: '44444444-4444-4444-8444-444444444444',
        },
        error: null,
      });

    const error = await executeDurableOfflineAction(makeAction()).catch((caught) => caught);
    expect(error).toBeInstanceOf(OfflineReceiptSyncError);
    expect(error).toMatchObject({
      disposition: 'office_resolved',
      receipt: expect.objectContaining({
        review_resolution: 'abandoned',
        review_note: 'Customer cancelled this delivery with the office.',
      }),
    });
    expect(mockRpc).toHaveBeenNthCalledWith(3, 'get_offline_action_status', {
      p_client_action_id: RECEIVED.client_action_id,
    });
  });
});
