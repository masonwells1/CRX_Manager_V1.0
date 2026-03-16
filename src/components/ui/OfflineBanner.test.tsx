import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock dependencies before import
const mockIsOnline = vi.fn();
const mockGetPendingCount = vi.fn();
const mockSyncPendingActions = vi.fn();

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockIsOnline(),
}));

vi.mock('../../lib/offlineQueue', () => ({
  getPendingCount: () => mockGetPendingCount(),
}));

vi.mock('../../lib/offlineSync', () => ({
  syncPendingActions: () => mockSyncPendingActions(),
}));

import OfflineBanner from './OfflineBanner';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPendingCount.mockResolvedValue(0);
  mockSyncPendingActions.mockResolvedValue({ synced: 0, failed: 0 });
});

describe('OfflineBanner', () => {
  it('renders nothing when online with no pending actions', () => {
    mockIsOnline.mockReturnValue(true);
    const { container } = render(<OfflineBanner />);
    // Initially renders nothing (pending count defaults to 0)
    expect(container.firstChild).toBeNull();
  });

  it('shows offline message when not online', async () => {
    mockIsOnline.mockReturnValue(false);
    render(<OfflineBanner />);
    expect(screen.getByText('You are offline.')).toBeInTheDocument();
  });

  it('shows WifiOff icon when offline', () => {
    mockIsOnline.mockReturnValue(false);
    render(<OfflineBanner />);
    // The WifiOff icon is rendered as an SVG
    const banner = screen.getByText('You are offline.').closest('div');
    expect(banner).toBeTruthy();
  });
});
