#!/usr/bin/env node
/**
 * Full-chain proof for the local 20260911120000 adjust_inventory candidate
 * (CRX-IDEM-01: receipt replay before authentication and the admin check).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration before the candidate, then, using the REAL bodies
 * (no stand-ins):
 *   1. THE FINDING, BEFORE: an admin adjusts stock with a key; a signed-in
 *      sales rep AND a second active admin, each calling with that key (and a
 *      different delta), are handed the admin's receipt, and stock does not
 *      move again;
 *   2. runs the rolled-back smoke chain against the live body and expects FAIL;
 *   3. the candidate REFUSES to apply while that unbound receipt is unexpired
 *      (PREFLIGHT_LEGACY_RECEIPTS) and leaves the live body and the table
 *      untouched;
 *   4. CUTOVER: once the receipt expires, a keyed call of the OLD body is caught
 *      mid-flight (blocked inside check_idempotency by the migration's lock,
 *      confirmed from pg_stat_activity), the candidate commits, the old-body
 *      call resumes, and the cutover trigger rolls it back whole: no stock
 *      change, no ledger row, no receipt;
 *   5. THE FINDING, AFTER: the same rep call is refused with INSUFFICIENT_ROLE,
 *      the second admin with IDEMPOTENCY_ACTOR_MISMATCH (no result attached),
 *      and the admin's own retry still replays;
 *   6. the smoke chain passes (SMOKE_PASS_ROLLBACK);
 *   7. a same-key two-session race (session 2 confirmed waiting on the lock)
 *      ends with one stock change, both sessions returning the same result, and
 *      one receipt bound to the admin;
 *   8. the candidate re-applies cleanly and the chain still passes;
 *   9. MUTATION: with the cutover trigger neutered the chain FAILS on the
 *      unbound-receipt case; re-applying the candidate restores it.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-adjust-intent-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260911120000_bind_adjust_inventory_receipt_to_intent.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-adjust-inventory-intent-binding.sql');
const SIG = 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
const TRIGGER = 'refuse_unbound_adjust_inventory_receipt_20260911';
const LIVE_PIN = 'ef485890f3b9ef82359a95dda95d12a57ad633b86f841ead80e872d1eb71b4df';

const ADMIN = '5c000000-0000-4000-8000-00000000000a';
const REP = '5c000000-0000-4000-8000-00000000000b';
const ADMIN2 = '5c000000-0000-4000-8000-00000000000c';
const PRODUCT = {
  leak: '5c000000-0000-4000-8000-0000000000f1',
  cutover: '5c000000-0000-4000-8000-0000000000f2',
  race: '5c000000-0000-4000-8000-0000000000f3',
};

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
  finally {
    // Log a cleanup failure instead of throwing it: a throw from finally would
    // replace the staging error that actually explains why the prover stopped.
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
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
  assert.ok(candidate >= 0, 'adjust_inventory candidate must be selected for post-baseline replay');
  const intent = all.findIndex((f) => path.basename(f) === '20260811130000_bind_commission_payout_idempotency_to_intent.sql');
  const binding = all.findIndex((f) => path.basename(f) === '20260803010917_bind_idempotency_to_mutation_intent.sql');
  assert.ok(intent >= 0 && intent < candidate, 'check_idempotency_intent migration must precede the candidate');
  assert.ok(binding >= 0 && binding < candidate, 'receipt binding-column migration must precede the candidate');
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

const bodySha = () => scalar(`SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = to_regprocedure('${SIG}');`);
const inventoryId = (product) => scalar(`SELECT id FROM public.inventory WHERE product_id = '${product}';`);
const stock = (product) => Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${product}';`));
const ledgerRows = (product) => Number(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${product}' AND transaction_type = 'adjusted';`));
const receipts = (key) => Number(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`));
const triggerCount = () => scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.idempotency_keys'::regclass AND tgname = '${TRIGGER}';`);

// The image's auth.uid() may read request.jwt.claim.sub before request.jwt.claims; set both.
// Calls run as the `authenticated` role, exactly like a browser session through PostgREST.
function asUser(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE authenticated;`;
}
function adjustSql(inventory, delta, reason, performedBy, key) {
  const actor = performedBy ? `'${performedBy}'::uuid` : 'NULL::uuid';
  return `SELECT public.adjust_inventory('${inventory}'::uuid, ${delta}, '${reason}', ${actor}, '${key}')::text;`;
}
/** One committed call as `uid`; returns the parsed result or the error text. */
function callAs(uid, inventory, delta, reason, performedBy, key) {
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${asUser(uid)}\n${adjustSql(inventory, delta, reason, performedBy, key)}\nCOMMIT;\n`,
    allowFailure: true,
  });
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return { ok: r.status === 0, result: r.status === 0 ? JSON.parse(last) : null, error: r.stderr.trim() };
}
function candidatePin() {
  const pins = [...readFileSync(CANDIDATE, 'utf8').matchAll(/v_new_pin\s+text := '([0-9a-f]{64})'/g)].map((m) => m[1]);
  assert.equal(pins.length, 2, 'expected the new-body pin in both the preflight and the postflight');
  assert.equal(pins[0], pins[1], 'preflight and postflight pin different new bodies');
  return pins[0];
}
/** Poll until another backend is waiting on a lock while running a statement that names `key`. */
function waitUntilBlocked(key) {
  for (let i = 0; i < 100; i += 1) {
    const n = Number(scalar(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%${key}%' AND pid <> pg_backend_pid();`));
    if (n > 0) return true;
    wait(50);
  }
  return false;
}

