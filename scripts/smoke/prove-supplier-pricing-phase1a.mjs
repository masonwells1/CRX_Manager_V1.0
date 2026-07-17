#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'fixtures',
  'supplier-pricing-phase1a-base.sql'
);
const bootstrapSql = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260717025710_supplier_pricing_phase1a.sql'
);
const bootstrapCompatSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a-bootstrap-compat.sql'
);
const seedSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'seed-supplier-pricing-phase1a.sql'
);
const cutoverSql = path.join(
  repoRoot,
  'scripts',
  '.staging-migrations',
  '20260717030000_supplier_pricing_phase1a_cutover.sql'
);
const smokeSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a.sql'
);

const container = `crx-pricing-phase1a-proof-${process.pid}-${Date.now()}`;
const password = 'phase1a-disposable-proof';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(`${command} exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function docker(...args) {
  return run('docker', args);
}

function copyToContainer(localPath, targetName) {
  docker('cp', localPath, `${container}:/tmp/${targetName}`);
}

function psql(fileName) {
  docker(
    'exec',
    '-e',
    `PGPASSWORD=${password}`,
    container,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    `/tmp/${fileName}`
  );
}

let started = false;
try {
  docker(
    'run',
    '--detach',
    '--name',
    container,
    '--network',
    'none',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    'postgres:17-alpine'
  );
  started = true;

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { capture: true, allowFailure: true }
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL container did not become ready');

  copyToContainer(baseSql, 'base.sql');
  copyToContainer(bootstrapSql, 'bootstrap.sql');
  copyToContainer(bootstrapCompatSql, 'bootstrap-compat.sql');
  copyToContainer(seedSql, 'seed.sql');
  copyToContainer(cutoverSql, 'cutover.sql');
  copyToContainer(smokeSql, 'smoke.sql');

  console.log('[phase1a-proof] compiling live-shaped base fixture');
  psql('base.sql');
  console.log('[phase1a-proof] compiling parked additive bootstrap');
  psql('bootstrap.sql');
  console.log('[phase1a-proof] proving compatibility with the deployed legacy frontend');
  psql('bootstrap-compat.sql');
  console.log('[phase1a-proof] seeding pre-cutover live-shaped Products');
  psql('seed.sql');
  console.log('[phase1a-proof] compiling parked enforcement cutover');
  psql('cutover.sql');
  console.log('[phase1a-proof] exercising RPC, conflict, atomicity, history, and privilege flows');
  psql('smoke.sql');
  console.log('[phase1a-proof] PASS');
} finally {
  if (started) {
    run('docker', ['rm', '--force', container], { allowFailure: true });
  }
}
