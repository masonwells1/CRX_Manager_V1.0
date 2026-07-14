import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OfflineActionReviewQueueItem } from '../types';

const mockRpc = vi.fn();
const mockToast = vi.fn();
const mockCaptureException = vi.fn();
const mockGenerateIdempotencyKey = vi.fn(
  (_operation: string, _userId: string) => 'resolve_offline_action:office-user:test',
);

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'office-user', role: 'admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/idempotency', () => ({
  generateIdempotencyKey: (operation: string, userId: string) => (
    mockGenerateIdempotencyKey(operation, userId)
  ),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => mockCaptureException(...args) },
}));

vi.mock('../lib/db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  assertRpcResult: (data: unknown) => data,
  hasRpcCode: (error: unknown, code: string) => (
    Boolean(error && typeof error === 'object' && 'message' in error && String(error.message).startsWith(code))
  ),
  RpcErrorCodes: {
    OFFLINE_ACTION_ALREADY_RESOLVED: 'OFFLINE_ACTION_ALREADY_RESOLVED',
    OFFLINE_ACTION_NOT_REVIEWABLE: 'OFFLINE_ACTION_NOT_REVIEWABLE',
    IDEMPOTENCY_ARGUMENT_MISMATCH: 'IDEMPOTENCY_ARGUMENT_MISMATCH',
  },
}));

import OfflineWorkReview from './OfflineWorkReview';

const queueItem: OfflineActionReviewQueueItem = {
  client_action_id: '22222222-2222-4222-8222-222222222222',
  operation: 'complete_job',
  entity_id: 'job-1',
  actor_id: 'driver-1',
  actor_name: 'Test Applicator',
  attempt_count: 2,
  failure_code: 'TARGET_STATE_CONFLICT',
  failure_summary: 'The job changed while this device was offline.',
  client_created_at: '2026-07-14T11:55:00.000Z',
  received_at: '2026-07-14T12:00:00.000Z',
  needs_review_at: '2026-07-14T12:05:00.000Z',
  updated_at: '2026-07-14T12:05:00.000Z',
  review_resolution: null,
  review_note: null,
  resolved_at: null,
  resolved_by: null,
  resolver_name: null,
};

function queueResponse() {
  return {
    data: { success: true, items: [queueItem], total: 1 },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockImplementation((name: string) => {
    if (name === 'get_offline_action_review_queue') return Promise.resolve(queueResponse());
    return Promise.resolve({
      data: {
        success: true,
        client_action_id: queueItem.client_action_id,
        review_resolution: 'already_completed',
        resolved_at: '2026-07-14T13:00:00.000Z',
      },
      error: null,
    });
  });
});

describe('OfflineWorkReview', () => {
  it('records a confirmed audited resolution without a business-action RPC', async () => {
    render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );

    expect(await screen.findByText(queueItem.failure_summary)).toBeInTheDocument();
    expect(screen.getByText(/Support ID: 22222222/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open record/ })).toHaveAttribute('href', '/jobs/job-1');

    fireEvent.click(screen.getByRole('button', { name: 'Resolve safely' }));
    const finalReview = screen.getByRole('button', { name: 'Review final confirmation' });
    expect(finalReview).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Explain what you checked/), {
      target: { value: 'Verified against the signed paper ticket.' },
    });
    expect(mockGenerateIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(finalReview).not.toBeDisabled();
    fireEvent.click(finalReview);

    expect(screen.getByText(/does not mark this receipt as server-processed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record as already handled' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('resolve_offline_action', {
      p_client_action_id: queueItem.client_action_id,
      p_resolution: 'already_completed',
      p_note: 'Verified against the signed paper ticket.',
      p_idempotency_key: 'resolve_offline_action:office-user:test',
    }));
    expect(mockRpc.mock.calls.some(([name]) => name === 'process_offline_action')).toBe(false);
    expect(mockToast).toHaveBeenCalledWith('success', 'Offline work resolution recorded permanently.');
  });

  it('explains when the reviewed migration has not been activated', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing function' } });

    render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/offline receipt migrations are not active yet/i)).toBeInTheDocument();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('refreshes instead of leaving a stale modal when another office user resolves first', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_offline_action_review_queue') return Promise.resolve(queueResponse());
      return Promise.resolve({
        data: null,
        error: { message: 'OFFLINE_ACTION_ALREADY_RESOLVED: another office user won' },
      });
    });

    render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve safely' }));
    fireEvent.change(screen.getByPlaceholderText(/Explain what you checked/), {
      target: { value: 'Verified against the signed paper ticket.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review final confirmation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record as already handled' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      'Another office user changed this receipt first. The review queue was refreshed.',
    ));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'get_offline_action_review_queue')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Resolve Offline Work' })).not.toBeInTheDocument();
  });
});
