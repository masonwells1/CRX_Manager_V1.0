import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react';

// Regression guards for the retry-safe call logging RPC (migration
// 20260717113000_log_customer_interaction_rpc.sql):
//  1. A failed save retried in the same modal session sends the SAME
//     idempotency key — the server dedups a response lost after commit.
//  2. A confirmed success resets the key — the next log is a new intent.
//  3. Reopening the modal after an abandoned failure resets the key (RLS
//     review M1: a stale key must not silently replay an old result for a
//     new call, possibly for a different customer).
//  4. Partial success (interaction committed, follow-up failed) warns and
//     still completes the log — the interaction-first UX.

const { toastSpy, rpcSpy } = vi.hoisted(() => ({ toastSpy: vi.fn(), rpcSpy: vi.fn() }));
vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'neq', 'is', 'order', 'limit']) {
      self[method] = () => self;
    }
    self.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return self;
  };
  return {
    ...actual,
    supabase: { from: () => chain(), rpc: rpcSpy },
  };
});
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import LogInteractionModal from './LogInteractionModal';

const SUCCESS = {
  data: { success: true, interaction_id: 'int-1', follow_up_requested: false, follow_up_note_id: null, follow_up_error: null },
  error: null,
};

const baseProps = {
  onClose: vi.fn(),
  customerId: 'customer-1',
  userId: 'user-1',
  customerName: 'Farm Beta',
  onLogged: vi.fn(),
};

// The open-effect resets all form state asynchronously (loads resolve, then
// state setters run, then a setTimeout(0) focus) — interacting before that
// completes gets clobbered. Flush timers + microtasks inside act.
async function modalReady() {
  await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function fillSummaryAndSave(text = 'Talked pricing') {
  const textarea = document.querySelector('textarea');
  expect(textarea).not.toBeNull();
  fireEvent.change(textarea as HTMLTextAreaElement, { target: { value: text } });
  await clickSave();
}

async function clickSave() {
  const button = () => screen.getByRole('button', { name: /Log Call/ }) as HTMLButtonElement;
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
}

function sentKey(callIndex: number): string {
  const args = rpcSpy.mock.calls[callIndex];
  expect(args[0]).toBe('log_customer_interaction');
  return (args[1] as { p_idempotency_key: string }).p_idempotency_key;
}

describe('LogInteractionModal retry-safe logging', () => {
  beforeEach(() => {
    rpcSpy.mockReset();
    toastSpy.mockClear();
    baseProps.onClose.mockClear();
    baseProps.onLogged.mockClear();
  });
  afterEach(cleanup);

  it('sends the RPC the full interaction shape with an idempotency key', async () => {
    rpcSpy.mockResolvedValue(SUCCESS);
    render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    const params = rpcSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(params.p_customer_id).toBe('customer-1');
    expect(params.p_interaction_type).toBe('call');
    expect(params.p_direction).toBe('outbound');
    expect(params.p_summary).toBe('Talked pricing');
    expect(typeof params.p_occurred_at).toBe('string');
    expect(params.p_follow_up_title).toBeUndefined();
    expect(params.p_idempotency_key).toBeTruthy();
    await waitFor(() => expect(baseProps.onLogged).toHaveBeenCalled());
    expect(toastSpy).toHaveBeenCalledWith('success', 'Interaction logged');
  });

  it('a same-session retry after a failed save reuses the SAME idempotency key', async () => {
    rpcSpy.mockResolvedValueOnce({ data: null, error: new Error('network timeout') });
    rpcSpy.mockResolvedValueOnce(SUCCESS);
    render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', expect.any(String)));
    await clickSave();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(2));
    expect(sentKey(1)).toBe(sentKey(0));
  });

  it('after a confirmed success the next save uses a NEW key', async () => {
    rpcSpy.mockResolvedValue(SUCCESS);
    const view = render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    view.rerender(<LogInteractionModal open={false} {...baseProps} />);
    view.rerender(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave('Second call');
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(2));
    expect(sentKey(1)).not.toBe(sentKey(0));
  });

  it('reopening the modal after an ABANDONED failure resets the key (no stale replay)', async () => {
    rpcSpy.mockResolvedValue({ data: null, error: new Error('network timeout') });
    const view = render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    // Abandon: close without retrying, then open a fresh logging intent.
    view.rerender(<LogInteractionModal open={false} {...baseProps} />);
    view.rerender(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave('Different call');
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(2));
    expect(sentKey(1)).not.toBe(sentKey(0));
  });

  it('a replay whose payload was edited surfaces the mismatch instead of silently closing', async () => {
    // Server raises INTERACTION_REPLAY_PAYLOAD_MISMATCH when the same key
    // arrives with different values (the first attempt committed; the rep
    // edited the form before retrying).
    rpcSpy.mockResolvedValue({ data: null, error: { message: 'INTERACTION_REPLAY_PAYLOAD_MISMATCH: this key already logged an interaction with different values' } });
    render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    await fillSummaryAndSave();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('warning', expect.stringContaining('already saved')));
    expect(baseProps.onLogged).toHaveBeenCalled(); // timeline refresh shows what actually saved
    expect(baseProps.onClose).toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('partial success (follow-up failed server-side) warns and still completes the log', async () => {
    rpcSpy.mockResolvedValue({
      data: { success: true, interaction_id: 'int-1', follow_up_requested: true, follow_up_note_id: null, follow_up_error: 'note insert failed' },
      error: null,
    });
    render(<LogInteractionModal open {...baseProps} />);
    await modalReady();
    fireEvent.click(screen.getByRole('checkbox', { name: /Create follow-up/ }));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Call back Tuesday' } });
    await fillSummaryAndSave();
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    const params = rpcSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(params.p_follow_up_title).toBe('Call back Tuesday');
    expect(params.p_follow_up_content).toContain('Talked pricing');
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('warning', expect.stringContaining('follow-up')));
    expect(baseProps.onLogged).toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalledWith('success', 'Interaction logged');
  });
});
