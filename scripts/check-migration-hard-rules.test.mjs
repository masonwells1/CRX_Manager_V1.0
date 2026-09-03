#!/usr/bin/env node
// Regression tests for scripts/check-migration-hard-rules.mjs.
//
// Two layers: pure-function tests for the SQL matcher and the change
// classifier, then end-to-end runs of the CLI against throwaway git
// repositories so the merge-base, base-tree registry read, and exit codes are
// exercised for real. Every acceptance rule has a near-miss DENY canary beside
// it, so a widened matcher that can no longer fire is caught here rather than
// on a live PR.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeMigrationSql,
  classifyMigrationChanges,
  migrationVersion,
  normalizeRelationName,
  parseNameStatus,
  readHighWater,
  runDiffCheck,
} from './check-migration-hard-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'check-migration-hard-rules.mjs');

let assertions = 0;
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
};
const ok = (value, message) => {
  assert.ok(value, message);
  assertions += 1;
};

// ---------------------------------------------------------------------------
// Pure: SQL matcher
// ---------------------------------------------------------------------------

eq(normalizeRelationName('widgets'), 'public.widgets', 'unqualified name defaults to public');
eq(normalizeRelationName('"Public"."Widgets"'), 'public.widgets', 'quotes stripped, lowercased');
eq(normalizeRelationName('private.widgets'), 'private.widgets', 'explicit schema kept');

const GOOD = `
-- CREATE TABLE inside a comment must not count: fake_table
CREATE TABLE IF NOT EXISTS public.widgets (
  id uuid PRIMARY KEY,
  amount_cents bigint NOT NULL
);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY widgets_read ON public.widgets FOR SELECT USING (true);
`;
eq(analyzeMigrationSql(GOOD).violations, [], 'RLS + policy in the same file passes');
eq(analyzeMigrationSql(GOOD).tables, ['public.widgets'], 'comment-only CREATE TABLE is not a table');

const UNQUALIFIED = `
CREATE TABLE widgets (id uuid PRIMARY KEY);
ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON widgets USING (true);
`;
eq(analyzeMigrationSql(UNQUALIFIED).violations, [], 'unqualified spellings match each other');

const MIXED_QUALIFICATION = `
CREATE TABLE widgets (id uuid PRIMARY KEY);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "p" ON "public"."widgets" USING (true);
`;
eq(analyzeMigrationSql(MIXED_QUALIFICATION).violations, [], 'public. prefix and quotes are equivalent');

const NO_RLS = `CREATE TABLE public.widgets (id uuid PRIMARY KEY);`;
eq(analyzeMigrationSql(NO_RLS).violations.length, 1, 'DENY canary: table with nothing else fails');
eq(
  analyzeMigrationSql(NO_RLS).violations[0].missing,
  ['ALTER TABLE ... ENABLE ROW LEVEL SECURITY', 'CREATE POLICY ... ON <table>'],
  'both requirements named',
);

const RLS_NO_POLICY = `
CREATE TABLE public.widgets (id uuid PRIMARY KEY);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
`;
eq(analyzeMigrationSql(RLS_NO_POLICY).violations[0].missing, ['CREATE POLICY ... ON <table>'], 'DENY canary: RLS without a policy fails');

const POLICY_NO_RLS = `
CREATE TABLE public.widgets (id uuid PRIMARY KEY);
CREATE POLICY p ON public.widgets USING (true);
`;
eq(analyzeMigrationSql(POLICY_NO_RLS).violations[0].missing, ['ALTER TABLE ... ENABLE ROW LEVEL SECURITY'], 'DENY canary: policy without RLS fails');

const WRONG_TABLE = `
CREATE TABLE public.widgets (id uuid PRIMARY KEY);
ALTER TABLE public.gadgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.gadgets USING (true);
`;
eq(analyzeMigrationSql(WRONG_TABLE).violations.length, 1, 'DENY canary: RLS on a different table does not count');

const OTHER_SCHEMA = `
CREATE TABLE private.widgets (id uuid PRIMARY KEY);
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.widgets USING (true);
`;
eq(analyzeMigrationSql(OTHER_SCHEMA).violations[0].table, 'private.widgets', 'DENY canary: same name in another schema is a different table');

