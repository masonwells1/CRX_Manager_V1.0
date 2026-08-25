import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  OFFLINE_DB_UPGRADE_BLOCKED_MESSAGE,
  type OfflineQueueSummary,
} from '../../lib/offlineQueue';

const mockIsOnline = vi.fn();
const mockGetQueueSummary = vi.fn();
const mockSyncPendingActions = vi.fn();

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockIsOnline(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' } }),
}));

vi.mock('../../lib/offlineQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/offlineQueue')>();
  return {
    ...actual,
    getQueueSummary: (userId: string | null) => mockGetQueueSummary(userId),
  };
});

vi.mock('../../lib/offlineSync', () => ({
  RETRY_DELAYS_MS: [30_000, 120_000, 600_000],
  syncPendingActions: (userId: string, options: { force?: boolean }) => mockSyncPendingActions(userId, options),
}));

import OfflineBanner from './OfflineBanner';

const EMPTY_SUMMARY: OfflineQueueSummary = {
  ownedTotal: 0,
  ownedAutoSyncable: 0,
  ownedNeedsAttention: 0,
  ownedOfficeResolved: 0,
  otherUserTotal: 0,
  ownerUnknownTotal: 0,
  nextAutoSyncAt: null,
};

const EMPTY_SYNC_RESULT = {
  synced: 0,
  failed: 0,
  deferred: 0,
  skippedOtherUser: 0,
  needsAttention: 0,
  conflicts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsOnline.mockReturnValue(true);
  mockGetQueueSummary.mockResolvedValue(EMPTY_SUMMARY);
  mockSyncPendingActions.mockResolvedValue(EMPTY_SYNC_RESULT);
});

describe('OfflineBanner', () => {
  it('renders nothing when online with no unresolved actions', () => {
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('shows an offline warning', () => {
    mockIsOnline.mockReturnValue(false);
    render(<OfflineBanner />);
    expect(screen.getByText('You are offline.')).toBeInTheDocument();
  });

  it('shows the actionable recovery message when another tab blocks storage upgrade', async () => {
    mockGetQueueSummary.mockRejectedValue(new Error(OFFLINE_DB_UPGRADE_BLOCKED_MESSAGE));

    render(<OfflineBanner />);

    expect(await screen.findByText(OFFLINE_DB_UPGRADE_BLOCKED_MESSAGE)).toBeInTheDocument();
  });

  it('shows retained needs-attention work truthfully', async () => {
    mockGetQueueSummary.mockResolvedValue({
      ...EMPTY_SUMMARY,
      ownedTotal: 1,
      ownedNeedsAttention: 1,
    });

    render(<OfflineBanner />);

    expect(await screen.findByText(/1 offline action needs attention — saved safely on this device/)).toBeInTheDocument();
    expect(screen.queryByText(/synced successfully/)).not.toBeInTheDocument();
  });

  it('does not expose another user\'s action details or try to sync them', async () => {
    mockGetQueueSummary.mockResolvedValue({
      ...EMPTY_SUMMARY,
      otherUserTotal: 1,
    });

    render(<OfflineBanner />);

    expect(await screen.findByText(/Offline work for another user is safely stored/)).toBeInTheDocument();
    expect(mockSyncPendingActions).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /sync|try again/i })).not.toBeInTheDocument();
  });

  it('shows ownerless legacy work without deleting it', async () => {
    mockGetQueueSummary.mockResolvedValue({
      ...EMPTY_SUMMARY,
      ownerUnknownTotal: 1,
    });

    render(<OfflineBanner />);

    expect(await screen.findByText(/Older offline work needs support/)).toBeInTheDocument();
    expect(screen.getByText(/It has not been deleted/)).toBeInTheDocument();
  });

  it('auto-syncs one due action and schedules its retained retry instead of looping', async () => {
    const pending: OfflineQueueSummary = {
      ...EMPTY_SUMMARY,
      ownedTotal: 1,
      ownedAutoSyncable: 1,
    };
    const retryWaiting: OfflineQueueSummary = {
      ...pending,
      nextAutoSyncAt: '2999-01-01T00:00:00.000Z',
    };
    mockGetQueueSummary
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(retryWaiting);
    mockSyncPendingActions.mockResolvedValue({ ...EMPTY_SYNC_RESULT, failed: 1 });

    render(<OfflineBanner />);

    await waitFor(() => expect(mockSyncPendingActions).toHaveBeenCalledTimes(1));
    expect(mockSyncPendingActions).toHaveBeenCalledWith('user-1', {
      force: false,
      runWithBelowCostApproval: expect.any(Function),
    });
    await waitFor(() => expect(screen.getByText(/failed to sync and remain saved/)).toBeInTheDocument());
    expect(mockSyncPendingActions).toHaveBeenCalledTimes(1);
  });

  it('re-arms automatic sync after a wholesale sync rejection', async () => {
    vi.useFakeTimers();
    try {
      const pending: OfflineQueueSummary = {
        ...EMPTY_SUMMARY,
        ownedTotal: 1,
        ownedAutoSyncable: 1,
      };
      mockGetQueueSummary.mockImplementation(() => Promise.resolve(
        mockSyncPendingActions.mock.calls.length >= 2 ? EMPTY_SUMMARY : pending
      ));
      mockSyncPendingActions
        .mockRejectedValueOnce(new Error('IndexedDB transaction aborted'))
        .mockResolvedValueOnce({ ...EMPTY_SYNC_RESULT, synced: 1 });

      render(<OfflineBanner />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await Promise.resolve(); });
      expect(mockSyncPendingActions).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
      expect(mockSyncPendingActions).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(mockSyncPendingActions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows the owning user to manually retry needs-attention work', async () => {
    mockGetQueueSummary.mockResolvedValue({
      ...EMPTY_SUMMARY,
      ownedTotal: 1,
      ownedNeedsAttention: 1,
    });
    mockSyncPendingActions.mockResolvedValue({ ...EMPTY_SYNC_RESULT, synced: 1 });

    render(<OfflineBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try Again' }));

    await waitFor(() => {
      expect(mockSyncPendingActions).toHaveBeenCalledWith('user-1', {
        force: true,
        runWithBelowCostApproval: expect.any(Function),
      });
    });
  });

  it('lets a user-initiated Sync Now bypass the automatic backoff window', async () => {
    mockGetQueueSummary.mockResolvedValue({
      ...EMPTY_SUMMARY,
      ownedTotal: 1,
      ownedAutoSyncable: 1,
      nextAutoSyncAt: '2999-01-01T00:00:00.000Z',
    });

    render(<OfflineBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Now' }));

    await waitFor(() => {
      expect(mockSyncPendingActions).toHaveBeenCalledWith('user-1', {
        force: true,
        runWithBelowCostApproval: expect.any(Function),
      });
    });
  });
});
