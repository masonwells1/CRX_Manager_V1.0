#!/usr/bin/env node
/**
 * Full-chain proof for the local 20260920120000 adjust_inventory candidate:
 * idempotency keys carrying an ASCII control character are refused.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration before the candidate -- which includes
 * 20260911120000, applied live on 2026-09-20 -- then, using the REAL bodies
 * (no stand-ins):
 *   1. asserts the replayed body is byte-identical to what production runs;
 *   2. THE GAP, BEFORE: a UUID with a trailing newline is ACCEPTED by the
 *      installed body and moves stock, while a non-ASCII-only key is already
 *      refused (only the control-character case is new);
 *   3. the rolled-back chain FAILS against the installed body;
 *   4. the candidate REFUSES to apply while an unexpired receipt carries a
 *      control-character key (PREFLIGHT_STRANDED_RECEIPTS), leaving the body
 *      untouched;
 *   5. once that receipt expires, TWO MUTATIONS are judged from the same
 *      untouched starting state the real apply sees -- this ordering matters,
 *      because after the real apply every mutant is stopped by the PREFLIGHT
 *      body check instead, which never reaches the assertion under test:
 *        A. clause removed, pins left alone -> POSTFLIGHT_BODY_PIN;
 *        B. clause removed AND both pins recomputed so every hash check
 *           passes -> POSTFLIGHT_CONTROL_CHAR, proving that named assertion
 *           is load-bearing on its own and not a restatement of the pin.
 *      Each mutant runs under psql -1, so the refusal rolls back whole;
 *   6. the candidate then applies and installs the pinned body;
 *   7. THE GAP, AFTER: the same newline key is refused with
 *      IDEMPOTENCY_KEY_REQUIRED and leaves no receipt, no ledger row and no
 *      stock movement, while an ordinary key still works;
 *   8. the chain passes (SMOKE_PASS_ROLLBACK);
 *   9. the candidate re-applies cleanly (the re-run pin path) and the chain
 *      still passes.
 *
 * Exit code: 0 only on ADJUST_INVENTORY_CONTROL_CHAR_PASS. Any failure exits
 * non-zero. (The older adjust_inventory prover exits 0 on both outcomes; this
 * one deliberately does not.)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-adjust-ctrlkey-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260920120000_refuse_control_character_adjust_inventory_keys.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-adjust-inventory-control-character-keys.sql');
const SIG = 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
const TRIGGER = 'refuse_unbound_adjust_inventory_receipt_20260911';

/** The body 20260911120000 installed, read from live pg_proc on 2026-09-20. */
const INSTALLED_PIN = '9a503e549f42ad54fd9309d4843bab18f646731e5896c015734a61f524ca0af3';

const ADMIN = '5e000000-0000-4000-8000-00000000000a';
const PRODUCT = '5e000000-0000-4000-8000-0000000000f1';

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
function stageText(text, name) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try { writeFileSync(staged, text.replaceAll('\r\n', '\n'), 'utf8'); docker(['cp', staged, `${NAME}:/tmp/${name}`]); }
  finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function stageSql(file, name) { stageText(readFileSync(file, 'utf8'), name); }
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

/** Every post-baseline migration that sorts before the candidate. */
function selected() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'control-character candidate must be selected for post-baseline replay');
  const binding = all.findIndex((f) => path.basename(f) === '20260911120000_bind_adjust_inventory_receipt_to_intent.sql');
  assert.ok(binding >= 0 && binding < candidate, '20260911120000 must precede the candidate; this file replaces the body it installs');
  return all.slice(0, candidate);
}
/**
 * Production stores this body with CRLF; a later migration's PRECONDITION pins
 * that exact text. Reinstall it verbatim before replaying that migration. Piped
 * straight into psql, never staged as a file: staging normalizes CRLF to LF,
 * which is precisely what must be preserved here. Copied verbatim from
 * scripts/smoke/prove-adjust-inventory-intent-binding-real-schema.mjs.
 */
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

