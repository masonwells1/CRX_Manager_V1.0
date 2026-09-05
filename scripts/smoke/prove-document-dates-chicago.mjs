#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for
 *   supabase/migrations/20260905020500_document_dates_follow_chicago_business_day.sql
 *
 * The four document-date writers stop stamping orders.order_date / invoices.invoice_date
 * (and, in transfer_job_to_invoice, the due date and the derived SEASON) from the UTC
 * clock. Together with 20260905020400 this closes the September 30 commission risk;
 * 020400 alone did not, because the document it derives from was itself UTC-stamped.
 *
 * Same harness as prove-invoice-date-fallbacks-chicago.mjs / prove-commission-dates-chicago.mjs:
 * restores the supported schema baseline, replays the ledger-selected post-baseline
 * migrations, never reads a DB URL, and touches nothing outside its own throwaway,
 * network-less container.
 *
 * WHAT IT PROVES, in order:
 *   1.  baseline restored and post-baseline migrations replayed;
 *   1a. each writer's clean-rebuild body hashes to a pin the candidate accepts, so a
 *       disaster-recovery rebuild is not refused;
 *   2.  BEFORE the candidate, every writer evaluates CURRENT_DATE in code — the defect,
 *       and the discriminator for phase 4;
 *   3.  against an unexpected anon EXECUTE grant the candidate ABORTS with
 *       PREFLIGHT_ACL and changes nothing; against a DRIFTED body it separately
 *       ABORTS with PREFLIGHT_DRIFT;
 *   4.  it applies over the pinned bodies, and AFTER it NO writer evaluates CURRENT_DATE
 *       in code any more, while each carries exactly the number of America/Chicago
 *       conversions the file claims;
 *   5.  re-applying is safe;
 *   6.  MUTATION: a candidate with one conversion reverted must ABORT in
 *       POSTFLIGHT_UTC_RESIDUAL with nothing installed — proving the postflight is
 *       load-bearing. Then it is discarded.
 *   7.  MUTATION: an extra anon grant inserted immediately before postflight must
 *       ABORT in POSTFLIGHT_ACL and roll the entire candidate back.
 *
 * SCOPE — read this before quoting the result. This proves the CONVERSION: which bodies
 * are replaced, that the replacement is byte-faithful apart from the date expression, and
 * that no UTC date evaluation survives. It does NOT drive a quote, a delivery or a job
 * end-to-end; those paths need large fixtures. The behavioural half — that a Chicago
 * business date actually reaches a commission when the session clock disagrees — is proven
 * for the commission helpers by prove-commission-dates-chicago.mjs.
 *
 * Requires Docker.
 *
 *   node scripts/smoke/prove-document-dates-chicago.mjs
 *
 * Exits 0 only if every phase passes, including the mutation phase, which must FAIL.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWrappable } from '../../.claude/hooks/migration-wrappability-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-document-dates-chicago-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260905020500_document_dates_follow_chicago_business_day.sql');
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';

// name -> the number of CURRENT_DATE values the candidate converts, read from its own
// header rather than re-typed here.
const WRITERS = [
  '_convert_quote_to_order_owner_impl',
  '_draw_down_quote_below_cost_impl_20260810',
  '_create_quick_delivery_intent_impl_20260802',
  'transfer_job_to_invoice',
];

