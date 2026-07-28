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

// The expectation applies both of the selector's rules, not just the version one.
// Supabase assigns its own ledger version for a Management-API apply, so a file whose
// filename timestamp sits above the high-water can already be recorded in the captured
// ledger under a lower version. Filtering on the timestamp alone would then demand a
// migration the selector correctly withholds, and fail a test that is about wiring.
// The ledger is parsed here rather than imported so the assertion stays independent of
// the predicate under test — the synthetic case above is what proves that predicate.
const historyLines = readFileSync(
  path.join(root, 'supabase', 'baselines', `${highWater}_migration_history.sql`),
  'utf8',
).split(/\r?\n/);
const copyStart = historyLines.findIndex((line) =>
  line.startsWith('COPY "supabase_migrations"."schema_migrations"'),
);
const copyEnd = historyLines.indexOf('\\.', copyStart + 1);
assert.equal(copyStart >= 0 && copyEnd > copyStart, true, 'ledger COPY block not found');
const ledgerNames = new Set(
  historyLines.slice(copyStart + 1, copyEnd).map((line) => line.split('\t')[1]),
);
const expectedPending = allMigrations.filter(
  (name) => name.slice(0, 14) > highWater && !ledgerNames.has(name.slice(0, -4)),
);
assert.deepEqual(
  files.map((file) => path.basename(file)),
  expectedPending,
  'every uncaptured migration newer than the baseline high-water must remain pending, and nothing else',
);
console.log(`POST_BASELINE_MIGRATIONS_PASS pending=${files.length}`);
