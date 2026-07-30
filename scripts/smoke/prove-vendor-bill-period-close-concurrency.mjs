#!/usr/bin/env node
/**
 * Real-schema, network-isolated PostgreSQL 17 proof for vendor-bill versus
 * period-close serialization.  The barriers are disposable triggers only;
 * writers call the real restored RPCs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-vendor-period-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const BASE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260730031031_vendor_bill_period_close_lock.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-vendor-bill-period-close-lock.sql');
const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const KEY = 818181;

function run(args, { input, fail = false } = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 60 * 1024 * 1024 });
  if (r.error || (!fail && r.status !== 0)) throw new Error(`${r.error?.message || ''}\n${r.stderr || r.stdout}`);
  return r;
}
function psqlArgs() { return ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']; }
function sql(s, o = {}) { return run(psqlArgs(), { input: s, fail: o.fail }); }
function adminSql(s, o = {}) { return run(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: s, fail: o.fail }); }
function scalar(s) { const out = sql(s).stdout.trim().split(/\r?\n/).filter(Boolean); return out.at(-1); }
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function session(s, marker) {
  const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', resolved = false, resolve, reject;
  const ready = new Promise((r, j) => { resolve = r; reject = j; setTimeout(() => !resolved && j(new Error(`timeout ${marker}: ${out}\n${err}`)), 20000); });
  child.stdout.on('data', x => { out += x; if (!resolved && out.includes(marker)) { resolved = true; resolve(); } });
  child.stderr.on('data', x => { err += x; });
  child.stdin.end(s);
  const done = new Promise(r => child.on('close', code => { if (!resolved) { resolved = true; reject(new Error(`ended before ${marker}: ${out}\n${err}`)); } r({ code, out, err }); }));
  return { ready, done };
}
async function waiting(p, label) { assert.equal(await Promise.race([p.then(() => 'done'), pause(500).then(() => 'waiting')]), 'waiting', `${label} was not blocked`); }
function claims() { return `SET request.jwt.claim.sub='${ADMIN}'; SET request.jwt.claim.role='authenticated';`; }
function expectError(r, code, label) { assert.notEqual(r.code, 0, `${label} unexpectedly succeeded`); assert.match(`${r.out}\n${r.err}`, new RegExp(code), `${label}: ${r.out}\n${r.err}`); }
function applyFile(name) { return sql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`); }

try {
  run(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  let ok = false;
  for (let i = 0; i < 60; i += 1) { if (run(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { fail: true }).status === 0) { ok = true; break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  assert.ok(ok, 'PostgreSQL 17 did not start');
  adminSql('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);');
  run(['cp', path.join(BASE, '20260727174805_extensions.sql'), `${NAME}:/tmp/extensions.sql`]);
  run(['cp', path.join(BASE, '20260727174805_acl_lockdown.sql'), `${NAME}:/tmp/acl.sql`]);
  run(['cp', path.join(BASE, '20260727174805_platform_overlay.sql'), `${NAME}:/tmp/overlay.sql`]);
  run(['cp', path.join(BASE, '20260727174805_cron_jobs.sql'), `${NAME}:/tmp/cron.sql`]);
  run(['cp', path.join(BASE, '20260727174805_migration_history.sql'), `${NAME}:/tmp/history.sql`]);
  applyFile('extensions.sql');
  const decoded = spawnSync('node', ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 60 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  run(psqlArgs(), { input: decoded.stdout });
  applyFile('acl.sql');
  // The concurrency contract is entirely in public/auth. The storage platform
  // overlay is intentionally not needed by these RPC paths on a networkless
  // disposable PostgreSQL image.
  // Migration-ledger restoration is unrelated to function execution in this
  // disposable proof and needs Supabase's platform schema, so omit it here.
  sql(`${claims()} INSERT INTO auth.users(id) VALUES ('${ADMIN}') ON CONFLICT DO NOTHING; INSERT INTO public.profiles(id,email,role,is_active) VALUES ('${ADMIN}','period-proof@example.invalid','admin',true) ON CONFLICT (id) DO UPDATE SET role='admin',is_active=true;`);

  const vendor = scalar(`INSERT INTO public.vendors(name) VALUES ('[PROOF] period vendor ${process.pid}') RETURNING id;`);
  const date = '2025-01-15', end = '2025-01-31', monthKey = 2025 * 12 + 1 - 1;
  const bill = (key, d = date) => `${claims()} SELECT public.create_vendor_bill('${vendor}'::uuid,NULL,'proof-${key}','${d}',NULL,NULL,1000,0,NULL,'${key}');`;
  const close = key => `${claims()} SELECT public.close_accounting_period('${end}'::date,'${ADMIN}'::uuid,'${key}');`;

  // Baseline: pause the real writer after its real period check, close, then
  // release it. This proves the old check-then-write race.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill BEFORE INSERT OR UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill();`);
  const holder = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(3); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await holder.ready;
  const oldWriter = session(`BEGIN; SET application_name='baseline-writer'; ${bill('baseline-create')} COMMIT; SELECT 'BASELINE_WRITER_DONE';`, 'BASELINE_WRITER_DONE');
  await waiting(oldWriter.done, 'baseline writer barrier');
  const oldClose = sql(`BEGIN; ${close('baseline-close')} COMMIT;`); assert.equal(oldClose.status, 0, oldClose.stderr);
  const oldResult = await oldWriter.done; assert.equal(oldResult.code, 0, oldResult.err);
  assert.equal(scalar(`SELECT status FROM public.accounting_periods WHERE period_start='2025-01-01'`), 'closed');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE bill_number='proof-baseline-create'`), '1');
  console.log('BASELINE_CREATE_CLOSE_RACE_REPRODUCED');

  sql(`DELETE FROM public.vendor_bills WHERE bill_number='proof-baseline-create'; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DROP TRIGGER proof_pause_bill ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill();`);
  run(['cp', MIGRATION, `${NAME}:/tmp/candidate.sql`]); console.log(applyFile('candidate.sql').stdout);
  run(['cp', SMOKE, `${NAME}:/tmp/smoke.sql`]);
  // The candidate must be visibly present before testing its live schedules.
  assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounting_periods'::regclass AND conname='accounting_periods_whole_calendar_month_check'`), '1');
  const smoke = sql('\\i /tmp/smoke.sql', { fail: true });
  assert.match(`${smoke.stdout}\n${smoke.stderr}`, /SMOKE_PASS_ROLLBACK/, 'registered rollback smoke did not pass');
  console.log('SMOKE_PASS_ROLLBACK');

  // Candidate writer-first: its actual check owns shared 73492010/month while
  // the proof trigger pauses before INSERT; close must wait on that advisory key.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill BEFORE INSERT OR UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill();`);
  const h1 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(3); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h1.ready;
  const writer = session(`BEGIN; ${bill('candidate-writer-first')} COMMIT; SELECT 'WRITER_DONE';`, 'WRITER_DONE'); await waiting(writer.done, 'candidate writer barrier');
  assert.equal(scalar(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=73492010 AND objid=${monthKey} AND mode='ShareLock'`), '1');
  const closer = session(`BEGIN; ${close('candidate-writer-close')} COMMIT; SELECT 'CLOSE_DONE';`, 'CLOSE_DONE'); await waiting(closer.done, 'candidate close');
  assert.equal(scalar(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=73492010 AND objid=${monthKey} AND mode='ExclusiveLock' AND NOT granted`), '1');
  const [wr, cr] = await Promise.all([writer.done, closer.done]); assert.equal(wr.code, 0, wr.err); assert.equal(cr.code, 0, cr.err);
  console.log('CANDIDATE_WRITER_FIRST_CLOSE_WAITS_PASS');

  sql(`DELETE FROM public.vendor_bills WHERE bill_number='proof-candidate-writer-first'; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DROP TRIGGER proof_pause_bill ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill();`);
  // Candidate close-first: pause the real close at accounting_periods INSERT;
  // writer waits, then sees closed state and leaves no side effects.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_period();`);
  const h2 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(3); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h2.ready;
  const cfirst = session(`BEGIN; ${close('candidate-close-first')} COMMIT; SELECT 'CLOSE_FIRST_DONE';`, 'CLOSE_FIRST_DONE'); await waiting(cfirst.done, 'close-first barrier');
  const wfirst = session(`BEGIN; SELECT 'WRITER_STARTED'; ${bill('candidate-close-first-writer')} COMMIT;`, 'WRITER_STARTED'); await wfirst.ready; await waiting(wfirst.done, 'writer waiting exclusive month');
  const [cf, wf] = await Promise.all([cfirst.done, wfirst.done]); assert.equal(cf.code, 0, cf.err); expectError(wf, 'closed accounting period', 'close-first writer');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE bill_number='proof-candidate-close-first-writer'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='candidate-close-first-writer'`), '0');
  console.log('CANDIDATE_CLOSE_FIRST_FAIL_CLOSED_PASS');
  console.log('VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS');
} finally { run(['rm', '-f', NAME], { fail: true }); }
