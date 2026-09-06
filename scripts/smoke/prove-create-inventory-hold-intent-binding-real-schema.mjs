#!/usr/bin/env node
/**
 * Full-chain proof for the local 20260905210000 create_inventory_hold candidate.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration before the candidate, then:
 *   1. runs the rolled-back smoke chain against the LIVE body and expects it to
 *      FAIL (the live body accepts a NULL key, so the chain cannot pass);
 *   2. races two sessions on the SAME idempotency key against the live body and
 *      expects ONE hold plus an ERROR for the loser (the Codex HIGH: receipt read
 *      before the stock lock, receipt written after the hold, no per-key lock;
 *      the live BEFORE INSERT receipt guard rolls the loser back instead of
 *      letting it replay, so the caller whose hold DID get created is told it
 *      failed);
 *   3. applies the candidate with the exact LF bytes;
 *   4. runs the smoke chain and expects SMOKE_PASS_ROLLBACK;
 *   5. re-runs the same two-session race and expects ONE hold, both sessions
 *      returning the same hold_id, and a receipt bound to the actor;
 *   6. re-applies the candidate to prove it is re-runnable.
 *
 * The race uses no stand-in bodies: session 1 creates a hold and then sleeps
 * inside its open transaction; session 2 starts while session 1 is sleeping.
 * Before the candidate, session 2 misses the (uncommitted) receipt, waits on
 * the inventory FOR UPDATE lock, inserts a second hold once session 1 commits,
 * and is then aborted by the receipt-insert guard. After the candidate,
 * session 2 waits on the per-key advisory lock in check_idempotency_intent and
 * replays session 1's receipt: one hold, both callers get the same hold_id.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-hold-intent-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260905210000_bind_create_inventory_hold_receipt_to_intent.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-create-inventory-hold-intent-binding.sql');

const ADMIN = '5a000000-0000-4000-8000-00000000000a';
const CUSTOMER = '5a000000-0000-4000-8000-0000000000c1';
const RACE_PRODUCT_BEFORE = '5a000000-0000-4000-8000-0000000000e1';
const RACE_PRODUCT_AFTER = '5a000000-0000-4000-8000-0000000000e2';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') {
  return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
}
function psql(sql, options = {}) {
  return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure });
}
function scalar(sql) {
  return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function stageSql(file, name) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try { writeFileSync(staged, readFileSync(file, 'utf8').replaceAll('\r\n', '\n'), 'utf8'); docker(['cp', staged, `${NAME}:/tmp/${name}`]); }
  finally { try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function apply(name, allowFailure = false) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure });
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
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'hold candidate must be selected for post-baseline replay');
  const intent = all.findIndex((f) => path.basename(f) === '20260811130000_bind_commission_payout_idempotency_to_intent.sql');
  const binding = all.findIndex((f) => path.basename(f) === '20260803010917_bind_idempotency_to_mutation_intent.sql');
  assert.ok(intent >= 0 && intent < candidate, 'check_idempotency_intent migration must precede the hold candidate');
  assert.ok(binding >= 0 && binding < candidate, 'receipt binding-column migration must precede the hold candidate');
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
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`, { user: db });
}

/**
 * Start a psql session that runs `sql`; resolves `ready` once `marker` appears
 * on stdout (immediately when no marker is given, so the promise never dangles).
 */
function startSqlWithMarker(sql, marker) {
  const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  if (!marker) { settled = true; readyResolve(); }
  const timer = setTimeout(() => { if (!settled) { settled = true; readyReject(new Error(`timed out waiting for ${marker}`)); } }, 20_000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; if (!settled && stdout.includes(marker)) { settled = true; clearTimeout(timer); readyResolve(); } });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  const completion = new Promise((resolve) => {
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; readyReject(new Error(`session exited before ${marker}: ${stderr || stdout}`)); }
      resolve({ code, stdout, stderr });
    });
  });
  return { ready, completion };
}

