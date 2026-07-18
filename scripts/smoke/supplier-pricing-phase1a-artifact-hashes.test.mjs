#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const expectedArtifacts = new Map([
  [
    'supabase/migrations/20260717042803_supplier_pricing_phase1a.sql',
    '63994ba53114d65cb1a4a0b14c4bbe410bc1b5b5159b86a06287b4bdb40d9bcd',
  ],
  [
    'supabase/migrations/20260717112011_supplier_pricing_zero_cost_guard.sql',
    '1c55202509664cfdffb401ad66456bc768b4039a48e542fc33c8bc861efb46f5',
  ],
  [
    'supabase/migrations/20260717171331_restore_legacy_pricing_version_compat.sql',
    '90cbc98a0ff4ea21c15395b378af76b66e6861e3e31fc54fd6770979fdf91799',
  ],
  [
    'scripts/applied-migration-artifacts/20260718154131_20260718124517_harden_supplier_pricing_cent_scale_and_trigger.live.sql',
    '988c36dff572d09eba6f7da3b6d6bc0bac51c2c61ce9bf3756b45f9444965ec3',
  ],
  [
    'supabase/migrations/20260718152837_20260718131500_revert_quote_escape_hatch_for_cancelled_order.sql',
    'c1748f6fb0b180faa5bc24d30d1005916ee99f3012ae5c7757cdeffc8aba212b',
  ],
  [
    'supabase/migrations/20260718153744_20260718124500_harden_prepay_and_payment_role_gate.sql',
    'd2b29457b2e7e3584127e317a86477e518c40f72a2c83f526d0c70b4c41ebc3e',
  ],
  [
    'supabase/migrations/20260718154810_20260718133000_void_invoice_block_applied_payments.sql',
    '7250e762ccecbb6381eb4719a881ce9e7b8805eb3838fa31d24b1ecfa0aedfb2',
  ],
]);

const expectedReplayArtifacts = new Map([
  [
    'supabase/migrations/20260718124517_harden_supplier_pricing_cent_scale_and_trigger.sql',
    '7253a9a5d0bba12dfb7e958f46c8664eabe4856f6a3e5e1296b9f4852dbb3426',
  ],
  [
    'supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql',
    '7a1a018712ef632ae8f2bc9a2d24e80e261e265f7c596c8d2028f49adf5ecaca',
  ],
  [
    'supabase/migrations/20260718193000_supplier_pricing_phase1a_data_integrity_rescan.sql',
    '27f96801f55f3b850a8925c941959d68d4f0779b44a6bd3b575e57d8229a168b',
  ],
]);

function readGitIndexBytes(relativePath) {
  const result = spawnSync('git', ['show', `:${relativePath}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git index read failed for ${relativePath}: ${result.stderr}`);
  return result.stdout;
}

for (const [relativePath, expectedSha256] of expectedArtifacts) {
  const bytes = readGitIndexBytes(relativePath);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    actualSha256,
    expectedSha256,
    `${relativePath} bytes changed; applied supplier-pricing migrations must remain byte-identical`
  );
}

for (const [relativePath, expectedSha256] of expectedReplayArtifacts) {
  const bytes = readGitIndexBytes(relativePath);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    actualSha256,
    expectedSha256,
    `${relativePath} bytes changed; reviewed reconstruction migrations must remain pinned`
  );
}

const bootstrapPath = 'supabase/migrations/20260717042803_supplier_pricing_phase1a.sql';
const bootstrapBytes = readGitIndexBytes(bootstrapPath);
assert.ok(bootstrapBytes.includes(Buffer.from('\r\n')), `${bootstrapPath} must retain CRLF bytes`);
const normalizedBootstrapSha256 = createHash('sha256')
  .update(Buffer.from(bootstrapBytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))
  .digest('hex');
assert.notEqual(
  normalizedBootstrapSha256,
  expectedArtifacts.get(bootstrapPath),
  'the regression guard must detect CRLF-to-LF normalization'
);

console.log(
  `supplier-pricing-phase1a-artifact-hashes: ${expectedArtifacts.size} live artifacts and ${expectedReplayArtifacts.size} replay artifacts passed`
);