const TEMP = `
CREATE TEMP TABLE scratch (id int);
CREATE TEMPORARY TABLE scratch2 (id int);
`;
eq(analyzeMigrationSql(TEMP).tables, [], 'temporary tables are exempt');

const UNLOGGED = `CREATE UNLOGGED TABLE public.cache (id int);`;
eq(analyzeMigrationSql(UNLOGGED).violations.length, 1, 'unlogged tables are still tables');

const BLOCK_COMMENT = `/* CREATE TABLE public.ghost (id int); */ SELECT 1;`;
eq(analyzeMigrationSql(BLOCK_COMMENT).tables, [], 'block comments are stripped');

const COMBINED_ALTER = `
CREATE TABLE public.widgets (id uuid PRIMARY KEY);
ALTER TABLE public.widgets
  ADD COLUMN note text,
  ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.widgets USING (true);
`;
eq(analyzeMigrationSql(COMBINED_ALTER).violations, [], 'ENABLE RLS inside a multi-action ALTER counts');

const TWO_TABLES = `
CREATE TABLE public.a (id int);
CREATE TABLE public.b (id int);
ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;
CREATE POLICY pa ON public.a USING (true);
`;
eq(analyzeMigrationSql(TWO_TABLES).violations.map((v) => v.table), ['public.b'], 'each created table is checked on its own');

const EXEMPT = `
-- rls-check: exempt — system counter table reached only through a SECURITY DEFINER RPC
CREATE TABLE public.counters (id int);
`;
eq(analyzeMigrationSql(EXEMPT).violations, [], 'documented exemption marker passes');
eq(analyzeMigrationSql(EXEMPT).exempt, true, 'exemption is reported, not hidden');
eq(analyzeMigrationSql(EXEMPT).exemptViolations.length, 1, 'the would-be violation is still surfaced for the log');

const NEAR_MISS_MARKER = `
-- rls-check: exemption requested
CREATE TABLE public.counters (id int);
`;
eq(analyzeMigrationSql(NEAR_MISS_MARKER).violations.length, 1, 'DENY canary: a misspelled marker does not exempt');

const MARKER_OUTSIDE_COMMENT = `
CREATE TABLE public.counters (id int); rls-check: exempt
`;
eq(analyzeMigrationSql(MARKER_OUTSIDE_COMMENT).violations.length, 1, 'DENY canary: marker must be a -- comment');

// ---------------------------------------------------------------------------
// Pure: change classification
// ---------------------------------------------------------------------------

eq(migrationVersion('supabase/migrations/20260901184530_x.sql'), '20260901184530', 'version is the 14-digit prefix');
eq(migrationVersion('supabase/migrations/README.md'), null, 'non-migration has no version');
eq(readHighWater('{"_meta":{"migrations_high_water":"20260901184530"}}'), '20260901184530', 'registry high water read');
eq(readHighWater('{"_meta":{}}'), null, 'missing high water is null');
eq(readHighWater('not json'), null, 'unparseable registry is null');
eq(parseNameStatus('M\0supabase/migrations/a.sql\0A\0supabase/migrations/b.sql\0'), [
  { status: 'M', path: 'supabase/migrations/a.sql' },
  { status: 'A', path: 'supabase/migrations/b.sql' },
], '-z name-status parses');

const HW = '20260901184530';
const classified = classifyMigrationChanges([
  { status: 'M', path: 'supabase/migrations/20260801000000_old.sql' },
  { status: 'D', path: 'supabase/migrations/20260802000000_old2.sql' },
  { status: 'M', path: 'supabase/migrations/20260902000000_pending.sql' },
  { status: 'A', path: 'supabase/migrations/20260903000000_new.sql' },
  { status: 'M', path: 'supabase/migrations/README.md' },
  { status: 'M', path: 'supabase/baselines/manifest.json' },
], HW);
eq(classified.protectedChanges.map((c) => c.path), [
  'supabase/migrations/20260801000000_old.sql',
  'supabase/migrations/20260802000000_old2.sql',
], 'older-than-high-water modifications and deletions are protected');
eq(classified.pendingChanges.map((c) => c.path), ['supabase/migrations/20260902000000_pending.sql'], 'newer-than-high-water is the pending band');
eq(classified.added, ['supabase/migrations/20260903000000_new.sql'], 'added files are collected');
eq(classified.ignored.length, 2, 'non-sql and non-migration paths are ignored');

