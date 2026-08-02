#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  ['null-cost-overload-guard.sql', 'supabase/migrations/20260722042515_assert_supplier_cost_basis_followup_overloads.sql'],
  ['null-cost-overload-guard-replay.sql', 'supabase/migrations/20260722043537_assert_supplier_cost_basis_followup_overloads_replay.sql'],
  ['wells-rollout-seed.sql', 'scripts/smoke/seed-wells-cost-basis-rollout.sql'],
  ['wells-rollout-flag-true.sql', 'scripts/smoke/smoke-wells-cost-basis-rollout-flag-true.sql'],
  ['wells-rollout-flag-missing.sql', 'scripts/smoke/smoke-wells-cost-basis-rollout-flag-missing.sql'],
  ['wells-rollout-nonreusable.sql', 'scripts/smoke/smoke-wells-cost-basis-rollout-nonreusable.sql'],
  ['wells-rollout-observation-link.sql', 'scripts/smoke/smoke-wells-cost-basis-rollout-observation-link.sql'],
  ['wells-rollout.sql', 'supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql'],
  ['po-reassignment-guard.sql', 'supabase/migrations/20260722080226_lock_received_po_cost_snapshot_across_product_reassignment.sql'],
  ['workbook-v2.sql', 'supabase/migrations/20260722091359_supplier_pricing_workbook_v2_product_info.sql'],
  ['inner-rpc-revoke.sql', 'supabase/migrations/20260722100456_revoke_inner_pricing_rpc_access.sql'],
  ['xlsx-export.sql', 'scripts/smoke/export-supplier-pricing-phase1a-workbook.sql'],
  ['xlsx-current-wrappers.sql', 'scripts/smoke/smoke-supplier-cost-basis-phase2-xlsx.sql'],
  ['smoke.sql', 'scripts/smoke/smoke-supplier-cost-basis-phase2.sql'],
];
const container = `crx-pricing-phase2-proof-${process.pid}-${Date.now()}`;
const password = 'phase2-disposable-proof';
const workbookRoundtripScript = path.join(
  repoRoot, 'scripts', 'smoke', 'roundtrip-supplier-pricing-phase1a-workbook.ts',
);

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

function psqlCapture(file) {
  return run('docker', [
    'exec', '-e', `PGPASSWORD=${password}`, container,
    'psql', '-qAt', '-U', 'postgres', '-d', 'postgres', '-X',
    '-v', 'ON_ERROR_STOP=1', '-f', `/tmp/${file}`,
  ], { capture: true }).stdout.trim();
}

function psqlExpectedFailure(file, token) {
  const result = run('docker', [
    'exec', '-e', `PGPASSWORD=${password}`, container, 'psql',
    '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
    '-f', `/tmp/${file}`,
  ], { capture: true, allowFailure: true });
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 || !detail.includes(token)) {
    throw new Error(
      `Expected ${file} to fail with ${token}; status=${result.status}\n${detail}`,
    );
  }
  console.log(`[phase2-proof] expected failure confirmed: ${token}`);
}

