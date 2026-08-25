import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

type QueueRpcResponse = {
  data: ReturnType<typeof queueResponse>['data'] | null;
  error: { message: string } | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it('removes stale resolution controls when refreshing the queue fails', async () => {
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
    expect(screen.getByRole('heading', { name: 'Record this permanent resolution?' })).toBeInTheDocument();
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_offline_action_review_queue') {
        return Promise.resolve({ data: null, error: { message: 'network unavailable' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Could not load the offline work review queue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve safely' })).not.toBeInTheDocument();
    expect(screen.queryByText(queueItem.failure_summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resolve Offline Work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Record this permanent resolution?' })).not.toBeInTheDocument();
  });

  it('keeps the newest queue response when an older filter request finishes last', async () => {
    render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );
    expect(await screen.findByText(queueItem.failure_summary)).toBeInTheDocument();

    const olderRequest = deferred<QueueRpcResponse>();
    const newerRequest = deferred<QueueRpcResponse>();
    let requestNumber = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'get_offline_action_review_queue') return Promise.resolve({ data: null, error: null });
      requestNumber += 1;
      return requestNumber === 1 ? olderRequest.promise : newerRequest.promise;
    });

    const filter = screen.getByRole('checkbox', { name: 'Include resolved history' });
    fireEvent.click(filter);
    await waitFor(() => expect(requestNumber).toBe(1));
    fireEvent.click(filter);
    await waitFor(() => expect(requestNumber).toBe(2));

    newerRequest.resolve({
      data: {
        success: true,
        items: [{ ...queueItem, client_action_id: '33333333-3333-4333-8333-333333333333', failure_summary: 'Newest queue result.' }],
        total: 1,
      },
      error: null,
    });
    expect(await screen.findByText('Newest queue result.')).toBeInTheDocument();

    olderRequest.resolve({
      data: {
        success: true,
        items: [{ ...queueItem, client_action_id: '44444444-4444-4444-8444-444444444444', failure_summary: 'Stale queue result.' }],
        total: 1,
      },
      error: null,
    });
    await waitFor(() => expect(screen.queryByText('Stale queue result.')).not.toBeInTheDocument());
    expect(screen.getByText('Newest queue result.')).toBeInTheDocument();
  });

  it('ignores a stale queue error without ending the newer request loading state', async () => {
    render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );
    expect(await screen.findByText(queueItem.failure_summary)).toBeInTheDocument();

    const olderRequest = deferred<QueueRpcResponse>();
    const newerRequest = deferred<QueueRpcResponse>();
    let requestNumber = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'get_offline_action_review_queue') return Promise.resolve({ data: null, error: null });
      requestNumber += 1;
      return requestNumber === 1 ? olderRequest.promise : newerRequest.promise;
    });

    const filter = screen.getByRole('checkbox', { name: 'Include resolved history' });
    fireEvent.click(filter);
    await waitFor(() => expect(requestNumber).toBe(1));
    fireEvent.click(filter);
    await waitFor(() => expect(requestNumber).toBe(2));

    olderRequest.resolve({ data: null, error: { message: 'stale network failure' } });
    await act(async () => { await olderRequest.promise; });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.queryByText('Could not load the offline work review queue.')).not.toBeInTheDocument();
    expect(mockCaptureException).not.toHaveBeenCalled();

    newerRequest.resolve({
      data: {
        success: true,
        items: [{ ...queueItem, client_action_id: '55555555-5555-4555-8555-555555555555', failure_summary: 'Current queue result.' }],
        total: 1,
      },
      error: null,
    });
    expect(await screen.findByText('Current queue result.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled();
  });

  it('invalidates a pending queue request when the page unmounts', async () => {
    const pendingRequest = deferred<QueueRpcResponse>();
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_offline_action_review_queue') return pendingRequest.promise;
      return Promise.resolve({ data: null, error: null });
    });

    const { unmount } = render(
      <MemoryRouter>
        <OfflineWorkReview />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_offline_action_review_queue', expect.any(Object)));
    unmount();

    await act(async () => {
      pendingRequest.resolve({ data: null, error: { message: 'late queue failure' } });
      await pendingRequest.promise;
    });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