async function cutoverRace(inventory, key) {
  // M holds the migration's lock, waits until B is provably blocked INSIDE the
  // old body, then applies the candidate and commits.
  const m = startSqlWithMarker(`BEGIN;
LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
\\echo M_LOCKED
DO $wait$
BEGIN
  FOR i IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS (SELECT 1 FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND query LIKE '%${key}%') THEN
      RAISE NOTICE 'CUTOVER_CALLER_BLOCKED';
      RETURN;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE EXCEPTION 'CUTOVER_CALLER_NEVER_BLOCKED';
END;
$wait$;
\\i /tmp/candidate.sql
COMMIT;
`, 'M_LOCKED');
  await m.ready;
  // B resolves the OLD adjust_inventory now, before M replaces it.
  const b = startSqlWithMarker(`BEGIN;\n${asUser(ADMIN)}\n${adjustSql(inventory, 7, 'cutover', ADMIN, key)}\nCOMMIT;\n`, null);
  const [rm, rb] = await Promise.all([m.completion, b.completion]);
  return { m: rm, b: rb };
}

async function raceSameKey(inventory, key) {
  const call = adjustSql(inventory, 5, 'race', ADMIN, key);
  // Session 1 adjusts, announces it, then sleeps with the transaction open.
  const s1 = startSqlWithMarker(`BEGIN;\n${asUser(ADMIN)}\n${call}\n\\echo S1_DONE\nSELECT pg_sleep(2.5);\nCOMMIT;\n`, 'S1_DONE');
  await s1.ready;
  const s2 = startSqlWithMarker(`BEGIN;\n${asUser(ADMIN)}\n${call}\nCOMMIT;\n`, null);
  const s2Blocked = waitUntilBlocked(key);
  const [r1, r2] = await Promise.all([s1.completion, s2.completion]);
  const lastJson = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('{')).at(-1) ?? null;
  return { r1, r2, s2Blocked, out1: lastJson(r1.stdout), out2: lastJson(r2.stdout) };
}

