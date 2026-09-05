#!/usr/bin/env node
/**
 * Network-isolated proof for the commission report snapshot follow-up.
 *
 * The existing commission-history prover owns the complete baseline restore,
 * exact replay through 20260903150100, and real ledger fixture.  This wrapper
 * injects a small continuation immediately after that migration is applied,
 * then lets the original prover finish and remove the disposable container.
 * No live connection is possible: the delegated container runs --network none.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE_PROVER = path.join(HERE, 'prove-commission-history-as-of.mjs');
const SNAPSHOT = path.join(HERE, 'smoke-commission-report-snapshot-contract.sql');
const MIGRATION = path.join(
  ROOT, 'supabase', 'migrations',
  '20260903230000_commission_report_snapshot_contract.sql',
);
const LEDGER_MIGRATION = path.join(
  ROOT, 'supabase', 'migrations',
  '20260903150100_ledger_backed_commission_history.sql',
);
const GENERATED = path.join(HERE, `.commission-report-snapshot-${process.pid}.mjs`);
const NAME = `crx-commission-snapshot-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const PROOF_LABEL_KEY = 'com.croprx.commission-proof';

function cleanupTimedOutProof() {
  const listed = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=${PROOF_LABEL_KEY}=${NAME}`],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  if (listed.error || listed.status !== 0) return;
  const containerIds = (listed.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (containerIds.length > 0) {
    spawnSync('docker', ['rm', '-f', ...containerIds], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
  }
}

assert.ok(readFileSync(MIGRATION, 'utf8'), `missing migration: ${MIGRATION}`);

function extractReviewedFunction(source, signature) {
  const startMarker = `CREATE OR REPLACE FUNCTION ${signature}`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing reviewed function source: ${signature}`);
  const remainder = source.slice(start);
  const bodyMarker = remainder.match(/\nAS (\$[A-Za-z0-9_]*\$)\n/);
  assert.ok(bodyMarker, `missing reviewed function body marker: ${signature}`);
  const closingMarker = `${bodyMarker[1]};`;
  const end = remainder.indexOf(closingMarker, bodyMarker.index + bodyMarker[0].length);
  assert.notEqual(end, -1, `missing reviewed function body close: ${signature}`);
  return remainder.slice(0, end + closingMarker.length);
}

const reviewedWrapperDefinition = extractReviewedFunction(
  readFileSync(MIGRATION, 'utf8'),
  'public.get_commission_history_report(p_as_of_date date)',
);
const reviewedBalanceDefinition = extractReviewedFunction(
  readFileSync(LEDGER_MIGRATION, 'utf8'),
  'public.get_commission_balance_report(p_as_of_date date)',
);

// This continuation is evaluated inside the original prover, where psql(),
// applySql(), scalar(), copyIntoContainer(), psql and cutoverPreimage already
// refer to the same isolated PostgreSQL container and seeded admin.
const continuation = `
  // ── Snapshot follow-up: real wrapper, replay, and catalog mutations ─────
  const snapshotSource = readFileSync(${JSON.stringify(MIGRATION)}, 'utf8');
  const replayGuardSource = readFileSync(${JSON.stringify(path.join(ROOT, 'supabase', 'migrations', '20260905020000_commission_history_report_replay_guard.sql'))}, 'utf8');
  const latestRecipientLabelSource = readFileSync(${JSON.stringify(path.join(ROOT, 'supabase', 'migrations', '20260905185619_latest_commission_recipient_label.sql'))}, 'utf8');
  const snapshotSmokePath = ${JSON.stringify(SNAPSHOT)};
  copyIntoContainer(snapshotSmokePath, 'commission-report-snapshot.sql');
  applySql(snapshotSource);
  applySql(replayGuardSource);
  const originalCutover = scalar("SELECT jsonb_build_object('cutover_at', cutover_at, 'first_supported_date', first_supported_date, 'created_at', created_at)::text FROM public.commission_history_cutover WHERE singleton;");
  // The real migration deliberately starts reporting tomorrow when applied
  // today.  Move only the disposable fixture's immutable cutover observation
  // back one day so the first supported Chicago date is testable now.  Replica
  // mode suppresses the immutability trigger; CHECK constraints remain active.
  psql(\`
SET session_replication_role = replica;
UPDATE public.commission_history_cutover
   SET cutover_at = cutover_at - interval '1 day',
       created_at = created_at - interval '1 day',
       first_supported_date = first_supported_date - 1;
SET session_replication_role = origin;
DO $shift_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.commission_history_cutover
    WHERE NOT singleton
       OR first_supported_date <> ((cutover_at AT TIME ZONE 'America/Chicago')::date + 1)
       OR opening_commission_count < 0
       OR length(opening_commission_digest) <> 32
       OR opening_commission_digest !~ '^[0-9a-f]{32}'
       OR created_at <> cutover_at
  ) OR (SELECT count(*) FROM public.commission_history_cutover) <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_REPORT_SNAPSHOT_FIXTURE_CUTOVER_CHECK_FAIL';
  END IF;
END
$shift_check$;
\`);
  const asOfDate = scalar('SELECT first_supported_date FROM public.commission_history_cutover WHERE singleton;');
  const adminClaims = \`SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', false);\n\\\\set as_of_date '\${asOfDate}'\n\\\\i /tmp/commission-report-snapshot.sql\`;
  const firstSnapshot = psql(adminClaims, { allowFailure: true });
  const firstSnapshotOutput = (firstSnapshot.stdout || '') + (firstSnapshot.stderr || '');
  assert.equal(firstSnapshot.status, 0, 'snapshot wrapper SQL failed:\\n' + firstSnapshotOutput);
  assert.match(firstSnapshotOutput, /COMMISSION_REPORT_SNAPSHOT_RESULT_PASS/);
  assert.match(firstSnapshotOutput, /COMMISSION_REPORT_SNAPSHOT_RECONCILIATION_PASS/);
  assert.match(firstSnapshotOutput, /COMMISSION_REPORT_SNAPSHOT_CATALOG_PASS/);
  console.log('COMMISSION_REPORT_SNAPSHOT_REAL_PATH_PASS wrapper=true arrays_reconciled=true');

  const adminScalar = (query) => psql(\`\\\\pset format unaligned
\\\\pset tuples_only on
SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', false);
\${query}\`).stdout.trim().split(/\\r?\\n/).pop();
  const beforeReplay = adminScalar(\`SELECT public.get_commission_history_report(DATE '\${asOfDate}')::text;\`);
  applySql(snapshotSource);
  applySql(replayGuardSource);
  const afterReplay = adminScalar(\`SELECT public.get_commission_history_report(DATE '\${asOfDate}')::text;\`);
  assert.equal(afterReplay, beforeReplay, 'identical snapshot migration replay changed report output');
  console.log('COMMISSION_REPORT_SNAPSHOT_REPLAY_PASS output_unchanged=true');

  function expectSnapshotFailure(sql, label) {
    const result = applySql(sql, { allowFailure: true });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
    assert.match(output, /COMMISSION_HISTORY_SCHEMA_DRIFT:/, label + ' failed for wrong reason:\\n' + output);
    console.log('COMMISSION_REPORT_SNAPSHOT_MUTATION_REJECTED ' + label);
  }

  function expectReplayGuardFailure(sql, label) {
    const result = applySql(sql, { allowFailure: true });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
    assert.match(output, /COMMISSION_HISTORY_REPORT_(?:CONTRACT|DEPENDENCY)_DRIFT:/,
      label + ' failed for wrong reason:\\n' + output);
    console.log('COMMISSION_REPORT_SNAPSHOT_MUTATION_REJECTED ' + label);
  }

  expectSnapshotFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger ALTER COLUMN recipient_name DROP NOT NULL;
\${snapshotSource}
COMMIT;\`, 'earned_nullable');
  expectSnapshotFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger ALTER COLUMN created_at SET DEFAULT now();
\${snapshotSource}
COMMIT;\`, 'earned_default_drift');
  expectSnapshotFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger ALTER COLUMN id DROP IDENTITY;
\${snapshotSource}
COMMIT;\`, 'earned_identity_drift');
  expectSnapshotFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger DROP CONSTRAINT commission_earned_state_ledger_commission_id_fkey;
ALTER TABLE public.commission_earned_state_ledger
  ADD CONSTRAINT commission_earned_state_ledger_commission_id_fkey FOREIGN KEY (commission_id) REFERENCES public.commissions(id);
\${snapshotSource}
COMMIT;\`, 'earned_wrong_fk');
  const languageDrift = psql(\`BEGIN;
CREATE OR REPLACE FUNCTION public.get_commission_history_report(p_as_of_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS 'BEGIN RETURN ''{}''::jsonb; END';
\${adminClaims}
ROLLBACK;\`, { allowFailure: true });
  const languageDriftOutput = (languageDrift.stdout || '') + (languageDrift.stderr || '');
  assert.notEqual(languageDrift.status, 0, 'sql_language_drift unexpectedly passed smoke');
  assert.match(languageDriftOutput, /COMMISSION_REPORT_SNAPSHOT_CATALOG_FAIL: language or ACL/,
    'sql_language_drift failed for wrong reason:\\n' + languageDriftOutput);
  console.log('COMMISSION_REPORT_SNAPSHOT_MUTATION_REJECTED sql_language_drift');
  expectReplayGuardFailure(\`BEGIN;
CREATE FUNCTION public.get_commission_history_report(p_as_of_date text)
RETURNS jsonb
LANGUAGE sql
AS 'SELECT ''{}''::jsonb';
\${replayGuardSource}
COMMIT;\`, 'shadow_overload');
  expectReplayGuardFailure(\`BEGIN;
GRANT EXECUTE ON FUNCTION public.get_commission_history_report(date) TO anon;
\${replayGuardSource}
COMMIT;\`, 'unexpected_anon_grantee');
  expectReplayGuardFailure(\`BEGIN;
GRANT EXECUTE ON FUNCTION public.get_commission_history_report(date) TO authenticated WITH GRANT OPTION;
\${replayGuardSource}
COMMIT;\`, 'authenticated_grant_option');
  expectReplayGuardFailure(\`BEGIN;
ALTER FUNCTION public.get_commission_history_report(date) COST 321;
\${replayGuardSource}
COMMIT;\`, 'wrapper_cost_drift');
  const wrapperDefinition = ${JSON.stringify(reviewedWrapperDefinition)};
  const wrapperDefaultDrift = wrapperDefinition.replace(
    'p_as_of_date date)',
    'p_as_of_date date DEFAULT CURRENT_DATE)',
  );
  assert.notEqual(wrapperDefaultDrift, wrapperDefinition,
    'wrapper default-argument mutation could not alter the reviewed signature');
  expectReplayGuardFailure(\`BEGIN;
\${wrapperDefaultDrift}
\${replayGuardSource}
COMMIT;\`, 'wrapper_default_argument_drift');
  expectReplayGuardFailure(\`BEGIN;
CREATE FUNCTION public.get_commission_balance_report(p_as_of_date text)
RETURNS text
LANGUAGE sql
AS 'SELECT p_as_of_date';
\${replayGuardSource}
COMMIT;\`, 'child_shadow_overload');
  const balanceDefinition = ${JSON.stringify(reviewedBalanceDefinition)};
  const balanceBodyDrift = balanceDefinition.replace(
    'PERFORM public.require_admin();',
    'PERFORM 1;',
  );
  assert.notEqual(balanceBodyDrift, balanceDefinition,
    'child body mutation could not remove the reviewed admin gate');
  expectReplayGuardFailure(\`BEGIN;
\${balanceBodyDrift}
\${replayGuardSource}
COMMIT;\`, 'child_balance_body_drift');
  expectReplayGuardFailure(\`BEGIN;
GRANT EXECUTE ON FUNCTION public.get_commission_payment_detail_report(date) TO anon;
\${replayGuardSource}
COMMIT;\`, 'child_unexpected_anon_grantee');
  expectReplayGuardFailure(\`BEGIN;
ALTER FUNCTION public.get_commission_balance_report(date) SECURITY INVOKER;
\${replayGuardSource}
COMMIT;\`, 'child_security_invoker');
  expectReplayGuardFailure(\`BEGIN;
ALTER FUNCTION public.get_commission_payment_detail_report(date) SET search_path TO public;
\${replayGuardSource}
COMMIT;\`, 'child_search_path_drift');
  console.log('COMMISSION_REPORT_SNAPSHOT_PROOF_PASS postgres=17 replay=ledger_then_snapshot mutation_guards=15');

  // ── Latest recipient label: earned and paid-only real paths ─────────────
  applySql(latestRecipientLabelSource);
  const latestLabelReportBeforeReplay = adminScalar(
    \`SELECT public.get_commission_history_report(DATE '\${asOfDate}')::text;\`,
  );
  applySql(latestRecipientLabelSource);
  const latestLabelReportAfterReplay = adminScalar(
    \`SELECT public.get_commission_history_report(DATE '\${asOfDate}')::text;\`,
  );
  assert.equal(latestLabelReportAfterReplay, latestLabelReportBeforeReplay,
    'latest-recipient-label migration replay changed the report');

  const earnedRecipient = 'c011ec70-0000-4000-8000-000000000201';
  const paidRecipient = 'c011ec70-0000-4000-8000-000000000202';
  const latestLabelFixture = \`
BEGIN;
SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', true);
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('\${earnedRecipient}', 'earned-label@example.test', jsonb_build_object('full_name', 'Zulu Earned New', 'role', 'sales_rep'), now(), now()),
  ('\${paidRecipient}', 'paid-label@example.test', jsonb_build_object('full_name', 'Zulu Paid New', 'role', 'sales_rep'), now(), now());
INSERT INTO public.profiles (id, email, full_name, role, is_active)
VALUES
  ('\${earnedRecipient}', 'earned-label@example.test', 'Zulu Earned New', 'sales_rep', true),
  ('\${paidRecipient}', 'paid-label@example.test', 'Zulu Paid New', 'sales_rep', true)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active;

INSERT INTO public.commissions (
  id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES
  ('c011ec70-0000-4000-8000-000000000211', '\${cutoverPreimage.order}', '\${cutoverPreimage.customer}', 'Alpha Earned Old', '\${earnedRecipient}', 100, 10, 10, DATE '\${asOfDate}', 'pending'),
  ('c011ec70-0000-4000-8000-000000000212', '\${cutoverPreimage.order}', '\${cutoverPreimage.customer}', 'Zulu Earned New', '\${earnedRecipient}', 100, 20, 20, DATE '\${asOfDate}', 'pending'),
  ('c011ec70-0000-4000-8000-000000000213', '\${cutoverPreimage.order}', '\${cutoverPreimage.customer}', 'Alpha Paid Old', '\${paidRecipient}', 100, 15, 15, DATE '\${asOfDate}', 'pending');

INSERT INTO public.commission_payments (
  id, payment_number, recipient_id, total_amount, status, payment_date
) VALUES (
  'c011ec70-0000-4000-8000-000000000214',
  'PROVER-LATEST-PAID-LABEL', '\${paidRecipient}', 15, 'unposted', DATE '\${asOfDate}'
);
INSERT INTO public.commission_payment_items (
  commission_payment_id, commission_id, amount
) VALUES (
  'c011ec70-0000-4000-8000-000000000214',
  'c011ec70-0000-4000-8000-000000000213', 15
);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${cutoverPreimage.admin}'
 WHERE id = 'c011ec70-0000-4000-8000-000000000214';
UPDATE public.commissions
   SET deleted_at = clock_timestamp()
 WHERE id = 'c011ec70-0000-4000-8000-000000000213';
UPDATE public.commissions
   SET recipient = 'Zulu Paid New'
 WHERE id = 'c011ec70-0000-4000-8000-000000000213';

DO $latest_label_proof$
DECLARE
  v_earned record;
  v_paid record;
BEGIN
  SELECT * INTO STRICT v_earned
  FROM public.get_commission_balance_report(DATE '\${asOfDate}')
  WHERE recipient_id = '\${earnedRecipient}'::uuid;
  IF v_earned.recipient_name IS DISTINCT FROM 'Zulu Earned New'
     OR v_earned.total_earned IS DISTINCT FROM 30::numeric
     OR v_earned.total_paid IS DISTINCT FROM 0::numeric
     OR v_earned.outstanding_balance IS DISTINCT FROM 30::numeric
     OR v_earned.pending_count IS DISTINCT FROM 2::bigint
     OR v_earned.paid_count IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'LATEST_RECIPIENT_LABEL_EARNED_FAIL: %', row_to_json(v_earned);
  END IF;

  SELECT * INTO STRICT v_paid
  FROM public.get_commission_balance_report(DATE '\${asOfDate}')
  WHERE recipient_id = '\${paidRecipient}'::uuid;
  IF v_paid.recipient_name IS DISTINCT FROM 'Zulu Paid New'
     OR v_paid.total_earned IS DISTINCT FROM 0::numeric
     OR v_paid.total_paid IS DISTINCT FROM 15::numeric
     OR v_paid.outstanding_balance IS DISTINCT FROM (-15)::numeric
     OR v_paid.pending_count IS DISTINCT FROM 0::bigint
     OR v_paid.paid_count IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'LATEST_RECIPIENT_LABEL_PAID_ONLY_FAIL: %', row_to_json(v_paid);
  END IF;
END
$latest_label_proof$;

SET LOCAL session_replication_role = replica;
DELETE FROM public.commission_earned_state_ledger
 WHERE commission_id = 'c011ec70-0000-4000-8000-000000000213';
SET LOCAL session_replication_role = origin;

DO $settlement_fallback_proof$
DECLARE
  v_paid record;
BEGIN
  SELECT * INTO STRICT v_paid
  FROM public.get_commission_balance_report(DATE '\${asOfDate}')
  WHERE recipient_id = '\${paidRecipient}'::uuid;
  IF v_paid.recipient_name IS DISTINCT FROM 'Alpha Paid Old'
     OR v_paid.total_earned IS DISTINCT FROM 0::numeric
     OR v_paid.total_paid IS DISTINCT FROM 15::numeric
     OR v_paid.outstanding_balance IS DISTINCT FROM (-15)::numeric
     OR v_paid.pending_count IS DISTINCT FROM 0::bigint
     OR v_paid.paid_count IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'LATEST_RECIPIENT_LABEL_SETTLEMENT_FALLBACK_FAIL: %', row_to_json(v_paid);
  END IF;
END
$settlement_fallback_proof$;
\\\\echo COMMISSION_REPORT_LATEST_RECIPIENT_LABEL_PASS earned=true paid_only=true settlement_fallback=true replay=true
ROLLBACK;
\`;
  const latestLabelProof = psql(latestLabelFixture, { allowFailure: true });
  const latestLabelProofOutput = (latestLabelProof.stdout || '') + (latestLabelProof.stderr || '');
  assert.equal(latestLabelProof.status, 0,
    'latest recipient label real-path proof failed:\\n' + latestLabelProofOutput);
  assert.match(latestLabelProofOutput, /COMMISSION_REPORT_LATEST_RECIPIENT_LABEL_PASS/);
  console.log('COMMISSION_REPORT_LATEST_RECIPIENT_LABEL_REAL_PATH_PASS earned=true paid_only=true settlement_fallback=true replay=true');

  const latestLabelFunction = extractFunctionStatement(
    latestRecipientLabelSource,
    'get_commission_balance_report',
  );
  const oldestEarnedLabelMutation = latestLabelFunction.replace(
    'ORDER BY s.recipient_group_key, s.effective_at DESC, s.id DESC',
    'ORDER BY s.recipient_group_key, s.effective_at ASC, s.id ASC',
  );
  assert.notEqual(oldestEarnedLabelMutation, latestLabelFunction,
    'latest earned label ordering mutation did not change the function');
  applySql(oldestEarnedLabelMutation);
  const staleLabelProof = psql(latestLabelFixture, { allowFailure: true });
  const staleLabelOutput = (staleLabelProof.stdout || '') + (staleLabelProof.stderr || '');
  assert.notEqual(staleLabelProof.status, 0,
    'oldest-label mutation unexpectedly passed the latest-label fixture');
  assert.match(staleLabelOutput,
    /LATEST_RECIPIENT_LABEL_(EARNED|PAID_ONLY)_FAIL/,
    'oldest-label mutation failed for the wrong reason:\\n' + staleLabelOutput);
  applySql(latestLabelFunction);
  console.log('COMMISSION_REPORT_LATEST_RECIPIENT_LABEL_MUTATION_REJECTED oldest_earned_label');
  // The delegated base prover later replays the already-live ledger migration,
  // whose fail-closed contract accepts only its own reviewed report body. Restore
  // that preimage after this scoped forward-migration proof so the inherited
  // replay test remains meaningful and unchanged.
  applySql(balanceDefinition);

  psql(\`
SET session_replication_role = replica;
UPDATE public.commission_history_cutover
   SET cutover_at = cutover_at + interval '1 day',
       created_at = created_at + interval '1 day',
       first_supported_date = first_supported_date + 1;
SET session_replication_role = origin;
\`);
  assert.equal(scalar("SELECT jsonb_build_object('cutover_at', cutover_at, 'first_supported_date', first_supported_date, 'created_at', created_at)::text FROM public.commission_history_cutover WHERE singleton;"), originalCutover, 'fixture cutover restore drifted');
`;

let result;
try {
  let source = readFileSync(BASE_PROVER, 'utf8');
  const anchor = '      proveCutoverOpening(cutoverPreimage);';
  assert.equal(source.split(anchor).length - 1, 1, 'base prover injection anchor is ambiguous');
  source = source.replace(anchor, `${anchor}\n${continuation}`);
  writeFileSync(GENERATED, source, 'utf8');
  result = spawnSync(process.execPath, [GENERATED], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 900_000,
    env: { ...process.env, CRX_COMMISSION_PROOF_NAME: NAME },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (result?.error?.code === 'ETIMEDOUT') cleanupTimedOutProof();
  try { unlinkSync(GENERATED); } catch { /* already removed */ }
}
