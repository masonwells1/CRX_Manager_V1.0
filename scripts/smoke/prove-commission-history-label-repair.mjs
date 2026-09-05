#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof for the forward-only commission label
 * repair and stale-recipient settlement guard. The base prover establishes
 * the real cutover fixture; this wrapper then applies the published snapshot
 * contract, replay guard, and local forward migrations.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE_PROVER = path.join(HERE, 'prove-commission-history-as-of.mjs');
const SNAPSHOT = path.join(ROOT, 'supabase', 'migrations', '20260903230000_commission_report_snapshot_contract.sql');
const REPLAY_GUARD = path.join(ROOT, 'supabase', 'migrations', '20260905020000_commission_history_report_replay_guard.sql');
const REPAIR = path.join(ROOT, 'supabase', 'migrations', '20260905020100_repair_commission_history_label_snapshots.sql');
const RECIPIENT_GUARD = path.join(ROOT, 'supabase', 'migrations', '20260905020200_refuse_stale_commission_payment_recipient.sql');
const GENERATED = path.join(HERE, `.commission-history-label-repair-${process.pid}.mjs`);

for (const required of [SNAPSHOT, REPLAY_GUARD, REPAIR, RECIPIENT_GUARD]) {
  assert.ok(readFileSync(required, 'utf8'), `missing migration: ${required}`);
}

