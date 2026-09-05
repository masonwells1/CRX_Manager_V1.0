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
const GENERATED = path.join(HERE, `.commission-report-snapshot-${process.pid}.mjs`);

assert.ok(readFileSync(MIGRATION, 'utf8'), `missing migration: ${MIGRATION}`);

// This continuation is evaluated inside the original prover, where psql(),
// applySql(), scalar(), copyIntoContainer(), psql and cutoverPreimage already
// refer to the same isolated PostgreSQL container and seeded admin.
const continuation = `
  // ── Snapshot follow-up: real wrapper, replay, and catalog mutations ─────
  const snapshotSource = readFileSync(${JSON.stringify(MIGRATION)}, 'utf8');
  const replayGuardSource = readFileSync(${JSON.stringify(path.join(ROOT, 'supabase', 'migrations', '20260905020000_commission_history_report_replay_guard.sql'))}, 'utf8');
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
\${query}\`).stdout.trim().split(/\\\\r?\\\\n/).pop();
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
    assert.match(output, /COMMISSION_HISTORY_REPORT_CONTRACT_DRIFT:/,
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
  console.log('COMMISSION_REPORT_SNAPSHOT_PROOF_PASS postgres=17 replay=ledger_then_snapshot mutation_guards=8');
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

try {
  let source = readFileSync(BASE_PROVER, 'utf8');
  const anchor = '      proveCutoverOpening(cutoverPreimage);';
  assert.equal(source.split(anchor).length - 1, 1, 'base prover injection anchor is ambiguous');
  source = source.replace(anchor, `${anchor}\n${continuation}`);
  writeFileSync(GENERATED, source, 'utf8');
  const result = spawnSync(process.execPath, [GENERATED], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    timeout: 900_000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try { unlinkSync(GENERATED); } catch { /* already removed */ }
}
