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

const pending = migrationFiles.filter((name) => {
  const stem = name.slice(0, -4);
  const version = stem.slice(0, 14);
  if (version <= manifest.migrations_high_water) return false;
  return !capturedNames.has(stem);
});

for (const name of pending) {
  console.log(path.posix.join('supabase', 'migrations', name));
}
