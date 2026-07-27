import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPostBaselineMigrations } from './list-post-baseline-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(
  listPostBaselineMigrations(
    [
      '20260719092832_dashboard_summary_rpc.sql',
      '20260720220000_dashboard_summary_rpc.sql',
      '20260720210000_alpha.sql',
      '20260720230000_beta.sql',
    ],
    '20260719092832',
    new Set(['20260719092832_dashboard_summary_rpc', '20260720210000_alpha']),
  ),
  ['20260720220000_dashboard_summary_rpc.sql', '20260720230000_beta.sql'],
  'only an exact timestamped ledger name may hide a migration; reused suffixes stay pending',
);
const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const files = result.stdout.trim().split(/\r?\n/).filter(Boolean);
assert.deepEqual(files, [...files].sort(), 'post-baseline migrations must be ordered');

// Asserted structurally rather than against named migrations: a baseline refresh
// moves the high-water, and a hard-coded example silently becomes a captured
// migration and fails a test that was never about that file.
const manifest = JSON.parse(
  readFileSync(path.join(root, 'supabase', 'baselines', 'manifest.json'), 'utf8'),
);
const highWater = manifest.migrations_high_water;
for (const file of files) {
  assert.equal(
    path.basename(file).slice(0, 14) > highWater,
    true,
    `${file} is at or below the baseline high-water ${highWater} and must not be replayed`,
  );
}
const allMigrations = readdirSync(path.join(root, 'supabase', 'migrations'))
  .filter((name) => /^\d{14}_.+\.sql$/.test(name))
  .sort();
const expectedPending = allMigrations.filter((name) => name.slice(0, 14) > highWater);
assert.deepEqual(
  files.map((file) => path.basename(file)),
  expectedPending,
  'every migration newer than the baseline high-water must remain pending, and nothing else',
);
console.log(`POST_BASELINE_MIGRATIONS_PASS pending=${files.length}`);