async function main() {
  const newPin = candidatePin();
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
  const liveSha = bodySha();
  assert.equal(liveSha, LIVE_PIN, 'baseline adjust_inventory body is not the pinned live body');
  console.log(`[prover] baseline adjust_inventory prosrc sha256=${liveSha} (= live pin)`);

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder('postgres');
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true); if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} ordered post-baseline migrations before the candidate`);
  assert.equal(bodySha(), liveSha, 'a post-baseline migration redefined adjust_inventory; the candidate pin is stale');

  // The baseline auth.users is a stub; deactivating a profile fires
  // _sync_auth_access_on_profile_active, which writes the real column set.
  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','adjust-prover-admin@example.invalid','{"full_name":"[PROVER] Adjust Admin","role":"admin"}'::jsonb),
      ('${REP}','adjust-prover-rep@example.invalid','{"full_name":"[PROVER] Adjust Rep","role":"sales_rep"}'::jsonb),
      ('${ADMIN2}','adjust-prover-admin2@example.invalid','{"full_name":"[PROVER] Adjust Admin Two","role":"admin"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','adjust-prover-admin@example.invalid','[PROVER] Adjust Admin','admin',true),
      ('${REP}','adjust-prover-rep@example.invalid','[PROVER] Adjust Rep','sales_rep',true),
      ('${ADMIN2}','adjust-prover-admin2@example.invalid','[PROVER] Adjust Admin Two','admin',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.products (id,product_name,sku,is_active) VALUES
      ('${PRODUCT.leak}','[PROVER] Adjust Leak','PROVER-ADJ-1',true),
      ('${PRODUCT.cutover}','[PROVER] Adjust Cutover','PROVER-ADJ-2',true),
      ('${PRODUCT.race}','[PROVER] Adjust Race','PROVER-ADJ-3',true)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.inventory (product_id,location,quantity_available,quantity_prebooked,quantity_on_order) VALUES
      ('${PRODUCT.leak}','Main Warehouse',100,0,0),
      ('${PRODUCT.cutover}','Main Warehouse',100,0,0),
      ('${PRODUCT.race}','Main Warehouse',100,0,0);`);
  const inv = { leak: inventoryId(PRODUCT.leak), cutover: inventoryId(PRODUCT.cutover), race: inventoryId(PRODUCT.race) };

  // 1. THE FINDING, BEFORE: a sales rep holding an admin's key reads the receipt.
  const adminCall = callAs(ADMIN, inv.leak, 5, 'prover leak', ADMIN, 'prover-leak-key');
  assert.ok(adminCall.ok, `admin adjustment failed on the live body:\n${adminCall.error}`);
  assert.equal(Number(adminCall.result.new_quantity), 105, 'admin adjustment did not move stock to 105');
  const repBefore = callAs(REP, inv.leak, 999, 'not mine', null, 'prover-leak-key');
  assert.ok(repBefore.ok, `expected the LIVE body to hand the admin's receipt to a sales rep, got:\n${repBefore.error}`);
  assert.deepEqual(repBefore.result, adminCall.result, 'the sales rep did not receive the admin receipt');
  const admin2Before = callAs(ADMIN2, inv.leak, 1, 'other admin', ADMIN2, 'prover-leak-key');
  assert.ok(admin2Before.ok, `expected the LIVE body to hand the admin's receipt to a second admin, got:\n${admin2Before.error}`);
  assert.deepEqual(admin2Before.result, adminCall.result, 'the second admin did not receive the first admin receipt');
  assert.equal(stock(PRODUCT.leak), 105, 'the replay must not move stock (the finding is a read, not a write)');
  assert.equal(ledgerRows(PRODUCT.leak), 1, 'the replay must not write a ledger row');
  console.log(`[prover] pre-candidate FINDING reproduced: a sales rep and a second admin with the first admin's key each received ${JSON.stringify(repBefore.result)}; stock unchanged at 105`);

  // 2. The chain must not pass against the live body.
  stageSql(SMOKE, 'adjust-smoke.sql');
  let r = apply('adjust-smoke.sql', true);
  assert.equal(rollbackPass(r.output), false, `smoke chain unexpectedly PASSED against the live body:\n${r.output}`);
  assert.match(r.output, /SMOKE_FAIL/, `pre-candidate chain did not fail on a SMOKE_FAIL assertion:\n${r.output}`);
  console.log(`[prover] pre-candidate: smoke chain fails against the live body (expected): ${(r.output.match(/SMOKE_FAIL[^\n]*/) ?? [''])[0]}`);

  // 3. The unexpired unbound receipt from step 1 blocks the apply.
  stageSql(CANDIDATE, 'candidate.sql');
  r = apply('candidate.sql', true);
  assert.notEqual(r.status, 0, `candidate applied over an unexpired legacy receipt:\n${r.output}`);
  assert.match(r.output, /PREFLIGHT_LEGACY_RECEIPTS: 1 unexpired unbound adjust_inventory receipt/, `candidate did not refuse on the legacy receipt:\n${r.output}`);
  assert.equal(bodySha(), liveSha, 'the refused apply changed the live body');
  assert.equal(triggerCount(), '0', 'the refused apply left the cutover trigger behind');
  console.log('[prover] candidate refused while a legacy receipt is live (PREFLIGHT_LEGACY_RECEIPTS); body and triggers untouched');

  // 4. Expire it the way time would (container only — the live rule is to WAIT,
  //    never delete), then apply WHILE an old-body call is in flight.
  psql(`UPDATE public.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE idempotency_key = 'prover-leak-key';`);
  const cut = await cutoverRace(inv.cutover, 'prover-cutover-key');
  assert.equal(cut.m.code, 0, `the migration session failed:\n${cut.m.stderr}`);
  assert.match(cut.m.stderr, /CUTOVER_CALLER_BLOCKED/, 'the old-body call was never observed blocked inside the old body');
  assert.match(cut.m.stderr, /no unexpired pre-migration receipts; safe to swap/, `candidate did not confirm a clean receipt table:\n${cut.m.stderr}`);
  assert.notEqual(cut.b.code, 0, `the in-flight OLD-body call committed after cutover:\n${cut.b.stdout}`);
  assert.match(cut.b.stderr, /ADJUST_INVENTORY_UNBOUND_RECEIPT/, `the in-flight old-body call failed for the wrong reason:\n${cut.b.stderr}`);
  assert.equal(stock(PRODUCT.cutover), 100, 'the refused old-body call moved stock');
  assert.equal(ledgerRows(PRODUCT.cutover), 0, 'the refused old-body call left a ledger row');
  assert.equal(receipts('prover-cutover-key'), 0, 'the refused old-body call left a receipt');
  assert.equal(bodySha(), newPin, 'the installed body is not the body the candidate pins');
  console.log('[prover] cutover: old-body call caught mid-flight was rolled back whole by the trigger (no stock change, no ledger row, no receipt)');

  // 5. THE FINDING, AFTER.
  const admin2 = callAs(ADMIN, inv.leak, 5, 'prover leak after', ADMIN, 'prover-leak-key-2');
  assert.ok(admin2.ok, `admin adjustment failed after the candidate:\n${admin2.error}`);
  assert.equal(Number(admin2.result.new_quantity), 110, 'admin adjustment did not move stock to 110');
  const repAfter = callAs(REP, inv.leak, 999, 'not mine', null, 'prover-leak-key-2');
  assert.equal(repAfter.ok, false, `the sales rep still received the admin receipt: ${JSON.stringify(repAfter.result)}`);
  assert.match(repAfter.error, /INSUFFICIENT_ROLE/, `the sales rep was refused for the wrong reason:\n${repAfter.error}`);
  assert.doesNotMatch(repAfter.error, /new_quantity/, 'the refusal disclosed the receipt');
  const admin2After = callAs(ADMIN2, inv.leak, 5, 'prover leak after', ADMIN2, 'prover-leak-key-2');
  assert.equal(admin2After.ok, false, `the second admin still received the first admin receipt: ${JSON.stringify(admin2After.result)}`);
  assert.match(admin2After.error, /IDEMPOTENCY_ACTOR_MISMATCH/, `the second admin was refused for the wrong reason:\n${admin2After.error}`);
  assert.doesNotMatch(admin2After.error, /new_quantity/, 'the actor-mismatch refusal disclosed the receipt');
  const adminRetry = callAs(ADMIN, inv.leak, 5, 'prover leak after', ADMIN, 'prover-leak-key-2');
  assert.ok(adminRetry.ok, `the admin's own retry failed:\n${adminRetry.error}`);
  assert.deepEqual(adminRetry.result, admin2.result, 'the admin retry did not replay the same result');
  assert.equal(stock(PRODUCT.leak), 110, 'the refused call or the retry moved stock');
  assert.equal(ledgerRows(PRODUCT.leak), 2, 'expected exactly the two real adjustments in the ledger');
  console.log(`[prover] post-candidate FINDING closed: sales rep refused (${repAfter.error.match(/INSUFFICIENT_ROLE[^\n]*/)?.[0]}); second admin refused (${admin2After.error.match(/IDEMPOTENCY_ACTOR_MISMATCH[^\n]*/)?.[0]}); admin retry replays`);

  // 6. The chain passes.
  r = apply('adjust-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `smoke chain failed after candidate:\n${r.output}`);
  console.log('[prover] post-candidate: smoke chain SMOKE_PASS_ROLLBACK');

  // 7. Same-key race: one stock change, both callers the same result.
  const race = await raceSameKey(inv.race, 'prover-race-key');
  console.log(`[prover] race: s1_exit=${race.r1.code} s2_exit=${race.r2.code} s2_waited=${race.s2Blocked} same_result=${race.out1 === race.out2}`);
  assert.equal(race.r1.code, 0, `race session 1 failed:\n${race.r1.stderr}`);
  assert.equal(race.r2.code, 0, `race session 2 did not replay:\n${race.r2.stderr}`);
  assert.equal(race.s2Blocked, true, 'session 2 was never observed waiting on the key lock; the race did not overlap');
  assert.ok(race.out1, 'session 1 returned no result');
  assert.equal(race.out2, race.out1, 'the racing sessions returned different results');
  assert.equal(stock(PRODUCT.race), 105, 'the race moved stock more than once');
  assert.equal(ledgerRows(PRODUCT.race), 1, 'the race wrote more than one ledger row');
  assert.equal(receipts('prover-race-key'), 1, 'expected exactly one receipt');
  assert.equal(scalar(`SELECT coalesce(request_actor_id::text, '') FROM public.idempotency_keys WHERE idempotency_key = 'prover-race-key';`), ADMIN, 'the race receipt is not bound to the admin');

  // 8. Re-runnable.
  r = apply('candidate.sql', true);
  assert.equal(r.status, 0, `candidate re-run failed:\n${r.output}`);
  assert.match(r.output, /already this file's body; re-running/, `re-run did not take the re-run path:\n${r.output}`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'adjust_inventory';`), '1', 'expected exactly one overload after the re-run');
  assert.equal(triggerCount(), '1', 'expected exactly one cutover trigger after the re-run');
  r = apply('adjust-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `smoke chain failed after candidate re-run:\n${r.output}`);
  console.log('[prover] re-run: clean, one overload, one trigger, chain passes');

  // 9. MUTATION: the trigger is load-bearing for the chain's cutover case.
  psql(`CREATE OR REPLACE FUNCTION public._refuse_unbound_adjust_inventory_receipt_20260911()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
    AS $neutered$ BEGIN RETURN NEW; END; $neutered$;`);
  r = apply('adjust-smoke.sql', true);
  assert.equal(rollbackPass(r.output), false, 'the chain passed with the cutover trigger neutered');
  assert.match(r.output, /SMOKE_FAIL: the old receipt writer landed an UNBOUND adjust_inventory receipt/, `neutered trigger was not caught by the cutover case:\n${r.output}`);
  r = apply('candidate.sql', true);
  assert.equal(r.status, 0, `re-apply after the mutation failed:\n${r.output}`);
  r = apply('adjust-smoke.sql', true);
  assert.equal(rollbackPass(r.output), true, `chain failed after the trigger was restored:\n${r.output}`);
  console.log('[prover] mutation: neutered trigger caught by the chain; re-apply restores it');

  console.log('ADJUST_INVENTORY_INTENT_REAL_SCHEMA_PASS pre_finding=REP_AND_ADMIN2_READ_RECEIPT pre_chain=FAIL legacy_receipt=REFUSED cutover=OLD_BODY_ROLLED_BACK post_finding=INSUFFICIENT_ROLE+ACTOR_MISMATCH post_chain=PASS race=1_change_same_result rerun=PASS trigger_mutation=CAUGHT');
}

try { await main(); }
catch (error) { console.error(`ADJUST_INVENTORY_INTENT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`); process.exitCode = 1; }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
