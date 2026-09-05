#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof for the forward-only commission label
 * repair. The base prover establishes the real cutover fixture; this wrapper
 * then applies the published snapshot/replay guards and the local repair.
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
const GENERATED = path.join(HERE, `.commission-history-label-repair-${process.pid}.mjs`);

for (const required of [SNAPSHOT, REPLAY_GUARD, REPAIR]) {
  assert.ok(readFileSync(required, 'utf8'), `missing migration: ${required}`);
}

// Evaluated inside the established base prover, sharing its isolated container,
// helper functions, and populated cutover fixture.
const continuation = `
  const snapshotSource = readFileSync(${JSON.stringify(SNAPSHOT)}, 'utf8');
  const replayGuardSource = readFileSync(${JSON.stringify(REPLAY_GUARD)}, 'utf8');
  const repairSource = readFileSync(${JSON.stringify(REPAIR)}, 'utf8');
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
  console.log('COMMISSION_HISTORY_LABEL_REPAIR_PROOF_PASS postgres=17 append_only=true opening_labels=3 future_job_label=true mutation_guards=6');
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
