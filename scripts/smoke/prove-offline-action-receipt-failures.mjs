#!/usr/bin/env node
/**
 * Disposable local proof for offline receipt concurrency and connection loss.
 *
 * This deliberately creates and leaves a throwaway PostgreSQL database whose
 * name starts with crx_offline_receipts_. It never connects to linked/live
 * Supabase. The source template is a local schema snapshot that already has the
 * canonical complete_delivery and complete_job dependencies.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = 'supabase_db_fieldapp-local-db';
const TEMPLATE_DB = 'crx_offline_receipts_20260714';
const DB_PREFIX = 'crx_offline_receipts_';
const DATABASE = `${DB_PREFIX}failure_proof_${Date.now().toString(36)}`;
const MIGRATION = path.join(
  REPO_ROOT,
  'supabase',
  'migrations',
  '20260714171331_offline_action_receipts.sql'
);
const LIMIT_MIGRATION = path.join(
  REPO_ROOT,
  'supabase',
  'migrations',
  '20260714171800_offline_action_receipt_stage_limits.sql'
);
const FIXTURES = path.join(
  REPO_ROOT,
  'scripts',
  'smoke',
  'setup-offline-action-receipt-failure-proof.sql'
);

function fail(message, details = '') {
  const suffix = details ? `\n${details}` : '';
  throw new Error(`${message}${suffix}`);
}

function ensureDisposableName(database) {
  if (!database.startsWith(DB_PREFIX) || database === TEMPLATE_DB || database === 'postgres') {
    fail(`refusing unsafe database name: ${database}`);
  }
}

function dockerSync(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) fail(`docker could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(
      `docker ${args.join(' ')} failed with exit ${result.status}`,
      `${result.stdout || ''}${result.stderr || ''}`.trim()
    );
  }
  return result;
}

function psqlArgs(database, appName) {
  const args = ['exec', '-i'];
  if (appName) args.push('-e', `PGAPPNAME=${appName}`);
  args.push(
    CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    database,
    '-X',
    '-q',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1'
  );
  return args;
}

function runSql(sql, { database = DATABASE, appName, allowFailure = false } = {}) {
  return dockerSync(psqlArgs(database, appName), { input: sql, allowFailure });
}

function queryJson(sql) {
  const result = runSql(sql);
  const output = result.stdout.trim();
  if (!output) fail('JSON query returned no rows', sql);
  try {
    return JSON.parse(output.split(/\r?\n/).at(-1));
  } catch (error) {
    fail(`could not parse query JSON: ${error.message}`, output);
  }
}

function startSql(sql, appName) {
  const child = spawn('docker', psqlArgs(DATABASE, appName), {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sqlLiteral(value) {
  if (typeof value !== 'string') fail('SQL literal must be a string');
  return `'${value.replaceAll("'", "''")}'`;
}

function validateUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`${label} is not a UUID: ${value}`);
  }
  return value;
}

function processSql(fixture, delayReceipt = false) {
  const claims = JSON.stringify({ sub: validateUuid(fixture.actor_id, 'actor_id'), role: 'authenticated' });
  const action = validateUuid(fixture.client_action_id, 'client_action_id');
  return `
BEGIN;
SET LOCAL "request.jwt.claims" = ${sqlLiteral(claims)};
SET LOCAL ROLE authenticated;
${delayReceipt ? "SET LOCAL crx.proof_delay = 'on';" : ''}
SELECT public.process_offline_action(
  ${sqlLiteral(action)}::uuid,
  ${sqlLiteral(fixture.idempotency_key)}
)::text;
COMMIT;
`;
}

function stageSql(fixture, clientCreatedAt, delayStage = false) {
  const claims = JSON.stringify({ sub: validateUuid(fixture.actor_id, 'actor_id'), role: 'authenticated' });
  const action = validateUuid(fixture.client_action_id, 'client_action_id');
  const entity = validateUuid(fixture.entity_id, 'entity_id');
  return `
BEGIN;
SET LOCAL "request.jwt.claims" = ${sqlLiteral(claims)};
SET LOCAL ROLE authenticated;
${delayStage ? "SET LOCAL crx.proof_stage_delay = 'on';" : ''}
SELECT public.stage_offline_action(
  ${sqlLiteral(action)}::uuid,
  'complete_job',
  ${sqlLiteral(entity)}::uuid,
  1,
  ${sqlLiteral(clientCreatedAt)}::timestamptz,
  '{}'::jsonb,
  ${sqlLiteral(fixture.idempotency_key)}
)::text;
COMMIT;
`;
}

function commitThenLoseResponseSql(fixture) {
  const claims = JSON.stringify({ sub: validateUuid(fixture.actor_id, 'actor_id'), role: 'authenticated' });
  const action = validateUuid(fixture.client_action_id, 'client_action_id');
  return `
BEGIN;
SET LOCAL "request.jwt.claims" = ${sqlLiteral(claims)};
SET LOCAL ROLE authenticated;
DO $proof$
BEGIN
  PERFORM public.process_offline_action(
    ${sqlLiteral(action)}::uuid,
    ${sqlLiteral(fixture.idempotency_key)}
  );
END;
$proof$;
COMMIT;
SELECT pg_sleep(6);
`;
}

function activityFor(appName) {
  return queryJson(`
SELECT COALESCE(json_agg(row_to_json(a)), '[]'::json)::text
FROM (
  SELECT pid, state, wait_event_type, wait_event
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND application_name = ${sqlLiteral(appName)}
) a;
`);
}

async function waitForActivity(appName, predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = activityFor(appName);
    if (last.some(predicate)) return last;
    await delay(75);
  }
  fail(`timed out waiting for ${description} (${appName})`, JSON.stringify(last));
}

function parseProcessResult(completed, label) {
  if (completed.code !== 0) {
    fail(`${label} exited with ${completed.code}`, `${completed.stdout}\n${completed.stderr}`.trim());
  }
  const output = completed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`, completed.stdout);
  }
}

function receiptState(fixture) {
  const action = validateUuid(fixture.client_action_id, 'client_action_id');
  return queryJson(`
SELECT row_to_json(s)::text
FROM (
  SELECT status, attempt_count, failure_code, result,
         last_attempt_at, succeeded_at, updated_at
  FROM public.offline_action_receipts
  WHERE client_action_id = ${sqlLiteral(action)}::uuid
) s;
`);
}

function deliveryState(fixture) {
  const entity = validateUuid(fixture.entity_id, 'delivery entity_id');
  return queryJson(`
SELECT json_build_object(
  'status', d.status,
  'ledger_count', (
    SELECT count(*) FROM public.inventory_transactions i
    WHERE i.delivery_id = d.id AND i.transaction_type = 'delivered'
  )
)::text
FROM public.deliveries d
WHERE d.id = ${sqlLiteral(entity)}::uuid;
`);
}

function jobState(fixture) {
  const entity = validateUuid(fixture.entity_id, 'job entity_id');
  return queryJson(`
SELECT json_build_object(
  'status', j.status,
  'application_record_count', (
    SELECT count(*) FROM public.application_records a
    WHERE a.source_type = 'job' AND a.source_id = j.id
  )
)::text
FROM public.jobs j
WHERE j.id = ${sqlLiteral(entity)}::uuid;
`);
}

async function proveConcurrent(fixture, label, stateReader, countField) {
  const firstApp = `crx_proof_${label}_first`;
  const secondApp = `crx_proof_${label}_second`;
  const first = startSql(processSql(fixture, true), firstApp);

  await waitForActivity(
    firstApp,
    (row) => row.wait_event === 'PgSleep',
    'first transaction to pause after the business mutation'
  );

  const second = startSql(processSql(fixture, false), secondApp);
  await waitForActivity(
    secondApp,
    (row) => row.wait_event_type === 'Lock',
    'second transaction to block on the receipt row'
  );

  const [firstDone, secondDone] = await Promise.all([first.completed, second.completed]);
  const firstResult = parseProcessResult(firstDone, `${label} first caller`);
  const secondResult = parseProcessResult(secondDone, `${label} second caller`);

  assert.deepStrictEqual(secondResult, firstResult, `${label}: concurrent callers returned different receipts`);
  assert.equal(firstResult.status, 'succeeded', `${label}: receipt did not succeed`);
  assert.equal(firstResult.attempt_count, 1, `${label}: more than one processing attempt was recorded`);

  const receipt = receiptState(fixture);
  const business = stateReader(fixture);
  assert.equal(receipt.status, 'succeeded', `${label}: stored receipt is not succeeded`);
  assert.equal(receipt.attempt_count, 1, `${label}: stored attempt_count is not 1`);
  assert.equal(business.status, 'completed', `${label}: business entity is not completed`);
  assert.equal(Number(business[countField]), 1, `${label}: business mutation count is not exactly one`);

  return { lock_observed: true, receipt, business };
}

async function proveConcurrentStageLimit(firstFixture, secondFixture) {
  const clientCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const firstApp = 'crx_proof_stage_limit_first';
  const secondApp = 'crx_proof_stage_limit_second';
  const first = startSql(stageSql(firstFixture, clientCreatedAt, true), firstApp);

  await waitForActivity(
    firstApp,
    (row) => row.wait_event === 'PgSleep',
    'first stage call to pause while holding the actor limit lock'
  );

  const second = startSql(stageSql(secondFixture, clientCreatedAt, false), secondApp);
  await waitForActivity(
    secondApp,
    (row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory',
    'second stage call to block on the actor limit lock'
  );

  const [firstDone, secondDone] = await Promise.all([first.completed, second.completed]);
  const winner = parseProcessResult(firstDone, 'stage-limit first caller');
  assert.equal(winner.status, 'needs_review', 'stage-limit winner did not persist its missing-target receipt');
  assert.notEqual(secondDone.code, 0, 'stage-limit second caller unexpectedly succeeded');
  assert.match(
    secondDone.stderr,
    /OFFLINE_STAGE_RATE_LIMIT: no more than 250 new offline actions may be staged per 24 hours/,
    'stage-limit loser returned the wrong error'
  );

  const firstAction = validateUuid(firstFixture.client_action_id, 'first race action');
  const secondAction = validateUuid(secondFixture.client_action_id, 'second race action');
  const counts = queryJson(`
SELECT json_build_object(
  'recent_count', count(*) FILTER (WHERE received_at >= now() - interval '24 hours'),
  'race_receipts', count(*) FILTER (
    WHERE client_action_id IN (${sqlLiteral(firstAction)}::uuid, ${sqlLiteral(secondAction)}::uuid)
  )
)::text
FROM public.offline_action_receipts
WHERE actor_id = ${sqlLiteral(firstFixture.actor_id)}::uuid;
`);
  assert.equal(Number(counts.recent_count), 250, 'concurrent stage calls crossed the daily limit');
  assert.equal(Number(counts.race_receipts), 1, 'concurrent stage race did not persist exactly one receipt');

  const replayDone = await startSql(
    stageSql(firstFixture, clientCreatedAt, false),
    'crx_proof_stage_limit_exact_replay'
  ).completed;
  const replay = parseProcessResult(replayDone, 'stage-limit exact replay');
  assert.deepStrictEqual(replay, winner, 'exact stage replay changed or was blocked at the daily limit');

  return { lock_observed: true, winner, loser_error: 'OFFLINE_STAGE_RATE_LIMIT', counts };
}

async function proveInterruptedConnection(fixture) {
  const appName = 'crx_proof_interrupted_connection';
  const processing = startSql(processSql(fixture, true), appName);
  const activity = await waitForActivity(
    appName,
    (row) => row.wait_event === 'PgSleep',
    'transaction to pause before receipt success commits'
  );
  const pid = activity.find((row) => row.wait_event === 'PgSleep').pid;

  const termination = queryJson(`
SELECT json_build_object('pid', ${Number(pid)}, 'terminated', pg_terminate_backend(${Number(pid)}))::text;
`);
  assert.equal(termination.terminated, true, 'PostgreSQL did not terminate the proof connection');

  const interrupted = await processing.completed;
  assert.notEqual(interrupted.code, 0, 'terminated processing connection unexpectedly exited successfully');

  const rolledBackReceipt = receiptState(fixture);
  const rolledBackBusiness = deliveryState(fixture);
  assert.equal(rolledBackReceipt.status, 'received', 'interrupted receipt falsely advanced beyond received');
  assert.equal(rolledBackReceipt.attempt_count, 0, 'interrupted attempt_count did not roll back');
  assert.equal(rolledBackReceipt.result, null, 'interrupted receipt retained a result');
  assert.equal(rolledBackBusiness.status, 'in_progress', 'interrupted delivery business state did not roll back');
  assert.equal(Number(rolledBackBusiness.ledger_count), 0, 'interrupted delivery leaked a ledger row');

  const retryDone = await startSql(processSql(fixture, false), 'crx_proof_interrupted_retry').completed;
  const retryResult = parseProcessResult(retryDone, 'interrupted delivery retry');
  assert.equal(retryResult.status, 'succeeded', 'retry after connection loss did not succeed');
  assert.equal(retryResult.attempt_count, 1, 'retry after connection loss did not converge at attempt_count 1');

  const finalReceipt = receiptState(fixture);
  const finalBusiness = deliveryState(fixture);
  assert.equal(finalReceipt.status, 'succeeded', 'retried receipt is not succeeded');
  assert.equal(finalReceipt.attempt_count, 1, 'retried receipt attempt_count is not 1');
  assert.equal(finalBusiness.status, 'completed', 'retried delivery is not completed');
  assert.equal(Number(finalBusiness.ledger_count), 1, 'retried delivery did not write exactly one ledger row');

  return {
    backend_terminated: termination,
    after_termination: { receipt: rolledBackReceipt, business: rolledBackBusiness },
    after_retry: { receipt: finalReceipt, business: finalBusiness },
  };
}


async function proveLostResponseAfterCommit(fixture) {
  const appName = 'crx_proof_lost_response_after_commit';
  const processing = startSql(commitThenLoseResponseSql(fixture), appName);

  const activity = await waitForActivity(
    appName,
    (row) => row.wait_event === 'PgSleep',
    'post-commit connection window'
  );
  const pid = activity.find((row) => row.wait_event === 'PgSleep').pid;

  const committedReceipt = receiptState(fixture);
  const committedBusiness = deliveryState(fixture);
  assert.equal(committedReceipt.status, 'succeeded', 'post-commit receipt is not succeeded');
  assert.equal(committedReceipt.attempt_count, 1, 'post-commit receipt attempt_count is not 1');
  assert.equal(committedBusiness.status, 'completed', 'post-commit delivery is not completed');
  assert.equal(Number(committedBusiness.ledger_count), 1, 'post-commit delivery did not write exactly one ledger row');

  const termination = queryJson(`
SELECT json_build_object('pid', ${Number(pid)}, 'terminated', pg_terminate_backend(${Number(pid)}))::text;
`);
  assert.equal(termination.terminated, true, 'PostgreSQL did not terminate the post-commit connection');
  const disconnected = await processing.completed;
  assert.notEqual(disconnected.code, 0, 'post-commit disconnected client unexpectedly exited successfully');

  const replayDone = await startSql(processSql(fixture, false), 'crx_proof_lost_response_replay').completed;
  const replayResult = parseProcessResult(replayDone, 'lost-response replay');
  assert.equal(replayResult.status, 'succeeded', 'lost-response replay did not recover success');
  assert.equal(replayResult.attempt_count, 1, 'lost-response replay incremented attempt_count');
  assert.deepStrictEqual(replayResult.result, committedReceipt.result, 'lost-response replay returned different business result');

  const replayReceipt = receiptState(fixture);
  const replayBusiness = deliveryState(fixture);
  assert.deepStrictEqual(replayReceipt, committedReceipt, 'lost-response replay changed the permanent receipt');
  assert.equal(Number(replayBusiness.ledger_count), 1, 'lost-response replay duplicated the ledger row');

  return {
    backend_terminated_after_commit: termination,
    committed_before_disconnect: { receipt: committedReceipt, business: committedBusiness },
    replay_after_unknown_outcome: { receipt: replayReceipt, business: replayBusiness },
  };
}

function prepareDatabase() {
  ensureDisposableName(DATABASE);
  dockerSync(['exec', CONTAINER, 'createdb', '-U', 'postgres', '-T', TEMPLATE_DB, DATABASE]);

  runSql(`
DO $guard$
BEGIN
  IF current_database() !~ '^crx_offline_receipts_failure_proof_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PROOF_SAFETY: refusing composed setup on %', current_database();
  END IF;
END;
$guard$;
`);

  runSql(`
DO $preflight$
DECLARE
  v_delivery_hash text;
  v_job_hash text;
BEGIN
  SELECT md5(p.prosrc) INTO v_delivery_hash
  FROM pg_proc p
  WHERE p.oid = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure;

  SELECT md5(p.prosrc) INTO v_job_hash
  FROM pg_proc p
  WHERE p.oid = 'public.complete_job(uuid,jsonb,uuid,text)'::regprocedure;

  IF v_delivery_hash IS DISTINCT FROM '9fa0fdc953a0094dcb6e29a2850fe805'
     OR v_job_hash IS DISTINCT FROM '3b1137089054fb16166cb4affc695ff9' THEN
    RAISE EXCEPTION 'PROOF_PREFLIGHT: canonical RPC fingerprint drift (delivery %, job %)',
      v_delivery_hash, v_job_hash;
  END IF;
END;
$preflight$;
`);

  const migrationSql = readFileSync(MIGRATION, 'utf8');
  const limitMigrationSql = readFileSync(LIMIT_MIGRATION, 'utf8');
  const fixtureSql = readFileSync(FIXTURES, 'utf8');
  const setupSql = `
BEGIN;
DROP FUNCTION IF EXISTS public.process_offline_action(uuid, text);
DROP FUNCTION IF EXISTS public.get_offline_action_status(uuid);
DROP FUNCTION IF EXISTS public.stage_offline_action(uuid, text, uuid, integer, timestamptz, jsonb, text, timestamptz);
DROP TABLE IF EXISTS public.offline_action_receipts CASCADE;
${migrationSql}
${limitMigrationSql}
${fixtureSql}
COMMIT;
`;
  runSql(setupSql);
}

function loadFixtures() {
  const fixtures = queryJson(`
SELECT json_object_agg(label, row_to_json(c))::text
FROM public.offline_receipt_failure_proof_control c;
`);
  for (const label of [
    'concurrency_delivery',
    'interrupted_delivery',
    'lost_response_delivery',
    'concurrency_job',
    'rate_race_a',
    'rate_race_b',
  ]) {
    if (!fixtures[label]) fail(`missing fixture: ${label}`);
  }
  return fixtures;
}

async function main() {
  console.log(`[proof] creating disposable database ${DATABASE} from ${TEMPLATE_DB}`);
  prepareDatabase();
  const fixtures = loadFixtures();

  console.log('[proof] racing two new stage calls for one remaining daily slot');
  const stageLimitConcurrency = await proveConcurrentStageLimit(
    fixtures.rate_race_a,
    fixtures.rate_race_b
  );

  console.log('[proof] racing two complete_delivery processors');
  const deliveryConcurrency = await proveConcurrent(
    fixtures.concurrency_delivery,
    'concurrent_delivery',
    deliveryState,
    'ledger_count'
  );

  console.log('[proof] racing two complete_job processors');
  const jobConcurrency = await proveConcurrent(
    fixtures.concurrency_job,
    'concurrent_job',
    jobState,
    'application_record_count'
  );

  console.log('[proof] terminating a complete_delivery connection before commit, then retrying');
  const interruptedConnection = await proveInterruptedConnection(fixtures.interrupted_delivery);

  console.log('[proof] terminating a complete_delivery connection after commit, then replaying');
  const lostResponseAfterCommit = await proveLostResponseAfterCommit(fixtures.lost_response_delivery);

  console.log(JSON.stringify({
    database: DATABASE,
    stage_limit_concurrency: stageLimitConcurrency,
    delivery_concurrency: deliveryConcurrency,
    job_concurrency: jobConcurrency,
    interrupted_connection: interruptedConnection,
    lost_response_after_commit: lostResponseAfterCommit,
  }, null, 2));
  console.log('PASS: offline receipt concurrency + interrupted-connection proof');
  console.log(`[proof] disposable evidence database left in place: ${DATABASE}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  console.error(`[proof] disposable database retained for inspection if created: ${DATABASE}`);
  process.exitCode = 1;
});