const bodySha = () => scalar(`SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = to_regprocedure('${SIG}');`);
const inventoryId = () => scalar(`SELECT id FROM public.inventory WHERE product_id = '${PRODUCT}';`);
const stock = () => Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id = '${PRODUCT}';`));
const ledgerRows = () => Number(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PRODUCT}' AND transaction_type = 'adjusted';`));
const triggerEnabled = () => scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.idempotency_keys'::regclass AND tgname = '${TRIGGER}' AND tgenabled = 'O';`);

function asUser(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE authenticated;`;
}
/** One committed call as `uid`. `keyExpr` is SQL text, so a key can carry chr(10). */
function callAs(uid, inventory, delta, reason, keyExpr) {
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${asUser(uid)}\nSELECT public.adjust_inventory('${inventory}'::uuid, ${delta}, '${reason}', '${uid}'::uuid, ${keyExpr})::text;\nCOMMIT;\n`,
    allowFailure: true,
  });
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return { ok: r.status === 0, result: r.status === 0 && last.startsWith('{') ? JSON.parse(last) : null, error: r.stderr.trim() };
}

/** Both v_new_pin occurrences, asserted equal. */
function pinsOf(text) {
  const pins = [...text.matchAll(/v_new_pin\s+text := '([0-9a-f]{64})'/g)].map((m) => m[1]);
  assert.equal(pins.length, 2, 'expected the new-body pin in both the preflight and the postflight');
  assert.equal(pins[0], pins[1], 'preflight and postflight pin different new bodies');
  return pins[0];
}
/** sha256 of the emitted body, computed the way the migration's own SQL does. */
function emittedBodySha(text) {
  const OPEN = 'AS $adjust$';
  const start = text.indexOf(OPEN) + OPEN.length;
  const end = text.indexOf('$adjust$', start);
  assert.ok(start > OPEN.length - 1 && end > start, 'candidate has no $adjust$ body');
  const prosrc = text.slice(start, end).replaceAll('\r\n', '\n');
  return createHash('sha256').update(Buffer.from(prosrc, 'utf8')).digest('hex');
}

