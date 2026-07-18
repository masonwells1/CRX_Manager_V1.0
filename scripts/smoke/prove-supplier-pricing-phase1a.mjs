#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
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
  '20260717042803_supplier_pricing_phase1a.sql'
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
  'supabase',
  'migrations',
  '20260718190000_supplier_pricing_phase1a_cutover.sql'
);
const forwardCorrectionSql = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260718124517_harden_supplier_pricing_cent_scale_and_trigger.sql'
);
const forwardCorrectionSmokeSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a-forward-correction.sql'
);
const zeroCostGuardSql = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260717112011_supplier_pricing_zero_cost_guard.sql'
);
const pricingVersionCompatSql = path.join(
  repoRoot, 'supabase', 'migrations',
  '20260717171331_restore_legacy_pricing_version_compat.sql'
);
const zeroCostGuardSmokeSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a-zero-cost-guard.sql'
);
const smokeSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a.sql'
);
const workbookExportSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'export-supplier-pricing-phase1a-workbook.sql'
);
const workbookSmokeSql = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'smoke-supplier-pricing-phase1a-xlsx.sql'
);
const workbookRoundtripScript = path.join(
  repoRoot,
  'scripts',
  'smoke',
  'roundtrip-supplier-pricing-phase1a-workbook.ts'
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

function psqlCapture(fileName) {
  return run(
    'docker',
    [
      'exec', '-e', `PGPASSWORD=${password}`, container,
      'psql', '-qAt', '-U', 'postgres', '-d', 'postgres', '-X',
      '-v', 'ON_ERROR_STOP=1', '-f', `/tmp/${fileName}`,
    ],
    { capture: true }
  ).stdout.trim();
}

let started = false;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-phase1a-xlsx-'));
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
  copyToContainer(pricingVersionCompatSql, 'pricing-version-compat.sql');
  copyToContainer(seedSql, 'seed.sql');
  copyToContainer(zeroCostGuardSql, 'zero-cost-guard.sql');
  copyToContainer(zeroCostGuardSmokeSql, 'zero-cost-guard-smoke.sql');
  copyToContainer(cutoverSql, 'cutover.sql');
  copyToContainer(forwardCorrectionSql, 'forward-correction.sql');
  copyToContainer(forwardCorrectionSmokeSql, 'forward-correction-smoke.sql');
  copyToContainer(smokeSql, 'smoke.sql');
  copyToContainer(workbookExportSql, 'xlsx-export.sql');
  copyToContainer(workbookSmokeSql, 'xlsx-smoke.sql');

  console.log('[phase1a-proof] compiling live-shaped base fixture');
  psql('base.sql');
  console.log('[phase1a-proof] compiling the live additive compatibility bootstrap');
  psql('bootstrap.sql');
  console.log('[phase1a-proof] restoring repeat-save compatibility for the deployed legacy Product form');
  psql('pricing-version-compat.sql');
  console.log('[phase1a-proof] proving compatibility with the deployed legacy frontend');
  psql('bootstrap-compat.sql');
  console.log('[phase1a-proof] compiling the live pre-deploy zero-cost guard');
  psql('zero-cost-guard.sql');
  console.log('[phase1a-proof] proving the guard blocks governed zero cost without breaking legacy mode');
  psql('zero-cost-guard-smoke.sql');
  console.log('[phase1a-proof] seeding pre-cutover live-shaped Products');
  psql('seed.sql');
  console.log('[phase1a-proof] proving the forward preflight fails closed on fractional-cent drift');
  run('docker', [
    'exec', '-e', `PGPASSWORD=${password}`, container,
    'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
    '-c', "SET session_replication_role = replica; UPDATE public.products SET current_cost = 20.001 WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;",
  ]);
  const driftResult = run(
    'docker',
    [
      'exec', '-e', `PGPASSWORD=${password}`, container,
      'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
      '-f', '/tmp/forward-correction.sql',
    ],
    { capture: true, allowFailure: true }
  );
  const driftOutput = `${driftResult.stdout || ''}\n${driftResult.stderr || ''}`;
  if (driftResult.status === 0
      || !driftOutput.includes('PHASE1A_FRACTIONAL_CENT_PRODUCT_VALUES')
      || !driftOutput.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5')) {
    throw new Error(`Forward preflight did not fail closed with the offending Product id:\n${driftOutput}`);
  }
  run('docker', [
    'exec', '-e', `PGPASSWORD=${password}`, container,
    'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
    '-c', "SET session_replication_role = replica; UPDATE public.products SET current_cost = 20.00 WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'::uuid;",
  ]);
  console.log('[phase1a-proof] applying parked forward corrections in disposable DB');
  psql('forward-correction.sql');
  console.log('[phase1a-proof] re-proving legacy Product compatibility after the forward correction');
  psql('bootstrap-compat.sql');
  console.log('[phase1a-proof] proving the forward correction before the enforcement cutover');
  psql('forward-correction-smoke.sql');
  console.log('[phase1a-proof] compiling parked enforcement cutover');
  psql('cutover.sql');
  console.log('[phase1a-proof] exercising .xlsx generator/parser against real PostgreSQL RPCs');
  const exportOutput = psqlCapture('xlsx-export.sql');
  const exportLine = exportOutput.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
  if (!exportLine) throw new Error(`Workbook export RPC did not return JSON: ${exportOutput}`);
  const exportPayload = JSON.parse(exportLine);
  if (!Array.isArray(exportPayload.rows) || exportPayload.rows.length !== 3) {
    throw new Error('Workbook export RPC did not return the expected 3 Product rows');
  }
  const exportJsonPath = path.join(tempDir, 'export.json');
  const parsedPayloadPath = path.join(tempDir, 'parsed.json');
  const exportedWorkbookPath = path.join(tempDir, 'export.xlsx');
  const proofOutputDir = path.join(repoRoot, 'output', 'phase1a-db');
  fs.mkdirSync(proofOutputDir, { recursive: true });
  // Keep the temporary ESM bundle under the repo so external packages resolve
  // through this checkout's node_modules. It is ignored and removed on success.
  const workbookRoundtripBundle = path.join(proofOutputDir, '.roundtrip-workbook.mjs');
  const editedWorkbookPath = path.join(proofOutputDir, 'phase1a-xlsx-to-real-db.xlsx');
  fs.writeFileSync(exportJsonPath, JSON.stringify(exportPayload));
  buildSync({
    entryPoints: [workbookRoundtripScript],
    outfile: workbookRoundtripBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  run(process.execPath, [
    workbookRoundtripBundle,
    exportJsonPath, parsedPayloadPath, exportedWorkbookPath, editedWorkbookPath,
  ]);
  fs.rmSync(workbookRoundtripBundle, { force: true });
  copyToContainer(parsedPayloadPath, 'phase1a-workbook-payload.json');
  psql('xlsx-smoke.sql');
  console.log('[phase1a-proof] exercising RPC, conflict, atomicity, history, and privilege flows');
  psql('smoke.sql');
  console.log('[phase1a-proof] PASS');
} finally {
  if (started) {
    run('docker', ['rm', '--force', container], { allowFailure: true });
  }
  const resolvedTemp = path.resolve(tempDir);
  const resolvedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolvedTemp.startsWith(resolvedRoot)) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
