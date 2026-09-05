import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { captureMigrationProofEvidence } from './migration-proof-evidence-hash.mjs';

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
});
