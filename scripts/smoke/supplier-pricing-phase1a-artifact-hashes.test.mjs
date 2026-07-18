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
    'supabase/migrations/20260718124517_harden_supplier_pricing_cent_scale_and_trigger.sql',
    'fa1493ac1183948888890dd5c94dff225c4a5a058a58b227686fcac705645e55',
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

console.log(`supplier-pricing-phase1a-artifact-hashes: ${expectedArtifacts.size} artifacts passed`);
