import { defineConfig, devices } from '@playwright/test';

// This proof is intentionally self-contained: Vite points at an unreachable
// loopback Supabase URL and the browser test intercepts every request to it.
// The real SQL behavior is proved separately in the network-disabled Postgres
// harness; this config can never reach CRX production.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.VITE_SUPABASE_ANON_KEY = 'phase1a-local-proof-key';

export default defineConfig({
  testDir: './tests/phase1a-ui',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:41731',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 41731',
    url: 'http://127.0.0.1:41731',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
