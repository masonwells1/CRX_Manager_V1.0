/**
 * E2E safety guards — fail loudly when running against production without an
 * explicit acknowledgement. Called from playwright.config.ts global setup so
 * any test invocation passes through the check.
 *
 * Today the SUPABASE_URL is still hardcoded in setup-fixtures.ts and
 * teardown-fixtures.ts to the production project. This guard checks BOTH the
 * `VITE_SUPABASE_URL` env override AND the hardcoded fixture URL — Codex P1
 * fix (2026-05-16): the prior version only checked the env var, so an
 * undefined `VITE_SUPABASE_URL` would silently let the fixture's hardcoded
 * prod URL pass through.
 *
 * Once PR-23 (staging Supabase) lands, the fixture URL becomes env-driven
 * and this guard simplifies to env-only.
 */

const PROD_PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';

// Mirror of the hardcoded URL in setup-fixtures.ts:20 / teardown-fixtures.ts:16.
// Keep in sync until those files become env-driven (PR-23).
const HARDCODED_FIXTURE_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';

export function assertNotProductionWithoutOverride(): void {
  const envUrl = process.env.VITE_SUPABASE_URL ?? '';
  const explicitlyAllowed = process.env.E2E_ALLOW_PROD === 'true';

  // Check the effective URL the fixtures will actually use. If env override
  // is set, fixtures still use the hardcoded URL — both must be checked.
  const effectiveUrls = [envUrl, HARDCODED_FIXTURE_URL].filter(Boolean);
  const targetsProd = effectiveUrls.some((u) => u.includes(PROD_PROJECT_ID));

  if (targetsProd && !explicitlyAllowed) {
    throw new Error(
      `E2E_SAFETY: Test fixtures target production Supabase (${PROD_PROJECT_ID}).\n` +
        `  VITE_SUPABASE_URL=${envUrl || '<unset>'}\n` +
        `  fixture URL (hardcoded)=${HARDCODED_FIXTURE_URL}\n` +
        `Set E2E_ALLOW_PROD=true to acknowledge that you intentionally want to run E2E\n` +
        `tests against live production data. Without that flag, this run is refused.`,
    );
  }
}
