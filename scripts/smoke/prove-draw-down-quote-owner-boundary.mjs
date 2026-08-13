#!/usr/bin/env node
// Container-only prover for 20260813161614_restrict_draw_down_quote_owner.sql.
//
// Replays a FRESH read-only dump of the live public/auth schema into a
// disposable PostgreSQL container, then:
//   1. pins the live private draw-down body to the md5 the migration gates on;
//   2. runs the canonical smoke chain BEFORE the candidate and requires it to
//      FAIL at the foreign-quote probe — that proves the chain actually
//      detects the missing ownership check rather than passing vacuously;
//   3. applies the candidate migration;
//   4. re-runs the chain and requires SMOKE_PASS_ROLLBACK with zero residue.
//
// Nothing is written to the live database: the only live call is a read-only
// schema dump.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-draw-down-owner-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const EXTENSIONS = path.join(ROOT, 'supabase', 'baselines', '20260727174805_extensions.sql');
const CANDIDATE = path.join(
  ROOT, 'supabase', 'migrations', '20260813161614_restrict_draw_down_quote_owner.sql',
);
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-draw-down-quote-owner-boundary.sql');
const LIVE_SCHEMA = path.join(ROOT, '.claude', 'session-state', 'draw-down-owner-live-schema.sql');

const IMPL = 'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)';
const APPLIED_BASELINE_MD5 = '87bf7adcdc63d94684676da5ab09bfde';
const PATCHED_MD5 = '313ef19f5d604b9e35b341a22fdb75b8';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 80 * 1024 * 1024, ...options,
  });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}
function psql(sql, options = {}) {
  return docker(
    ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres',
      '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, allowFailure: options.allowFailure },
  );
}
function psqlValue(sql) {
  return docker([
    'exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]).stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function apply(name) { psql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const ready = docker(
      ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'],
      { allowFailure: true },
    );
    if (ready.status === 0 && ready.stdout.trim() === '1') return;
    wait(500);
  }
  throw new Error(
    `disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`,
  );
}
function sanitizeCliOutput(value) {
  let safe = String(value || '');
  for (const secret of [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_DB_PASSWORD]) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:sbp|sb_secret)_[A-Za-z0-9._-]+\b/g, '[REDACTED]')
    .slice(0, 4000);
}
function refreshLiveSchema() {
  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (commonDir.status !== 0) throw new Error(`cannot locate linked checkout: ${commonDir.stderr}`);
  const linkedRoot = path.dirname(path.resolve(ROOT, commonDir.stdout.trim()));
  // `supabase db dump --file` appends when the target already exists, and it
  // will not create the directory itself.
  mkdirSync(path.dirname(LIVE_SCHEMA), { recursive: true });
  rmSync(LIVE_SCHEMA, { force: true });
  const dump = spawnSync(
    'supabase',
    ['db', 'dump', '--linked', '--workdir', linkedRoot, '--schema', 'public,auth',
      '--file', LIVE_SCHEMA, '--keep-comments'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (dump.status !== 0) {
    throw new Error(`fresh read-only live schema dump failed: ${sanitizeCliOutput(dump.stderr || dump.stdout)}`);
  }
}
function implMd5() {
  return psqlValue(`SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = '${IMPL}'::regprocedure;`);
}
function runSmoke() {
  const smoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  return { status: smoke.status, output: `${smoke.stdout}\n${smoke.stderr}` };
}

try {
  assert.ok(readFileSync(CANDIDATE, 'utf8').length > 0, 'candidate migration is missing');
  assert.match(readFileSync(SMOKE, 'utf8'), /SMOKE_PASS_ROLLBACK/, 'canonical smoke lacks its rollback marker');
  refreshLiveSchema();
  assert.ok(existsSync(LIVE_SCHEMA), `fresh read-only live schema dump is required at ${LIVE_SCHEMA}`);

  docker(['run', '-d', '--name', NAME, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m',
    '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();
  wait(2000);
  waitForDatabase();

  copy(EXTENSIONS, 'extensions.sql');
  apply('extensions.sql');
  psql('DROP SCHEMA auth CASCADE;', { user: 'supabase_admin' });
  psql('DROP SCHEMA public CASCADE;');
  const liveSchema = readFileSync(LIVE_SCHEMA, 'utf8')
    .replace(/OWNER TO "[^"]+";/g, 'OWNER TO postgres;')
    .replace(/FOR ROLE "[^"]+"/g, 'FOR ROLE "postgres"');
  psql(liveSchema);

  // 1. The replayed schema must be the exact body the candidate gates on.
  assert.equal(
    implMd5(), APPLIED_BASELINE_MD5,
    'replayed live private draw-down body does not match the md5 the candidate requires',
  );

  copy(SMOKE, path.basename(SMOKE));

  // 2. Pre-apply the chain must FAIL — otherwise it proves nothing.
  const before = runSmoke();
  assert.notEqual(before.status, 0, 'pre-apply smoke committed instead of raising');
  assert.doesNotMatch(
    before.output, /SMOKE_PASS_ROLLBACK/,
    `pre-apply smoke already passed — the chain does not detect the missing owner check:\n${before.output}`,
  );
  // The live body has no ownership check at all, so rep A's draw against rep
  // B's quote runs straight past authorization and stops only at the
  // pre-existing empty-draw-lines validation. That is the defect this
  // candidate closes.
  assert.match(
    before.output,
    /SMOKE_FAIL: (foreign sales-rep quote draw was allowed|expected NOT_QUOTE_OWNER, got: EMPTY_DRAW)/,
    `pre-apply smoke failed for an unexpected reason:\n${before.output}`,
  );

  // 3. Apply the candidate.
  copy(CANDIDATE, 'candidate.sql');
  apply('candidate.sql');
  assert.equal(implMd5(), PATCHED_MD5, 'candidate installed an unexpected private body');

  // 4. Post-apply the chain must reach SMOKE_PASS_ROLLBACK.
  const after = runSmoke();
  assert.notEqual(after.status, 0, 'post-apply smoke committed instead of forcing rollback');
  assert.match(
    after.output, /SMOKE_PASS_ROLLBACK/,
    `post-apply smoke did not reach SMOKE_PASS_ROLLBACK:\n${after.output}`,
  );

  assert.equal(
    psqlValue("SELECT count(*) FROM public.quotes WHERE quote_number LIKE 'SMK-DRAW-%';"),
    '0', 'quote fixture residue remained',
  );
  assert.equal(
    psqlValue("SELECT count(*) FROM public.customers WHERE farm_name LIKE '[SMOKE] Draw Owner Farm %';"),
    '0', 'customer fixture residue remained',
  );
  assert.equal(
    psqlValue("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key LIKE 'smk-%';"),
    '0', 'idempotency residue remained',
  );

  console.log(
    'DRAW_DOWN_OWNER_REAL_SCHEMA_PASS source=fresh-live-read-only-schema '
    + 'preapply=SMOKE_FAIL_FOREIGN_DRAW_REACHED_EMPTY_DRAW '
    + 'smoke_draw_down_owner=SMOKE_PASS_ROLLBACK residue=0',
  );
} catch (error) {
  console.error(`DRAW_DOWN_OWNER_REAL_SCHEMA_FAIL ${sanitizeCliOutput(error.stack ?? error.message)}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