async function main() {
  const candidateText = readFileSync(CANDIDATE, 'utf8');
  const newPin = pinsOf(candidateText);
  assert.equal(emittedBodySha(candidateText), newPin, 'the candidate pins a body it does not emit');
  console.log(`[prover] candidate pins the body it emits: sha256=${newPin}`);

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
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} ordered post-baseline migrations before the candidate`);

  // 1. The replayed tree must carry exactly what production runs.
  const installed = bodySha();
  assert.equal(installed, INSTALLED_PIN,
    `replayed adjust_inventory body is ${installed}, not the body live runs (${INSTALLED_PIN}). The repo has drifted off production.`);
  assert.equal(triggerEnabled(), '1', '20260911120000 cutover trigger is not installed and enabled before the candidate');
  console.log(`[prover] replayed body sha256=${installed} (= the live 20260911120000 body); cutover trigger present`);

  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','ctrlkey-prover-admin@example.invalid','{"full_name":"[PROVER] Ctrl Key Admin","role":"admin"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','ctrlkey-prover-admin@example.invalid','[PROVER] Ctrl Key Admin','admin',true)
    ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.products (id,product_name,sku,is_active) VALUES
      ('${PRODUCT}','[PROVER] Ctrl Key Product','PROVER-CTRL-1',true)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.inventory (product_id,location,quantity_available,quantity_prebooked,quantity_on_order) VALUES
      ('${PRODUCT}','Main Warehouse',100,0,0);`);
  const inv = inventoryId();

  // 2. THE GAP, BEFORE. A newline-bearing key is accepted by the installed body.
  const NL_KEY_SQL = `('prover-ctrl-' || chr(10))`;
  const before = callAs(ADMIN, inv, 5, 'newline key before', NL_KEY_SQL);
  assert.ok(before.ok, `expected the INSTALLED body to ACCEPT a control-character key, got:\n${before.error}`);
  assert.equal(Number(before.result.new_quantity), 105, 'the accepted control-character key did not move stock');
  assert.equal(stock(), 105, 'stock should have moved to 105 on the installed body');
  assert.equal(ledgerRows(), 1, 'the accepted call should have written one ledger row');
  console.log(`[prover] GAP reproduced on the installed body: a key of 'prover-ctrl-' || chr(10) was ACCEPTED and moved stock to ${before.result.new_quantity}`);

  // A non-ASCII-only key is ALREADY refused: only the control-character case is new.
  const utf8Before = callAs(ADMIN, inv, 1, 'non-ascii before', `repeat(chr(233), 8)`);
  assert.equal(utf8Before.ok, false, 'a non-ASCII-only key should already be refused by the installed body');
  assert.match(utf8Before.error, /IDEMPOTENCY_KEY_REQUIRED/, `non-ASCII-only key refused for the wrong reason:\n${utf8Before.error}`);
  console.log('[prover] scope confirmed: a non-ASCII-only key was ALREADY refused before the candidate; the control-character case is the only new refusal');

  // 3. The chain must not pass against the installed body.
  stageSql(SMOKE, 'ctrl-smoke.sql');
  let r = apply('ctrl-smoke.sql', true);
  assert.equal(rollbackPass(r.output), false, `smoke chain unexpectedly PASSED against the installed body:\n${r.output}`);
  assert.match(r.output, /SMOKE_FAIL/, `pre-candidate chain did not fail on a SMOKE_FAIL assertion:\n${r.output}`);
  console.log(`[prover] pre-candidate: chain fails against the installed body (expected): ${(r.output.match(/SMOKE_FAIL[^\n]*/) ?? [''])[0]}`);

  // 4. The unexpired control-character receipt from step 2 blocks the apply.
  stageSql(CANDIDATE, 'candidate.sql');
  r = apply('candidate.sql', true);
  assert.notEqual(r.status, 0, `candidate applied over an unexpired control-character receipt:\n${r.output}`);
  assert.match(r.output, /PREFLIGHT_STRANDED_RECEIPTS/, `candidate did not refuse on the stranded receipt:\n${r.output}`);
  assert.equal(bodySha(), installed, 'the refused apply changed the installed body');
  console.log('[prover] candidate refused while a control-character receipt is live (PREFLIGHT_STRANDED_RECEIPTS); body untouched');

  // 5. Expire it the way time would (container only -- the live rule is to WAIT).
  psql(`UPDATE public.idempotency_keys SET expires_at = now() - interval '1 minute' WHERE operation = 'adjust_inventory';`);

  // 5a/5b. MUTATIONS, run HERE rather than after the real apply. Both must be
  // judged from the same starting state the real apply sees -- the installed
  // 20260911120000 body. Run after it, each mutant is stopped by the PREFLIGHT
  // body check (the installed body is then the candidate's, which no mutant
  // pins), which proves defense in depth but never reaches the postflight
  // assertion under test. Each mutant runs under psql -1, so a refusal rolls
  // the whole file back and leaves the installed body untouched for the next.
  const CLAUSE = `\n     OR p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]'`;
  assert.equal(candidateText.split(CLAUSE).length - 1, 1, 'the control-character clause is not uniquely locatable in the candidate');

  // MUTATION A: drop the clause, leave the pins. The emitted body no longer
  // matches what the file pins, so the body pin must catch it.
  const mutatedA = candidateText.replace(CLAUSE, '');
  stageText(mutatedA, 'mutant-a.sql');
  r = apply('mutant-a.sql', true);
  assert.notEqual(r.status, 0, `MUTATION A applied despite emitting a different body:\n${r.output}`);
  assert.match(r.output, /POSTFLIGHT_BODY_PIN/, `MUTATION A was not caught by the body pin:\n${r.output}`);
  assert.equal(bodySha(), installed, 'MUTATION A left a changed body behind');
  console.log('[prover] MUTATION A (clause removed, pins untouched): refused by POSTFLIGHT_BODY_PIN; body rolled back');

  // MUTATION B: drop the clause AND recompute both pins, so the file is
  // self-consistent and every hash check passes. Only the named assertion can
  // catch this one -- which is the point of having it beside the pin.
  const mutatedB = mutatedA.replaceAll(newPin, emittedBodySha(mutatedA));
  assert.equal(pinsOf(mutatedB), emittedBodySha(mutatedB), 'MUTATION B is not self-consistent');
  assert.equal(mutatedB.includes(CLAUSE), false, 'MUTATION B still contains the clause');
  stageText(mutatedB, 'mutant-b.sql');
  r = apply('mutant-b.sql', true);
  assert.notEqual(r.status, 0, `MUTATION B applied: a self-consistent body with no control-character test passed every postflight check:\n${r.output}`);
  assert.match(r.output, /POSTFLIGHT_CONTROL_CHAR/, `MUTATION B was not caught by the named assertion:\n${r.output}`);
  assert.equal(bodySha(), installed, 'MUTATION B left a changed body behind');
  console.log('[prover] MUTATION B (clause removed, pins recomputed so every hash check passes): refused by POSTFLIGHT_CONTROL_CHAR -- the named assertion stands on its own');

  // 6. The real candidate now applies from that same untouched starting state.
  r = apply('candidate.sql', true);
  assert.equal(r.status, 0, `candidate failed to apply after the receipt expired:\n${r.output}`);
  assert.equal(bodySha(), newPin, 'the applied body is not the pinned candidate body');
  assert.equal(triggerEnabled(), '1', 'the candidate disturbed the 20260911120000 cutover trigger');
  console.log(`[prover] candidate applied; installed body sha256=${newPin}; cutover trigger still enabled`);

  // 6. THE GAP, AFTER.
  const stockBefore = stock();
  const ledgerBefore = ledgerRows();
  const after = callAs(ADMIN, inv, 5, 'newline key after', NL_KEY_SQL);
  assert.equal(after.ok, false, 'the control-character key was still accepted after the candidate applied');
  assert.match(after.error, /IDEMPOTENCY_KEY_REQUIRED/, `control-character key refused for the wrong reason:\n${after.error}`);
  assert.equal(stock(), stockBefore, 'the refused call moved stock');
  assert.equal(ledgerRows(), ledgerBefore, 'the refused call wrote a ledger row');
  const stillWorks = callAs(ADMIN, inv, 7, 'ordinary key after', `gen_random_uuid()::text`);
  assert.ok(stillWorks.ok, `an ordinary key stopped working after the candidate:\n${stillWorks.error}`);
  assert.equal(stock(), stockBefore + 7, 'an ordinary key did not move stock after the candidate');
  console.log(`[prover] AFTER: the same control-character key is refused (IDEMPOTENCY_KEY_REQUIRED), stock held at ${stockBefore}; an ordinary key still adjusted to ${stock()}`);

  // 7. The chain passes.
  r = apply('ctrl-smoke.sql', true);
  assert.ok(rollbackPass(r.output), `smoke chain did not reach SMOKE_PASS_ROLLBACK after the candidate:\n${r.output}`);
  console.log('[prover] post-candidate: chain SMOKE_PASS_ROLLBACK');

  // 8. Re-apply (the re-run pin path), then the chain again.
  r = apply('candidate.sql', true);
  assert.equal(r.status, 0, `candidate did not re-apply cleanly:\n${r.output}`);
  assert.match(r.output, /already this file's body; re-running/, `re-run did not take the re-run pin path:\n${r.output}`);
  assert.equal(bodySha(), newPin, 're-applying changed the body');
  r = apply('ctrl-smoke.sql', true);
  assert.ok(rollbackPass(r.output), `chain failed after a clean re-apply:\n${r.output}`);
  console.log('[prover] candidate re-applied cleanly via the re-run pin path; chain still passes');

  console.log('ADJUST_INVENTORY_CONTROL_CHAR_PASS');
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  console.error('ADJUST_INVENTORY_CONTROL_CHAR_FAIL');
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
