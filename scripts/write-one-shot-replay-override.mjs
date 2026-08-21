#!/usr/bin/env node
// Write the single-use authorization consumed by migration-apply-guard.mjs.
// This fixed wrapper replaces a copy-ready inline program: every identifier is
// validated, the migration path is contained to supabase/migrations, registry
// prose is never reflected, and an existing authorization is never replaced.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validMigrationStem,
  validProjectRef,
  validRegistryReason,
} from '../.claude/hooks/guard-input-validation.mjs';

export function validateMigrationStem(value) {
  if (!validMigrationStem(value)) {
    throw new Error('migration must be a validated 8- or 14-digit timestamp stem');
  }
  return value;
}

export function validateProjectRef(value) {
  if (!validProjectRef(value)) {
    throw new Error('project must contain only lowercase ASCII letters, digits, underscores, or hyphens');
  }
  return value;
}

function requireRegistryReason(value) {
  if (!validRegistryReason(value)) {
    throw new Error('one-shot registry contains an invalid metadata value');
  }
}

export function migrationPath(projectDir, migration) {
  const stem = validateMigrationStem(migration);
  const migrationsDir = path.resolve(projectDir, 'supabase', 'migrations');
  const resolved = path.resolve(migrationsDir, `${stem}.sql`);
  if (path.dirname(resolved) !== migrationsDir) {
    throw new Error('migration path escaped supabase/migrations');
  }
  return resolved;
}

export function readOneShotRegistry(projectDir) {
  const registryPath = path.resolve(
    projectDir,
    'supabase',
    'baselines',
    'one-shot-migrations.json',
  );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    throw new Error('one-shot registry failed strict parsing');
  }
  const map = parsed?.one_shot;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('one-shot registry has no plain one_shot map');
  }
  const stems = new Set();
  for (const [stem, reason] of Object.entries(map)) {
    validateMigrationStem(stem);
    requireRegistryReason(reason);
    stems.add(stem);
  }
  return stems;
}

export function buildOverride({
  projectDir,
  migration,
  queryMigration = migration,
  project,
  now = new Date(),
}) {
  const stem = validateMigrationStem(migration);
  const queryStem = validateMigrationStem(queryMigration);
  const projectRef = validateProjectRef(project);
  const registered = readOneShotRegistry(projectDir);
  if (!registered.has(stem)) {
    throw new Error('migration is not registered as a one-shot data repair');
  }
  const sourcePath = migrationPath(projectDir, queryStem);
  if (!existsSync(sourcePath)) throw new Error('query migration SQL is missing');
  const query = readFileSync(sourcePath, 'utf8');
  const issuedAt = now.toISOString();
  return {
    migration: stem,
    queryMigration: queryStem,
    queryHash: createHash('sha256').update(query).digest('hex'),
    project: projectRef,
    issuedAt,
  };
}

export function writeOverride({
  projectDir,
  migration,
  queryMigration = migration,
  project,
  now = new Date(),
}) {
  const payload = buildOverride({ projectDir, migration, queryMigration, project, now });
  const stateDir = path.resolve(projectDir, '.claude', 'session-state');
  mkdirSync(stateDir, { recursive: true });
  const outputPath = path.join(stateDir, 'one-shot-replay-override.json');
  writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { outputPath, payload };
}

export function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--migration', '--query-migration', '--project'].includes(flag) ||
        value === undefined || values.has(flag)) {
      throw new Error(
        'usage: write-one-shot-replay-override --migration <registered-stem> ' +
        '[--query-migration <current-query-stem>] --project <ref>',
      );
    }
    values.set(flag, value);
  }
  if (!values.has('--migration') || !values.has('--project') || values.size > 3) {
    throw new Error(
      'usage: write-one-shot-replay-override --migration <registered-stem> ' +
      '[--query-migration <current-query-stem>] --project <ref>',
    );
  }
  return {
    migration: validateMigrationStem(values.get('--migration')),
    queryMigration: values.has('--query-migration')
      ? validateMigrationStem(values.get('--query-migration'))
      : undefined,
    project: validateProjectRef(values.get('--project')),
  };
}

function main() {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  const { outputPath, payload } = writeOverride({ projectDir, ...args });
  process.stdout.write(
    `Wrote one single-use replay authorization to ${outputPath}. ` +
    `It hashes the exact bytes of supabase/migrations/${payload.queryMigration}.sql. ` +
    `It is valid for the next guarded apply attempt only.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Refused to write replay authorization: ${error?.message || 'validation failed'}\n`);
    process.exitCode = 1;
  }
}
