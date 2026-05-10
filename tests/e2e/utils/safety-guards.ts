/**
 * E2E safety guards — fail loudly when running against production without an
 * explicit acknowledgement. Called from playwright.config.ts global setup so
 * any test invocation passes through the check.
 *
 * Today the SUPABASE_URL is still hardcoded in setup-fixtures.ts and
 * teardown-fixtures.ts to the production project. This guard's first job is
 * to assert that anyone OVERRIDING the URL via env var must explicitly opt in.
 * Once PR-23 (staging Supabase) lands, the URL becomes env-driven and this
 * guard fires for real.
 */

const PROD_PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';

export function assertNotProductionWithoutOverride(): void {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const isProdUrl = url.includes(PROD_PROJECT_ID);
  const explicitlyAllowed = process.env.E2E_ALLOW_PROD === 'true';

  if (isProdUrl && !explicitlyAllowed) {
    throw new Error(
      `E2E_SAFETY: VITE_SUPABASE_URL points at production Supabase (${PROD_PROJECT_ID}).\n` +
        `Set E2E_ALLOW_PROD=true to acknowledge that you intentionally want to run E2E\n` +
        `tests against live production data. Without that flag, this run is refused.`,
    );
  }
}
