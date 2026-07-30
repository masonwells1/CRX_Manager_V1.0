import { defineConfig, devices } from '@playwright/test';

// This browser proof starts Vite with an unreachable loopback Supabase URL.
// Every request is intercepted by the spec, so it cannot reach CRX services.
process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.VITE_SUPABASE_ANON_KEY = 'row-version-proof-key';

export default defineConfig({
  testDir: './tests/row-version-ui',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'output/playwright/row-version-results',
  use: { baseURL: 'http://127.0.0.1:41732', ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 41732', url: 'http://127.0.0.1:41732', reuseExistingServer: false, timeout: 120_000 },
});
