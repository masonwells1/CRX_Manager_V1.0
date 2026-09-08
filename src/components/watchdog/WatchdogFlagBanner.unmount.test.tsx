/**
 * Regression test for the CI flake on PR #592 head 0eb710369, where the
 * "Lint, Type Check, Test, Build" job exited non-zero while all 359 files and
 * 5,123 tests PASSED. The exact failure, from that job's log:
 *
 *   ReferenceError: window is not defined
 *    ❯ getCurrentEventPriority node_modules/react-dom/cjs/react-dom.development.js:10993:22
 *    ❯ requestUpdateLane        react-dom.development.js:25495:19
 *    ❯ dispatchSetState         react-dom.development.js:16648:14
 *    ❯ src/components/watchdog/WatchdogFlagBanner.tsx:108:36   <- setLoading(false)
 *    ❯ src/components/watchdog/WatchdogFlagBanner.tsx:141:5    <- await fetchFlags(seq)
 *   This error originated in "src/components/JobDetailRoute.test.tsx"
 *
 * WHY IT HAPPENS: the finally-block asked only `seq === loadSeq.current`, i.e. "has a
 * NEWER load started?". Unmounting with nothing newer behind it leaves that true, so the
 * component calls setLoading on a torn-down tree. React 18's dispatchSetState reaches
 * requestUpdateLane -> getCurrentEventPriority BEFORE it discovers the fiber is gone, and
 * that function reads a bare `window`. Once Vitest has torn the jsdom environment down,
 * that bare reference throws — which is why the symptom is an unhandled rejection with
 * every test green, and why it only shows up under a full-suite run.
 *
 * WHAT THIS TEST DOES: reproduces that frame chain deterministically instead of waiting
 * for the race. It holds the RPC pending, unmounts, removes the global `window` binding
 * the way teardown does, and only then resolves. Against the unguarded component this
 * fails with the identical ReferenceError from dispatchSetState; against the guarded one
 * the setState never runs, so there is nothing to throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const rpc = vi.fn();

vi.mock('../../lib/db', () => ({
  supabaseUntyped: { rpc: (...a: unknown[]) => rpc(...a) },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'p1', role: 'admin' } }),
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'k', resetKey: vi.fn() }),
}));

import WatchdogFlagBanner from './WatchdogFlagBanner';

describe('WatchdogFlagBanner — a load that outlives the component', () => {
  let windowDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    rpc.mockReset();
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  });

  afterEach(() => {
    if (windowDescriptor && !Object.getOwnPropertyDescriptor(globalThis, 'window')) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    }
  });

  it('does not write state after unmount once the environment is gone', async () => {
    // Hold the read open so the component is still mid-load when it unmounts.
    let releaseRead!: (rows: unknown) => void;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'refresh_watchdog_flags') return Promise.resolve({ data: {}, error: null });
      return new Promise((resolve) => {
        releaseRead = (rows) => resolve({ data: rows, error: null });
      });
    });

    const { unmount } = render(<WatchdogFlagBanner jobId="job-1" autoRefresh />);
    // Let the effect run and the refresh settle so the read is genuinely in flight.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(rpc).toHaveBeenCalled();

    // Unmount with NO newer load behind it — loadSeq still matches the in-flight seq,
    // which is exactly the state the old guard could not distinguish.
    unmount();

    // Reproduce Vitest's environment teardown: the global `window` binding disappears,
    // so any bare reference to it (as in getCurrentEventPriority) throws ReferenceError.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => { rejections.push(err); };
    process.on('unhandledRejection', onRejection);
    // @ts-expect-error deliberately removing the global to mimic teardown
    delete globalThis.window;

    try {
      releaseRead([]);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections.map(String).join('\n')).not.toMatch(/window is not defined/);
    expect(rejections).toHaveLength(0);
  });
});
