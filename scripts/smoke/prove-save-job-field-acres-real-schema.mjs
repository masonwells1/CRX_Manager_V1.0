#!/usr/bin/env node
/**
 * Full-chain proof for the local 20260904185900 save_job candidate. It replays
 * every ordered current-main migration before the candidate in a network-disabled
 * PostgreSQL 17 container. The permanent registered parity chain must pass both
 * before and after the candidate; the focused candidate fixture must expose F06's
 * missing-key and JSON-null acreage defects before the apply and pass A1-A4
 * after the exact LF bytes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-save-job-acres-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const SOURCE = path.join(ROOT, 'supabase', 'migrations', '20260903150000_job_chemicals_persist_driver.sql');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260904185900_refuse_null_job_field_acres.sql');
const CORE_SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-save-job-parity.sql');
const ACRES_SMOKE = path.join(ROOT, 'scripts', 'smoke', 'fixtures', 'save-job-field-acres-tests.sql');

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psql(sql, options = {}) {
  return docker(['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure: options.allowFailure });
}
function stageSql(file, name) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try { writeFileSync(staged, readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), 'utf8'); docker(['cp', staged, `${NAME}:/tmp/${name}`]); }
  finally { try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function apply(name, allowFailure = false) {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', `/tmp/${name}`], { allowFailure });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function rollbackPass(text) { return /(?:^|\n)(?:psql:[^:\n]+:\d+:\s+)?ERROR:\s+SMOKE_PASS_ROLLBACK\b/.test(text); }
function selected() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const source = all.indexOf(SOURCE);
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(source >= 0, 'F06 source must be selected for post-baseline replay');
  assert.ok(candidate >= 0, 'acreage candidate must be selected for post-baseline replay');
  assert.ok(source < candidate, 'F06 source must precede the acreage candidate');
  return all.slice(0, candidate);
}
function restoreLiveCrLfCloseRemainder(db) {
  const definingPath = path.join(ROOT, 'supabase', 'migrations', '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
  const source = readFileSync(definingPath, 'utf8').replace(/\r\n/g, '\n');
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  assert.ok(tag, 'close-remainder body has no dollar quote');
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  assert.ok(bodyEnd > bodyStart, 'close-remainder body is unterminated');
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  assert.equal(createHash('md5').update(body, 'utf8').digest('hex'), 'e2d4b46c47be7561a8829191c30dc0a7', 'close-remainder live CRLF body hash drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`, { user: db });
  console.log('FULL_SCHEMA_LIVE_BODY_RESTORED _close_undelivered_order_remainder_20260718 crlf=true');
}

try {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder('postgres');
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true); if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} ordered post-baseline migrations before acreage candidate`);
  psql(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES ('11111111-1111-1111-1111-111111111111','save-job-prover@example.invalid','{"full_name":"[PROVER] Save Job Admin","role":"admin"}'::jsonb) ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES ('11111111-1111-1111-1111-111111111111','save-job-prover@example.invalid','[PROVER] Save Job Admin','admin',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.customers (id,farm_name) VALUES ('22222222-2222-2222-2222-222222222222','[PROVER] Save Job Farm') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.fields (id,customer_id,field_name,crop_type,total_acres) VALUES
      ('33333333-3333-3333-3333-333333333331','22222222-2222-2222-2222-222222222222','[PROVER] Missing Acres','corn',10),
      ('33333333-3333-3333-3333-333333333332','22222222-2222-2222-2222-222222222222','[PROVER] Null Acres','corn',10),
      ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','[PROVER] Blank Acres','corn',10),
      ('33333333-3333-3333-3333-333333333334','22222222-2222-2222-2222-222222222222','[PROVER] Infinite Acres','corn',10)
    ON CONFLICT (id) DO NOTHING;`);
  stageSql(CORE_SMOKE, 'core-smoke.sql');
  stageSql(ACRES_SMOKE, 'acres-smoke.sql');
  let r = apply('core-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `permanent save_job parity failed before candidate:\n${r.output}`);
  r = apply('acres-smoke.sql', true);
  assert.notEqual(r.status, 0, `focused acreage fixture unexpectedly passed against F06:\n${r.output}`);
  assert.match(r.output, /A1 FAIL\s+refused=f\b/, `pre-candidate fixture did not prove that F06 accepted a missing acreage key:\n${r.output}`);
  const acreageFixture = readFileSync(ACRES_SMOKE, 'utf8').replaceAll('\r\n', '\n');
  const a1Start = acreageFixture.indexOf('-- A1:');
  const a2Start = acreageFixture.indexOf('-- A2:');
  const a3Start = acreageFixture.indexOf('-- A3:');
  assert.ok(a1Start >= 0 && a2Start > a1Start && a3Start > a2Start, 'focused fixture A1-A3 boundaries drifted');
  const a2Only = `${acreageFixture.slice(0, a1Start)}${acreageFixture.slice(a2Start, a3Start)}`;
  const a2Before = psql(a2Only, { allowFailure: true });
  const a2BeforeOutput = `${a2Before.stdout}\n${a2Before.stderr}`;
  assert.notEqual(a2Before.status, 0, `JSON-null fixture unexpectedly passed against F06:\n${a2BeforeOutput}`);
  assert.match(a2BeforeOutput, /A2 FAIL\s+refused=f\b/, `pre-candidate fixture did not prove that F06 accepted JSON-null acreage:\n${a2BeforeOutput}`);
  // The repository checkout may be CRLF on Windows. stageSql applies the canonical
  // LF SQL bytes used by PostgreSQL migration hashing; the candidate's own body-md5
  // preflight/postflight then prove those exact executable bytes are the reviewed body.
  stageSql(CANDIDATE, 'candidate.sql'); r = apply('candidate.sql');
  r = apply('core-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `permanent save_job parity failed after candidate:\n${r.output}`);
  r = apply('acres-smoke.sql', true);
  assert.equal(r.status, 0, `focused acreage fixture failed after candidate:\n${r.output}`);
  for (const label of ['A1 PASS', 'A2 PASS', 'A3 PASS', 'A4 PASS']) {
    assert.match(r.output, new RegExp(label), `focused acreage fixture omitted ${label}:\n${r.output}`);
  }
  console.log('SAVE_JOB_FIELD_ACRES_REAL_SCHEMA_PASS core_pre=PASS pre_candidate=A1_FAIL,A2_FAIL core_post=PASS acreage_post=A1-A4_PASS');
} catch (error) { console.error(`SAVE_JOB_FIELD_ACRES_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`); process.exitCode = 1; }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
