#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [
  ['base.sql', 'scripts/smoke/fixtures/supplier-pricing-phase1a-base.sql'],
  ['phase1a.sql', 'supabase/migrations/20260717042803_supplier_pricing_phase1a.sql'],
  ['compat.sql', 'supabase/migrations/20260717171331_restore_legacy_pricing_version_compat.sql'],
  ['zero-guard.sql', 'supabase/migrations/20260717112011_supplier_pricing_zero_cost_guard.sql'],
  ['seed.sql', 'scripts/smoke/seed-supplier-pricing-phase1a.sql'],
  ['cent-hardening.sql', 'scripts/applied-migration-artifacts/20260718154131_20260718124517_harden_supplier_pricing_cent_scale_and_trigger.live.sql'],
  ['cutover.sql', 'supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql'],
  ['phase1b-base.sql', 'scripts/smoke/fixtures/supplier-cost-basis-phase2-base.sql'],
  ['phase2.sql', 'supabase/migrations/20260722015019_supplier_cost_basis_phase2.sql'],
  ['null-cost-followup.sql', 'supabase/migrations/20260722035521_allow_inert_null_cost_workbook_rows.sql'],
  ['smoke.sql', 'scripts/smoke/smoke-supplier-cost-basis-phase2.sql'],
];
const container = `crx-pricing-phase2-proof-${process.pid}-${Date.now()}`;
const password = 'phase2-disposable-proof';

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

function docker(...args) { return run('docker', args); }
function psql(file) {
  docker('exec', '-e', `PGPASSWORD=${password}`, container, 'psql',
    '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
    '-f', `/tmp/${file}`);
}

let started = false;
try {
  docker('run', '--detach', '--name', container, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
    '--env', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine');
  started = true;

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run('docker', [
      'exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres',
    ],
      { capture: true, allowFailure: true });
    if (result.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL container did not become ready');

  for (const [target, source] of files) {
    docker('cp', path.join(repoRoot, source), `${container}:/tmp/${target}`);
  }
  for (const [target] of files) {
    console.log(`[phase2-proof] applying ${target}`);
    psql(target);
  }
} finally {
  if (started) run('docker', ['rm', '-f', container], { allowFailure: true });
}
