#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof that the parked commission migration set
 * survives SETTLED data in its REAL filename order.
 *
 * The defect this guards against: 20260908130000_repair_commission_history_label_snapshots
 * (formerly 20260905020100, then 20260905190000) correctly refuses to run once any
 * commission payment has been posted, and the filename-ordered runner
 * (scripts/list-post-baseline-migrations.mjs) halts at the first failing file. At its
 * old position that refusal would have stopped
 * 20260905200200_refuse_stale_commission_payment_recipient — the payout money-safety
 * guard — and every later file from ever installing.
 *
 * A second ordering hazard, found 2026-09-05 evening: the ordering guard the apply path
 * runs (checkMigrationOrdering) refuses any file stamped older than the newest APPLIED
 * ledger row. #606 landed live that day as version 20260905185938 under a bare name, so
 * the five surviving files then stamped 20260905020000..185619 would each have been refused.
 * (The former standalone 020500 was superseded before apply by the unified 020400 cutover.)
 * The original six-file set was restamped on 2026-09-05; five remain at
 * 20260905200000..200600 while the deliberately-last repair is now 20260908130000.
 * The LEDGER phase below proves the current names against the captured live boundary
 * and keeps the old names as a negative control.
 *
 * What this proves, in one disposable container seeded by the commission-history
 * base prover (which leaves REAL posted/voided settlement history behind):
 *   PLAN      the enumerated plan puts the recipient guard before the repair and the
 *             repair last (checked statically, before Docker starts)
 *   CONTROL   the OLD order (repair right after the replay guard) halts at the repair
 *             and the recipient guard never installs — the harness sees the defect
 *   ROLLOUT   the REAL order, applied file by file with per-file commits exactly as
 *             the runner does, installs every file through the intent wrapper, leaves the
 *             recipient guard's recorder body + trigger in place, and refuses ONLY the
 *             repair, as the final file, with COMMISSION_HISTORY_LABEL_REPAIR_SETTLED
 *   PIN       narrowing the repair's settlement-recorder pin back to the single
 *             pre-200200 body makes it fail with ..._DRIFT after the guard — the
 *             widened pin is load-bearing, not decorative
 *   REPLAY    after 200600 replaces the balance report, replaying 200000 succeeds;
 *             removing either the successor body or comment pin makes it fail
 *   TAIL      once the settled data is gone the repair still applies AFTER the guard
 *             (post-200200 recorder body) and installs its own recorder body
 *   LEDGER    the proof pins the current live high-water and refuses to call the five
 *             older-stamp candidates apply-ready; only the later wrapper and repair
 *             currently clear ordering, and they still depend on the parked files first
 *
 * Every file in the seven named parked commission candidates is asserted wrappable
 * (the real single-transaction delivery path) before it is applied. The separate
 * parked next-invoice-number prerequisite is also asserted wrappable here before
 * this full-plan harness executes it; its independent prover owns its behavior.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE_PROVER = path.join(HERE, 'prove-commission-history-as-of.mjs');
const LEDGER_MIGRATION = '20260903150100_ledger_backed_commission_history.sql';
const REPLAY_GUARD = '20260905200000_commission_history_report_replay_guard.sql';
const RECIPIENT_GUARD = '20260905200200_refuse_stale_commission_payment_recipient.sql';
const PAYMENT_DATE_GUARD = '20260905200300_enforce_commission_payment_business_date.sql';
const CHICAGO_DATE_CUTOVER = '20260905200400_commission_dates_follow_chicago_business_day.sql';
const TRANSFER_INTENT = '20260908120000_bind_transfer_invoice_intent.sql';
const REPAIR = '20260908130000_repair_commission_history_label_snapshots.sql';
const LABEL_FIX = '20260905200600_latest_commission_recipient_label.sql';
const NEXT_INVOICE_YEAR = '20260905090000_next_invoice_number_year_chicago.sql';
const PARKED_COMMISSION_NAMES = [
  REPLAY_GUARD,
  RECIPIENT_GUARD,
  PAYMENT_DATE_GUARD,
  CHICAGO_DATE_CUTOVER,
  LABEL_FIX,
  TRANSFER_INTENT,
  REPAIR,
];
const WRAPPABLE_PLAN_NAMES = [...PARKED_COMMISSION_NAMES, NEXT_INVOICE_YEAR];

