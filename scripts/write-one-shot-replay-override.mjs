#!/usr/bin/env node
// Write the single-use authorization consumed by migration-apply-guard.mjs.
// This fixed wrapper replaces a copy-ready inline program: every identifier is
// validated, the migration path is contained to supabase/migrations, registry
// prose is never reflected, and an existing authorization is never replaced.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_STEM_RE = /^\d{8}(?:\d{6})?_[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/;
const PROJECT_REF_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateMigrationStem(value) {
  if (typeof value !== 'string' || !MIGRATION_STEM_RE.test(value)) {
    throw new Error('migration must be a validated 8- or 14-digit timestamp stem');
  }
  return value;
}

export function validateProjectRef(value) {
  if (typeof value !== 'string' || !PROJECT_REF_RE.test(value)) {
    throw new Error('project must contain only lowercase ASCII letters, digits, underscores, or hyphens');
  }
  return value;
}

function validateRegistryReason(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
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
    validateRegistryReason(reason);
    stems.add(stem);
  }
  return stems;
}

export function buildOverride({ projectDir, migration, project, now = new Date() }) {
  const stem = validateMigrationStem(migration);
  const projectRef = validateProjectRef(project);
  const registered = readOneShotRegistry(projectDir);
  if (!registered.has(stem)) {
    throw new Error('migration is not registered as a one-shot data repair');
  }
  const sourcePath = migrationPath(projectDir, stem);
  if (!existsSync(sourcePath)) throw new Error('registered migration SQL is missing');
  const query = readFileSync(sourcePath, 'utf8');
  const issuedAt = now.toISOString();
  return {
    migration: stem,
    queryHash: createHash('sha256').update(query).digest('hex'),
    project: projectRef,
    issuedAt,
  };
}

export function writeOverride({ projectDir, migration, project, now = new Date() }) {
  const payload = buildOverride({ projectDir, migration, project, now });
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
    if (!['--migration', '--project'].includes(flag) || value === undefined || values.has(flag)) {
      throw new Error('usage: write-one-shot-replay-override --migration <stem> --project <ref>');
    }
    values.set(flag, value);
  }
  if (values.size !== 2) {
    throw new Error('usage: write-one-shot-replay-override --migration <stem> --project <ref>');
  }
  return {
    migration: validateMigrationStem(values.get('--migration')),
    project: validateProjectRef(values.get('--project')),
  };
}

function main() {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  const { outputPath } = writeOverride({ projectDir, ...args });
  process.stdout.write(
    `Wrote one single-use replay authorization to ${outputPath}. ` +
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
