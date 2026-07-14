#!/usr/bin/env node
/**
 * Disposable local proof for office review/resolution behavior.
 *
 * Creates and retains a database named crx_offline_resolution_proof_* from the
 * local template. It never connects to linked or live Supabase.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = 'supabase_db_fieldapp-local-db';
const TEMPLATE = 'crx_offline_receipts_20260714';
const PREFIX = 'crx_offline_resolution_proof_';
const DATABASE = `${PREFIX}${Date.now().toString(36)}`;
const ADMIN = 'ac1c1148-1f98-4de5-9201-2488350a08b5';
const SALES = '5da61655-13ac-4930-9121-a5fd365ec416';
const APPLICATOR_1 = '00000000-0000-0000-0000-0000000000a1';
const APPLICATOR_2 = '00000000-0000-0000-0000-0000000000a2';
const MIGRATIONS = [
  '20260714024811_offline_action_receipts.sql',
  '20260714070000_offline_action_receipt_stage_limits.sql',
  '20260714122626_offline_action_review_resolution.sql',
].map((name) => path.join(ROOT, 'supabase', 'migrations', name));
const SETUP = path.join(ROOT, 'scripts', 'smoke', 'setup-offline-action-review-resolution-proof.sql');

function fail(message, details = '') {
  throw new Error(details ? `${message}\n${details}` : message);
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.error) fail(`docker failed to start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`docker ${args.join(' ')} exited ${result.status}`, `${result.stdout}\n${result.stderr}`.trim());
  }
  return result;
}

function psqlArgs(database = DATABASE, appName) {
  const args = ['exec', '-i'];
  if (appName) args.push('-e', `PGAPPNAME=${appName}`);
  args.push(CONTAINER, 'psql', '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1');
  return args;
}

function sql(source, { database = DATABASE, appName, allowFailure = false } = {}) {
  return docker(psqlArgs(database, appName), { input: source, allowFailure });
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function authenticated(userId, statement, extra = '') {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return `
BEGIN;
SELECT set_config('request.jwt.claims', ${literal(claims)}, true);
SET LOCAL ROLE authenticated;
${extra}
${statement}
COMMIT;
`;
}

function jsonResult(result, label) {
  if (result.status !== 0) fail(`${label} failed`, `${result.stdout}\n${result.stderr}`.trim());
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`, result.stdout);
  }
}

function queryJson(statement, label = 'JSON query') {
  return jsonResult(sql(statement), label);
}

function control(label) {
  return queryJson(`
SELECT row_to_json(c)::text
FROM public.offline_resolution_proof_control c
WHERE c.label = ${literal(label)};
`, `control ${label}`);
}

function startAuthenticated(userId, statement, appName, extra = '') {
  const child = spawn('docker', psqlArgs(DATABASE, appName), {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(authenticated(userId, statement, extra));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProofDelay(appName) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = queryJson(`
SELECT COALESCE(json_agg(row_to_json(a)), '[]'::json)::text
FROM (
  SELECT state, wait_event_type, wait_event
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND application_name = ${literal(appName)}
) a;
`, 'proof activity');
    if (rows.some((row) => row.wait_event === 'PgSleep')) return;
    await sleep(75);
  }
  fail('timed out waiting for the first resolution session to enter the proof delay');
}

async function waitForLock(appName, blockerAppName) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = queryJson(`
SELECT COALESCE(json_agg(row_to_json(a)), '[]'::json)::text
FROM (
  SELECT waiting.pid, waiting.wait_event_type, waiting.wait_event,
         EXISTS (
           SELECT 1
           FROM pg_stat_activity blocker
           WHERE blocker.pid = ANY(pg_blocking_pids(waiting.pid))
             AND blocker.application_name = ${literal(blockerAppName)}
         ) AS blocked_by_expected_session
  FROM pg_stat_activity waiting
  WHERE waiting.datname = current_database()
    AND waiting.application_name = ${literal(appName)}
) a;
`, 'lock activity');
    if (rows.some((row) => row.wait_event_type === 'Lock' && row.blocked_by_expected_session)) return;
    await sleep(75);
  }
  fail(`timed out waiting for ${appName} to block on ${blockerAppName}`);
}

function assertRejected(result, token, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(token), `${label} did not return ${token}`);
}

async function main() {
  if (!DATABASE.startsWith(PREFIX) || DATABASE === TEMPLATE) fail(`unsafe proof database name: ${DATABASE}`);
  docker(['exec', CONTAINER, 'createdb', '-U', 'postgres', '-T', TEMPLATE, DATABASE]);
  for (const migration of MIGRATIONS) sql(readFileSync(migration, 'utf8'));
  sql(readFileSync(SETUP, 'utf8'));

  const primary = control('primary');
  const race = control('race');
  const ownerStatus = control('owner_status');
  const sameKeyA = control('same_key_a');
  const sameKeyB = control('same_key_b');

  const adminQueue = jsonResult(sql(authenticated(ADMIN,
    "SELECT public.get_offline_action_review_queue(false, 100, 0)::text;"
  )), 'admin queue');
  const salesQueue = jsonResult(sql(authenticated(SALES,
    "SELECT public.get_offline_action_review_queue(false, 100, 0)::text;"
  )), 'sales queue');
  assert.equal(adminQueue.total, 5);
  assert.equal(salesQueue.total, 5);
  assert.equal(JSON.stringify(adminQueue).includes('request_payload'), false);
  assert.equal(JSON.stringify(adminQueue).includes('idempotency_key'), false);
  assert.equal(JSON.stringify(adminQueue).includes('RAW_PAYLOAD_MUST_NOT_ESCAPE'), false);

  const payloadDriftTarget = queryJson(`
SELECT json_build_object(
  'client_action_id', gen_random_uuid(),
  'snapshot_client_action_id', gen_random_uuid(),
  'process_drift_client_action_id', gen_random_uuid(),
  'missing_snapshot_client_action_id', gen_random_uuid(),
  'client_created_at', now(),
  'job_id', (SELECT j.id FROM public.jobs j ORDER BY j.created_at LIMIT 1),
  'job_updated_at', (SELECT j.updated_at FROM public.jobs j ORDER BY j.created_at LIMIT 1),
  'stale_snapshot_at', (
    SELECT j.updated_at - interval '1 minute'
    FROM public.jobs j
    ORDER BY j.created_at
    LIMIT 1
  ),
  'field_id', (
    SELECT f.id
    FROM public.fields f
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.job_fields jf
      WHERE jf.job_id = (SELECT j.id FROM public.jobs j ORDER BY j.created_at LIMIT 1)
        AND jf.field_id = f.id
    )
    LIMIT 1
  )
)::text;
`, 'payload drift target');
  assert.ok(payloadDriftTarget.job_id, 'proof template must contain a job');
  assert.ok(payloadDriftTarget.field_id, 'proof template must contain a field outside the selected job');
  const payloadDriftKey = `[PROOF] payload-drift-${Date.now().toString(36)}`;
  const payloadDriftStatement = `SELECT public.stage_offline_action(
    ${literal(payloadDriftTarget.client_action_id)}::uuid,
    'complete_job',
    ${literal(payloadDriftTarget.job_id)}::uuid,
    1,
    ${literal(payloadDriftTarget.client_created_at)}::timestamptz,
    jsonb_build_object(
      'field_acres',
      jsonb_build_array(jsonb_build_object(
        'field_id', ${literal(payloadDriftTarget.field_id)}::uuid,
        'acres_applied', 1
      ))
    ),
    ${literal(payloadDriftKey)},
    ${literal(payloadDriftTarget.job_updated_at)}::timestamptz
  )::text;`;
  const payloadDriftReceipt = jsonResult(
    sql(authenticated(ADMIN, payloadDriftStatement)),
    'payload drift receipt',
  );
  const payloadDriftReplay = jsonResult(
    sql(authenticated(ADMIN, payloadDriftStatement)),
    'payload drift replay',
  );
  assert.deepEqual(payloadDriftReplay, payloadDriftReceipt);
  assert.equal(payloadDriftReceipt.status, 'needs_review');
  assert.equal(payloadDriftReceipt.failure_code, 'PAYLOAD_INVALID');
  assert.match(payloadDriftReceipt.failure_summary, /saved field no longer belongs to this job/i);

  const payloadDriftQueue = jsonResult(sql(authenticated(ADMIN,
    "SELECT public.get_offline_action_review_queue(false, 100, 0)::text;"
  )), 'payload drift queue');
  assert.ok(payloadDriftQueue.items.some((item) => (
    item.client_action_id === payloadDriftTarget.client_action_id
    && item.failure_code === 'PAYLOAD_INVALID'
  )));
  assert.equal(JSON.stringify(payloadDriftQueue).includes('field_acres'), false);

  const targetDriftKey = `[PROOF] target-drift-${Date.now().toString(36)}`;
  const targetDriftStatement = `SELECT public.stage_offline_action(
    ${literal(payloadDriftTarget.snapshot_client_action_id)}::uuid,
    'complete_job',
    ${literal(payloadDriftTarget.job_id)}::uuid,
    1,
    ${literal(payloadDriftTarget.client_created_at)}::timestamptz,
    '{}'::jsonb,
    ${literal(targetDriftKey)},
    ${literal(payloadDriftTarget.stale_snapshot_at)}::timestamptz
  )::text;`;
  const targetDriftReceipt = jsonResult(
    sql(authenticated(ADMIN, targetDriftStatement)),
    'target snapshot drift receipt',
  );
  const targetDriftReplay = jsonResult(
    sql(authenticated(ADMIN, targetDriftStatement)),
    'target snapshot drift replay',
  );
  assert.deepEqual(targetDriftReplay, targetDriftReceipt);
  assert.equal(targetDriftReceipt.status, 'needs_review');
  assert.equal(targetDriftReceipt.failure_code, 'TARGET_STATE_CONFLICT');
  assert.match(targetDriftReceipt.failure_summary, /changed after this action was saved offline/i);

  const missingSnapshotReceipt = jsonResult(sql(authenticated(ADMIN, `
SELECT public.stage_offline_action(
  ${literal(payloadDriftTarget.missing_snapshot_client_action_id)}::uuid,
  'complete_job',
  ${literal(payloadDriftTarget.job_id)}::uuid,
  1,
  ${literal(payloadDriftTarget.client_created_at)}::timestamptz,
  '{}'::jsonb,
  ${literal(`[PROOF] missing-snapshot-${Date.now().toString(36)}`)}
)::text;
`)), 'missing snapshot receipt');
  assert.equal(missingSnapshotReceipt.status, 'needs_review');
  assert.equal(missingSnapshotReceipt.failure_code, 'LEGACY_OUTCOME_UNKNOWN');

  const processDriftKey = `[PROOF] process-drift-${Date.now().toString(36)}`;
  const processDriftStage = jsonResult(sql(authenticated(ADMIN, `
SELECT public.stage_offline_action(
  ${literal(payloadDriftTarget.process_drift_client_action_id)}::uuid,
  'complete_job',
  ${literal(payloadDriftTarget.job_id)}::uuid,
  1,
  ${literal(payloadDriftTarget.client_created_at)}::timestamptz,
  '{}'::jsonb,
  ${literal(processDriftKey)},
  ${literal(payloadDriftTarget.job_updated_at)}::timestamptz
)::text;
`)), 'process drift stage');
  assert.equal(processDriftStage.status, 'received');
  const applicationCountBeforeDrift = Number(sql(`
SELECT count(*)
FROM public.application_records
WHERE source_type = 'job'
  AND source_id = ${literal(payloadDriftTarget.job_id)}::uuid;
`).stdout.trim());
  sql(`
UPDATE public.jobs
SET updated_at = updated_at + interval '2 minutes'
WHERE id = ${literal(payloadDriftTarget.job_id)}::uuid;
`);
  const processDriftReceipt = jsonResult(sql(authenticated(ADMIN, `
SELECT public.process_offline_action(
  ${literal(payloadDriftTarget.process_drift_client_action_id)}::uuid,
  ${literal(processDriftKey)}
)::text;
`)), 'process drift receipt');
  assert.equal(processDriftReceipt.status, 'needs_review');
  assert.equal(processDriftReceipt.failure_code, 'TARGET_STATE_CONFLICT');
  const applicationCountAfterDrift = Number(sql(`
SELECT count(*)
FROM public.application_records
WHERE source_type = 'job'
  AND source_id = ${literal(payloadDriftTarget.job_id)}::uuid;
`).stdout.trim());
  assert.equal(applicationCountAfterDrift, applicationCountBeforeDrift);

  const deniedApplicator = sql(authenticated(APPLICATOR_1,
    "SELECT public.get_offline_action_review_queue(false, 100, 0)::text;"
  ), { allowFailure: true });
  assertRejected(deniedApplicator, 'NOT_AUTHORIZED', 'applicator queue');
  assert.equal(queryJson(`
SELECT json_build_object(
  'anon_queue', has_function_privilege('anon', 'public.get_offline_action_review_queue(boolean,integer,integer)', 'EXECUTE'),
  'anon_resolve', has_function_privilege('anon', 'public.resolve_offline_action(uuid,text,text,text)', 'EXECUTE')
)::text;
`).anon_queue, false);

  const note = 'Dispatch verified the signed paper record was already posted.';
  const primaryKey = '[PROOF] resolve-primary';
  const resolveStatement = `SELECT public.resolve_offline_action(
    ${literal(primary.client_action_id)}::uuid,
    'already_completed',
    ${literal(note)},
    ${literal(primaryKey)}
  )::text;`;
  const first = jsonResult(sql(authenticated(ADMIN, resolveStatement)), 'first resolution');
  const replay = jsonResult(sql(authenticated(ADMIN, resolveStatement)), 'resolution replay');
  assert.deepEqual(replay, first);
  assert.equal(first.status, 'needs_review');
  assert.equal(first.review_resolution, 'already_completed');

  const activityAfterReplay = queryJson(`
SELECT json_build_object(
  'events', count(*),
  'receipts', (SELECT count(*) FROM public.offline_action_receipts WHERE client_action_id = ${literal(primary.client_action_id)}::uuid)
)::text
FROM public.activity_feed
WHERE event_type = 'offline_action_resolved'
  AND description LIKE '%' || left(${literal(primary.client_action_id)}, 8) || '%';
`);
  assert.equal(Number(activityAfterReplay.events), 1);
  assert.equal(Number(activityAfterReplay.receipts), 1);

  const keyMismatch = sql(authenticated(ADMIN, `SELECT public.resolve_offline_action(
    ${literal(ownerStatus.client_action_id)}::uuid,
    'already_completed',
    ${literal(note)},
    ${literal(primaryKey)}
  )::text;`), { allowFailure: true });
  assertRejected(keyMismatch, 'IDEMPOTENCY_ARGUMENT_MISMATCH', 'idempotency argument mismatch');

  const ownerView = jsonResult(sql(authenticated(APPLICATOR_1,
    `SELECT public.get_offline_action_status(${literal(primary.client_action_id)}::uuid)::text;`
  )), 'owner status view');
  assert.equal(ownerView.review_resolution, 'already_completed');
  assert.equal(ownerView.review_note, note);
  assert.equal(JSON.stringify(ownerView).includes('RAW_PAYLOAD_MUST_NOT_ESCAPE'), false);

  const firstRaceApp = 'crx_resolution_race_first';
  const firstRace = startAuthenticated(ADMIN, `SELECT public.resolve_offline_action(
    ${literal(race.client_action_id)}::uuid,
    'already_completed',
    'Admin verified this against the signed dispatch record.',
    '[PROOF] resolve-race-admin'
  )::text;`, firstRaceApp, "SET LOCAL crx.review_delay = 'on';");
  await waitForProofDelay(firstRaceApp);
  const secondRace = startAuthenticated(SALES, `SELECT public.resolve_offline_action(
    ${literal(race.client_action_id)}::uuid,
    'abandoned',
    'Sales verified this saved action must never be replayed.',
    '[PROOF] resolve-race-sales'
  )::text;`, 'crx_resolution_race_second');
  await waitForLock('crx_resolution_race_second', firstRaceApp);
  const [firstRaceResult, secondRaceResult] = await Promise.all([firstRace, secondRace]);
  jsonResult(firstRaceResult, 'winning concurrent resolution');
  assertRejected(secondRaceResult, 'OFFLINE_ACTION_ALREADY_RESOLVED', 'losing concurrent resolution');

  const raceState = queryJson(`
SELECT json_build_object(
  'resolution', r.review_resolution,
  'resolver', r.resolved_by,
  'status', r.status,
  'events', (
    SELECT count(*) FROM public.activity_feed a
    WHERE a.event_type = 'offline_action_resolved'
      AND a.description LIKE '%' || left(r.client_action_id::text, 8) || '%'
  )
)::text
FROM public.offline_action_receipts r
WHERE r.client_action_id = ${literal(race.client_action_id)}::uuid;
`);
  assert.equal(raceState.resolution, 'already_completed');
  assert.equal(raceState.resolver, ADMIN);
  assert.equal(raceState.status, 'needs_review');
  assert.equal(Number(raceState.events), 1);

  const sameKey = '[PROOF] shared-key-different-receipts';
  const sameKeyFirstApp = 'crx_resolution_same_key_first';
  const sameKeyFirst = startAuthenticated(ADMIN, `SELECT public.resolve_offline_action(
    ${literal(sameKeyA.client_action_id)}::uuid,
    'already_completed',
    'Admin verified the first same-key receipt against dispatch.',
    ${literal(sameKey)}
  )::text;`, sameKeyFirstApp, "SET LOCAL crx.review_delay = 'on';");
  await waitForProofDelay(sameKeyFirstApp);
  const sameKeySecondApp = 'crx_resolution_same_key_second';
  const sameKeySecond = startAuthenticated(SALES, `SELECT public.resolve_offline_action(
    ${literal(sameKeyB.client_action_id)}::uuid,
    'abandoned',
    'Sales attempted the second receipt using the same key.',
    ${literal(sameKey)}
  )::text;`, sameKeySecondApp);
  await waitForLock(sameKeySecondApp, sameKeyFirstApp);
  const [sameKeyFirstResult, sameKeySecondResult] = await Promise.all([sameKeyFirst, sameKeySecond]);
  jsonResult(sameKeyFirstResult, 'same-key winning resolution');
  assertRejected(sameKeySecondResult, 'IDEMPOTENCY_ARGUMENT_MISMATCH', 'same key on a different receipt');

  const sameKeyState = queryJson(`
SELECT json_build_object(
  'resolved_a', (SELECT resolved_at IS NOT NULL FROM public.offline_action_receipts WHERE client_action_id = ${literal(sameKeyA.client_action_id)}::uuid),
  'resolved_b', (SELECT resolved_at IS NOT NULL FROM public.offline_action_receipts WHERE client_action_id = ${literal(sameKeyB.client_action_id)}::uuid),
  'events_a', (SELECT count(*) FROM public.activity_feed WHERE event_type = 'offline_action_resolved' AND description LIKE '%' || left(${literal(sameKeyA.client_action_id)}, 8) || '%'),
  'events_b', (SELECT count(*) FROM public.activity_feed WHERE event_type = 'offline_action_resolved' AND description LIKE '%' || left(${literal(sameKeyB.client_action_id)}, 8) || '%')
)::text;
`);
  assert.equal(sameKeyState.resolved_a, true);
  assert.equal(sameKeyState.resolved_b, false);
  assert.equal(Number(sameKeyState.events_a), 1);
  assert.equal(Number(sameKeyState.events_b), 0);

  sql(`
INSERT INTO public.offline_action_receipts (
  client_action_id, actor_id, operation, entity_id, schema_version,
  client_created_at, request_payload, idempotency_key, status,
  failure_code, failure_summary, attempt_count, last_attempt_at,
  needs_review_at, received_at
)
SELECT
  gen_random_uuid(), ${literal(APPLICATOR_2)}::uuid, 'complete_job', gen_random_uuid(), 1,
  now() - interval '49 hours', '{}'::jsonb, '[PROOF] backlog-' || g, 'needs_review',
  'TARGET_STATE_CONFLICT', 'Backlog proof row requires office review.', 1,
  now() - interval '48 hours', now() - interval '48 hours', now() - interval '48 hours'
FROM generate_series(1, 500) g;
`);
  const blockedBacklog = sql(`
INSERT INTO public.offline_action_receipts (
  client_action_id, actor_id, operation, entity_id, schema_version,
  client_created_at, request_payload, idempotency_key
) VALUES (
  gen_random_uuid(), ${literal(APPLICATOR_2)}::uuid, 'complete_job', gen_random_uuid(), 1,
  now(), '{}'::jsonb, '[PROOF] backlog-blocked'
);
`, { allowFailure: true });
  assertRejected(blockedBacklog, 'OFFLINE_STAGE_REVIEW_BACKLOG', '500-item unresolved backlog');

  const backlogAction = sql(`
SELECT client_action_id::text
FROM public.offline_action_receipts
WHERE actor_id = ${literal(APPLICATOR_2)}::uuid
  AND idempotency_key LIKE '[PROOF] backlog-%'
ORDER BY client_action_id
LIMIT 1;
`).stdout.trim();
  jsonResult(sql(authenticated(ADMIN, `SELECT public.resolve_offline_action(
    ${literal(backlogAction)}::uuid,
    'abandoned',
    'Office closed one backlog proof item without running it.',
    '[PROOF] resolve-backlog-one'
  )::text;`)), 'backlog resolution');
  sql(`
INSERT INTO public.offline_action_receipts (
  client_action_id, actor_id, operation, entity_id, schema_version,
  client_created_at, request_payload, idempotency_key
) VALUES (
  gen_random_uuid(), ${literal(APPLICATOR_2)}::uuid, 'complete_job', gen_random_uuid(), 1,
  now(), '{}'::jsonb, '[PROOF] backlog-after-resolution'
);
`);
  const backlogCounts = queryJson(`
SELECT json_build_object(
  'resolved', count(*) FILTER (WHERE resolved_at IS NOT NULL),
  'unresolved', count(*) FILTER (WHERE status = 'needs_review' AND resolved_at IS NULL),
  'new_received', count(*) FILTER (WHERE idempotency_key = '[PROOF] backlog-after-resolution')
)::text
FROM public.offline_action_receipts
WHERE actor_id = ${literal(APPLICATOR_2)}::uuid;
`);
  assert.equal(Number(backlogCounts.resolved), 1);
  assert.equal(Number(backlogCounts.unresolved), 499);
  assert.equal(Number(backlogCounts.new_received), 1);

  sql(`UPDATE public.offline_action_receipts SET received_at = now() - interval '48 hours' WHERE actor_id = ${literal(APPLICATOR_1)}::uuid;`);
  sql(`
INSERT INTO public.offline_action_receipts (
  client_action_id, actor_id, operation, entity_id, schema_version,
  client_created_at, request_payload, idempotency_key
)
SELECT gen_random_uuid(), ${literal(APPLICATOR_1)}::uuid, 'complete_job', gen_random_uuid(), 1,
       now(), '{}'::jsonb, '[PROOF] daily-' || g
FROM generate_series(1, 250) g;
`);
  const blockedDaily = sql(`
INSERT INTO public.offline_action_receipts (
  client_action_id, actor_id, operation, entity_id, schema_version,
  client_created_at, request_payload, idempotency_key
) VALUES (
  gen_random_uuid(), ${literal(APPLICATOR_1)}::uuid, 'complete_job', gen_random_uuid(), 1,
  now(), '{}'::jsonb, '[PROOF] daily-blocked'
);
`, { allowFailure: true });
  assertRejected(blockedDaily, 'OFFLINE_STAGE_DAILY_CAP', '250-item daily cap');

  const summary = queryJson(`
SELECT json_build_object(
  'database', current_database(),
  'primary_resolution', (SELECT review_resolution FROM public.offline_action_receipts WHERE client_action_id = ${literal(primary.client_action_id)}::uuid),
  'race_resolution', (SELECT review_resolution FROM public.offline_action_receipts WHERE client_action_id = ${literal(race.client_action_id)}::uuid),
  'same_key_second_unresolved', (SELECT resolved_at IS NULL FROM public.offline_action_receipts WHERE client_action_id = ${literal(sameKeyB.client_action_id)}::uuid),
  'resolution_events', (SELECT count(*) FROM public.activity_feed WHERE event_type = 'offline_action_resolved'),
  'backlog_unresolved', ${Number(backlogCounts.unresolved)},
  'daily_recent', (SELECT count(*) FROM public.offline_action_receipts WHERE actor_id = ${literal(APPLICATOR_1)}::uuid AND received_at >= now() - interval '24 hours')
)::text;
`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`PASS: disposable proof database retained as ${DATABASE}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  console.error(`Disposable database retained for inspection: ${DATABASE}`);
  process.exitCode = 1;
});