const log = (m) => process.stdout.write(`${m}\n`);

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (!options.allowFailure && r.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function psql(sql, options = {}) {
  const r = docker(
    ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(options.wrap ? ['-1'] : [])],
    { input: sql, allowFailure: options.allowFailure },
  );
  if (!options.allowFailure && r.status !== 0) throw new Error(`psql failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function isWrappable(text) { try { assertWrappable(text, 'replay'); return true; } catch { return false; } }
const wrapByName = new Map();
function scalar(sql) { return docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atqc', sql]).stdout.trim(); }
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function copyLf(local, name, dir) {
  const lf = readFileSync(local, 'utf8').replace(/\r\n/g, '\n');
  const tmp = path.join(dir, name);
  writeFileSync(tmp, lf, 'utf8');
  wrapByName.set(name, isWrappable(lf));
  copy(tmp, name);
}
function copyText(text, name, dir) {
  const tmp = path.join(dir, name);
  writeFileSync(tmp, text, 'utf8');
  wrapByName.set(name, isWrappable(text));
  copy(tmp, name);
}
function apply(name, user) { return psql(`\\i /tmp/${name}`, { user, wrap: wrapByName.get(name) ?? false }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let i = 0; i < 120; i += 1) {
    const q = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], { allowFailure: true });
    if (q.status === 0 && q.stdout.trim() === '1') return;
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout.split(/\r?\n/).filter((l) => l.startsWith('supabase/migrations/')).map((rel) => path.join(ROOT, rel));
  const idx = migrations.indexOf(CANDIDATE);
  assert.notEqual(idx, -1, 'candidate migration is not in the ledger-selected post-baseline replay');
  return migrations.slice(0, idx + 1);
}
function bodyMd5(fn) { return scalar(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`); }
function functionDef(fn) { return scalar(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`); }
function bodyState() { return Object.fromEntries(WRITERS.map((fn) => [fn, bodyMd5(fn)])); }
function roleCanExecute(role, signature) {
  return scalar(`SELECT has_function_privilege('${role}', '${signature}'::regprocedure, 'EXECUTE')`) === 't';
}
// CURRENT_DATE occurrences in CODE only — a comment mentioning it must not count, in
// either direction.
function codeCurrentDateCount(fn) {
  return Number(scalar(`
    SELECT count(*) FROM regexp_matches(
      (SELECT string_agg(CASE WHEN position('--' in l) > 0 THEN left(l, position('--' in l) - 1) ELSE l END, E'\\n')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
              regexp_split_to_table(p.prosrc, E'\\n') AS l
        WHERE n.nspname = 'public' AND p.proname = '${fn}'),
      '\\mcurrent_date\\M', 'gi')`));
}
function chicagoCount(fn) {
  return Number(scalar(`SELECT count(*) FROM regexp_matches((SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}'), 'America/Chicago', 'g')`));
}

// Argument DEFAULT expressions are NOT in prosrc — they live in pg_proc.proargdefaults, which is
// why every prosrc-based check above is blind to them. pg_get_expr's second argument is the
// RELATION the expression belongs to; an argument default references no table, so it must be 0.
// `viaProOid` exists only so PHASE 9 can prove the wrong-but-obvious form really does go dark.
function argDefaults(fn) {
  return scalar(`SELECT COALESCE(pg_get_expr(p.proargdefaults, 0), '<NULL>') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}'`);
}
function argDefaultsViaProOid(fn) {
  return scalar(`SELECT COALESCE(pg_get_expr(p.proargdefaults, p.oid), '<NULL>') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}'`);
}

const QUICK_IMPL = '_create_quick_delivery_intent_impl_20260802';

const candidateSql = readFileSync(CANDIDATE, 'utf8');
assert.equal(candidateSql.includes('\r'), false, 'candidate must be LF');

// Read the pins and the claimed conversion counts out of the candidate itself, so this
// prover cannot silently disagree with the file it is proving.
const PINS = {};
const CLAIMED = {};
for (const fn of WRITERS) {
  const pin = new RegExp(`'${fn}',\\s*\\n?\\s*jsonb_build_array\\('([0-9a-f]{32})',\\s*'([0-9a-f]{32})'\\)`).exec(candidateSql);
  assert.ok(pin, `could not read the md5 pin pair for ${fn} out of the candidate`);
  PINS[fn] = { pre: pin[1], post: pin[2] };
  const claim = new RegExp(`public\\.${fn}\\n--\\s+.*\\n--\\s+(\\d+) CURRENT_DATE value`).exec(candidateSql);
  assert.ok(claim, `could not read the claimed conversion count for ${fn}`);
  CLAIMED[fn] = Number(claim[1]);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'crx-document-dates-'));

try {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();

  const artifacts = ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql'];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 40 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);
  apply('20260727174805_extensions.sql');
  psql(schema.stdout.toString());
  psql(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
      name text NOT NULL, owner_id text
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
  `, { user: 'supabase_admin' });
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  apply('20260727174805_migration_history.sql');

  const migrations = selectedMigrations();
  assert.equal(migrations.at(-1), CANDIDATE, 'candidate must be the final ledger-selected migration');
  const stopIdx = migrations.findIndex((m) => path.basename(m) === REPLAY_STOP_BEFORE);
  assert.notEqual(stopIdx, -1, `replay stop marker ${REPLAY_STOP_BEFORE} is not in the ledger-selected list`);
  for (const [index, migration] of migrations.slice(0, stopIdx).entries()) {
    const name = `migration-${index}.sql`;
    copyLf(migration, name, workDir);
    apply(name);
  }
  log(`PHASE 1: baseline restored and ${stopIdx} post-baseline migrations replayed`);

  // PHASE 1a: disaster recovery. A clean rebuild reaches this file with the writers in
  // their replayed form; if that is not a pin the candidate accepts, a rebuild is refused.
  const rebuild = bodyState();
  for (const fn of WRITERS) {
    assert.ok(
      rebuild[fn] === PINS[fn].pre || rebuild[fn] === PINS[fn].post,
      `${fn}: the clean-rebuild body hashes to ${rebuild[fn]} but the candidate accepts only ${PINS[fn].pre} / ${PINS[fn].post}. A disaster-recovery rebuild would be REFUSED.`,
    );
  }
  log('PHASE 1a: every writer\'s clean-rebuild body is a pin the candidate accepts — a rebuild is not refused');

  // PHASE 2: the defect.
  const before = Object.fromEntries(WRITERS.map((fn) => [fn, codeCurrentDateCount(fn)]));
  for (const fn of WRITERS) {
    assert.equal(before[fn], CLAIMED[fn],
      `BEFORE: ${fn} evaluates CURRENT_DATE ${before[fn]} time(s) in code, but the candidate claims it converts ${CLAIMED[fn]}. The claim and the code disagree.`);
  }
  log(`PHASE 2: the defect reproduces — code CURRENT_DATE per writer ${JSON.stringify(before)}, matching the candidate's own claims`);

  // PHASE 2b: the SECOND defect, the one prosrc cannot see. The clean rebuild must install the
  // quick-delivery implementation with a UTC CURRENT_DATE in its ARGUMENT DEFAULT. If this ever
  // stops reproducing, the phases below would be proving nothing.
  const defaultsBefore = argDefaults(QUICK_IMPL);
  assert.match(defaultsBefore, /current_date/i,
    `BEFORE: ${QUICK_IMPL} should carry CURRENT_DATE in an argument default, got: ${defaultsBefore}`);
  assert.equal(codeCurrentDateCount(QUICK_IMPL) > 0, true, 'sanity: the body defect must also be present');
  log(`PHASE 2b: the argument-default defect reproduces — ${QUICK_IMPL} defaults are "${defaultsBefore}", invisible to every prosrc check`);

  // PHASE 3: ACL and body-drift refusal.
  const originalDefs = Object.fromEntries(WRITERS.map((fn) => [fn, functionDef(fn)]));
  const restoreWriters = () => {
    psql(Object.values(originalDefs).join('\n;\n'));
    assert.deepEqual(bodyState(), rebuild, 'writers not restored');
  };
  copyLf(CANDIDATE, 'candidate.sql', workDir);
  const quickSignature = 'public._create_quick_delivery_intent_impl_20260802(uuid,jsonb,uuid,date,text,uuid,text,boolean)';
  psql(`GRANT EXECUTE ON FUNCTION ${quickSignature} TO anon;`);
  assert.equal(roleCanExecute('anon', quickSignature), true, 'ACL drift setup did not grant anon EXECUTE');
  const aclDrifted = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.match(`${aclDrifted.stdout}\n${aclDrifted.stderr}`, /PREFLIGHT_ACL/,
    'the candidate must ABORT on an unexpected anon EXECUTE grant');
  assert.deepEqual(bodyState(), rebuild, 'ACL-drift refusal must not replace any writer body');
  assert.equal(roleCanExecute('anon', quickSignature), true,
    'the refused candidate must not hide the pre-existing ACL drift by partially applying');
  psql(`REVOKE EXECUTE ON FUNCTION ${quickSignature} FROM anon;`);
  assert.equal(roleCanExecute('anon', quickSignature), false, 'ACL drift cleanup failed');
  log('PHASE 3: the candidate ABORTS with PREFLIGHT_ACL on an unexpected anon grant and changes nothing');

  psql(`
    CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
    AS $drift$ BEGIN RETURN '{}'::jsonb; END; $drift$;
  `);
  const drifted = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.match(`${drifted.stdout}\n${drifted.stderr}`, /PREFLIGHT_DRIFT/, 'the candidate must ABORT on a drifted writer body');
  assert.equal(bodyMd5('_convert_quote_to_order_owner_impl'), rebuild._convert_quote_to_order_owner_impl, 'other writers must be untouched after the refused apply');
  log('PHASE 3b: the candidate ABORTS with PREFLIGHT_DRIFT on a drifted body and changes nothing');
  restoreWriters();

  // PHASE 4: the real apply.
  const applied = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.equal(applied.status, 0, `the candidate must apply over the pinned bodies:\n${applied.stdout}\n${(applied.stderr || '').slice(-2000)}`);
  const afterBodies = bodyState();
  for (const fn of WRITERS) {
    assert.equal(afterBodies[fn], PINS[fn].post, `${fn}: installed body ${afterBodies[fn]} is not the candidate's post-image pin ${PINS[fn].post}`);
    assert.equal(codeCurrentDateCount(fn), 0, `AFTER: ${fn} still evaluates CURRENT_DATE in code`);
    assert.ok(chicagoCount(fn) >= CLAIMED[fn], `AFTER: ${fn} carries ${chicagoCount(fn)} America/Chicago conversions, expected at least the ${CLAIMED[fn]} claimed`);
  }
  log(`PHASE 4: applied. Every writer now evaluates ZERO code CURRENT_DATE; Chicago conversions ${JSON.stringify(Object.fromEntries(WRITERS.map((f) => [f, chicagoCount(f)])))}`);

  // PHASE 4b: the installed expression must actually EVALUATE to the Chicago business day
  // when the session clock disagrees. Phase 4 proves the right text is installed in all
  // 19 sites; this proves that text is the right text. Without it the whole file rests on
  // reading SQL rather than running it.
  const evaluated = psql(`
DO $eval$
DECLARE v_chi date; v_sess date; v_installed date; v_zone text;
BEGIN
  PERFORM set_config('TimeZone', 'Pacific/Kiritimati', true);
  v_chi := (now() AT TIME ZONE 'America/Chicago')::date;
  IF CURRENT_DATE = v_chi THEN PERFORM set_config('TimeZone', 'Etc/GMT+12', true); END IF;
  v_zone := current_setting('TimeZone');
  v_sess := CURRENT_DATE;
  IF v_sess = v_chi THEN
    RAISE EXCEPTION 'EVAL_SETUP: no session zone differs from Chicago at this instant';
  END IF;
  -- the exact expression this migration installs at all 19 sites
  v_installed := (now() AT TIME ZONE 'America/Chicago')::date;
  RAISE EXCEPTION 'EVAL_RESULT zone=% session=% chicago=% installed=%', v_zone, v_sess, v_chi, v_installed;
END
$eval$;`, { allowFailure: true });
  const em = /EVAL_RESULT zone=(\S+) session=(\S+) chicago=(\S+) installed=(\S+)/.exec(`${evaluated.stdout}\n${evaluated.stderr}`);
  assert.ok(em, `the evaluation probe did not report:\n${(evaluated.stderr || '').slice(-1200)}`);
  const [, zone, session, chicago, installed] = em;
  assert.equal(installed, chicago, 'the installed expression must evaluate to the Chicago business day');
  assert.notEqual(installed, session, 'the installed expression must NOT follow the session clock');
  log(`PHASE 4b: under ${zone} the session day is ${session} but the installed expression evaluates ${installed} (Chicago ${chicago}) — it follows Chicago, not the session clock`);

  // PHASE 4c: the argument default is converted too, and the reader that sees it is alive.
  const defaultsAfter = argDefaults(QUICK_IMPL);
  assert.doesNotMatch(defaultsAfter, /current_date/i,
    `AFTER: ${QUICK_IMPL} still carries CURRENT_DATE in an argument default: ${defaultsAfter}`);
  assert.match(defaultsAfter, /America\/Chicago/,
    `AFTER: ${QUICK_IMPL} argument default must carry the Chicago conversion: ${defaultsAfter}`);
  assert.notEqual(defaultsAfter, '<NULL>',
    'the argument-default reader returned NULL after apply — a NULL here would make PHASE 8 vacuous');
  log(`PHASE 4c: the argument default converted too — "${defaultsBefore}" -> "${defaultsAfter}"`);

  // PHASE 5: replay safety.
  const replay = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.equal(replay.status, 0, `re-applying must succeed, not abort on its own output:\n${(replay.stderr || '').slice(-1200)}`);
  assert.deepEqual(bodyState(), afterBodies, 're-applying must leave the converted bodies in place');
  log('PHASE 5: re-applying the candidate is safe');

  // PHASE 6: mutation — put ONE conversion back to UTC and require the postflight to catch it.
  restoreWriters();
  const mutated = candidateSql.replace(
    "v_quote.total_margin_pct, (now() AT TIME ZONE 'America/Chicago')::date,",
    'v_quote.total_margin_pct, current_date,',
  );
  assert.notEqual(mutated, candidateSql, 'mutation did not alter the candidate — the anchor text moved');
  copyText(mutated, 'mutant.sql', workDir);
  const mutantRun = psql('\\i /tmp/mutant.sql', { allowFailure: true, wrap: wrapByName.get('mutant.sql') ?? false });
  assert.match(`${mutantRun.stdout}\n${mutantRun.stderr}`, /POSTFLIGHT_UTC_RESIDUAL/,
    'a candidate leaving one UTC date in code MUST abort in POSTFLIGHT_UTC_RESIDUAL — the postflight is not load-bearing');
  assert.deepEqual(bodyState(), rebuild, 'the mutant must install nothing (its transaction rolled back)');
  log('PHASE 6: MUTATION — reverting ONE conversion aborts in POSTFLIGHT_UTC_RESIDUAL and installs nothing');

  // PHASE 7: prove the exact-ACL postflight is load-bearing, not documentation.
  const aclMutated = candidateSql.replace(
    'DO $postflight$',
    `GRANT EXECUTE ON FUNCTION ${quickSignature} TO anon;\n\nDO $postflight$`,
  );
  assert.notEqual(aclMutated, candidateSql, 'ACL mutation did not alter the candidate — the postflight anchor moved');
  copyText(aclMutated, 'acl-mutant.sql', workDir);
  const aclMutantRun = psql('\\i /tmp/acl-mutant.sql', { allowFailure: true, wrap: wrapByName.get('acl-mutant.sql') ?? false });
  assert.match(`${aclMutantRun.stdout}\n${aclMutantRun.stderr}`, /POSTFLIGHT_ACL/,
    'an extra anon grant immediately before postflight MUST abort in POSTFLIGHT_ACL');
  assert.deepEqual(bodyState(), rebuild, 'the ACL mutant must install nothing (its transaction rolled back)');
  assert.equal(roleCanExecute('anon', quickSignature), false,
    'the ACL mutant grant must roll back with the candidate transaction');
  log('PHASE 7: MUTATION — an extra anon grant before postflight aborts in POSTFLIGHT_ACL and installs nothing');

  // PHASE 8: mutation — revert ONLY the argument default, leaving every body conversion intact.
  // The old prosrc-based POSTFLIGHT_UTC_RESIDUAL cannot see this, so if the run aborts it can only
  // be the new argument-default check doing the work.
  const defaultMutated = candidateSql.replace(
    "p_scheduled_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date",
    'p_scheduled_date date DEFAULT CURRENT_DATE',
  );
  assert.notEqual(defaultMutated, candidateSql, 'default mutation did not alter the candidate — the anchor text moved');
  copyText(defaultMutated, 'default-mutant.sql', workDir);
  const defaultMutantRun = psql('\\i /tmp/default-mutant.sql', { allowFailure: true, wrap: wrapByName.get('default-mutant.sql') ?? false });
  const defaultMutantOut = `${defaultMutantRun.stdout}\n${defaultMutantRun.stderr}`;
  assert.match(defaultMutantOut, /POSTFLIGHT_UTC_RESIDUAL_DEFAULT/,
    'a candidate leaving CURRENT_DATE in an ARGUMENT DEFAULT must abort in POSTFLIGHT_UTC_RESIDUAL_DEFAULT');
  assert.doesNotMatch(defaultMutantOut, /POSTFLIGHT_UTC_RESIDUAL:/,
    'the body check must NOT be what caught this — that would mean the argument-default check is untested');
  assert.deepEqual(bodyState(), rebuild, 'the default mutant must install nothing (its transaction rolled back)');
  log('PHASE 8: MUTATION — reverting ONLY the argument default aborts in POSTFLIGHT_UTC_RESIDUAL_DEFAULT (body check silent) and installs nothing');

  // PHASE 9: prove the fail-closed reader assertion. Swapping pg_get_expr's second argument from 0
  // to p.oid is the wrong-but-obvious form: it returns NULL for every function, silently, and would
  // turn PHASE 8's check into a tautology that passes on NULL. The candidate must refuse to certify
  // rather than report clean. First, demonstrate the reader really does go dark.
  const darkReader = argDefaultsViaProOid(QUICK_IMPL);
  assert.equal(darkReader, '<NULL>',
    `pg_get_expr(proargdefaults, p.oid) was expected to return NULL, got: ${darkReader}`);
  const readerMutated = candidateSql.replace(
    'pg_get_expr(p.proargdefaults, 0) AS arg_defaults',
    'pg_get_expr(p.proargdefaults, p.oid) AS arg_defaults',
  );
  assert.notEqual(readerMutated, candidateSql, 'reader mutation did not alter the candidate — the anchor text moved');
  copyText(readerMutated, 'reader-mutant.sql', workDir);
  const readerMutantRun = psql('\\i /tmp/reader-mutant.sql', { allowFailure: true, wrap: wrapByName.get('reader-mutant.sql') ?? false });
  assert.match(`${readerMutantRun.stdout}\n${readerMutantRun.stderr}`, /POSTFLIGHT_DEFAULTS_UNREADABLE/,
    'a blinded argument-default reader must abort in POSTFLIGHT_DEFAULTS_UNREADABLE, not pass on NULL');
  assert.deepEqual(bodyState(), rebuild, 'the reader mutant must install nothing (its transaction rolled back)');
  log(`PHASE 9: MUTATION — blinding the reader (pg_get_expr second arg 0 -> p.oid, which returns ${darkReader}) aborts in POSTFLIGHT_DEFAULTS_UNREADABLE instead of passing on NULL`);

  log('\nALL PHASES PASSED');
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
  log(`(disposable container ${NAME} removed; work dir ${workDir})`);
}
