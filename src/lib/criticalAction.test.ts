import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCriticalAction } from './criticalAction';

// Mock Sentry
vi.mock('./sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

// Get the mock so we can assert on it
import { Sentry } from './sentry';

describe('runCriticalAction', () => {
  const toast = vi.fn();
  const setLoading = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────

  it('calls setLoading(true), runs action, then setLoading(false)', async () => {
    const callOrder: string[] = [];
    const trackLoading = (v: boolean) => callOrder.push(`loading:${v}`);
    const action = async () => {
      callOrder.push('action');
      return 42;
    };

    await runCriticalAction({
      action,
      toast,
      setLoading: trackLoading,
    });

    expect(callOrder).toEqual(['loading:true', 'action', 'loading:false']);
  });

  it('returns the action result on success', async () => {
    const result = await runCriticalAction({
      action: async () => ({ id: 'abc' }),
      toast,
    });

    expect(result).toEqual({ id: 'abc' });
  });

  it('shows success toast when successMessage is provided', async () => {
    await runCriticalAction({
      action: async () => {},
      toast,
      successMessage: 'Recipe saved',
    });

    expect(toast).toHaveBeenCalledWith('success', 'Recipe saved');
  });

  it('does not show success toast when successMessage is omitted', async () => {
    await runCriticalAction({
      action: async () => {},
      toast,
    });

    expect(toast).not.toHaveBeenCalled();
  });

  it('calls onSuccess callback with the result', async () => {
    const onSuccess = vi.fn();
    await runCriticalAction({
      action: async () => 'data',
      toast,
      onSuccess,
    });

    expect(onSuccess).toHaveBeenCalledWith('data');
  });

  // ── Error path ──────────────────────────────────────────────

  it('returns undefined on error', async () => {
    const result = await runCriticalAction({
      action: async () => {
        throw new Error('RLS denied');
      },
      toast,
    });

    expect(result).toBeUndefined();
  });

  it('shows sanitized error in toast', async () => {
    await runCriticalAction({
      action: async () => {
        throw new Error('duplicate key value violates unique constraint "products_sku_key"');
      },
      toast,
    });

    // sanitizeError maps this to a user-friendly message
    expect(toast).toHaveBeenCalledWith(
      'error',
      'A record with this information already exists'
    );
  });

  it('reports raw error to Sentry with tags', async () => {
    const err = new Error('permission denied for table orders');
    await runCriticalAction({
      action: async () => {
        throw err;
      },
      toast,
      sentryTag: 'save_order',
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { source: 'critical_action', action: 'save_order' },
    });
  });

  it('uses "unknown" sentryTag when none provided', async () => {
    const err = new Error('oops');
    await runCriticalAction({
      action: async () => {
        throw err;
      },
      toast,
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { source: 'critical_action', action: 'unknown' },
    });
  });

  it('does not call onSuccess on error', async () => {
    const onSuccess = vi.fn();
    await runCriticalAction({
      action: async () => {
        throw new Error('fail');
      },
      toast,
      onSuccess,
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('always calls setLoading(false), even on error', async () => {
    await runCriticalAction({
      action: async () => {
        throw new Error('boom');
      },
      toast,
      setLoading,
    });

    expect(setLoading).toHaveBeenCalledWith(true);
    expect(setLoading).toHaveBeenCalledWith(false);
    // true was called first
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('works without setLoading (optional)', async () => {
    const result = await runCriticalAction({
      action: async () => 'ok',
      toast,
      successMessage: 'Done',
    });

    expect(result).toBe('ok');
    expect(toast).toHaveBeenCalledWith('success', 'Done');
  });

  it('handles non-Error thrown values', async () => {
    await runCriticalAction({
      action: async () => {
        throw 'string error';
      },
      toast,
    });

    // sanitizeError handles strings
    expect(toast).toHaveBeenCalledWith('error', 'string error');
  });

  it('handles null/undefined thrown values', async () => {
    await runCriticalAction({
      action: async () => {
        throw null;
      },
      toast,
    });

    expect(toast).toHaveBeenCalledWith('error', 'An unexpected error occurred');
  });

  it('handles PostgrestError-shaped objects', async () => {
    await runCriticalAction({
      action: async () => {
        throw { message: 'null value in column "name" of relation "products"', code: '23502' };
      },
      toast,
    });

    expect(toast).toHaveBeenCalledWith('error', 'A required field is missing');
  });
});
