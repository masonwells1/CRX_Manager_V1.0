import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureMigrationProofEvidence, reviewableEvidencePaths } from './migration-proof-evidence-hash.mjs';
import { applicationRpcAccessInventory, unresolvedApplicationRpcCallSites } from './rpc-call-site-matcher.mjs';

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
  assert.equal(snapshot.has('.claude/hooks/protected-git.mjs'), true);
  assert.ok(snapshot.paths('supabase/migrations/', (relative) => relative.endsWith('.sql')).length > 0);
  assert.ok(snapshot.paths('src/', (relative) => /\.(?:ts|tsx)$/.test(relative)).length > 0);
  assert.ok(snapshot.paths('supabase/functions/', (relative) => /\.(?:ts|tsx)$/.test(relative)).length > 0);
  assert.deepEqual(unresolvedApplicationRpcCallSites(snapshot), [], 'current production source has no unresolvable dynamic RPC name calls');

  // This independent textual inventory catches a future matcher regression that
  // drops a receiver name before it reaches the proof evidence. The matcher must
  // account for every direct `.rpc` token present in production source.
  const lineAt = (source, index) => source.slice(0, index).split(/\r?\n/).length;
  const matchedSites = new Set(applicationRpcAccessInventory(snapshot).map(({ file, index }) => `${file}:${lineAt(snapshot.text(file), index)}`));
  const missing = [];
  const productionSources = [
    ...snapshot.paths('src/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
    ...snapshot.paths('supabase/functions/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
  ];
  for (const relative of productionSources) {
    const source = snapshot.text(relative);
    for (const match of source.matchAll(/\.\s*rpc\b/g)) {
      const line = lineAt(source, match.index);
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.indexOf('\n', match.index);
      const sourceLine = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
      // This inventory intentionally ignores standalone documentation comments;
      // comment/string boundary behavior belongs to the matcher unit tests above.
      if (/^\s*(?:\/\/|\/\*|\*)/.test(sourceLine)) continue;
      if (!matchedSites.has(`${relative}:${line}`)) missing.push(`${relative}:${line}`);
    }
  }
  assert.deepEqual(missing, [], 'every direct production .rpc access is represented in the proof matcher inventory');
});

test('the proof snapshot includes non-ignored untracked application files', () => {
  const root = process.cwd();
  const probeDir = mkdtempSync(path.join(root, 'src', '.migration-proof-untracked-'));
  const relativeProbe = path.relative(root, path.join(probeDir, 'scratch.ts')).replaceAll('\\', '/');
  try {
    writeFileSync(path.join(probeDir, 'scratch.ts'), "client.rpc('unreviewed_local_scratch')", 'utf8');
    const snapshot = captureMigrationProofEvidence({ projectDir: root, stateDir: path.join(root, '.claude', 'session-state') });
    assert.equal(snapshot.paths('src/').includes(relativeProbe), true);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
});

test('changing the protected Git boundary invalidates migration proof evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'migration-proof-protected-git-'));
  try {
    const helper = path.join(root, '.claude', 'hooks', 'protected-git.mjs');
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, 'export const policy = "first";\n', 'utf8');
    const first = captureMigrationProofEvidence({ projectDir: root }).evidenceHash;
    writeFileSync(helper, 'export const policy = "second";\n', 'utf8');
    const second = captureMigrationProofEvidence({ projectDir: root }).evidenceHash;
    assert.notEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('reviewable evidence uses the fixed Git boundary and rejects malformed or timed-out output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'migration-proof-trusted-git-'));
  const originalGitDir = process.env.GIT_DIR;
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'caller.ts'), "client.rpc('fixture_rpc')", 'utf8');
    process.env.GIT_DIR = 'hostile-index-override';
    let invocation;
    const execute = (binary, args, options) => {
      invocation = { binary, args, options };
      return Buffer.from('src/caller.ts\0', 'utf8');
    };
    assert.deepEqual(reviewableEvidencePaths(root, ['src/'], () => true, { execute }), ['src/caller.ts']);
    assert.match(invocation.binary, /git(?:\.exe)?$/i);
    assert.deepEqual(invocation.args.slice(0, 2), ['--no-replace-objects', '-C']);
    assert.ok(invocation.args.includes('--cached'));
    assert.ok(invocation.args.includes('--others'));
    assert.ok(invocation.args.includes('--exclude-standard'));
    assert.equal(invocation.options.timeout, 1500);
    assert.equal(invocation.options.env.GIT_DIR, undefined);
    assert.throws(
      () => reviewableEvidencePaths(root, ['src/'], () => true, { execute: () => Buffer.from([0xff, 0x00]) }),
      /not valid UTF-8/,
    );
    const timeout = new Error('timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(
      () => reviewableEvidencePaths(root, ['src/'], () => true, { execute: () => { throw timeout; } }),
      /could not enumerate trusted Git reviewable migration-proof evidence/,
    );
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    rmSync(root, { recursive: true, force: true });
  }
});
