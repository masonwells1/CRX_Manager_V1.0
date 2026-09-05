import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureMigrationProofEvidence } from './migration-proof-evidence-hash.mjs';
import { unresolvedApplicationRpcCallSites } from './rpc-call-site-matcher.mjs';

test('the proof snapshot retains every repository source used by the evidence renderer', () => {
  const root = process.cwd();
  const snapshot = captureMigrationProofEvidence({
    projectDir: root,
    stateDir: path.join(root, '.claude', 'session-state'),
  });

  assert.equal(snapshot.has('.claude/schema-registry.json'), true);
  assert.equal(snapshot.has('docs/reference/migration-history.md'), true);
  assert.equal(snapshot.has('src/types/index.ts'), true);
  assert.equal(snapshot.has('scripts/rpc-call-site-matcher.mjs'), true);
  assert.ok(snapshot.paths('supabase/migrations/', (relative) => relative.endsWith('.sql')).length > 0);
  assert.ok(snapshot.paths('src/', (relative) => /\.(?:ts|tsx)$/.test(relative)).length > 0);
  assert.ok(snapshot.paths('supabase/functions/', (relative) => /\.(?:ts|tsx)$/.test(relative)).length > 0);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), [], 'current production source has no unresolvable dynamic RPC name calls');
});

test('the proof snapshot excludes untracked application files', () => {
  const root = process.cwd();
  const probeDir = mkdtempSync(path.join(root, 'src', '.migration-proof-untracked-'));
  const relativeProbe = path.relative(root, path.join(probeDir, 'scratch.ts')).replaceAll('\\', '/');
  try {
    writeFileSync(path.join(probeDir, 'scratch.ts'), "client.rpc('unreviewed_local_scratch')", 'utf8');
    const snapshot = captureMigrationProofEvidence({ projectDir: root, stateDir: path.join(root, '.claude', 'session-state') });
    assert.equal(snapshot.paths('src/').includes(relativeProbe), false);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('non-Git test fixtures retain project-relative evidence paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'migration-proof-fixture-'));
  try {
    mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'supabase', 'functions'), { recursive: true });
    writeFileSync(path.join(root, 'supabase', 'migrations', '20260905000000_fixture.sql'), 'select 1;', 'utf8');
    writeFileSync(path.join(root, 'src', 'caller.ts'), "client.rpc('fixture_rpc')", 'utf8');
    writeFileSync(path.join(root, 'supabase', 'functions', 'handler.ts'), "client.rpc('fixture_edge_rpc')", 'utf8');

    const snapshot = captureMigrationProofEvidence({ projectDir: root });
    assert.equal(snapshot.has('supabase/migrations/20260905000000_fixture.sql'), true);
    assert.equal(snapshot.has('src/caller.ts'), true);
    assert.equal(snapshot.has('supabase/functions/handler.ts'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
