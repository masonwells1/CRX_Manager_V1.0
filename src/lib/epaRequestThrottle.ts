export const EPA_REQUEST_INTERVAL_MS = 500;
export const EPA_EDGE_RATE_LIMIT_COUNT = 30;
export const EPA_EDGE_RATE_LIMIT_WINDOW_MS = 60_000;

const RATE_LIMIT_SAFETY_BUFFER_MS = 100;
const CANCEL_POLL_INTERVAL_MS = 250;

interface QueuedEpaRequest {
  shouldCancel: () => boolean;
  resolve: (slotReady: boolean) => void;
}

let lastStartedAt = 0;
const recentRequestStarts: number[] = [];
const requestQueue: QueuedEpaRequest[] = [];
let processingQueue = false;

export function getEpaRequestWaitMs(
  now: number,
  lastStartedAt: number,
  recentRequestStarts: readonly number[],
): number {
  const activeWindowStarts = recentRequestStarts.filter((startedAt) => (
    startedAt > now - EPA_EDGE_RATE_LIMIT_WINDOW_MS
  ));
  const intervalWait = Math.max(0, EPA_REQUEST_INTERVAL_MS - (now - lastStartedAt));
  const windowWait = activeWindowStarts.length >= EPA_EDGE_RATE_LIMIT_COUNT
    ? Math.max(
      0,
      activeWindowStarts[0] + EPA_EDGE_RATE_LIMIT_WINDOW_MS + RATE_LIMIT_SAFETY_BUFFER_MS - now,
    )
    : 0;
  return Math.max(intervalWait, windowWait);
}

async function processEpaRequestQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (requestQueue.length > 0) {
      const request = requestQueue[0];
      let slotReady = false;

      while (!request.shouldCancel()) {
        const now = Date.now();
        while (
          recentRequestStarts.length > 0
          && recentRequestStarts[0] <= now - EPA_EDGE_RATE_LIMIT_WINDOW_MS
        ) {
          recentRequestStarts.shift();
        }

        const waitMs = getEpaRequestWaitMs(now, lastStartedAt, recentRequestStarts);
        if (waitMs <= 0) {
          lastStartedAt = now;
          recentRequestStarts.push(now);
          slotReady = true;
          break;
        }

        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(waitMs, CANCEL_POLL_INTERVAL_MS),
        ));
      }

      requestQueue.shift();
      request.resolve(slotReady);
    }
  } finally {
    processingQueue = false;
    if (requestQueue.length > 0) void processEpaRequestQueue();
  }
}

export function waitForEpaRequestSlot(
  shouldCancel: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    requestQueue.push({ shouldCancel, resolve });
    void processEpaRequestQueue();
  });
}
