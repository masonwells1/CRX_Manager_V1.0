import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingAction } from '../../lib/offlineQueue';

const mockGetPendingActions = vi.fn();
const mockRemoveAction = vi.fn();
const mockToast = vi.fn();

vi.mock('../../lib/offlineQueue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/offlineQueue')>();
  return {
    ...original,
    getPendingActions: () => mockGetPendingActions(),
    removeAction: (id: number) => mockRemoveAction(id),
  };
});

vi.mock('./Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import OfflineWorkPanel from './OfflineWorkPanel';

const resolvedAction: PendingAction = {
  id: 7,
  operation: 'complete_delivery',
  params: {
    p_delivery_id: 'delivery-1',
    p_signed_by: 'RAW PRIVATE SIGNATURE',
    p_idempotency_key: 'RAW PRIVATE KEY',
  },
  entityId: 'delivery-1',
  clientActionId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'complete_delivery:user-1:test',
  schemaVersion: 1,
  createdAt: '2026-07-14T12:00:00.000Z',
  retryCount: 0,
  ownerUserId: 'user-1',
  status: 'office_resolved',
  officeResolution: 'already_completed',
  officeResolutionNote: 'Dispatch confirmed the signed delivery was already posted.',
  officeResolvedAt: '2026-07-14T13:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPendingActions.mockResolvedValue([resolvedAction]);
  mockRemoveAction.mockResolvedValue(undefined);
});

describe('OfflineWorkPanel', () => {
  it('shows safe retained metadata without exposing the stored payload', async () => {
    render(
      <MemoryRouter>
        <OfflineWorkPanel
          open
          currentUserId="user-1"
          isOnline
          onClose={vi.fn()}
          onRetry={vi.fn()}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Office resolved — acknowledgement required')).toBeInTheDocument();
    expect(screen.getByText(resolvedAction.officeResolutionNote!)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open record/ })).toHaveAttribute('href', '/deliveries/delivery-1');
    expect(screen.queryByText('RAW PRIVATE SIGNATURE')).not.toBeInTheDocument();
    expect(screen.queryByText('RAW PRIVATE KEY')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved work' })).not.toBeInTheDocument();
  });

  it('requires confirmation before removing only the local acknowledged copy', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    mockGetPendingActions
      .mockResolvedValueOnce([resolvedAction])
      .mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <OfflineWorkPanel
          open
          currentUserId="user-1"
          isOnline
          onClose={vi.fn()}
          onRetry={vi.fn()}
          onChanged={onChanged}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge resolution' }));
    expect(screen.getByText(/removes only the saved browser copy/i)).toBeInTheDocument();
    expect(mockRemoveAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge and remove' }));

    await waitFor(() => expect(mockRemoveAction).toHaveBeenCalledWith(7));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('No saved offline work remains.')).toBeInTheDocument();
  });

  it('does not spend retries while the device is offline', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    mockGetPendingActions.mockResolvedValue([{ ...resolvedAction, status: 'pending' }]);

    render(
      <MemoryRouter>
        <OfflineWorkPanel
          open
          currentUserId="user-1"
          isOnline={false}
          onClose={vi.fn()}
          onRetry={onRetry}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Reconnect before retrying saved work.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry saved work' })).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