// The image's auth.uid() may read request.jwt.claim.sub before request.jwt.claims; set both.
const claims = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);`;
function holdCall(productId, key) {
  return `SELECT public.create_inventory_hold('${productId}'::uuid, '${CUSTOMER}'::uuid, 5, 'manual', DATE '2026-12-31', 'race', '${ADMIN}'::uuid, false, NULL, '${key}') ->> 'hold_id';`;
}

async function raceSameKey(productId, key) {
  // Session 1 does the hold, announces it, then sleeps with the transaction open.
  const s1 = startSqlWithMarker(
    `BEGIN;\n${claims}\n${holdCall(productId, key)}\n\\echo S1_HOLD_DONE\nSELECT pg_sleep(2.5);\nCOMMIT;\n`,
    'S1_HOLD_DONE',
  );
  await s1.ready;
  // Session 2 starts while session 1 still holds its uncommitted hold + receipt.
  const s2 = startSqlWithMarker(`BEGIN;\n${claims}\n${holdCall(productId, key)}\nCOMMIT;\n`, null);
  const [r1, r2] = await Promise.all([s1.completion, s2.completion]);
  assert.equal(r1.code, 0, `race session 1 failed:\n${r1.stderr}`);
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const id1 = r1.stdout.match(uuidRe)?.[0];
  const id2 = r2.code === 0 ? r2.stdout.match(uuidRe)?.[0] : null;
  assert.ok(id1, `race session 1 did not return a hold_id:\n${r1.stdout}`);
  const holds = Number(scalar(`SELECT count(*) FROM public.inventory_holds WHERE product_id = '${productId}';`));
  const receipts = Number(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`));
  const boundActor = scalar(`SELECT coalesce(request_actor_id::text, '') FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  return { id1, id2, s2Code: r2.code, s2Error: r2.stderr.trim(), holds, receipts, boundActor };
}

async function main() {
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

  // The baseline dump must carry the body this candidate pins as live.
  const liveSha = scalar(`SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)');`);
  assert.equal(liveSha, '3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09', 'baseline create_inventory_hold body is not the pinned live body');
  console.log(`[prover] baseline create_inventory_hold prosrc sha256=${liveSha}`);

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder('postgres');
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true); if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} ordered post-baseline migrations before the hold candidate`);
  const postReplaySha = scalar(`SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)');`);
  assert.equal(postReplaySha, liveSha, 'a post-baseline migration redefined create_inventory_hold; the candidate pin is stale');

  // The baseline auth.users is a stub; deactivating a profile fires
  // _sync_auth_access_on_profile_active, which writes the real column set
  // (same shim as prove-draw-down-price-tier-real-schema.mjs).
  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES ('${ADMIN}','hold-prover@example.invalid','{"full_name":"[PROVER] Hold Admin","role":"admin"}'::jsonb) ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES ('${ADMIN}','hold-prover@example.invalid','[PROVER] Hold Admin','admin',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.customers (id,farm_name) VALUES ('${CUSTOMER}','[PROVER] Hold Farm') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.products (id,product_name,sku,is_active) VALUES
      ('${RACE_PRODUCT_BEFORE}','[PROVER] Race Before','PROVER-RACE-1',true),
      ('${RACE_PRODUCT_AFTER}','[PROVER] Race After','PROVER-RACE-2',true)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.inventory (product_id,location,quantity_available,quantity_prebooked,quantity_on_order) VALUES
      ('${RACE_PRODUCT_BEFORE}','Main Warehouse',100,0,0),
      ('${RACE_PRODUCT_AFTER}','Main Warehouse',100,0,0);`);

  // 1. The chain must not pass against the live body.
  stageSql(SMOKE, 'hold-smoke.sql');
  let r = apply('hold-smoke.sql', true);
  assert.equal(rollbackPass(r.output), false, `hold smoke chain unexpectedly PASSED against the live body:\n${r.output}`);
  assert.match(r.output, /SMOKE_FAIL/, `pre-candidate chain did not fail on a SMOKE_FAIL assertion:\n${r.output}`);
  console.log('[prover] pre-candidate: smoke chain fails against the live body (expected)');

  // 2. Against the live body the same-key loser is NOT replayed. It misses the
  //    uncommitted receipt, waits on the FOR UPDATE stock lock, inserts a second
  //    hold, and is then rolled back by the BEFORE INSERT receipt guard from
  //    20260714230000 / 20260716160000 (IDEMPOTENCY_CONCURRENT_REPLAY_RETRY).
  //    Net: one hold, but the second caller gets an ERROR for work that
  //    succeeded, and a browser that treats that as a definitive refusal
  //    releases its key and mints a new one on the next click -> duplicate hold.
  const before = await raceSameKey(RACE_PRODUCT_BEFORE, 'prover-race-key-before');
  console.log(`[prover] pre-candidate race: holds=${before.holds} receipts=${before.receipts} s2_exit=${before.s2Code} s2_error=${before.s2Error.split('\n')[0]}`);
  assert.equal(before.holds, 1, 'expected the receipt-insert guard to roll back the LIVE body loser');
  assert.notEqual(before.s2Code, 0, 'expected the LIVE body loser to fail instead of replaying');
  assert.match(before.s2Error, /IDEMPOTENCY_CONCURRENT_REPLAY_RETRY/, 'expected the loser to die in the receipt-insert guard');
  assert.equal(before.id2, null, 'expected the LIVE body loser to return no hold_id');
  assert.equal(before.receipts, 1, 'expected one receipt from the winner');

  // 3a. The winner's receipt from step 2 is an unexpired UNBOUND legacy receipt.
  //     The candidate must refuse to apply while it exists (PREFLIGHT_LEGACY_RECEIPTS)
  //     and must leave the live body untouched.
  stageSql(CANDIDATE, 'candidate.sql');
  r = apply('candidate.sql', true);
  assert.notEqual(r.status, 0, `candidate applied over an unexpired legacy receipt:\n${r.output}`);
  assert.match(r.output, /PREFLIGHT_LEGACY_RECEIPTS: 1 unexpired unbound create_inventory_hold receipt/, `candidate did not refuse on the legacy receipt:\n${r.output}`);
  const shaAfterRefusal = scalar(`SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)');`);
  assert.equal(shaAfterRefusal, liveSha, 'the refused apply changed the live body');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_create_inventory_hold_intent_impl_20260905';`), '0', 'the refused apply left an impl behind');
  console.log('[prover] candidate refused while a legacy receipt is live (PREFLIGHT_LEGACY_RECEIPTS), live body untouched');

  // 3b. Expire that receipt the way time would (container only — the live rule
  //     is to WAIT for expiry, never delete), then the candidate applies.
  psql(`UPDATE public.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE idempotency_key = 'prover-race-key-before';`);
  r = apply('candidate.sql');
  assert.match(r.output, /no unexpired pre-migration receipts; safe to swap/, `candidate did not confirm a clean receipt table:\n${r.output}`);
  console.log('[prover] candidate applied');

  // 4. The chain passes.
  r = apply('hold-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `hold smoke chain failed after candidate:\n${r.output}`);
  console.log('[prover] post-candidate: smoke chain SMOKE_PASS_ROLLBACK');

  // 5. The same race now yields one hold and one bound receipt.
  const after = await raceSameKey(RACE_PRODUCT_AFTER, 'prover-race-key-after');
  console.log(`[prover] post-candidate race: holds=${after.holds} receipts=${after.receipts} s2_exit=${after.s2Code} same_id=${after.id1 === after.id2} bound=${after.boundActor}`);
  assert.equal(after.s2Code, 0, `expected the wrapper loser to succeed by replay:\n${after.s2Error}`);
  assert.equal(after.holds, 1, 'expected the wrapper to leave exactly one hold for one key');
  assert.equal(after.id1, after.id2, 'expected both racing sessions to return the same hold_id');
  assert.equal(after.receipts, 1, 'expected exactly one receipt');
  assert.equal(after.boundActor, ADMIN, 'expected the receipt bound to the actor');

  // 6. Re-runnable.
  r = apply('candidate.sql');
  const overloads = scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('create_inventory_hold','_create_inventory_hold_intent_impl_20260905');`);
  assert.equal(overloads, '2', `expected exactly one wrapper and one impl after the re-run, found ${overloads}`);
  r = apply('hold-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `hold smoke chain failed after candidate re-run:\n${r.output}`);

  console.log(`CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS pre_chain=FAIL pre_race=${before.holds}_hold_loser_errors legacy_receipt=REFUSED post_chain=PASS post_race=${after.holds}_hold_loser_replays rerun=PASS`);
}

try { await main(); }
catch (error) { console.error(`CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`); process.exitCode = 1; }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
