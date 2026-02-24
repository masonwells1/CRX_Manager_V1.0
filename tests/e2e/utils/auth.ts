import { Page } from '@playwright/test';

export const TEST_USER = {
  email: process.env.E2E_TEST_EMAIL || 'mason@croprxsolutions.com',
  password: process.env.E2E_TEST_PASSWORD || '',
};

export async function login(page: Page, email = TEST_USER.email, password = TEST_USER.password) {
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
  await page.waitForURL('/');
}

export async function logout(page: Page) {
  await page.click('[data-testid="user-menu"] button:has-text("Sign Out")');
  await page.waitForURL('/login');
}
