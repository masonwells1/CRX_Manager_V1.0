#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof for ledger-backed commission history.
 * Restores the checked-in schema baseline, replays every selected migration
 * through the candidate, runs the real create/post/report/void rollback smoke,
 * and mutation-tests the candidate's fail-closed postconditions.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = (
  process.env.CRX_COMMISSION_PROOF_NAME ||
  `crx-commission-history-${process.pid}-${Date.now().toString(36)}`
).toLowerCase();
const PROOF_LABEL_KEY = 'com.croprx.commission-proof';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE_DIR = path.join(ROOT, 'supabase', 'baselines');
const BASELINE_MANIFEST = JSON.parse(
  readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8'),
);
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260903150100_ledger_backed_commission_history.sql',
);
const SMOKE_PATH = path.join(
  ROOT,
  'scripts',
  'smoke',
  'smoke-commission-history-as-of.sql',
);

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 80 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.error) {
    if (!allowFailure) throw result.error;
    return { ...result, status: result.status ?? -1 };
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, { user = 'postgres', allowFailure = false } = {}) {
  return docker([
    'exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres',
    '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql, allowFailure });
}

function baselineArtifact(suffix) {
  const matches = Object.keys(BASELINE_MANIFEST.artifacts ?? {})
    .filter((name) => name.endsWith(suffix));
  assert.equal(
    matches.length,
    1,
    `expected exactly one baseline artifact *${suffix}, found ${matches.join(', ') || 'none'}`,
  );
  const local = path.join(BASELINE_DIR, matches[0]);
  assert.ok(existsSync(local), `missing baseline artifact: ${local}`);
  const actualSha = createHash('sha256').update(readFileSync(local)).digest('hex').toUpperCase();
  assert.equal(
    actualSha,
    BASELINE_MANIFEST.artifacts[matches[0]].sha256,
    `baseline artifact ${matches[0]} does not match manifest SHA-256`,
  );
  return local;
}

function copyIntoContainer(local, remoteName) {
  docker(['cp', local, `${NAME}:/tmp/${remoteName}`]);
}

function selectedMigrationsThroughCandidate() {
  const enumerator = path.join(ROOT, 'scripts', 'list-post-baseline-migrations.mjs');
  const listed = spawnSync(process.execPath, [enumerator], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    listed.status,
    0,
    `could not enumerate post-baseline migrations:\n${listed.stderr || listed.stdout}`,
  );
  const notice = listed.stderr.trim().replace(/\r?\n/g, ' | ');
  console.log(`COMMISSION_HISTORY_REPLAY_SELECTOR_NOTICE ${notice || 'none'}`);
  const migrations = listed.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^supabase\/migrations\/\d{14}_[^/]+\.sql$/.test(line))
    .map((relative) => path.join(ROOT, relative));
  const candidateIndex = migrations.findIndex(
    (local) => path.resolve(local) === path.resolve(MIGRATION_PATH),
  );
  assert.notEqual(candidateIndex, -1, 'candidate is absent from the ledger-selected replay');
  const trailing = migrations.slice(candidateIndex + 1);
  if (trailing.length > 0) {
    console.log(
      `COMMISSION_HISTORY_REPLAY_STOPS_AT_CANDIDATE trailing=${trailing.map((local) => path.basename(local)).join(',')}`,
    );
  }
  return migrations.slice(0, candidateIndex + 1);
}

function applySql(source, { allowFailure = false } = {}) {
  const ownsTransaction = /^[ \t]*BEGIN[ \t]*;/mi.test(source);
  const executable = ownsTransaction ? source : `BEGIN;\n${source}\nCOMMIT;`;
  return psql(executable, { allowFailure });
}

function startPsql(sql) {
  const child = spawn('docker', [
    'exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return { child, output: () => `${stdout}\n${stderr}` };
}

async function waitForOutput(handle, token, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!handle.output().includes(token) && Date.now() < deadline) {
    if (handle.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(handle.output(), new RegExp(token), `holder did not reach ${token}:\n${handle.output()}`);
}

async function waitForExit(handle, timeoutMs = 10_000) {
  if (handle.child.exitCode !== null) return handle.child.exitCode;
  return await Promise.race([
    new Promise((resolve) => handle.child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('psql holder did not exit')), timeoutMs)),
  ]);
}

function extractCandidateLockStatement(candidateSource) {
  const matches = candidateSource.match(
    /LOCK TABLE public\.commission_payments,\s+public\.commission_payment_items,\s+public\.commissions\s+IN [A-Z ]+ MODE;/g,
  );
  assert.equal(
    matches?.length,
    1,
    'candidate must contain exactly one lock statement covering all three cheap-window writer tables',
  );
  return matches[0];
}

async function proveWriterLockConflict(candidateSource, expectedToBlock) {
  const lockStatement = extractCandidateLockStatement(candidateSource);
  const holder = startPsql(`
BEGIN;
${lockStatement}
\\echo COMMISSION_HISTORY_LOCK_HELD
SELECT pg_sleep(5);
ROLLBACK;
`);
  await waitForOutput(holder, 'COMMISSION_HISTORY_LOCK_HELD');

  const writers = [
    ['commission payment posting', "UPDATE public.commission_payments SET status = 'posted' WHERE false"],
    ['commission payment-item insertion', 'INSERT INTO public.commission_payment_items (commission_payment_id, commission_id, amount) SELECT NULL, NULL, 0 WHERE false'],
    ['commission cancellation', "UPDATE public.commissions SET status = 'cancelled' WHERE false"],
  ];
  for (const [label, statement] of writers) {
    let writer;
    let output = '';
    const attempts = expectedToBlock ? 30 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      writer = psql(`
BEGIN;
SET LOCAL lock_timeout = '400ms';
${statement};
ROLLBACK;
`, { allowFailure: true });
      output = `${writer.stdout || ''}\n${writer.stderr || ''}`;
      if (!expectedToBlock || writer.status !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (expectedToBlock) {
      assert.notEqual(writer?.status, 0, `${label} did not block`);
      assert.match(output, /canceling statement due to lock timeout/, `${label} blocked for the wrong reason:\n${output}`);
    } else {
      assert.equal(writer?.status, 0, `${label} should not block under weakened lock:\n${output}`);
    }
  }

  assert.equal(await waitForExit(holder), 0, `holder failed:\n${holder.output()}`);
}

function extractFunctionBody(source, functionName) {
  const declaration = `CREATE OR REPLACE FUNCTION public.${functionName}`;
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, `missing function declaration: ${functionName}`);
  const delimiter = '$function$';
  const bodyStart = source.indexOf(delimiter, declarationIndex) + delimiter.length;
  const bodyEnd = source.indexOf(delimiter, bodyStart);
  assert.ok(bodyStart >= delimiter.length && bodyEnd > bodyStart, `unterminated function body: ${functionName}`);
  return source.slice(bodyStart, bodyEnd);
}

function extractFunctionStatement(source, functionName) {
  const declaration = `CREATE OR REPLACE FUNCTION public.${functionName}`;
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, `missing function declaration: ${functionName}`);
  const statementEnd = source.indexOf('$function$;', declarationIndex);
  assert.ok(statementEnd > declarationIndex, `unterminated function statement: ${functionName}`);
  return source.slice(declarationIndex, statementEnd + '$function$;'.length);
}

function applyMigration(local, index) {
  const source = readFileSync(local, 'utf8');
  if (path.resolve(local) === path.resolve(MIGRATION_PATH)) {
    assert.ok(!source.includes('\r'), 'candidate migration is not LF byte-verbatim');
  }
  applySql(source.replace(/\r\n/g, '\n'));
  if ((index + 1) % 10 === 0 || path.resolve(local) === path.resolve(MIGRATION_PATH)) {
    console.log(`COMMISSION_HISTORY_REPLAY_PROGRESS ${index + 1} ${path.basename(local)}`);
  }
}

function scalar(sql) {
  const result = psql(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  return result.stdout.trim();
}

function seedCutoverPreimage() {
  // These rows intentionally exist before the candidate is applied.  They
  // exercise the populated first-apply path without carrying any live IDs.
  const admin = 'c011ec70-0000-4000-8000-000000000099';
  const customer = 'c011ec70-0000-4000-8000-000000000111';
  const order = 'c011ec70-0000-4000-8000-000000000112';
  const legacyIds = [
    'c011ec70-0000-4000-8000-000000000121',
    'c011ec70-0000-4000-8000-000000000122',
  ];
  const activeId = 'c011ec70-0000-4000-8000-000000000123';
  psql(`
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES ('${admin}', 'commission-history-prover@example.test', jsonb_build_object('full_name', 'Commission History Prover', 'role', 'admin'), now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role, is_active)
VALUES ('${admin}', 'commission-history-prover@example.test', 'Commission History Prover', 'admin', true)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
INSERT INTO public.customers (id, farm_name, assigned_sales_rep)
VALUES ('${customer}', '[PROVER] Commission History Cutover Farm', '${admin}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.orders (id, order_number, customer_id, order_date, status)
VALUES ('${order}', 'PROVER-COMMISSION-CUTOVER', '${customer}', DATE '2026-03-16', 'confirmed')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.commissions (
  id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES
  ('${legacyIds[0]}', '${order}', '${customer}', 'Legacy Cancelled', '${admin}', 100, 0, 0, DATE '2026-03-16', 'cancelled'),
  ('${legacyIds[1]}', '${order}', '${customer}', 'Legacy Cancelled', '${admin}', 100, 0, 0, DATE '2026-03-16', 'cancelled'),
  ('${activeId}', '${order}', '${customer}', 'Commission History Prover', '${admin}', 100, 10, 10, DATE '2026-03-16', 'pending');
`);
  const legacyDigest = createHash('md5').update([...legacyIds].sort().join(',')).digest('hex');
  return { admin, customer, order, activeId, legacyDigest };
}

function bindPopulatedCandidate(candidateSource, legacyDigest) {
  const reportMd5 = scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_commission_balance_report(date)'::regprocedure;`);
  const postMd5 = scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._post_commission_payment_intent_impl_20260809(uuid,uuid,text)'::regprocedure;`);
  assert.match(reportMd5, /^[a-f0-9]{32}$/, 'could not read preimage report body md5');
  assert.match(postMd5, /^[a-f0-9]{32}$/, 'could not read preimage post body md5');
  const bound = candidateSource
    .replaceAll('d2111549f1dc613edf9a31e4d152b096', legacyDigest)
    .replaceAll('0ea6b39cc91141362461598e3ab91294', reportMd5)
    .replaceAll('7bbf107055396b788b5aaefec8c2e195', postMd5);
  assert.notEqual(bound, candidateSource, 'test-bound candidate did not substitute live-bound preimage literals');
  return { bound, reportMd5, postMd5 };
}

function proveCutoverOpening(preimage) {
  const row = scalar(`
SELECT opening_commission_count || '|' || opening_commission_digest || '|' ||
       (cutover_at = (SELECT min(effective_at) FROM public.commission_earned_state_ledger))::text || '|' ||
       (first_supported_date = ((cutover_at AT TIME ZONE 'America/Chicago')::date + 1))::text
  FROM public.commission_history_cutover WHERE singleton;
`);
  const [count, digest, sameTime, nextDay] = row.split('|');
  assert.equal(count, '3', 'cutover opening count must pin all deterministic preimage commissions');
  assert.equal(digest, createHash('md5').update([
    'c011ec70-0000-4000-8000-000000000121',
    'c011ec70-0000-4000-8000-000000000122',
    preimage.activeId,
  ].sort().join(',')).digest('hex'), 'cutover opening digest drifted');
  assert.equal(sameTime, 'true', 'opening events must be effective at cutover, never order_date');
  assert.equal(nextDay, 'true', 'first supported date must be the first complete Chicago day after cutover');
  assert.equal(scalar(`SELECT count(*) FROM public.commission_earned_state_ledger WHERE event_kind = 'baseline';`), '1');
  assert.equal(scalar(`SELECT count(*) FROM public.commission_earned_state_ledger WHERE event_kind = 'legacy_excluded';`), '2');
  const firstSupported = scalar(`SELECT first_supported_date FROM public.commission_history_cutover WHERE singleton;`);
  const rejected = psql(`
BEGIN;
SELECT set_config('request.jwt.claim.sub', '${preimage.admin}', true);
SELECT * FROM public.get_commission_balance_report((DATE '${firstSupported}') - 1);
ROLLBACK;
`, { allowFailure: true });
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /COMMISSION_HISTORY_BEFORE_LEDGER_START/, 'pre-boundary report was not refused');
  console.log('COMMISSION_HISTORY_CUTOVER_OPENING_PASS count=3 baseline=1 legacy=2 boundary=next_chicago_day');
}

function commitRuntimeLedgerActivity(preimage) {
  psql(`
BEGIN;
SELECT set_config('request.jwt.claim.sub', '${preimage.admin}', true);
INSERT INTO public.commissions (
  order_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES ('${preimage.order}', '${preimage.customer}', 'Commission History Prover', '${preimage.admin}', 100, 25, 25, CURRENT_DATE, 'pending')
RETURNING id \\gset comm_
INSERT INTO public.commission_payments (payment_number, recipient_id, total_amount, status, payment_date)
VALUES ('PROVER-REPLAY-' || :'comm_id', '${preimage.admin}', 25, 'unposted', CURRENT_DATE)
RETURNING id \\gset pay_
INSERT INTO public.commission_payment_items (commission_payment_id, commission_id, amount)
VALUES (:'pay_id', :'comm_id', 25);
UPDATE public.commission_payments SET status = 'posted', posted_by = '${preimage.admin}' WHERE id = :'pay_id';
UPDATE public.commissions SET deleted_at = clock_timestamp() WHERE id = :'comm_id';
UPDATE public.commissions SET deleted_at = NULL WHERE id = :'comm_id';
UPDATE public.commission_payments SET status = 'voided', voided_by = '${preimage.admin}' WHERE id = :'pay_id';
UPDATE public.commissions SET commission_amount = 30 WHERE id = :'comm_id';
COMMIT;
`);
  console.log('COMMISSION_HISTORY_COMMITTED_RUNTIME_ACTIVITY create=1 post=1 soft_delete=1 restore=1 void=1 amount_revision=1');
}

function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql',
  );
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
  assert.equal(
    createHash('md5').update(body, 'utf8').digest('hex'),
    'e2d4b46c47be7561a8829191c30dc0a7',
    'close-remainder live CRLF body hash drifted',
  );
  psql(`
CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(
  p_order_id uuid, p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $live_crlf_close$${body}$live_crlf_close$;
`);
  console.log('COMMISSION_HISTORY_LIVE_BODY_RESTORED close_remainder_crlf=true');
}

