#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(root, 'supabase', 'baselines');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const manifest = JSON.parse(readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));
const history = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_migration_history.sql`),
  'utf8',
);

const lines = history.split(/\r?\n/);
const copyStart = lines.findIndex((line) =>
  line.startsWith('COPY "supabase_migrations"."schema_migrations"'),
);
const copyEnd = lines.indexOf('\\.', copyStart + 1);
if (copyStart < 0 || copyEnd < 0) {
  throw new Error('baseline migration-history COPY block is missing');
}

const capturedNames = new Set(
  lines.slice(copyStart + 1, copyEnd).map((line) => line.split('\t')[1]),
);
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d{14}_.+\.sql$/.test(name))
  .sort();

export function listPostBaselineMigrations(migrationNames, highWater, ledgerNames) {
  return migrationNames.filter((name) => {
    const stem = name.slice(0, -4);
    const version = stem.slice(0, 14);
    if (version <= highWater) return false;
    return !ledgerNames.has(stem);
  });
}

/**
 * Split the pending set into what a rebuild may replay and what it may not.
 *
 * A one-shot DATA migration rewrote specific rows that existed on production at
 * a specific moment. Replaying it on a database whose ledger lacks it points
 * that same edit at a DIFFERENT population — which is an unapproved money
 * mutation, not a rebuild. Schema and function migrations are unaffected: they
 * are idempotent by contract and stay in the plan.
 */
export function partitionOneShot(pending, oneShotStems) {
  const replay = [];
  const quarantined = [];
  for (const name of pending) {
    (oneShotStems.has(name.slice(0, -4)) ? quarantined : replay).push(name);
  }
  return { replay, quarantined };
}

const registry = JSON.parse(readFileSync(path.join(baselineDir, 'one-shot-migrations.json'), 'utf8'));
const oneShotStems = new Set(Object.keys(registry.one_shot ?? {}));

const pending = listPostBaselineMigrations(
  migrationFiles,
  manifest.migrations_high_water,
  capturedNames,
);
const { replay, quarantined } = partitionOneShot(pending, oneShotStems);
const includeOneShot = process.argv.includes('--include-one-shot');
const repairPlan = process.argv.includes('--one-shot-repair-plan');

if (repairPlan) {
  for (const name of quarantined) {
    console.log(
      `supabase migration repair ${name.slice(0, 14)} --status applied --db-url "$DATABASE_URL"`,
    );
  }
} else {
  for (const name of includeOneShot ? pending : replay) {
    console.log(path.posix.join('supabase', 'migrations', name));
  }
}

// stderr, not stdout: the plan on stdout must stay directly runnable, and a
// withheld money migration must never be silently absent from it.
if (quarantined.length > 0) {
  const verb = includeOneShot ? 'INCLUDED BY --include-one-shot' : 'WITHHELD from the replay plan';
  process.stderr.write(`\nONE-SHOT DATA MIGRATION(S) ${verb}:\n`);
  for (const name of quarantined) {
    process.stderr.write(`  ${name}\n    ${registry.one_shot[name.slice(0, -4)]}\n`);
  }
  process.stderr.write(
    repairPlan
      ? '  Run this plan only AFTER independently proving the restored data already\n' +
        '  contains every correction. It records the skipped versions so a later\n' +
        '  unfiltered push cannot rediscover them.\n\n'
      : includeOneShot
        ? '  Replaying these rewrites rows on THIS database. Only do it against a ledger\n' +
          '  you have proven matches the population the migration was approved against.\n\n'
        : '  These edited data, not schema. After a restore the corrected values come back\n' +
          '  with the DATA restore. Pass --include-one-shot only after proving the target\n' +
          '  population matches the one each migration was approved against. After the\n' +
          '  filtered push and data proof, run --one-shot-repair-plan so the skipped\n' +
          '  versions cannot be rediscovered by a later unfiltered push.\n\n',
  );
}
