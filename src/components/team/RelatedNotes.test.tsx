/**
 * RelatedNotes.test.tsx — failure-path guard for the mount load.
 *
 * The component used to destructure only `data` off the RPC reply and call
 * assertRpcResult with no try/catch. A raised Postgres error (permission
 * denied, RLS refusal, network failure) or a null payload therefore escaped as
 * an UNHANDLED PROMISE REJECTION, nothing reached the operator, and
 * setLoading(false) — which only ran on the success path — never fired, so the
 * card sat on its skeleton forever. Every page that embeds RelatedNotes
 * (JobDetail, OrderDetail, DeliveryDetail, CustomerDetail, PurchaseOrderDetail)
 * mocks it out in its own tests, so nothing else covers this path.
 *
 * These tests pin both failure shapes: a raised error and a null reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const rpc = vi.fn();
const captureException = vi.fn();

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    // The real assertRpcResult is what throws on a null payload — stubbing it
    // would delete the very error path under test.
    assertRpcResult: actual.assertRpcResult,
    supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  };
});

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => captureException(...args) },
}));

import { ToastProvider } from '../ui/Toast';
import RelatedNotes from './RelatedNotes';

// The REAL ToastProvider, deliberately: an identity-unstable `useToast` stub is
// what produced the load-fail → toast → reload loop that Toast.loopguard.test
// pins, and it would hide a regression here rather than catch one.
function renderCard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <RelatedNotes entityType="job" entityId="job-1" onCreateTask={() => {}} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Open the body regardless of which state the card settled into. */
function openBody() {
  const toggle = screen.getByRole('button', { name: /team notes/i });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

describe('RelatedNotes load failures', () => {
  beforeEach(() => {
    rpc.mockReset();
    captureException.mockReset();
  });

  it('surfaces a raised RPC error and clears loading', async () => {
    // Supabase returns PostgrestError as a plain object, not an Error instance.
    // `data` is deliberately a VALID empty array so only the `error` binding can
    // reach the catch — with a null payload assertRpcResult would throw anyway
    // and this test would pass without proving the error is bound at all.
    rpc.mockResolvedValue({ data: [], error: { message: 'permission denied for function get_notes_for_entity' } });
    renderCard();

    // The operator sees it …
    expect(await screen.findByTestId('related-notes-error')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/You do not have permission/i)).toBeInTheDocument());
    // … it reaches Sentry …
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1));
    // … and the card does not claim "(0) notes" when it simply failed to load.
    expect(screen.queryByText(/Team Notes \(/)).not.toBeInTheDocument();

    // … and the skeleton is gone even with the body open: loading cleared.
    openBody();
    expect(screen.queryByTestId('related-notes-loading')).not.toBeInTheDocument();
  });

  it('surfaces a null reply and clears loading', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    renderCard();

    expect(await screen.findByTestId('related-notes-error')).toBeInTheDocument();
    await waitFor(() => expect(captureException).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Team Notes \(/)).not.toBeInTheDocument();

    openBody();
    expect(screen.queryByTestId('related-notes-loading')).not.toBeInTheDocument();
  });

  it('an empty array is a successful empty load, not a failure', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    renderCard();

    await waitFor(() => expect(screen.getByText('Team Notes (0)')).toBeInTheDocument());
    expect(screen.queryByTestId('related-notes-error')).not.toBeInTheDocument();
    expect(captureException).not.toHaveBeenCalled();

    openBody();
    expect(screen.queryByTestId('related-notes-loading')).not.toBeInTheDocument();
    expect(screen.getByText('No related notes')).toBeInTheDocument();
  });

  // Without this, the `no skeleton after the load settles` assertions above
  // could pass vacuously against a build where the skeleton never renders at
  // all — this pins that the testid really is the in-flight state.
  it('shows the skeleton while the load is in flight, then clears it', async () => {
    let settle: (reply: unknown) => void = () => {};
    rpc.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    renderCard();

    openBody();
    expect(screen.getByTestId('related-notes-loading')).toBeInTheDocument();

    settle({ data: [], error: null });
    await waitFor(() => expect(screen.queryByTestId('related-notes-loading')).not.toBeInTheDocument());
  });

  it('retry after a failure reloads and recovers', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network error' } });
    renderCard();
    expect(await screen.findByTestId('related-notes-error')).toBeInTheDocument();

    rpc.mockResolvedValueOnce({
      data: [{ id: 'n1', title: 'Call the grower', priority: 'high', is_completed: false, created_at: '2026-09-05T00:00:00Z', assignee: null }],
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('Call the grower')).toBeInTheDocument());
    expect(screen.queryByTestId('related-notes-error')).not.toBeInTheDocument();
  });
});
