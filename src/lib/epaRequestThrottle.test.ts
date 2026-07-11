import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EpaThrottle = typeof import('./epaRequestThrottle');

async function loadThrottle(): Promise<EpaThrottle> {
  return import('./epaRequestThrottle');
}

async function fillRollingWindow(throttle: EpaThrottle): Promise<void> {
  for (let index = 0; index < throttle.EPA_EDGE_RATE_LIMIT_COUNT; index += 1) {
    const slot = throttle.waitForEpaRequestSlot(() => false);
    if (index > 0) {
      await vi.advanceTimersByTimeAsync(throttle.EPA_REQUEST_INTERVAL_MS);
    }
    await expect(slot).resolves.toBe(true);
  }
}

describe('EPA request pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces normal requests by at least 500 ms', async () => {
    const { EPA_REQUEST_INTERVAL_MS, getEpaRequestWaitMs } = await loadThrottle();
    const now = 10_000;
    expect(getEpaRequestWaitMs(now, now - 100, [])).toBe(EPA_REQUEST_INTERVAL_MS - 100);
  });

  it('pauses before a 31st edge-function request inside one minute', async () => {
    const throttle = await loadThrottle();
    const {
      EPA_EDGE_RATE_LIMIT_COUNT,
      EPA_EDGE_RATE_LIMIT_WINDOW_MS,
      EPA_REQUEST_INTERVAL_MS,
      getEpaRequestWaitMs,
    } = throttle;
    const firstStartedAt = 100_000;
    const recentStarts = Array.from(
      { length: EPA_EDGE_RATE_LIMIT_COUNT },
      (_, index) => firstStartedAt + (index * EPA_REQUEST_INTERVAL_MS),
    );
    const now = recentStarts[recentStarts.length - 1];

    expect(getEpaRequestWaitMs(now, now, recentStarts)).toBeGreaterThanOrEqual(
      firstStartedAt + EPA_EDGE_RATE_LIMIT_WINDOW_MS - now,
    );
  });

  it('actually delays while the shared rolling window is full', async () => {
    const throttle = await loadThrottle();
    await fillRollingWindow(throttle);

    let resolved = false;
    const blockedSlot = throttle.waitForEpaRequestSlot(() => false).then((slotReady) => {
      resolved = true;
      return slotReady;
    });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(601);
    await expect(blockedSlot).resolves.toBe(true);
  });

  it('honors cancellation while a request is waiting', async () => {
    const throttle = await loadThrottle();
    await expect(throttle.waitForEpaRequestSlot(() => false)).resolves.toBe(true);

    let cancelled = false;
    const waitingSlot = throttle.waitForEpaRequestSlot(() => cancelled);
    await vi.advanceTimersByTimeAsync(100);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(150);

    await expect(waitingSlot).resolves.toBe(false);
  });

  it('throttles bulk and inline callers against one rolling limit', async () => {
    const throttle = await loadThrottle();
    const bulkSlot = () => throttle.waitForEpaRequestSlot(() => false);
    const inlineSlot = (shouldCancel: () => boolean = () => false) => (
      throttle.waitForEpaRequestSlot(shouldCancel)
    );

    for (let index = 0; index < throttle.EPA_EDGE_RATE_LIMIT_COUNT; index += 1) {
      const slot = index % 2 === 0 ? bulkSlot() : inlineSlot();
      if (index > 0) {
        await vi.advanceTimersByTimeAsync(throttle.EPA_REQUEST_INTERVAL_MS);
      }
      await expect(slot).resolves.toBe(true);
    }

    let resolved = false;
    let cancelled = false;
    const nextInlineSlot = inlineSlot(() => cancelled).then((slotReady) => {
      resolved = true;
      return slotReady;
    });
    await vi.advanceTimersByTimeAsync(throttle.EPA_REQUEST_INTERVAL_MS);

    expect(resolved).toBe(false);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(250);
    await expect(nextInlineSlot).resolves.toBe(false);
  });
});