const failClosed = classifyMigrationChanges([
  { status: 'M', path: 'supabase/migrations/20260902000000_pending.sql' },
], null);
eq(failClosed.protectedChanges.length, 1, 'DENY canary: unreadable registry closes the pending band');
eq(failClosed.pendingChanges.length, 0, 'no pending band without a high water');

const equalToHighWater = classifyMigrationChanges([
  { status: 'M', path: `supabase/migrations/${HW}_exact.sql` },
], HW);
eq(equalToHighWater.protectedChanges.length, 1, 'DENY canary: the high-water migration itself is applied');

// ---------------------------------------------------------------------------
// End to end against throwaway git repositories
// ---------------------------------------------------------------------------

function sh(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'crx-mig-rules-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'test']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(dir, message) {
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', message]);
  return sh(dir, ['rev-parse', 'HEAD']);
}

const APPLIED = 'supabase/migrations/20260801000000_applied.sql';
const PENDING = 'supabase/migrations/20260902000000_pending.sql';
const REGISTRY = JSON.stringify({ _meta: { migrations_high_water: HW } });

function seedBase(dir, { registry = REGISTRY } = {}) {
  write(dir, APPLIED, GOOD);
  write(dir, PENDING, GOOD);
  if (registry !== null) write(dir, '.claude/schema-registry.json', registry);
  write(dir, 'README.md', 'base\n');
  return commitAll(dir, 'base');
}

function runCli(dir, base, head) {
  return spawnSync(process.execPath, [SCRIPT, '--repo-root', dir, '--base', base, '--head', head], {
    encoding: 'utf8',
  });
}

const scenarios = [];

scenarios.push(['modifying an applied migration fails', (dir) => {
  const base = seedBase(dir);
  write(dir, APPLIED, `${GOOD}\n-- tweak\n`);
  const head = commitAll(dir, 'tweak applied');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'exit 1');
  ok(result.stdout.includes('MODIFIES an applied migration'), 'names the violation');
}]);

scenarios.push(['deleting an applied migration fails', (dir) => {
  const base = seedBase(dir);
  rmSync(path.join(dir, APPLIED));
  const head = commitAll(dir, 'delete applied');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'exit 1');
  ok(result.stdout.includes('DELETES an applied migration'), 'names the deletion');
}]);

scenarios.push(['renaming (renumbering) an applied migration fails as a deletion', (dir) => {
  const base = seedBase(dir);
  sh(dir, ['mv', APPLIED, 'supabase/migrations/20260904000000_applied.sql']);
  const head = commitAll(dir, 'renumber applied');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'exit 1');
  ok(result.stdout.includes(`DELETES an applied migration: ${APPLIED}`), 'rename is caught as delete + add');
}]);

scenarios.push(['revising a pending migration passes with a notice', (dir) => {
  const base = seedBase(dir);
  write(dir, PENDING, `${GOOD}\n-- revised before apply\n`);
  const head = commitAll(dir, 'revise pending');
  const result = runCli(dir, base, head);
  eq(result.status, 0, 'exit 0');
  ok(result.stdout.includes('revises a pending migration'), 'notice printed');
}]);

scenarios.push(['head cannot widen the pending band by editing the registry', (dir) => {
  const base = seedBase(dir);
  write(dir, '.claude/schema-registry.json', JSON.stringify({ _meta: { migrations_high_water: '20260101000000' } }));
  write(dir, APPLIED, `${GOOD}\n-- tweak\n`);
  const head = commitAll(dir, 'lower high water and tweak');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'DENY canary: base registry governs');
  ok(result.stdout.includes(`high-water mark (from base registry): ${HW}`), 'base high water used');
}]);

scenarios.push(['unreadable base registry fails closed', (dir) => {
  const base = seedBase(dir, { registry: null });
  write(dir, PENDING, `${GOOD}\n-- tweak\n`);
  const head = commitAll(dir, 'tweak pending without registry');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'DENY canary: no registry means no pending band');
  ok(result.stdout.includes('UNREADABLE'), 'says why');
}]);

