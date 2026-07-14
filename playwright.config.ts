import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  assertNoProductionEndpointReferences,
  resolveSafeE2EConfig,
} from './tests/e2e/utils/safety-guards';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env so E2E_TEST_EMAIL / E2E_TEST_PASSWORD are available to tests
const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// Resolve one staging-only source of truth before Playwright starts either the
// app or the fixture mutators. Missing or production configuration fails while
// loading the config, before any browser or data-changing setup can run.
const e2eConfig = resolveSafeE2EConfig();
process.env.VITE_SUPABASE_URL = e2eConfig.supabaseUrl;
process.env.VITE_SUPABASE_ANON_KEY = e2eConfig.supabaseAnonKey;

const e2eRoot = resolve(__dirname, 'tests/e2e');
const e2eSources = readdirSync(e2eRoot, {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => {
    const path = resolve(entry.parentPath, entry.name);
    return { path, content: readFileSync(path, 'utf-8') };
  });
assertNoProductionEndpointReferences(e2eSources);

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/fixtures/setup-fixtures.ts',
  globalTeardown: './tests/e2e/fixtures/teardown-fixtures.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // Never reuse an unknown server: it may have been started with production
    // Vite credentials even though fixtures are correctly pointed at staging.
    reuseExistingServer: false,
    timeout: 120000,
  },
});
