/**
 * FieldRoute.test.tsx — F1 regression guard (Codex cross-review, 2026-06-14).
 *
 * The /my-route list called `statusToBadgeVariant(stop.status)`, but
 * statusToBadgeVariant is a Record (indexed like `statusToBadgeVariant[status]`),
 * not a function — so rendering ANY stop card threw a runtime TypeError. The
 * pre-commit gate that ran for these commits did `npm run build` (esbuild
 * transpile, no type-check) and missed it. This render test fails if a stop
 * card can't render; combined with `npm run typecheck` in the gate it closes
 * the regression.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FieldRoute from './FieldRoute';

const getQueueSummaryMock = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...(actual as object), useNavigate: () => vi.fn() };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u1', full_name: 'Admin', role: 'admin' } }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('../lib/offlineQueue', () => ({ getQueueSummary: getQueueSummaryMock }));

vi.mock('../lib/db', () => {
  const stopRow = {
    id: 'd1', delivery_number: 'DEL-001', status: 'in_progress',
    scheduled_date: '2026-06-14', scheduled_time: null, priority: 'normal',
    assigned_driver: 'u1', delivery_notes: null, customer: { farm_name: 'Wells Farm' },
  };
  // Chain: from().select().is().in().order().order() → { data, error }
  const order2 = vi.fn(() => ({ data: [stopRow], error: null }));
  const order1 = vi.fn(() => ({ order: order2 }));
  const inFn = vi.fn(() => ({ order: order1 }));
  const isFn = vi.fn(() => ({ in: inFn }));
  const selectFn = vi.fn(() => ({ is: isFn }));
  return { supabase: { from: vi.fn(() => ({ select: selectFn })) } };
});

describe('FieldRoute — stops list renders (F1 regression guard)', () => {
  beforeEach(() => {
    getQueueSummaryMock.mockResolvedValue({
      ownedTotal: 0,
      ownedAutoSyncable: 0,
      ownedNeedsAttention: 0,
      otherUserTotal: 0,
      ownerUnknownTotal: 0,
      nextAutoSyncAt: null,
    });
  });

  it('renders a stop card with its status badge without crashing', async () => {
    render(<MemoryRouter><FieldRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Wells Farm')).toBeInTheDocument());
    // The in_progress badge ("In progress") is rendered via
    // statusToBadgeVariant[stop.status] — the exact line that threw when it was
    // called as a function. Its presence proves the card rendered.
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.queryByText('No open stops right now')).not.toBeInTheDocument();
  });

  it('does not claim another user\'s saved work is waiting for the current user to sync', async () => {
    getQueueSummaryMock.mockResolvedValue({
      ownedTotal: 0,
      ownedAutoSyncable: 0,
      ownedNeedsAttention: 0,
      otherUserTotal: 1,
      ownerUnknownTotal: 0,
      nextAutoSyncAt: null,
    });

    render(<MemoryRouter><FieldRoute /></MemoryRouter>);

    expect(await screen.findByText('Another user has saved offline work')).toBeInTheDocument();
    expect(screen.queryByText('1 waiting to sync')).not.toBeInTheDocument();
  });

  it('refreshes its offline-work summary after the background banner can sync', async () => {
    vi.useFakeTimers();
    try {
      render(<MemoryRouter><FieldRoute /></MemoryRouter>);
      await act(async () => { await Promise.resolve(); });
      const callsBeforeInterval = getQueueSummaryMock.mock.calls.length;
      expect(callsBeforeInterval).toBeGreaterThan(0);

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(getQueueSummaryMock.mock.calls.length).toBeGreaterThan(callsBeforeInterval);
    } finally {
      vi.useRealTimers();
    }
  });
});
