const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a database-observed concurrency condition.  Child-process liveness
 * is not a proof that a session reached its intended lock or trigger barrier.
 */
export async function waitForDatabaseReadiness({
  label,
  observe,
  timeoutMs = 20_000,
  intervalMs = 25,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const deadline = now() + timeoutMs;
  let last;
  do {
    last = await observe();
    if (last?.ready) return last;
    if (now() >= deadline) break;
    await sleep(intervalMs);
  } while (true);

  throw new Error(`database readiness timeout for ${label}; last observed ${JSON.stringify(last)}`);
}