let started = false;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-phase2-xlsx-'));
let workbookRoundtripBundle;
let costBasisRowsBundle;
let supplierEvidenceWorkbookBundle;
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
    if (target === 'xlsx-export.sql' || target === 'xlsx-current-wrappers.sql' || target === 'smoke.sql') continue;
    console.log(`[phase2-proof] applying ${target}`);
    if (target === 'wells-rollout-flag-true.sql'
        || target === 'wells-rollout-flag-missing.sql') {
      psqlExpectedFailure(target, 'WELLS_COST_BASIS_ROLLOUT_GLOBAL_FLAG_DRIFT');
    } else if (target === 'wells-rollout-nonreusable.sql') {
      psqlExpectedFailure(target, 'WELLS_COST_BASIS_ROLLOUT_LINK_SHAPE_DRIFT');
    } else if (target === 'wells-rollout-observation-link.sql') {
      psqlExpectedFailure(target, 'WELLS_COST_BASIS_ROLLOUT_OBSERVATION_SHAPE_DRIFT');
    } else {
      psql(target);
    }
  }
  console.log('[phase2-proof] exercising supplier-evidence .xlsx generator/parser through current wrappers');
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
  const proofOutputDir = path.join(repoRoot, 'output', 'phase2-db');
  fs.mkdirSync(proofOutputDir, { recursive: true });
  // Keep the temporary ESM bundle under the repo so external packages resolve
  // through this checkout's node_modules; the guarded finally cleanup removes it.
  workbookRoundtripBundle = path.join(
    proofOutputDir, `.roundtrip-supplier-evidence-${process.pid}-${Date.now()}.mjs`,
  );
  const costBasisRowsEntry = path.join(tempDir, 'cost-basis-rows-entry.ts');
  costBasisRowsBundle = path.join(
    proofOutputDir, `.cost-basis-rows-${process.pid}-${Date.now()}.mjs`,
  );
  const supplierEvidenceWorkbookEntry = path.join(tempDir, 'supplier-evidence-workbook-entry.ts');
  supplierEvidenceWorkbookBundle = path.join(
    proofOutputDir, `.supplier-evidence-workbook-${process.pid}-${Date.now()}.mjs`,
  );
  const editedWorkbookPath = path.join(proofOutputDir, 'phase2-supplier-evidence-xlsx-to-real-db.xlsx');
  fs.writeFileSync(exportJsonPath, JSON.stringify(exportPayload));
  fs.writeFileSync(
    costBasisRowsEntry,
    `export { costBasisRows } from ${JSON.stringify(
      path.join(repoRoot, 'src', 'lib', 'productPricing.ts'),
    )};\n`,
  );
  fs.writeFileSync(
    supplierEvidenceWorkbookEntry,
    `export {\n  generateProductPricingWorkbookWithSupplierEvidence,\n  parseProductPricingWorkbookWithSupplierEvidence,\n} from ${JSON.stringify(
      path.join(repoRoot, 'src', 'lib', 'productPricingSupplierEvidenceWorkbook.ts'),
    )};\n`,
  );
  buildSync({
    entryPoints: [workbookRoundtripScript],
    outfile: workbookRoundtripBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  buildSync({
    entryPoints: [costBasisRowsEntry],
    outfile: costBasisRowsBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    define: {
      'import.meta.env': JSON.stringify({
        VITE_SUPABASE_URL: 'https://example.invalid',
        VITE_SUPABASE_ANON_KEY: 'disposable-workbook-proof-key',
      }),
      window: 'globalThis',
    },
  });
  buildSync({
    entryPoints: [supplierEvidenceWorkbookEntry],
    outfile: supplierEvidenceWorkbookBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    define: {
      'import.meta.env': JSON.stringify({
        VITE_SUPABASE_URL: 'https://example.invalid',
        VITE_SUPABASE_ANON_KEY: 'disposable-workbook-proof-key',
      }),
      window: 'globalThis',
    },
  });
  run(process.execPath, [
    workbookRoundtripBundle, exportJsonPath, parsedPayloadPath, exportedWorkbookPath,
    editedWorkbookPath, 'supplier-evidence',
  ], {
    env: {
      ...process.env,
      CRX_COST_BASIS_ROWS_MODULE: pathToFileURL(costBasisRowsBundle).href,
      CRX_SUPPLIER_EVIDENCE_WORKBOOK_MODULE: pathToFileURL(supplierEvidenceWorkbookBundle).href,
    },
  });
  console.log('[phase2-proof] PHASE2_XLSX_GENERATE_PARSE_PASS');
  docker('cp', parsedPayloadPath, `${container}:/tmp/phase2-workbook-payload.json`);
  psql('xlsx-current-wrappers.sql');
  console.log('[phase2-proof] exercising existing Phase 2 smoke');
  psql('smoke.sql');
} finally {
  if (started) run('docker', ['rm', '-f', container], { allowFailure: true });
  if (workbookRoundtripBundle) fs.rmSync(workbookRoundtripBundle, { force: true });
  if (costBasisRowsBundle) fs.rmSync(costBasisRowsBundle, { force: true });
  if (supplierEvidenceWorkbookBundle) fs.rmSync(supplierEvidenceWorkbookBundle, { force: true });
  const resolvedTemp = path.resolve(tempDir);
  const resolvedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolvedTemp.startsWith(resolvedRoot)) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