scenarios.push(['adding a migration with RLS + policy passes', (dir) => {
  const base = seedBase(dir);
  write(dir, 'supabase/migrations/20260905000000_new.sql', GOOD);
  const head = commitAll(dir, 'add good');
  const result = runCli(dir, base, head);
  eq(result.status, 0, 'exit 0');
  ok(result.stdout.includes('1 new table(s) carry RLS + policy'), 'reports the table');
}]);

scenarios.push(['adding a migration whose table lacks RLS fails', (dir) => {
  const base = seedBase(dir);
  write(dir, 'supabase/migrations/20260905000000_bad.sql', NO_RLS);
  const head = commitAll(dir, 'add bad');
  const result = runCli(dir, base, head);
  eq(result.status, 1, 'exit 1');
  ok(result.stdout.includes('new table public.widgets is missing'), 'names the table');
}]);

scenarios.push(['adding an exempt-marked migration passes with a loud notice', (dir) => {
  const base = seedBase(dir);
  write(dir, 'supabase/migrations/20260905000000_exempt.sql', EXEMPT);
  const head = commitAll(dir, 'add exempt');
  const result = runCli(dir, base, head);
  eq(result.status, 0, 'exit 0');
  ok(result.stdout.includes('rls-check: exempt'), 'notice names the marker');
  ok(result.stdout.includes('⚠'), 'reported as a warning line');
}]);

scenarios.push(['adding a migration with no CREATE TABLE passes', (dir) => {
  const base = seedBase(dir);
  write(dir, 'supabase/migrations/20260905000000_fn.sql', 'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
  const head = commitAll(dir, 'add fn');
  const result = runCli(dir, base, head);
  eq(result.status, 0, 'exit 0');
}]);

scenarios.push(['non-migration changes are ignored', (dir) => {
  const base = seedBase(dir);
  write(dir, 'README.md', 'changed\n');
  write(dir, 'supabase/migrations/README.md', 'notes\n');
  const head = commitAll(dir, 'docs');
  const result = runCli(dir, base, head);
  eq(result.status, 0, 'exit 0');
  ok(result.stdout.includes('applied-and-changed: 0'), 'nothing counted');
}]);

scenarios.push(['a branch behind main is compared at the merge-base, not the base tip', (dir) => {
  const base = seedBase(dir);
  // main moves on: a new applied migration lands after the branch point.
  sh(dir, ['checkout', '-q', '-b', 'feature']);
  sh(dir, ['checkout', '-q', 'main']);
  write(dir, 'supabase/migrations/20260803000000_later_on_main.sql', GOOD);
  const mainTip = commitAll(dir, 'main moves');
  sh(dir, ['checkout', '-q', 'feature']);
  write(dir, 'supabase/migrations/20260905000000_new.sql', GOOD);
  const head = commitAll(dir, 'feature adds');
  const result = runCli(dir, mainTip, head);
  eq(result.status, 0, 'main-only migration is not reported as deleted by the branch');
  ok(result.stdout.includes(`(merge-base) -> ${head.slice(0, 12)}`), 'merge-base used');
  ok(result.stdout.includes(`comparing ${base.slice(0, 12)}`), 'merge-base is the branch point');
}]);

scenarios.push(['zero base sha skips with a notice', (dir) => {
  const head = seedBase(dir);
  const result = runCli(dir, '0000000000000000000000000000000000000000', head);
  eq(result.status, 0, 'exit 0');
  ok(result.stdout.includes('no comparison base available'), 'says so');
}]);

scenarios.push(['unknown head is a hard error', (dir) => {
  const base = seedBase(dir);
  const result = runCli(dir, base, 'f'.repeat(40));
  eq(result.status, 2, 'exit 2: the check could not run');
}]);

scenarios.push(['runDiffCheck is callable in-process', (dir) => {
  const base = seedBase(dir);
  write(dir, APPLIED, `${GOOD}\n-- tweak\n`);
  const head = commitAll(dir, 'tweak');
  const lines = [];
  const result = runDiffCheck({ repoRoot: dir, base, head, log: (line) => lines.push(line) });
  eq(result.ok, false, 'reports failure');
  eq(result.protectedChanges.length, 1, 'one protected change');
}]);

for (const [name, run] of scenarios) {
  const dir = makeRepo();
  try {
    run(dir);
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`check-migration-hard-rules: ${assertions} assertions across ${scenarios.length} repository scenarios passed`);
