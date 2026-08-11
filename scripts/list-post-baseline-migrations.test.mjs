import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPostBaselineMigrations, partitionOneShot } from './list-post-baseline-migrations.mjs';

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
assert.deepEqual(
  partitionOneShot(['20260720210000_alpha.sql', '20260720230000_beta.sql'], new Set(['20260720210000_alpha'])),
  { replay: ['20260720230000_beta.sql'], quarantined: ['20260720210000_alpha.sql'] },
  'a registered one-shot data migration is held out of the replay plan, everything else stays',
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

// The replay plan is the pending set MINUS registered one-shot data migrations.
// Those rewrote rows that existed on production at one moment; pointing them at
// a restored or drifted population is an unapproved money mutation, so a rebuild
// must not be handed them by default.
const registry = JSON.parse(
  readFileSync(path.join(root, 'supabase', 'baselines', 'one-shot-migrations.json'), 'utf8'),
);
const oneShotStems = new Set(Object.keys(registry.one_shot ?? {}));
assert.equal(oneShotStems.size > 0, true, 'the one-shot registry must not be empty');
for (const stem of oneShotStems) {
  assert.equal(
    typeof registry.one_shot[stem] === 'string' && registry.one_shot[stem].length > 40,
    true,
    `${stem} needs a real reason in the registry, not a placeholder`,
  );
  assert.equal(
    allMigrations.includes(`${stem}.sql`),
    true,
    `${stem} is registered as one-shot but no such migration exists — a typo silently quarantines nothing`,
  );
}
const expectedReplay = expectedPending.filter((name) => !oneShotStems.has(name.slice(0, -4)));
const expectedQuarantined = expectedPending.filter((name) => oneShotStems.has(name.slice(0, -4)));
assert.deepEqual(
  files.map((file) => path.basename(file)),
  expectedReplay,
  'the replay plan is every uncaptured migration newer than the high-water except registered one-shot data migrations',
);
for (const name of expectedQuarantined) {
  assert.equal(
    result.stderr.includes(name),
    true,
    `${name} is withheld from the plan, so the operator must be told on stderr — silence would read as "nothing was skipped"`,
  );
}

// The escape hatch has to actually exist, or an operator who genuinely needs the
// migration will edit the script under pressure instead.
const forced = spawnSync(
  process.execPath,
  ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(forced.status, 0, forced.stderr);
assert.deepEqual(
  forced.stdout.trim().split(/\r?\n/).filter(Boolean).map((file) => path.basename(file)),
  expectedPending,
  '--include-one-shot restores the withheld migrations to the plan',
);

const repairPlan = spawnSync(
  process.execPath,
  ['scripts/list-post-baseline-migrations.mjs', '--one-shot-repair-plan'],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(repairPlan.status, 0, repairPlan.stderr);
assert.deepEqual(
  repairPlan.stdout.trim().split(/\r?\n/).filter(Boolean),
  expectedQuarantined.map(
    (name) =>
      `supabase migration repair ${name.slice(0, 14)} --status applied --db-url "$DATABASE_URL"`,
  ),
  'the recovery plan records every skipped version so later unfiltered pushes cannot rediscover it',
);
assert.equal(
  repairPlan.stderr.includes('only AFTER independently proving the restored data'),
  expectedQuarantined.length > 0,
  'the executable repair plan must retain the data-proof warning',
);

console.log(
  `POST_BASELINE_MIGRATIONS_PASS replay=${files.length} one_shot_withheld=${expectedQuarantined.length}`,
);
