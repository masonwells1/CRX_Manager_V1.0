import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
const envPath = resolve(__dirname, '..', '..', '..', '.env');
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

export default defineConfig({
  testDir: '.',
  fullyParallel: false,       // serial WITHIN each spec (shared state)
  forbidOnly: !!process.env.CI,
  retries: 1,                 // single retry for transient flakes
  workers: 6,                 // 6 parallel workers across spec files
  timeout: 60_000,            // 60s per test (generous for DB queries)

  reporter: [
    ['html', { outputFolder: resolve(__dirname, '..', '..', '..', 'golive-report') }],
    ['json', { outputFile: resolve(__dirname, '..', '..', '..', 'golive-results.json') }],
    ['list'],
  ],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on',               // always capture traces
    screenshot: 'on',          // capture every test
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'golive-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: resolve(__dirname, '..', '..', '..'),
  },
});