// The newest APPLIED authored name as read live on 2026-09-08 (ledger version
// 20260908045843). The ordering guard compares authored names, not apply-time versions.
// Pinned so the LEDGER phase never abstains when the gitignored snapshot is absent (CI); when
// the snapshot is present it is unioned in, so the bar can only rise, never fall.
const LIVE_HIGH_WATER_ROW = '20260906120000_preview_field_app_season_follows_invoice_date';
// The names the parked set carried before the 2026-09-05 evening renumber — the
// negative control for the LEDGER phase. All six now sort below the row above.
const PRE_RENUMBER_NAMES = [
  '20260905020000_commission_history_report_replay_guard.sql',
  '20260905020200_refuse_stale_commission_payment_recipient.sql',
  '20260905020300_enforce_commission_payment_business_date.sql',
  '20260905020400_commission_dates_follow_chicago_business_day.sql',
  '20260905185619_latest_commission_recipient_label.sql',
  '20260905190000_repair_commission_history_label_snapshots.sql',
];
const CURRENTLY_STALE_NAMES = [
  REPLAY_GUARD,
  RECIPIENT_GUARD,
  PAYMENT_DATE_GUARD,
  CHICAGO_DATE_CUTOVER,
  LABEL_FIX,
];

// md5(prosrc) pins, named after the file that installs each body.
const SETTLEMENT_RECORDER_LIVE = 'feb0f260fd2ad9e2945f761e93e9a3dc';   // pre-200200
const SETTLEMENT_RECORDER_GUARD = '9054ce6c57f3e985e2b044385e07a6cd';  // installed by 200200
const EARNED_RECORDER_LIVE = 'dc0577e8e694773e75a1c8099819ba6c';       // pre-repair
const EARNED_RECORDER_REPAIRED = '5623b0d31181d357b303a36e563a77aa';   // installed by the repair
const BALANCE_REPORT_LIVE = '3edbcba030a9d5d0a106eeb9bf5a6635';         // pre-200600
const BALANCE_REPORT_LATEST_LABEL = 'a302d0f87ca84794ceb9c815a073f77f'; // installed by 200600
const BALANCE_REPORT_LIVE_COMMENT_SQL = "Admin-only exact commission earned, paid, and outstanding balances from the immutable cutover''s first complete Chicago day through Chicago-today; earlier dates fail closed because pre-cutover earned-state history is unavailable.";
const BALANCE_REPORT_LATEST_COMMENT = 'Admin-only exact commission earned, paid, and outstanding balances with the latest ledgered recipient label at the requested supported Chicago business-date cutoff.';