// Evaluated inside the established base prover, sharing its isolated container,
// helper functions, and populated cutover fixture.
const continuation = `
  const snapshotSource = readFileSync(${JSON.stringify(SNAPSHOT)}, 'utf8');
  const replayGuardSource = readFileSync(${JSON.stringify(REPLAY_GUARD)}, 'utf8');
  const repairSource = readFileSync(${JSON.stringify(REPAIR)}, 'utf8');
  const recipientGuardSource = readFileSync(${JSON.stringify(RECIPIENT_GUARD)}, 'utf8');
  applySql(snapshotSource);
  applySql(replayGuardSource);
  // The base prover intentionally leaves a post/void scenario committed to
  // validate the original ledger. This repair is only eligible before the
  // first settlement, so reset that disposable scenario with trigger bypass
  // after the base proof and its replay guards have completed.
  psql(\`BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.commission_settlement_events;
UPDATE public.commission_payments
   SET status = 'unposted', posted_at = NULL, voided_at = NULL, voided_by = NULL;
SET LOCAL session_replication_role = origin;
COMMIT;\`);

  const beforeRepairLedgerCount = Number(scalar('SELECT count(*) FROM public.commission_earned_state_ledger;'));
  assert.ok(beforeRepairLedgerCount >= 3, 'base prover did not retain its opening observations');

  // The current schema fixture correctly stamps its synthetic preimage, so
  // inject one legacy-shaped opening snapshot exactly as production carried it:
  // canonical order/customer links, no denormalized labels, and no recorder
  // event. Replica mode is confined to this disposable fixture.
  psql(\`BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.commissions (
  id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES (
  'c011ec70-0000-4000-8000-000000000130', '\${cutoverPreimage.order}', '\${cutoverPreimage.customer}',
  'Commission History Prover', '\${cutoverPreimage.admin}', 100, 15, 15, DATE '2026-03-16', 'pending'
);
SET LOCAL session_replication_role = origin;
INSERT INTO public.commission_earned_state_ledger (
  commission_id, event_kind, effective_at, recorded_by,
  recipient_id, recipient_group_key, recipient_name,
  source_type, source_number, customer_name, order_date, amount_cents, is_earned
) VALUES (
  'c011ec70-0000-4000-8000-000000000130', 'baseline', clock_timestamp(), NULL,
  '\${cutoverPreimage.admin}', 'user:\${cutoverPreimage.admin}', 'Commission History Prover',
  'order', '\${cutoverPreimage.order}', '[Unknown customer]', DATE '2026-03-16', 1500, true
);
COMMIT;\`);
  assert.equal(Number(scalar(\`
    SELECT count(*)
      FROM public.commission_earned_state_ledger s
     WHERE s.commission_id = 'c011ec70-0000-4000-8000-000000000130'
       AND s.source_number = '\${cutoverPreimage.order}'
       AND s.customer_name = '[Unknown customer]'
  \`)), 1, 'fixture did not reproduce missing opening labels');

  function expectRepairFailure(sql, token, label) {
    const result = applySql(sql, { allowFailure: true });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
    assert.match(output, new RegExp(token), label + ' failed for wrong reason:\\n' + output);
    console.log('COMMISSION_HISTORY_LABEL_REPAIR_MUTATION_REJECTED ' + label);
  }

  // Prove that a widened execute grant is refused before the function can be
  // replaced. Rollback leaves the fixture and its ACL untouched.
  expectRepairFailure(\`BEGIN;
GRANT EXECUTE ON FUNCTION public.record_commission_earned_state() TO authenticated;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'recorder_acl_drift');

  expectRepairFailure(\`BEGIN;
CREATE FUNCTION public.record_commission_earned_state(p_unused integer)
RETURNS integer LANGUAGE sql AS 'SELECT p_unused';
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_recorder_shadow_overload');

  expectRepairFailure(\`BEGIN;
ALTER FUNCTION public.record_commission_earned_state() STABLE;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_recorder_volatility_drift');

  expectRepairFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger DISABLE ROW LEVEL SECURITY;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_ledger_rls_disabled');

  expectRepairFailure(\`BEGIN;
GRANT SELECT ON TABLE public.commission_earned_state_ledger TO authenticated;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_ledger_acl_drift');

  expectRepairFailure(\`BEGIN;
CREATE POLICY commission_earned_state_ledger_unexpected_select
  ON public.commission_earned_state_ledger
  FOR SELECT TO authenticated
  USING (public.is_admin());
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_ledger_extra_policy');

  expectRepairFailure(\`BEGIN;
GRANT USAGE ON SEQUENCE public.commission_earned_state_ledger_id_seq TO authenticated;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_ledger_sequence_acl_drift');

  expectRepairFailure(\`BEGIN;
ALTER TABLE public.commission_earned_state_ledger
  DISABLE TRIGGER trg_commission_earned_state_ledger_immutable;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_ledger_mutation_trigger_disabled');

  expectRepairFailure(\`BEGIN;
ALTER TABLE public.commission_settlement_events
  DISABLE TRIGGER trg_commission_settlement_events_no_truncate;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'settlement_ledger_truncate_trigger_disabled');

  expectRepairFailure(\`BEGIN;
DROP TRIGGER trg_commissions_record_earned_state ON public.commissions;
CREATE TRIGGER trg_commissions_record_earned_state
  BEFORE INSERT OR UPDATE ON public.commissions
  FOR EACH ROW EXECUTE FUNCTION public.record_commission_earned_state();
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'earned_recorder_trigger_shape');

  expectRepairFailure(\`BEGIN;
DROP TRIGGER trg_commission_payments_record_settlement_event ON public.commission_payments;
CREATE TRIGGER trg_commission_payments_record_settlement_event
  BEFORE UPDATE OF payment_number ON public.commission_payments
  FOR EACH ROW EXECUTE FUNCTION public.record_commission_settlement_event();
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'settlement_recorder_trigger_columns');

  expectRepairFailure(\`BEGIN;
DROP TRIGGER trg_commission_payments_record_settlement_event ON public.commission_payments;
CREATE TRIGGER trg_commission_payments_record_settlement_event
  BEFORE UPDATE OF status ON public.commission_payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.record_commission_settlement_event();
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'settlement_recorder_trigger_when_clause');

  expectRepairFailure(\`BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.commission_payments
   SET status = 'voided',
       voided_at = clock_timestamp(),
       voided_by = recipient_id
 WHERE id = (SELECT id FROM public.commission_payments ORDER BY id LIMIT 1);
SET LOCAL session_replication_role = origin;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_SETTLED:', 'posted_payment_without_settlement');

  // Prove the no-settlement boundary with a valid, trigger-bypassed fixture
  // settlement record. This models the only state this repair must not guess.
  expectRepairFailure(\`BEGIN;
INSERT INTO public.commission_payments (payment_number, recipient_id, total_amount, status, payment_date)
SELECT 'LABEL-REPAIR-MUTANT', recipient_user_id, 10, 'unposted', CURRENT_DATE
  FROM public.commissions
 WHERE id = '\${cutoverPreimage.activeId}';
INSERT INTO public.commission_payment_items (commission_payment_id, commission_id, amount)
SELECT p.id, '\${cutoverPreimage.activeId}', 10
  FROM public.commission_payments p
 WHERE p.payment_number = 'LABEL-REPAIR-MUTANT';
SET LOCAL session_replication_role = replica;
INSERT INTO public.commission_settlement_events (
  commission_payment_id, commission_payment_item_id, commission_id, event_kind,
  effective_at, payment_number, payment_date, recipient_id, recipient_group_key,
  recipient_name, source_type, source_number, customer_name, commission_order_date, amount_cents
)
SELECT p.id, i.id, i.commission_id, 'posted', clock_timestamp(), p.payment_number,
       p.payment_date, p.recipient_id, 'user:' || p.recipient_id::text,
       'Mutation Recipient', 'order', 'MUTANT', 'Mutation Farm', CURRENT_DATE, 1000
  FROM public.commission_payments p
  JOIN public.commission_payment_items i ON i.commission_payment_id = p.id
 WHERE p.payment_number = 'LABEL-REPAIR-MUTANT';
SET LOCAL session_replication_role = origin;
\${repairSource}
COMMIT;\`, 'COMMISSION_HISTORY_LABEL_REPAIR_SETTLED:', 'settlement_history');

  const driftedRepairPostimage = repairSource.replace(
    '  v_customer_name text;\\nBEGIN',
    '  v_customer_name text;\\nBEGIN\\n  PERFORM 1; -- MUTATION: unrelated recorder logic drift'
  );
  assert.notEqual(driftedRepairPostimage, repairSource,
    'label-repair postimage mutation did not change the recorder');
  expectRepairFailure(driftedRepairPostimage,
    'COMMISSION_HISTORY_LABEL_REPAIR_POSTCOND:', 'earned_recorder_postimage_drift');

  applySql(repairSource);
  assert.ok(Number(scalar('SELECT count(*) FROM public.commission_earned_state_ledger;')) > beforeRepairLedgerCount + 1,
    'repair did not append a corrected current observation');
  assert.equal(Number(scalar(\`
    SELECT count(*)
      FROM public.commission_earned_state_ledger s
      JOIN public.orders o ON o.id = '\${cutoverPreimage.order}'
      JOIN public.customers cu ON cu.id = '\${cutoverPreimage.customer}'
     WHERE s.commission_id = 'c011ec70-0000-4000-8000-000000000130'
       AND s.id = (
         SELECT newest.id
           FROM public.commission_earned_state_ledger newest
          WHERE newest.commission_id = s.commission_id
          ORDER BY newest.effective_at DESC, newest.id DESC
          LIMIT 1
       )
       AND s.source_number = o.order_number
       AND s.customer_name = cu.farm_name
  \`)), 1, 'repair did not make the defective latest label canonical');
  assert.equal(Number(scalar(\`
    SELECT count(*)
      FROM public.commission_earned_state_ledger
     WHERE commission_id = 'c011ec70-0000-4000-8000-000000000130'
       AND source_number = '\${cutoverPreimage.order}'
       AND customer_name = '[Unknown customer]'
  \`)), 1, 'repair rewrote immutable opening observations instead of preserving them');

  // Exercise the forward job path. It must persist JOB-* rather than its UUID.
  psql(\`INSERT INTO public.jobs (id, job_number, customer_id, job_date)
VALUES ('c011ec70-0000-4000-8000-000000000131', 'JOB-LABEL-REPAIR', '\${cutoverPreimage.customer}', CURRENT_DATE);
INSERT INTO public.commissions (
  id, job_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES (
  'c011ec70-0000-4000-8000-000000000132',
  'c011ec70-0000-4000-8000-000000000131',
  '\${cutoverPreimage.customer}', 'Commission History Prover', '\${cutoverPreimage.admin}',
  100, 25, 25, CURRENT_DATE, 'pending'
);\`);
  assert.equal(scalar(\`
    SELECT source_number || '|' || customer_name
      FROM public.commission_earned_state_ledger
     WHERE commission_id = 'c011ec70-0000-4000-8000-000000000132'
     ORDER BY effective_at DESC, id DESC
     LIMIT 1
  \`), 'JOB-LABEL-REPAIR|[PROVER] Commission History Cutover Farm',
    'future job capture did not snapshot the canonical job/customer labels');

  // A direct replay is intentionally refused: the migration engine records
  // successful files once, and accepting an arbitrary changed recorder here
  // would overwrite a later reviewed hotfix.
  expectRepairFailure(repairSource, 'COMMISSION_HISTORY_LABEL_REPAIR_DRIFT:', 'postimage_replay');

  function expectRecipientGuardFailure(sql, token, label) {
    const result = applySql(sql, { allowFailure: true });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.notEqual(result.status, 0, label + ' unexpectedly succeeded');
    assert.match(output, new RegExp(token), label + ' failed for wrong reason:\\n' + output);
    console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_MUTATION_REJECTED ' + label);
  }

  const recipientGuardLockMatches = recipientGuardSource.match(
    /LOCK TABLE public\\.commission_payments,\\s+public\\.commission_payment_items,\\s+public\\.commissions,\\s+public\\.commission_earned_state_ledger,\\s+public\\.commission_settlement_events\\s+IN SHARE ROW EXCLUSIVE MODE;/g
  );
  assert.equal(recipientGuardLockMatches?.length, 1,
    'recipient guard must carry exactly one five-table writer-drain lock');
  async function proveRecipientGuardApplyLock(lockStatement, expectedToBlock) {
    const holder = startPsql(\`BEGIN;
\${lockStatement}
SELECT pg_sleep(5);
ROLLBACK;\`);
    let writer;
    let output = '';
    const attempts = expectedToBlock ? 30 : 1;
    if (!expectedToBlock) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      writer = psql(\`BEGIN;
SET LOCAL lock_timeout = '400ms';
UPDATE public.commission_payments SET status = 'posted' WHERE false;
ROLLBACK;\`, { allowFailure: true });
      output = (writer.stdout || '') + (writer.stderr || '');
      if (!expectedToBlock || writer.status !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (expectedToBlock) {
      assert.notEqual(writer?.status, 0,
        'recipient-guard apply lock never blocked payment writers:\\n' + output + holder.output());
      assert.match(output, /canceling statement due to lock timeout/,
        'recipient-guard writer blocked for the wrong reason:\\n' + output);
    } else {
      assert.equal(writer?.status, 0,
        'weakened recipient-guard apply lock unexpectedly blocked a writer:\\n' + output);
    }
    assert.equal(await waitForExit(holder), 0, 'recipient-guard apply-lock holder failed:\\n' + holder.output());
  }
  await proveRecipientGuardApplyLock(recipientGuardLockMatches[0], true);
  await proveRecipientGuardApplyLock(
    recipientGuardLockMatches[0].replace('SHARE ROW EXCLUSIVE', 'ACCESS SHARE'),
    false
  );
  console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_MUTATION_CAUGHT weakened_apply_writer_lock');

  expectRecipientGuardFailure(\`BEGIN;
ALTER TABLE public.commission_payments DISABLE ROW LEVEL SECURITY;
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'payment_rls_disabled');

  expectRecipientGuardFailure(\`BEGIN;
CREATE POLICY commission_payments_unexpected_update
  ON public.commission_payments
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'payment_update_policy_added');

  const missingPaymentAclRevoke = recipientGuardSource.replace(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\\n' +
      '  ON TABLE public.commission_payments, public.commission_payment_items\\n' +
      '  FROM PUBLIC, anon, authenticated;',
    '-- MUTATION: legacy direct-write table grants were not revoked'
  );
  assert.notEqual(missingPaymentAclRevoke, recipientGuardSource,
    'payment ACL revoke mutation did not change the migration');
  expectRecipientGuardFailure(missingPaymentAclRevoke,
    'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'payment_direct_write_acl');

  expectRecipientGuardFailure(\`BEGIN;
ALTER TABLE public.commission_payment_items
  DROP CONSTRAINT commission_payment_items_amount_whole_cents_chk;
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'payment_item_whole_cents_constraint_missing');

  applySql(recipientGuardSource);

  const reassignedRecipient = 'c011ec70-0000-4000-8000-000000000140';
  const reassignedCommission = 'c011ec70-0000-4000-8000-000000000141';
  psql(\`BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES ('\${reassignedRecipient}', 'commission-history-recipient-b@example.test',
        jsonb_build_object('full_name', 'Commission History Recipient B', 'role', 'sales_rep'),
        now(), now());
INSERT INTO public.profiles (id, email, full_name, role, is_active)
VALUES ('\${reassignedRecipient}', 'commission-history-recipient-b@example.test',
        'Commission History Recipient B', 'sales_rep', true)
ON CONFLICT (id) DO UPDATE
  SET role = EXCLUDED.role,
      is_active = true;
SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', true);
INSERT INTO public.commissions (
  id, order_id, customer_id, recipient, recipient_user_id, split_percentage,
  commission_amount, order_profit, order_date, status
) VALUES (
  '\${reassignedCommission}', '\${cutoverPreimage.order}', '\${cutoverPreimage.customer}',
  'Commission History Prover', '\${cutoverPreimage.admin}', 100, 12.34, 12.34,
  CURRENT_DATE, 'pending'
);
INSERT INTO public.commission_payments (
  payment_number, recipient_id, total_amount, status, payment_date
) VALUES (
  'RECIPIENT-GUARD-STALE-A', '\${cutoverPreimage.admin}', 12.34, 'unposted', CURRENT_DATE
);
INSERT INTO public.commission_payment_items (commission_payment_id, commission_id, amount)
SELECT id, '\${reassignedCommission}', 12.34
  FROM public.commission_payments
 WHERE payment_number = 'RECIPIENT-GUARD-STALE-A';
UPDATE public.commissions
   SET recipient = 'Commission History Recipient B',
       recipient_user_id = '\${reassignedRecipient}'
 WHERE id = '\${reassignedCommission}';
INSERT INTO public.commission_payments (
  payment_number, recipient_id, total_amount, status, payment_date
) VALUES (
  'RECIPIENT-GUARD-CURRENT-B', '\${reassignedRecipient}', 12.34, 'unposted', CURRENT_DATE
);
INSERT INTO public.commission_payment_items (commission_payment_id, commission_id, amount)
SELECT id, '\${reassignedCommission}', 12.34
  FROM public.commission_payments
 WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B';
COMMIT;\`);

  const stalePost = psql(\`BEGIN;
SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', true);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${cutoverPreimage.admin}'
 WHERE payment_number = 'RECIPIENT-GUARD-STALE-A';
COMMIT;\`, { allowFailure: true });
  const stalePostOutput = (stalePost.stdout || '') + (stalePost.stderr || '');
  assert.notEqual(stalePost.status, 0, 'stale recipient A payment unexpectedly posted');
  assert.match(stalePostOutput, /COMMISSION_SETTLEMENT_RECIPIENT_CHANGED/,
    'stale recipient A payment failed for the wrong reason:\\n' + stalePostOutput);
  assert.equal(scalar(\`
    SELECT status || '|' || (
      SELECT count(*) FROM public.commission_settlement_events e
       WHERE e.commission_payment_id = p.id
    )
      FROM public.commission_payments p
     WHERE p.payment_number = 'RECIPIENT-GUARD-STALE-A'
  \`), 'unposted|0', 'rejected stale payment left posted state or settlement history');

  const missingRecipientGate = recipientGuardSource.replace(
    '    IF EXISTS (\\n      SELECT 1\\n        FROM public.commission_payment_items i\\n        LEFT JOIN LATERAL (',
    '    IF FALSE AND EXISTS (\\n      SELECT 1\\n        FROM public.commission_payment_items i\\n        LEFT JOIN LATERAL ('
  );
  assert.notEqual(missingRecipientGate, recipientGuardSource,
    'recipient-currentness mutation did not change the migration');
  applySql(extractFunctionStatement(missingRecipientGate, 'record_commission_settlement_event'));
  const unsafeStalePost = psql(\`BEGIN;
SELECT set_config('request.jwt.claim.sub', '\${cutoverPreimage.admin}', true);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${cutoverPreimage.admin}'
 WHERE payment_number = 'RECIPIENT-GUARD-STALE-A';
ROLLBACK;\`, { allowFailure: true });
  assert.equal(unsafeStalePost.status, 0,
    'disabled recipient-currentness gate did not expose the stale-recipient bug:\\n' +
      (unsafeStalePost.stdout || '') + (unsafeStalePost.stderr || ''));
  console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_MUTATION_CAUGHT missing_recipient_currentness_gate');
  applySql(extractFunctionStatement(recipientGuardSource, 'record_commission_settlement_event'));

  async function proveRecipientRowLock(expectedToBlock) {
    const holder = startPsql(\`BEGIN;
UPDATE public.commissions
   SET recipient = recipient
 WHERE id = '\${reassignedCommission}';
SELECT pg_sleep(5);
ROLLBACK;\`);
    let rowLockProbe;
    let rowLockProbeOutput = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      rowLockProbe = psql(\`BEGIN;
SET LOCAL lock_timeout = '400ms';
UPDATE public.commissions
   SET recipient = recipient
 WHERE id = '\${reassignedCommission}';
ROLLBACK;\`, { allowFailure: true });
      rowLockProbeOutput = (rowLockProbe.stdout || '') + (rowLockProbe.stderr || '');
      if (rowLockProbe.status !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(rowLockProbe?.status, 0,
      'holder never acquired the commission row lock:\\n' + rowLockProbeOutput + holder.output());
    assert.match(rowLockProbeOutput, /canceling statement due to lock timeout/,
      'commission row-lock probe failed for the wrong reason:\\n' + rowLockProbeOutput);
    const poster = psql(\`BEGIN;
SET LOCAL lock_timeout = '400ms';
SELECT set_config('request.jwt.claim.sub', '\${reassignedRecipient}', true);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${reassignedRecipient}'
 WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B'
 RETURNING id;
ROLLBACK;\`, { allowFailure: true });
    const output = (poster.stdout || '') + (poster.stderr || '');
    if (expectedToBlock) {
      assert.notEqual(poster.status, 0,
        'valid recipient post did not wait on the commission row lock:\\n' + output);
      assert.match(output, /canceling statement due to lock timeout/,
        'valid recipient post blocked for the wrong reason:\\n' + output);
    } else {
      assert.equal(poster.status, 0,
        'lock-free mutation should expose an unblocked post:\\n' + output);
    }
    assert.equal(await waitForExit(holder), 0, 'commission row-lock holder failed:\\n' + holder.output());
  }

  assert.equal(scalar(\`
    SELECT p.status || '|' || count(i.id)
      FROM public.commission_payments p
      LEFT JOIN public.commission_payment_items i ON i.commission_payment_id = p.id
     WHERE p.payment_number = 'RECIPIENT-GUARD-CURRENT-B'
     GROUP BY p.status
  \`), 'unposted|1', 'current-recipient concurrency fixture is incomplete');
  await proveRecipientRowLock(true);
  const missingCommissionLock = recipientGuardSource.replace(
    /    PERFORM c\\.id[\\s\\S]*?     FOR UPDATE OF c;\\n/,
    ''
  );
  assert.notEqual(missingCommissionLock, recipientGuardSource,
    'commission-row-lock mutation did not change the migration');
  applySql(extractFunctionStatement(missingCommissionLock, 'record_commission_settlement_event'));
  await proveRecipientRowLock(false);
  console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_MUTATION_CAUGHT missing_commission_row_lock');
  applySql(extractFunctionStatement(recipientGuardSource, 'record_commission_settlement_event'));

  const subcentPost = psql(\`BEGIN;
ALTER TABLE public.commission_payment_items
  DROP CONSTRAINT commission_payment_items_amount_whole_cents_chk;
SET LOCAL session_replication_role = replica;
UPDATE public.commission_payment_items i
   SET amount = 12.345
  FROM public.commission_payments p
 WHERE p.id = i.commission_payment_id
   AND p.payment_number = 'RECIPIENT-GUARD-CURRENT-B';
SET LOCAL session_replication_role = origin;
SELECT set_config('request.jwt.claim.sub', '\${reassignedRecipient}', true);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${reassignedRecipient}'
 WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B';
COMMIT;\`, { allowFailure: true });
  const subcentPostOutput = (subcentPost.stdout || '') + (subcentPost.stderr || '');
  assert.notEqual(subcentPost.status, 0, 'positive sub-cent payment item unexpectedly posted');
  assert.match(subcentPostOutput, /COMMISSION_SETTLEMENT_INVALID_ITEM_AMOUNT/,
    'positive sub-cent payment item failed for the wrong reason:\\n' + subcentPostOutput);
  assert.equal(scalar(\`
    SELECT p.status || '|' || i.amount::text
      FROM public.commission_payments p
      JOIN public.commission_payment_items i ON i.commission_payment_id = p.id
     WHERE p.payment_number = 'RECIPIENT-GUARD-CURRENT-B'
  \`), 'unposted|12.34', 'rejected sub-cent post did not roll back cleanly');
  console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_MUTATION_CAUGHT positive_subcent_item');

  const driftedRecorder = recipientGuardSource.replace(
    '  RETURN NEW;\\nEND;\\n$function$;',
    '  PERFORM 1; -- MUTATION: reviewed body drift\\n  RETURN NEW;\\nEND;\\n$function$;'
  );
  assert.notEqual(driftedRecorder, recipientGuardSource,
    'settlement-recorder body mutation did not change the migration');
  applySql(extractFunctionStatement(driftedRecorder, 'record_commission_settlement_event'));
  expectRecipientGuardFailure(recipientGuardSource,
    'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'recorder_body_drift');
  applySql(extractFunctionStatement(recipientGuardSource, 'record_commission_settlement_event'));

  expectRecipientGuardFailure(\`BEGIN;
CREATE FUNCTION public.record_commission_settlement_event(p_unused integer)
RETURNS integer LANGUAGE sql AS 'SELECT p_unused';
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'settlement_recorder_shadow_overload');

  expectRecipientGuardFailure(\`BEGIN;
CREATE OR REPLACE FUNCTION public.prevent_commission_history_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $mutant$ BEGIN PERFORM 1; RETURN OLD; END $mutant$;
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'earned_ledger_mutation_guard_body_drift');

  expectRecipientGuardFailure(\`BEGIN;
CREATE POLICY commission_earned_state_ledger_unexpected_select
  ON public.commission_earned_state_ledger
  FOR SELECT TO authenticated
  USING (public.is_admin());
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'earned_ledger_extra_policy');

  expectRecipientGuardFailure(\`BEGIN;
\${extractFunctionStatement(driftedRepairPostimage, 'record_commission_earned_state')}
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'earned_recorder_body_drift');

  expectRecipientGuardFailure(\`BEGIN;
GRANT SELECT ON TABLE public.commission_settlement_events TO authenticated;
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'settlement_ledger_acl_drift');

  expectRecipientGuardFailure(\`BEGIN;
ALTER TABLE public.commission_settlement_events
  DISABLE TRIGGER trg_commission_settlement_events_immutable;
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'settlement_ledger_mutation_trigger_disabled');

  expectRecipientGuardFailure(\`BEGIN;
DROP TRIGGER trg_commission_payments_record_settlement_event ON public.commission_payments;
CREATE TRIGGER trg_commission_payments_record_settlement_event
  BEFORE UPDATE OF status ON public.commission_payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.record_commission_settlement_event();
\${recipientGuardSource}
COMMIT;\`, 'COMMISSION_SETTLEMENT_RECIPIENT_GUARD_DRIFT:', 'settlement_recorder_trigger_when_clause');

  psql(\`BEGIN;
SELECT set_config('request.jwt.claim.sub', '\${reassignedRecipient}', true);
UPDATE public.commission_payments
   SET status = 'posted', posted_by = '\${reassignedRecipient}'
 WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B';
UPDATE public.commission_payments
   SET status = 'voided', voided_by = '\${reassignedRecipient}'
 WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B';
COMMIT;\`);
  const validSettlementHistory = scalar(\`
    SELECT string_agg(event_kind || ':' || recipient_id::text || ':' || amount_cents::text,
                      ',' ORDER BY id)
      FROM public.commission_settlement_events
     WHERE commission_payment_id = (
       SELECT id FROM public.commission_payments
        WHERE payment_number = 'RECIPIENT-GUARD-CURRENT-B'
     )
  \`);
  assert.equal(validSettlementHistory,
    'posted:' + reassignedRecipient + ':1234,voided:' + reassignedRecipient + ':-1234',
    'valid reassigned-recipient post/void did not preserve exact-cent ledger history');

  console.log('COMMISSION_HISTORY_LABEL_REPAIR_PROOF_PASS postgres=17 append_only=true opening_labels=3 future_job_label=true mutation_guards=16');
  console.log('COMMISSION_SETTLEMENT_RECIPIENT_GUARD_PROOF_PASS stale_rejected=true current_posted=true exact_cents=true void_preserved=true mutation_guards=16');
`;

try {
  let source = readFileSync(BASE_PROVER, 'utf8');
  const anchor = '  console.log(\n    `COMMISSION_HISTORY_PROOF_PASS postgres=17 baseline=${BASELINE_MANIFEST.migrations_high_water} replayed=${migrations.length}`,\n  );';
  assert.equal(source.split(anchor).length - 1, 1, 'base prover injection anchor is ambiguous');
  source = source.replace(anchor, `${continuation}\n${anchor}`);
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
