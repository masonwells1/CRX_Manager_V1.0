import { Page } from '@playwright/test';

/**
 * Throw if a required env var is missing. Fail-closed pattern — replaces the
 * old hardcoded credential fallback. PR-05.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `E2E env var ${name} is required.\n` +
        `Set E2E_TEST_EMAIL and E2E_TEST_PASSWORD before running Playwright.\n` +
        `See docs/CONTRIBUTING.md (E2E section) for setup instructions.`,
    );
  }
  return value;
}

export const TEST_USER = {
  email: requireEnv('E2E_TEST_EMAIL'),
  password: requireEnv('E2E_TEST_PASSWORD'),
};

export async function login(page: Page, email = TEST_USER.email, password = TEST_USER.password) {
  // Retry login up to 3 times — Supabase rate-limits rapid sequential auth requests
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto('/login');

    // If already authenticated, /login may redirect to / immediately
    const emailInput = page.locator('input[type="email"]');
    const isLoginPage = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (!isLoginPage) {
      // Already logged in — session cookie is still valid
      return;
    }

    await emailInput.fill(email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');

    try {
      await page.waitForURL('/', { timeout: 8000 });
      return; // Success
    } catch {
      if (attempt === 3) throw new Error(`Login failed after 3 attempts for ${email} — waitForURL('/') timed out`);
      // Wait before retry to let Supabase rate-limit window pass
      await page.waitForTimeout(1000);
    }
  }
}

export async function logout(page: Page) {
  await page.click('[data-testid="user-menu"] button:has-text("Sign Out")');
  await page.waitForURL('/login');
}