function expectCandidateFailure(source, token, label) {
  const result = applySql(source, { allowFailure: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(output, new RegExp(token), `${label} failed for the wrong reason:\n${output}`);
  console.log(`COMMISSION_HISTORY_MUTATION_REJECTED ${label} ${token}`);
}

function expectSmokeFailure(token, label) {
  const result = psql(readFileSync(SMOKE_PATH, 'utf8'), { allowFailure: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.notEqual(result.status, 0, `${label} smoke unexpectedly committed`);
  assert.match(output, new RegExp(token), `${label} smoke failed for the wrong reason:\n${output}`);
  assert.doesNotMatch(
    output,
    /SMOKE_PASS_ROLLBACK: COMMISSION_HISTORY_AS_OF/,
    `${label} mutation survived the real-path smoke`,
  );
  console.log(`COMMISSION_HISTORY_MUTATION_REJECTED ${label} ${token}`);
}

function restoreBaseline() {
  const extensions = baselineArtifact('_extensions.sql');
  const acl = baselineArtifact('_acl_lockdown.sql');
  const platform = baselineArtifact('_platform_overlay.sql');
  const cron = baselineArtifact('_cron_jobs.sql');
  const history = baselineArtifact('_migration_history.sql');

  copyIntoContainer(extensions, 'commission-extensions.sql');
  copyIntoContainer(acl, 'commission-acl.sql');
  copyIntoContainer(platform, 'commission-platform.sql');
  copyIntoContainer(cron, 'commission-cron.sql');
  copyIntoContainer(history, 'commission-history.sql');

  psql('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);', { user: 'supabase_admin' });
  psql('\\i /tmp/commission-extensions.sql');
  const decoded = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], {
    cwd: ROOT,
    maxBuffer: 80 * 1024 * 1024,
  });
  assert.equal(decoded.status, 0, decoded.stderr?.toString() || 'baseline decompression failed');
  psql(decoded.stdout.toString());
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
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE
AS $$ SELECT string_to_array(name, '/') $$;
CREATE OR REPLACE FUNCTION storage.filename(name text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
`, { user: 'supabase_admin' });
  psql('\\i /tmp/commission-acl.sql');
  psql('\\i /tmp/commission-platform.sql', { user: 'supabase_admin' });
  psql('\\i /tmp/commission-cron.sql');
  psql(`
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  statements text[]
);
\\i /tmp/commission-history.sql
`);
}

let started = false;
try {
  docker([
    'run', '--detach', '--name', NAME, '--network', 'none',
    '--label', `${PROOF_LABEL_KEY}=${NAME}`,
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m',
    '--env', 'POSTGRES_PASSWORD=postgres', IMAGE,
  ]);
  started = true;

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = docker(
      ['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert.ok(ready, 'network-isolated PostgreSQL 17 did not become ready');

  restoreBaseline();
  const migrations = selectedMigrationsThroughCandidate();
  const candidateSource = readFileSync(MIGRATION_PATH, 'utf8');
  let candidate = candidateSource;
  let cutoverPreimage;
  migrations.forEach((local, index) => {
    if (path.basename(local) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') {
      restoreLiveCrLfCloseRemainder();
    }
    if (path.resolve(local) === path.resolve(MIGRATION_PATH)) {
      cutoverPreimage = seedCutoverPreimage();
      const binding = bindPopulatedCandidate(candidateSource, cutoverPreimage.legacyDigest);
      candidate = binding.bound;
      console.log(`COMMISSION_HISTORY_TEST_BOUND_PREIMAGE legacy_digest=${cutoverPreimage.legacyDigest} report_md5=${binding.reportMd5} post_md5=${binding.postMd5}`);
      for (const [label, signature] of [
        ['fresh_anonymous_report_grant', 'public.get_commission_balance_report(date)'],
        [
          'fresh_anonymous_private_void_grant',
          'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)',
        ],
        [
          'fresh_anonymous_private_post_grant',
          'public._post_commission_payment_intent_impl_20260809(uuid,uuid,text)',
        ],
      ]) {
        const freshAclMutation = candidate.replace(
          'DO $precondition$',
          `GRANT EXECUTE ON FUNCTION ${signature} TO anon;\n\nDO $precondition$`,
        );
        assert.notEqual(freshAclMutation, candidate, `${label} did not change the candidate`);
        expectCandidateFailure(
          freshAclMutation,
          'COMMISSION_HISTORY_FRESH_ACL_DRIFT: existing report or payout implementation ACL differs',
          label,
        );
      }
      const postBodyMutation = candidate.replaceAll(
        binding.postMd5,
        '00000000000000000000000000000000',
      );
      assert.notEqual(postBodyMutation, candidate, 'fresh post-body pin mutation did not change the candidate');
      expectCandidateFailure(
        postBodyMutation,
        'COMMISSION_HISTORY_PREIMAGE_DRIFT:',
        'fresh_private_post_body_drift',
      );
    }
    if (path.resolve(local) === path.resolve(MIGRATION_PATH)) {
      applySql(candidate.replace(/\r\n/g, '\n'));
      console.log(`COMMISSION_HISTORY_REPLAY_PROGRESS ${index + 1} ${path.basename(local)}`);
      proveCutoverOpening(cutoverPreimage);
    } else {
      applyMigration(local, index);
    }
  });

  for (const functionName of [
    '_void_commission_payment_intent_impl_20260809',
    'get_commission_balance_report',
    'get_commission_payment_detail_report',
    'stamp_commission_cancellation_history',
    'record_commission_earned_state',
    'validate_commission_payment_item_history',
    'record_commission_settlement_event',
    'prevent_commission_history_ledger_mutation',
    'prevent_commission_history_ledger_truncate',
  ]) {
    const body = extractFunctionBody(candidate, functionName);
    console.log(
      `COMMISSION_HISTORY_CANDIDATE_BODY ${functionName} bytes=${Buffer.byteLength(body)} md5=${createHash('md5').update(body).digest('hex')}`,
    );
  }
  const constraintCatalog = psql(`
\\pset format unaligned
\\pset tuples_only on
SELECT conname || '=' || pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname IN (
   'commissions_cancelled_amount_cents_non_negative_chk',
   'commissions_cancellation_history_pair_chk',
   'commission_payments_void_history_chk',
   'commissions_commission_amount_whole_cents_chk',
   'commission_payments_total_amount_whole_cents_chk',
   'commission_payment_items_amount_whole_cents_chk',
   'commission_settlement_events_event_amount_direction_chk'
 )
 ORDER BY conname;
`);
  console.log(`COMMISSION_HISTORY_CONSTRAINT_CATALOG\n${constraintCatalog.stdout.trim()}`);

  const smoke = psql(readFileSync(SMOKE_PATH, 'utf8'), { allowFailure: true });
  const smokeOutput = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(
    smokeOutput,
    /SMOKE_PASS_ROLLBACK: COMMISSION_HISTORY_AS_OF/,
    `rollback smoke did not reach its terminal marker:\n${smokeOutput}`,
  );
  console.log('COMMISSION_HISTORY_REAL_PATH_PASS create_post_report_void_report rollback=true');

  assert.ok(cutoverPreimage, 'populated candidate preimage was not seeded');
  const lockIndex = candidate.indexOf('LOCK TABLE public.commission_payments,');
  const preconditionIndex = candidate.indexOf('DO $precondition$');
  assert.ok(lockIndex >= 0, 'candidate is missing the cheap-window writer lock');
  assert.ok(
    lockIndex < preconditionIndex,
    'candidate reads the cheap-window precondition before blocking concurrent writers',
  );
  await proveWriterLockConflict(candidate, true);
  console.log('COMMISSION_HISTORY_CONCURRENT_WRITERS_BLOCKED tables=3');
  const incompleteLockCoverage = candidate.replace(
    '           public.commission_payment_items,\n',
    '',
  );
  assert.notEqual(
    incompleteLockCoverage,
    candidate,
    'lock-table coverage mutation did not change the candidate',
  );
  assert.throws(
    () => extractCandidateLockStatement(incompleteLockCoverage),
    /exactly one lock statement covering all three cheap-window writer tables/,
  );
  console.log('COMMISSION_HISTORY_MUTATION_REJECTED missing_payment_items_writer_lock');
  const weakenedLock = candidate.replace(
    'IN SHARE ROW EXCLUSIVE MODE;',
    'IN ACCESS SHARE MODE;',
  );
  assert.notEqual(weakenedLock, candidate, 'lock-mode mutation did not change the candidate');
  await proveWriterLockConflict(weakenedLock, false);
  console.log('COMMISSION_HISTORY_MUTATION_REJECTED non_conflicting_lock_mode writers_were_not_blocked');

  const cutoverBeforeReplay = scalar(`
SELECT cutover_at || '|' || first_supported_date || '|' || opening_commission_count || '|' || opening_commission_digest
  FROM public.commission_history_cutover WHERE singleton;
`);
  commitRuntimeLedgerActivity(cutoverPreimage);
  applySql(candidate);
  assert.equal(
    scalar(`SELECT cutover_at || '|' || first_supported_date || '|' || opening_commission_count || '|' || opening_commission_digest FROM public.commission_history_cutover WHERE singleton;`),
    cutoverBeforeReplay,
    'candidate replay rewrote immutable cutover/opening metadata after committed runtime activity',
  );
  console.log('COMMISSION_HISTORY_IDEMPOTENT_REAPPLY_PASS runtime_events_preserved=true cutover_unchanged=true');

  const hotfixedVoid = extractFunctionStatement(
    candidate.replace(
      'v_actor := auth.uid();',
      'v_actor := auth.uid();\n  PERFORM 1; -- MUTATION: marker-preserving hotfix',
    ),
    '_void_commission_payment_intent_impl_20260809',
  );
  assert.notEqual(
    hotfixedVoid,
    extractFunctionStatement(candidate, '_void_commission_payment_intent_impl_20260809'),
    'void preimage mutation did not change the function',
  );
  applySql(hotfixedVoid);
  expectCandidateFailure(
    candidate,
    'COMMISSION_HISTORY_REPLAY_DRIFT: candidate function bodies or trust attributes differ',
    'marker_preserving_void_hotfix',
  );
  applySql(extractFunctionStatement(candidate, '_void_commission_payment_intent_impl_20260809'));

  const partialColumns = `
BEGIN;
ALTER TABLE public.commissions DROP COLUMN cancelled_at CASCADE;
${candidate}
COMMIT;
`;
  expectCandidateFailure(
    partialColumns,
    'COMMISSION_HISTORY_SCHEMA_DRIFT: expected none or all four history columns',
    'partial_four_column_replay',
  );

  const weakNamedConstraint = `
BEGIN;
ALTER TABLE public.commissions DROP CONSTRAINT commissions_commission_amount_whole_cents_chk;
ALTER TABLE public.commissions
  ADD CONSTRAINT commissions_commission_amount_whole_cents_chk CHECK (TRUE);
${candidate}
COMMIT;
`;
  expectCandidateFailure(
    weakNamedConstraint,
    'COMMISSION_HISTORY_REPLAY_DRIFT: required CHECK definition differs',
    'same_named_check_true',
  );

  const wrongCancellationTrigger = `
BEGIN;
DROP TRIGGER trg_commissions_stamp_cancellation_history ON public.commissions;
CREATE TRIGGER trg_commissions_stamp_cancellation_history
  AFTER UPDATE ON public.commissions
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_cancellation_history();
${candidate}
COMMIT;
`;
  expectCandidateFailure(
    wrongCancellationTrigger,
    'COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs',
    'same_named_wrong_cancellation_trigger',
  );

  const missedCancellationHistory = `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.commissions (
  order_id, customer_id, order_date, status, commission_amount
) VALUES (
  gen_random_uuid(), gen_random_uuid(), CURRENT_DATE, 'cancelled', 0
);
SET LOCAL session_replication_role = origin;
${candidate}
COMMIT;
`;
  expectCandidateFailure(
    missedCancellationHistory,
    'COMMISSION_HISTORY_REPLAY_DRIFT: NULL-history cancellations differ from the exact reviewed identity set',
    'missed_cancellation_history_row',
  );

  for (const [label, signature] of [
    ['anonymous_cancellation_helper_grant', 'public.stamp_commission_cancellation_history()'],
    ['anonymous_earned_recorder_grant', 'public.record_commission_earned_state()'],
    ['anonymous_payment_item_validator_grant', 'public.validate_commission_payment_item_history()'],
    ['anonymous_settlement_recorder_grant', 'public.record_commission_settlement_event()'],
    ['anonymous_ledger_mutation_guard_grant', 'public.prevent_commission_history_ledger_mutation()'],
    ['anonymous_ledger_truncate_guard_grant', 'public.prevent_commission_history_ledger_truncate()'],
    [
      'anonymous_private_void_helper_grant',
      'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)',
    ],
    [
      'anonymous_private_post_helper_grant',
      'public._post_commission_payment_intent_impl_20260809(uuid,uuid,text)',
    ],
  ]) {
    expectCandidateFailure(
      `
BEGIN;
GRANT EXECUTE ON FUNCTION ${signature} TO anon;
${candidate}
COMMIT;
`,
      'COMMISSION_HISTORY_REPLAY_DRIFT:',
      label,
    );
  }

  psql('CREATE ROLE commission_history_unexpected_acl_probe NOLOGIN;');
  try {
    expectCandidateFailure(
      `
BEGIN;
GRANT EXECUTE ON FUNCTION public.get_commission_balance_report(date)
  TO commission_history_unexpected_acl_probe;
${candidate}
COMMIT;
`,
      'COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs',
      'unexpected_report_role_grant',
    );
  } finally {
    psql('DROP ROLE commission_history_unexpected_acl_probe;');
  }

  expectCandidateFailure(
    `
BEGIN;
GRANT EXECUTE ON FUNCTION public.get_commission_balance_report(date)
  TO authenticated WITH GRANT OPTION;
${candidate}
COMMIT;
`,
    'COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs',
    'report_grant_option',
  );

  psql(`
CREATE TEMP TABLE commission_money_predicate_probe (
  amount numeric CHECK (amount IS NULL OR (
    amount = ROUND(amount, 2)
    AND amount > '-Infinity'::numeric
    AND amount < 'Infinity'::numeric
  ))
);
INSERT INTO commission_money_predicate_probe VALUES (10.00);
DO $money$
DECLARE
  v_value numeric;
BEGIN
  FOREACH v_value IN ARRAY ARRAY[10.005::numeric, 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric]
  LOOP
    BEGIN
      INSERT INTO commission_money_predicate_probe VALUES (v_value);
      RAISE EXCEPTION 'MONEY_PREDICATE_ACCEPTED_INVALID: %', v_value;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
  IF (SELECT count(*) FROM commission_money_predicate_probe) <> 1 THEN
    RAISE EXCEPTION 'MONEY_PREDICATE_PROBE_ROWCOUNT';
  END IF;
END
$money$;
`);
  console.log('COMMISSION_HISTORY_MONEY_PREDICATE_PASS rejected=10.005,NaN,Infinity,-Infinity');

  psql(`
CREATE FUNCTION public.get_commission_balance_report(p_decoy text)
RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
`);
  expectCandidateFailure(candidate, 'COMMISSION_HISTORY_OVERLOAD_DRIFT', 'decoy_overload');
  psql('DROP FUNCTION public.get_commission_balance_report(text);');

  const weakenedSnapshot = candidate.replace(
    'NEW.cancelled_amount_cents := (ROUND(OLD.commission_amount, 2) * 100)::bigint;',
    'NEW.cancelled_amount_cents := (ROUND(NEW.commission_amount, 2) * 100)::bigint;',
  );
  assert.notEqual(weakenedSnapshot, candidate, 'cancellation snapshot mutation did not change the candidate');
  expectCandidateFailure(
    weakenedSnapshot,
    'COMMISSION_HISTORY_POSTCOND: reviewed function body or security contract drift',
    'post_zero_cancellation_snapshot',
  );

  const missingDeletedCapture = candidate.replace(
    '     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at\n',
    '',
  );
  assert.notEqual(
    missingDeletedCapture,
    candidate,
    'deleted-at capture mutation did not change the candidate',
  );
  applySql(extractFunctionStatement(missingDeletedCapture, 'record_commission_earned_state'));
  expectSmokeFailure(
    'SMOKE_FAIL: mixed pending plus paid-only counts are wrong',
    'missing_soft_delete_history_capture',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_earned_state'));

  const backdatedRuntimeState = candidate.replace(
    `    clock_timestamp(),
    auth.uid(),`,
    `    (NEW.order_date::timestamp AT TIME ZONE 'America/Chicago'),
    auth.uid(),`,
  );
  assert.notEqual(
    backdatedRuntimeState,
    candidate,
    'runtime effective-at mutation did not change the candidate',
  );
  applySql(extractFunctionStatement(backdatedRuntimeState, 'record_commission_earned_state'));
  expectSmokeFailure(
    'SMOKE_FAIL: commission insert did not append a wall-clock earned-state snapshot',
    'backdated_runtime_history',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_earned_state'));

  const missingNegativePaymentItemGuard = candidate.replace(
    '  IF NEW.amount IS NULL OR round(NEW.amount, 2) < 0 THEN',
    '  IF FALSE THEN',
  );
  assert.notEqual(
    missingNegativePaymentItemGuard,
    candidate,
    'negative payment-item guard mutation did not change the candidate',
  );
  applySql(extractFunctionStatement(missingNegativePaymentItemGuard, 'validate_commission_payment_item_history'));
  expectSmokeFailure(
    'SMOKE_FAIL: negative-dollar payment item was accepted',
    'missing_create_time_negative_amount_guard',
  );
  applySql(extractFunctionStatement(candidate, 'validate_commission_payment_item_history'));

  const missingCreateTimeDateGuard = candidate.replace(
    '  IF v_payment_date < v_commission_order_date THEN',
    '  IF FALSE THEN',
  );
  assert.notEqual(
    missingCreateTimeDateGuard,
    candidate,
    'create-time payment-date guard mutation did not change the candidate',
  );
  applySql(extractFunctionStatement(missingCreateTimeDateGuard, 'validate_commission_payment_item_history'));
  expectSmokeFailure(
    'SMOKE_FAIL: payout before commission order_date was created',
    'missing_create_time_payment_date_guard',
  );
  applySql(extractFunctionStatement(candidate, 'validate_commission_payment_item_history'));

  const transactionTimestampSettlement = candidate.replaceAll(
    'v_event_at := clock_timestamp();',
    'v_event_at := transaction_timestamp();',
  );
  assert.notEqual(transactionTimestampSettlement, candidate, 'settlement clock-timestamp mutation did not change the candidate');
  applySql(extractFunctionStatement(transactionTimestampSettlement, 'record_commission_settlement_event'));
  expectSmokeFailure(
    'COMMISSION_SETTLEMENT_HISTORY_MISMATCH:',
    'transaction_timestamp_settlement_event',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_settlement_event'));

  const earnedAnchoredReport = candidate.replace(
    '  FULL OUTER JOIN paid_by_recipient p',
    '  JOIN paid_by_recipient p',
  );
  assert.notEqual(
    earnedAnchoredReport,
    candidate,
    'paid-only join mutation did not change the candidate',
  );
  applySql(extractFunctionStatement(earnedAnchoredReport, 'get_commission_balance_report'));
  expectSmokeFailure(
    'SMOKE_FAIL: controlled prior-day snapshot is wrong',
    'earned_anchored_paid_report',
  );
  applySql(extractFunctionStatement(candidate, 'get_commission_balance_report'));

  const missingSettlementPost = candidate.replace(
    "  IF OLD.status <> 'posted' AND NEW.status = 'posted' THEN",
    "  IF FALSE AND OLD.status <> 'posted' AND NEW.status = 'posted' THEN",
  );
  assert.notEqual(missingSettlementPost, candidate, 'settlement-post mutation did not change the candidate');
  applySql(extractFunctionStatement(missingSettlementPost, 'record_commission_settlement_event'));
  expectSmokeFailure(
    'SMOKE_FAIL: settled zero-dollar commission count is wrong',
    'missing_posted_settlement_event',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_settlement_event'));

  const missingRecipientSettlementGuard = candidate.replace(
    "       AND EXISTS (SELECT 1 FROM public.commission_settlement_events WHERE commission_id = NEW.id) THEN",
    "       AND FALSE THEN",
  );
  assert.notEqual(missingRecipientSettlementGuard, candidate, 'recipient settlement guard mutation did not change the candidate');
  applySql(extractFunctionStatement(missingRecipientSettlementGuard, 'record_commission_earned_state'));
  expectSmokeFailure(
    'SMOKE_FAIL: recipient group changed after settlement history existed',
    'missing_recipient_group_settlement_guard',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_earned_state'));

  const transactionTimestampRuntime = candidate.replace(
    '    clock_timestamp(),\n    auth.uid(),',
    '    transaction_timestamp(),\n    auth.uid(),',
  );
  assert.notEqual(transactionTimestampRuntime, candidate, 'clock-timestamp mutation did not change the candidate');
  applySql(extractFunctionStatement(transactionTimestampRuntime, 'record_commission_earned_state'));
  expectSmokeFailure(
    'SMOKE_FAIL: commission insert did not append a wall-clock earned-state snapshot',
    'transaction_timestamp_runtime_event',
  );
  applySql(extractFunctionStatement(candidate, 'record_commission_earned_state'));

  expectCandidateFailure(
    `
BEGIN;
ALTER TABLE public.commission_earned_state_ledger
  DISABLE TRIGGER trg_commission_earned_state_ledger_immutable;
UPDATE public.commission_earned_state_ledger
   SET effective_at = (order_date::timestamp AT TIME ZONE 'America/Chicago')
 WHERE event_kind IN ('baseline', 'legacy_excluded');
ALTER TABLE public.commission_earned_state_ledger
  ENABLE TRIGGER trg_commission_earned_state_ledger_immutable;
${candidate}
COMMIT;
`,
    'COMMISSION_HISTORY_REPLAY_DRIFT: opening observation or ledger coverage differs',
    'opening_baseline_backdated_to_order_date',
  );

  const corruptedOpeningDigestPostcondition = candidate.replace(
    '<> (SELECT opening_commission_digest FROM public.commission_history_cutover)',
    '= (SELECT opening_commission_digest FROM public.commission_history_cutover)',
  );
  assert.notEqual(corruptedOpeningDigestPostcondition, candidate, 'opening digest replay mutation did not change the candidate');
  expectCandidateFailure(
    corruptedOpeningDigestPostcondition,
    'COMMISSION_HISTORY_REPLAY_DRIFT: opening observation or ledger coverage differs',
    'corrupted_opening_digest_replay_postcondition',
  );

  for (const [label, mutation, token] of [
    [
      'earned_ledger_rls_disabled',
      'ALTER TABLE public.commission_earned_state_ledger DISABLE ROW LEVEL SECURITY;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: candidate function bodies or trust attributes differ',
    ],
    [
      'earned_ledger_trigger_disabled',
      'ALTER TABLE public.commission_earned_state_ledger DISABLE TRIGGER trg_commission_earned_state_ledger_immutable;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: ledger trigger catalog differs',
    ],
    [
      'anonymous_earned_ledger_select',
      'GRANT SELECT ON public.commission_earned_state_ledger TO anon;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: ledger RLS, owner, or ACL boundary differs',
    ],
    [
      'cutover_rls_disabled',
      'ALTER TABLE public.commission_history_cutover DISABLE ROW LEVEL SECURITY;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: ledger RLS, owner, or ACL boundary differs',
    ],
    [
      'anonymous_cutover_select',
      'GRANT SELECT ON public.commission_history_cutover TO anon;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: ledger RLS, owner, or ACL boundary differs',
    ],
    [
      'cutover_immutable_trigger_disabled',
      'ALTER TABLE public.commission_history_cutover DISABLE TRIGGER trg_commission_history_cutover_immutable;',
      'COMMISSION_HISTORY_REPLAY_DRIFT: ledger trigger catalog differs',
    ],
  ]) {
    expectCandidateFailure(`BEGIN;\n${mutation}\n${candidate}\nCOMMIT;`, token, label);
  }

  const wrongForeignKey = `
BEGIN;
ALTER TABLE public.commission_payments DROP CONSTRAINT commission_payments_voided_by_fkey;
ALTER TABLE public.commission_payments
  ADD CONSTRAINT commission_payments_voided_by_fkey
  FOREIGN KEY (voided_by) REFERENCES auth.users(id);
${candidate}
COMMIT;
`;
  const wrongFkResult = psql(wrongForeignKey, { allowFailure: true });
  const wrongFkOutput = `${wrongFkResult.stdout || ''}\n${wrongFkResult.stderr || ''}`;
  assert.notEqual(wrongFkResult.status, 0, 'wrong foreign key mutation unexpectedly succeeded');
  assert.match(
    wrongFkOutput,
    /COMMISSION_HISTORY_REPLAY_DRIFT: FK, trigger, or grant boundary differs/,
    `wrong foreign key failed for the wrong reason:\n${wrongFkOutput}`,
  );
  console.log('COMMISSION_HISTORY_MUTATION_REJECTED wrong_voided_by_fk');

  console.log(
    `COMMISSION_HISTORY_PROOF_PASS postgres=17 baseline=${BASELINE_MANIFEST.migrations_high_water} replayed=${migrations.length}`,
  );
} finally {
  if (started) docker(['rm', '-f', NAME], { allowFailure: true });
}
