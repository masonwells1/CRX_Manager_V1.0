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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-commission-history-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
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
  assert.equal(
    candidateIndex,
    migrations.length - 1,
    'candidate must be the final selected migration in this isolated release proof',
  );
  return migrations;
}

function applySql(source, { allowFailure = false } = {}) {
  const ownsTransaction = /^[ \t]*BEGIN[ \t]*;/mi.test(source);
  const executable = ownsTransaction ? source : `BEGIN;\n${source}\nCOMMIT;`;
  return psql(executable, { allowFailure });
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
  migrations.forEach((local, index) => {
    if (path.basename(local) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') {
      restoreLiveCrLfCloseRemainder();
    }
    applyMigration(local, index);
  });

  const smoke = psql(readFileSync(SMOKE_PATH, 'utf8'), { allowFailure: true });
  const smokeOutput = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(
    smokeOutput,
    /SMOKE_PASS_ROLLBACK: COMMISSION_HISTORY_AS_OF/,
    `rollback smoke did not reach its terminal marker:\n${smokeOutput}`,
  );
  console.log('COMMISSION_HISTORY_REAL_PATH_PASS create_post_report_void_report rollback=true');

  const candidate = readFileSync(MIGRATION_PATH, 'utf8');
  const lockIndex = candidate.indexOf('LOCK TABLE public.commission_payments,');
  const preconditionIndex = candidate.indexOf('DO $precondition$');
  assert.ok(lockIndex >= 0, 'candidate is missing the cheap-window writer lock');
  assert.ok(
    lockIndex < preconditionIndex,
    'candidate reads the cheap-window precondition before blocking concurrent writers',
  );
  applySql(candidate);
  console.log('COMMISSION_HISTORY_IDEMPOTENT_REAPPLY_PASS');

  psql(`
CREATE FUNCTION public.get_commission_balance_report(p_decoy text)
RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
`);
  expectCandidateFailure(candidate, 'COMMISSION_HISTORY_OVERLOAD_DRIFT', 'decoy_overload');
  psql('DROP FUNCTION public.get_commission_balance_report(text);');

  const weakenedCutoff = candidate.replace(
    "AND (cp.posted_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date",
    'AND TRUE -- MUTATION: removed posted-at historical cutoff',
  );
  assert.notEqual(weakenedCutoff, candidate, 'posted-at mutation did not change the candidate');
  expectCandidateFailure(
    weakenedCutoff,
    'COMMISSION_HISTORY_POSTCOND: reviewed function body or security contract drift',
    'missing_posted_at_cutoff',
  );

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

  const mutableRecipientName = candidate.replaceAll(
    "COALESCE(NULLIF(cm.recipient, ''), p.full_name, '[Unknown recipient]'::text)",
    "COALESCE(p.full_name, NULLIF(cm.recipient, ''), '[Unknown recipient]'::text)",
  );
  assert.notEqual(
    mutableRecipientName,
    candidate,
    'recipient-name mutation did not change the candidate',
  );
  applySql(mutableRecipientName);
  expectSmokeFailure(
    'SMOKE_FAIL: mutable profile name rewrote aggregate history',
    'mutable_recipient_name_history',
  );
  applySql(candidate);

  const splitRecipientAggregate = candidate.replace(
    `GROUP BY e.recipient_user_id,
           CASE
             WHEN e.recipient_user_id IS NULL THEN e.resolved_recipient_name
             ELSE NULL::text
           END`,
    'GROUP BY e.recipient_user_id, e.resolved_recipient_name',
  );
  assert.notEqual(
    splitRecipientAggregate,
    candidate,
    'recipient-grouping mutation did not change the candidate',
  );
  applySql(splitRecipientAggregate);
  expectSmokeFailure(
    'SMOKE_FAIL: one recipient split into 2 aggregate rows after rename',
    'recipient_name_split_aggregate',
  );
  applySql(candidate);

  const mutableCustomerName = candidate.replace(
    "COALESCE(NULLIF(cm.customer_name, ''), customer.farm_name, '[Unknown customer]'::text)",
    "COALESCE(customer.farm_name, NULLIF(cm.customer_name, ''), '[Unknown customer]'::text)",
  );
  assert.notEqual(
    mutableCustomerName,
    candidate,
    'customer-name mutation did not change the candidate',
  );
  applySql(mutableCustomerName);
  expectSmokeFailure(
    'SMOKE_FAIL: mutable order/customer labels rewrote payment detail history',
    'mutable_customer_name_history',
  );
  applySql(candidate);

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
    /COMMISSION_HISTORY_POSTCOND: voided_by foreign key is missing or has the wrong target/,
    `wrong foreign key failed for the wrong reason:\n${wrongFkOutput}`,
  );
  console.log('COMMISSION_HISTORY_MUTATION_REJECTED wrong_voided_by_fk');

  console.log(
    `COMMISSION_HISTORY_PROOF_PASS postgres=17 baseline=${BASELINE_MANIFEST.migrations_high_water} replayed=${migrations.length}`,
  );
} finally {
  if (started) docker(['rm', '-f', NAME], { allowFailure: true });
}