const GENERATED = path.join(HERE, `.commission-migration-plan-order-${process.pid}.mjs`);
const NAME = `crx-commission-plan-order-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
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

// ── PLAN: the real enumerator, the real order, checked before any container starts ──
function enumeratePlan() {
  const listed = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `could not enumerate the plan:\n${listed.stderr || listed.stdout}`);
  return listed.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^supabase\/migrations\/\d{14}_[^/]+\.sql$/.test(line))
    .map((relative) => path.join(ROOT, relative));
}

const plan = enumeratePlan();
const planNames = plan.map((local) => path.basename(local));
const ledgerIndex = planNames.indexOf(LEDGER_MIGRATION);
assert.notEqual(ledgerIndex, -1, `${LEDGER_MIGRATION} is absent from the plan`);
// Everything the runner would apply after the base prover's candidate, in order.
const trailing = plan.slice(ledgerIndex + 1);
const trailingNames = trailing.map((local) => path.basename(local));
const guardIndex = trailingNames.indexOf(RECIPIENT_GUARD);
const repairIndex = trailingNames.indexOf(REPAIR);
const replayGuardIndex = trailingNames.indexOf(REPLAY_GUARD);
assert.notEqual(guardIndex, -1, `${RECIPIENT_GUARD} is absent from the plan`);
assert.notEqual(repairIndex, -1, `${REPAIR} is absent from the plan`);
assert.notEqual(replayGuardIndex, -1, `${REPLAY_GUARD} is absent from the plan`);
assert.ok(guardIndex < repairIndex,
  `ORDERING DEFECT: ${RECIPIENT_GUARD} must sort before ${REPAIR}; a settled-data refusal would halt the payout guard`);
// This asserts the PLAN SHAPE, not only the invariant: the repair must be the final
// file so its settled-data refusal halts nothing. If a future migration is stamped
// after the repair, the right fix is to renumber the repair past it again (it is a
// cosmetic label repair that can always run last) — NOT to move this assertion.
assert.equal(repairIndex, trailingNames.length - 1,
  `${REPAIR} must be the LAST file in the plan so its settled-data refusal halts nothing else; plan tail: ${trailingNames.slice(-3).join(', ')}`);
assert.ok(trailingNames.indexOf(LABEL_FIX) < repairIndex, `${LABEL_FIX} must precede ${REPAIR}`);
console.log(`COMMISSION_PLAN_ORDER_STATIC_PASS trailing=${trailingNames.length} guard_index=${guardIndex} repair_index=${repairIndex} order=${trailingNames.join(',')}`);

// ── LEDGER: pin current ordering truth; this parked set is not apply-ready ──
// migration-apply-lib.mjs calls checkMigrationOrdering with the applied ledger names
// and refuses any file whose 14-digit stamp is older than the newest applied stamp.
// The pinned live row is always in the applied set; the gitignored local snapshot is
// unioned in when present, so the check can only ever get stricter, never looser.
const { checkMigrationOrdering } = await import(
  pathToFileURL(path.join(ROOT, '.claude', 'hooks', 'migration-ordering-lib.mjs')).href
);
let appliedNames = [LIVE_HIGH_WATER_ROW];
const appliedSnapshot = path.join(ROOT, '.claude', 'session-state', 'applied-migrations.json');
if (existsSync(appliedSnapshot)) {
  const snapshot = JSON.parse(readFileSync(appliedSnapshot, 'utf8'));
  if (Array.isArray(snapshot.applied)) appliedNames = appliedNames.concat(snapshot.applied);
}
const parkedNames = trailingNames.filter((name) => PARKED_COMMISSION_NAMES.includes(name));
assert.equal(parkedNames.length, PRE_RENUMBER_NAMES.length + 1,
  `parked set is ${parkedNames.length} files but the historical negative control lists ${PRE_RENUMBER_NAMES.length} original files`);
// Negative control first: the SAME guard against the SAME ledger refuses the old names.
const refusedBefore = PRE_RENUMBER_NAMES.filter((name) => checkMigrationOrdering({ name, sql: '', appliedNames }).ok === false);
assert.deepEqual(refusedBefore, PRE_RENUMBER_NAMES,
  `negative control: expected every pre-renumber name to fail the current ordering bar; refused ${refusedBefore.join(', ')}`);
const refusedCurrent = [];
const clearCurrent = [];
for (const name of parkedNames) {
  const sql = readFileSync(trailing[trailingNames.indexOf(name)], 'utf8');
  assert.ok(!/ordering-guard:\s*intentional-replay/i.test(sql), `${name} must not lean on the intentional-replay marker`);
  const verdict = checkMigrationOrdering({ name, sql, appliedNames });
  (verdict.ok && !verdict.abstained ? clearCurrent : refusedCurrent).push(name);
}
assert.deepEqual(refusedCurrent, CURRENTLY_STALE_NAMES,
  `current ordering guard refused an unexpected candidate set: ${refusedCurrent.join(', ')}`);
assert.deepEqual(clearCurrent, [TRANSFER_INTENT, REPAIR],
  `only the later wrapper and repair should clear current ordering: ${clearCurrent.join(', ')}`);
const ledgerHighWater = checkMigrationOrdering({ name: parkedNames[0], sql: '', appliedNames }).newestApplied;
assert.equal(ledgerHighWater, LIVE_HIGH_WATER_ROW.slice(0, 14),
  `ledger high-water moved: expected ${LIVE_HIGH_WATER_ROW.slice(0, 14)}, guard reports ${ledgerHighWater}; re-read live and re-stamp if needed`);
console.log(`COMMISSION_PLAN_ORDER_LEDGER_PASS high_water=${ledgerHighWater} refused_current=${refusedCurrent.length} clear_current=${clearCurrent.length} applied_rows=${appliedNames.length}`);

// The old order the defect lived in: the repair immediately after the replay guard.
const oldOrderNames = [REPLAY_GUARD, REPAIR];
for (const name of trailingNames) {
  if (PARKED_COMMISSION_NAMES.includes(name) && !oldOrderNames.includes(name)) oldOrderNames.push(name);
}
assert.equal(oldOrderNames.indexOf(REPAIR), 1, 'old-order reconstruction lost the defect position');
assert.ok(oldOrderNames.indexOf(REPAIR) < oldOrderNames.indexOf(RECIPIENT_GUARD),
  'old-order reconstruction must place the repair before the recipient guard');

// Pins named above must actually be what the files carry; a silent re-pin elsewhere
// would otherwise let this proof pass on stale constants.
const repairSourceOnDisk = readFileSync(trailing[repairIndex], 'utf8');
const guardSourceOnDisk = readFileSync(trailing[guardIndex], 'utf8');
assert.ok(repairSourceOnDisk.includes(`'${SETTLEMENT_RECORDER_LIVE}'`) && repairSourceOnDisk.includes(`'${SETTLEMENT_RECORDER_GUARD}'`),
  'repair must pin BOTH settlement-recorder bodies');
assert.ok(repairSourceOnDisk.includes(`'${EARNED_RECORDER_REPAIRED}'`), 'repair postflight pin drifted');
assert.ok(guardSourceOnDisk.includes(`'${SETTLEMENT_RECORDER_GUARD}'`), 'recipient guard postflight pin drifted');
assert.ok(guardSourceOnDisk.includes(`'${EARNED_RECORDER_LIVE}'`) && guardSourceOnDisk.includes(`'${EARNED_RECORDER_REPAIRED}'`),
  'recipient guard must accept both earned-recorder bodies');

// Evaluated inside the established base prover, sharing its isolated container,
// helper functions (psql, applySql, scalar), and populated cutover fixture. The
// base prover leaves a REAL post + void settlement scenario committed, which is
// exactly the settled data this proof needs.
const continuation = `
  // ── Plan-order continuation ─────────────────────────────────────────────
  const { pathToFileURL: planOrderFileUrl } = await import('node:url');
  const { assertWrappable: planOrderAssertWrappable } = await import(
    planOrderFileUrl(${JSON.stringify(path.join(ROOT, '.claude', 'hooks', 'migration-wrappability-lib.mjs'))}).href
  );
  const planOrderTrailing = ${JSON.stringify(trailing)};
  const planOrderOldOrder = ${JSON.stringify(oldOrderNames)};
  const planOrderCommissionNames = new Set(${JSON.stringify(PARKED_COMMISSION_NAMES)});
  const planOrderWrappableNames = new Set(${JSON.stringify(WRAPPABLE_PLAN_NAMES)});
  const planOrderSources = new Map();
  for (const local of planOrderTrailing) {
    const name = path.basename(local);
    const text = readFileSync(local, 'utf8').replace(/\\r\\n/g, '\\n');
    if (planOrderWrappableNames.has(name)) {
      // Asserted, never branched on: a parked file must take the real -1 path.
      planOrderAssertWrappable(text, name);
    }
    planOrderSources.set(name, text);
  }

  const bodyMd5 = (signature) => scalar(
    "SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = '" + signature + "'::regprocedure"
  );
  const settlementRecorderMd5 = () => bodyMd5('public.record_commission_settlement_event()');
  const earnedRecorderMd5 = () => bodyMd5('public.record_commission_earned_state()');
  const settlementTriggerAttached = () => scalar(\`
    SELECT count(*)::text
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.commission_payments'::regclass
       AND t.tgname = 'trg_commission_payments_record_settlement_event'
       AND t.tgfoid = 'public.record_commission_settlement_event()'::regprocedure
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  \`);

  assert.equal(settlementRecorderMd5(), ${JSON.stringify(SETTLEMENT_RECORDER_LIVE)},
    'container does not start from the live settlement recorder body');
  assert.equal(earnedRecorderMd5(), ${JSON.stringify(EARNED_RECORDER_LIVE)},
    'container does not start from the live earned recorder body');
  assert.equal(bodyMd5('public.get_commission_balance_report(date)'), ${JSON.stringify(BALANCE_REPORT_LIVE)},
    'container does not start from the live balance report body');

  // Settled data: the base prover's real post/void scenario. Assert it rather than
  // assume it — if the base fixture ever stops leaving settlement history, this
  // proof must fail loudly instead of proving the happy path by accident.
  const settlementEvents = Number(scalar('SELECT count(*) FROM public.commission_settlement_events;'));
  const settledPayments = Number(scalar(\`
    SELECT count(*) FROM public.commission_payments
     WHERE status <> 'unposted' OR posted_at IS NOT NULL OR voided_at IS NOT NULL
  \`));
  assert.ok(settlementEvents > 0, 'base prover left no settlement events; seed settled data before walking the plan');
  assert.ok(settledPayments > 0, 'base prover left no posted/voided payment; seed settled data before walking the plan');
  console.log('COMMISSION_PLAN_ORDER_SETTLED_DATA settlement_events=' + settlementEvents + ' settled_payments=' + settledPayments);

  // The inherited base fixture deliberately uses PostgreSQL CURRENT_DATE to
  // reproduce the UTC/Chicago boundary bug. At a Chicago evening boundary that
  // is tomorrow, and 200300 must correctly refuse it. This proof is about the
  // settled-data ordering path, so normalize only the disposable fixture's
  // payment date before walking the parked plan; 200300's own prover owns its
  // future-date negative control.
  psql(\`
UPDATE public.commission_payments
   SET payment_date = timezone('America/Chicago', statement_timestamp())::date
 WHERE payment_date > timezone('America/Chicago', statement_timestamp())::date;
\`);
  assert.equal(scalar(\`
    SELECT count(*)::text
      FROM public.commission_payments
     WHERE payment_date > timezone('America/Chicago', statement_timestamp())::date
  \`), '0', 'fixture still contains a future Chicago payment date');
  console.log('COMMISSION_PLAN_ORDER_FIXTURE_DATE_PASS future_payment_rows=0');

  // Files after the base candidate that are NOT part of the parked commission
  // set are replayed first with per-file commits, exactly as a rebuild does.
  // Most are already live; NEXT_INVOICE_YEAR is a separately parked candidate
  // whose wrappability was asserted above and whose behavior is proved by its
  // dedicated prover.
  const planOrderParked = [];
  for (const local of planOrderTrailing) {
    const name = path.basename(local);
    if (planOrderCommissionNames.has(name)) { planOrderParked.push(name); continue; }
    applySql(planOrderSources.get(name));
    console.log('COMMISSION_PLAN_ORDER_PREREQ_APPLIED ' + name);
  }
  assert.deepEqual(planOrderParked, planOrderTrailing.map((l) => path.basename(l)).filter((n) => planOrderCommissionNames.has(n)));

  // ── CONTROL: the OLD order, one transaction. The repair refuses on settled data
  // before the recipient guard is reached; nothing after it runs. ──
  const oldOrderSql = 'BEGIN;\\n' + planOrderOldOrder.map((n) => planOrderSources.get(n)).join('\\n') + '\\nCOMMIT;';
  const oldOrderResult = psql(oldOrderSql, { allowFailure: true });
  const oldOrderOutput = (oldOrderResult.stdout || '') + (oldOrderResult.stderr || '');
  assert.notEqual(oldOrderResult.status, 0, 'CONTROL: the old order unexpectedly applied against settled data');
  assert.match(oldOrderOutput, /COMMISSION_HISTORY_LABEL_REPAIR_SETTLED/,
    'CONTROL: the old order halted for the wrong reason:\\n' + oldOrderOutput);
  assert.equal(settlementRecorderMd5(), ${JSON.stringify(SETTLEMENT_RECORDER_LIVE)},
    'CONTROL: the recipient guard installed even though the plan halted before it');
  console.log('COMMISSION_PLAN_ORDER_CONTROL_PASS old_order_halts_at=' + ${JSON.stringify(REPAIR)} + ' recipient_guard_installed=false');

  // ── ROLLOUT: the REAL order, per-file commits, halt at the first failure. ──
  let halted = null;
  const applied = [];
  for (const name of planOrderParked) {
    const result = applySql(planOrderSources.get(name), { allowFailure: true });
    if (result.status !== 0) {
      halted = { name, output: (result.stdout || '') + (result.stderr || '') };
      break;
    }
    applied.push(name);
    console.log('COMMISSION_PLAN_ORDER_APPLIED ' + name);
  }
  assert.ok(halted, 'ROLLOUT: nothing halted, but the repair must refuse settled data');
  assert.equal(halted.name, ${JSON.stringify(REPAIR)},
    'ROLLOUT: the plan halted at ' + halted.name + ' instead of the repair:\\n' + halted.output);
  assert.match(halted.output, /COMMISSION_HISTORY_LABEL_REPAIR_SETTLED/,
    'ROLLOUT: the repair refused for the wrong reason:\\n' + halted.output);
  assert.equal(applied.length, planOrderParked.length - 1,
    'ROLLOUT: the repair was not the final file; ' + (planOrderParked.length - 1 - applied.length) + ' file(s) never ran');
  assert.equal(settlementRecorderMd5(), ${JSON.stringify(SETTLEMENT_RECORDER_GUARD)},
    'ROLLOUT: the recipient guard body is not installed');
  assert.equal(settlementTriggerAttached(), '1', 'ROLLOUT: the settlement recorder trigger is not attached');
  assert.equal(earnedRecorderMd5(), ${JSON.stringify(EARNED_RECORDER_LIVE)},
    'ROLLOUT: the refused repair must not have replaced the earned recorder');
  assert.equal(bodyMd5('public.get_commission_balance_report(date)'), ${JSON.stringify(BALANCE_REPORT_LATEST_LABEL)},
    'ROLLOUT: the latest-recipient-label report body is not installed');
  assert.equal(scalar("SELECT count(*)::text FROM pg_proc WHERE oid = 'public.enforce_commission_payment_business_date()'::regprocedure"), '1',
    'ROLLOUT: the payout business-date guard is not installed');
  console.log('COMMISSION_PLAN_ORDER_ROLLOUT_PASS applied=' + applied.length + ' refused_last=' + halted.name + ' recipient_guard_installed=true');

  // ── REPLAY: 200000 must accept both reviewed child-report contracts. ──
  const replayGuardText = planOrderSources.get(${JSON.stringify(REPLAY_GUARD)});
  const replayAfterLabel = applySql(replayGuardText, { allowFailure: true });
  const replayAfterLabelOutput = (replayAfterLabel.stdout || '') + (replayAfterLabel.stderr || '');
  assert.equal(replayAfterLabel.status, 0,
    'REPLAY: 200000 refused the reviewed post-200600 child contract:\\n' + replayAfterLabelOutput);
  assert.equal(bodyMd5('public.get_commission_balance_report(date)'), ${JSON.stringify(BALANCE_REPORT_LATEST_LABEL)},
    'REPLAY: 200000 changed the post-200600 balance report body');

  const latestBodyPinFragment = ",\\n          '" + ${JSON.stringify(BALANCE_REPORT_LATEST_LABEL)} + "'";
  assert.equal(replayGuardText.split(latestBodyPinFragment).length - 1, 2,
    'REPLAY: expected one successor body pin in each dependency contract block');
  const narrowedReplayBody = replayGuardText.split(latestBodyPinFragment).join('');
  const narrowedReplayBodyResult = applySql(narrowedReplayBody, { allowFailure: true });
  const narrowedReplayBodyOutput = (narrowedReplayBodyResult.stdout || '') + (narrowedReplayBodyResult.stderr || '');
  assert.notEqual(narrowedReplayBodyResult.status, 0,
    'REPLAY: removing the post-200600 body pin unexpectedly succeeded');
  assert.match(narrowedReplayBodyOutput, /COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT/,
    'REPLAY: narrowed body pin failed for the wrong reason:\\n' + narrowedReplayBodyOutput);

  const latestCommentPinFragment = ",\\n          '" + ${JSON.stringify(BALANCE_REPORT_LATEST_COMMENT)} + "'";
  assert.equal(replayGuardText.split(latestCommentPinFragment).length - 1, 2,
    'REPLAY: expected one successor comment pin in each dependency contract block');
  const narrowedReplayComment = replayGuardText.split(latestCommentPinFragment).join('');
  const narrowedReplayCommentResult = applySql(narrowedReplayComment, { allowFailure: true });
  const narrowedReplayCommentOutput = (narrowedReplayCommentResult.stdout || '') + (narrowedReplayCommentResult.stderr || '');
  assert.notEqual(narrowedReplayCommentResult.status, 0,
    'REPLAY: removing the post-200600 comment pin unexpectedly succeeded');
  assert.match(narrowedReplayCommentOutput, /COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT/,
    'REPLAY: narrowed comment pin failed for the wrong reason:\\n' + narrowedReplayCommentOutput);

  const pairedCommentFragment = "ARRAY[\\n          '" + ${JSON.stringify(BALANCE_REPORT_LIVE_COMMENT_SQL)} + "',\\n          '" + ${JSON.stringify(BALANCE_REPORT_LATEST_COMMENT)} + "'\\n        ]::text[]";
  const swappedCommentFragment = "ARRAY[\\n          '" + ${JSON.stringify(BALANCE_REPORT_LATEST_COMMENT)} + "',\\n          '" + ${JSON.stringify(BALANCE_REPORT_LIVE_COMMENT_SQL)} + "'\\n        ]::text[]";
  assert.equal(replayGuardText.split(pairedCommentFragment).length - 1, 2,
    'REPLAY: expected paired balance-report comment arrays in both dependency blocks');
  const mismatchedReplayPair = replayGuardText.split(pairedCommentFragment).join(swappedCommentFragment);
  const mismatchedReplayPairResult = applySql(mismatchedReplayPair, { allowFailure: true });
  const mismatchedReplayPairOutput = (mismatchedReplayPairResult.stdout || '') + (mismatchedReplayPairResult.stderr || '');
  assert.notEqual(mismatchedReplayPairResult.status, 0,
    'REPLAY: accepting the successor body with the predecessor comment unexpectedly succeeded');
  assert.match(mismatchedReplayPairOutput, /COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT/,
    'REPLAY: mismatched body/comment pair failed for the wrong reason:\\n' + mismatchedReplayPairOutput);
  assert.equal(bodyMd5('public.get_commission_balance_report(date)'), ${JSON.stringify(BALANCE_REPORT_LATEST_LABEL)},
    'REPLAY: refused pin mutations changed the post-200600 balance report body');
  console.log('COMMISSION_PLAN_ORDER_REPLAY_PASS post_200600=true body_pin=load_bearing comment_pin=load_bearing contract_pair=load_bearing');

  // ── PIN: the widened settlement-recorder pin is load-bearing. ──
  const repairText = planOrderSources.get(${JSON.stringify(REPAIR)});
  const narrowedPin = repairText.replace(
    /AND md5\\(p\\.prosrc\\) IN \\(\\s*'${SETTLEMENT_RECORDER_LIVE}',\\s*'${SETTLEMENT_RECORDER_GUARD}'\\s*\\)/,
    "AND md5(p.prosrc) = '${SETTLEMENT_RECORDER_LIVE}'"
  );
  assert.notEqual(narrowedPin, repairText, 'PIN: narrowing mutation did not change the repair');

  // Clear the settled data with trigger bypass (disposable fixture only) so the
  // repair's own refusal no longer masks the pin under test.
  psql(\`BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.commission_settlement_events;
UPDATE public.commission_payments
   SET status = 'unposted', posted_at = NULL, voided_at = NULL, voided_by = NULL;
SET LOCAL session_replication_role = origin;
COMMIT;\`);
  const narrowedResult = applySql(narrowedPin, { allowFailure: true });
  const narrowedOutput = (narrowedResult.stdout || '') + (narrowedResult.stderr || '');
  assert.notEqual(narrowedResult.status, 0, 'PIN: the single pre-200200 pin unexpectedly applied after the guard');
  assert.match(narrowedOutput, /COMMISSION_HISTORY_LABEL_REPAIR_DRIFT/,
    'PIN: the narrowed pin failed for the wrong reason:\\n' + narrowedOutput);
  assert.equal(earnedRecorderMd5(), ${JSON.stringify(EARNED_RECORDER_LIVE)}, 'PIN: refused repair must change nothing');
  console.log('COMMISSION_PLAN_ORDER_PIN_PASS narrowed_pin_refused_after_guard=true');

  // ── TAIL: the real repair applies after the guard once settled data is gone. ──
  applySql(repairText);
  assert.equal(earnedRecorderMd5(), ${JSON.stringify(EARNED_RECORDER_REPAIRED)}, 'TAIL: the repair did not install its recorder');
  assert.equal(settlementRecorderMd5(), ${JSON.stringify(SETTLEMENT_RECORDER_GUARD)}, 'TAIL: the repair disturbed the recipient guard');
  console.log('COMMISSION_PLAN_ORDER_TAIL_PASS repair_applied_after_guard=true');
  console.log('COMMISSION_MIGRATION_PLAN_ORDER_PROOF_PASS postgres=17 parked=' + planOrderParked.length + ' control=old_order_halts replay=post_200600 pin=load_bearing tail=applies');
`;

let result;
try {
  let source = readFileSync(BASE_PROVER, 'utf8');
  const anchor = '  console.log(\n    `COMMISSION_HISTORY_PROOF_PASS postgres=17 baseline=${BASELINE_MANIFEST.migrations_high_water} replayed=${migrations.length}`,\n  );';
  assert.equal(source.split(anchor).length - 1, 1, 'base prover injection anchor is ambiguous');
  source = source.replace(anchor, `${continuation}\n${anchor}`);
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
