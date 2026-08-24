#!/usr/bin/env node
/**
 * Disposable proof for 20260819232000. No DB URL is read and no Supabase
 * connection is possible: PostgreSQL 17 runs in a unique --network none
 * container with tmpfs storage and is force-removed in finally.
 *
 * The migration is applied verbatim twice. A compact fixture plus a faithful
 * effect-recording stand-in mutation-tests the new wrapper's parsing, auth,
 * receipt binding and key-race behavior. A second database restores the
 * supported full schema, replays every ledger-selected migration through this
 * candidate, then executes the checked-in rollback smokes against the REAL
 * pricing, cost, profit, commission, inventory and draw-ledger implementation.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = `crx-draw-intent-proof-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE_DIR = path.join(ROOT, 'supabase', 'baselines');
const BASELINE_MANIFEST = JSON.parse(
  readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8'),
);
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260819232000_bind_draw_down_receipts_to_intent.sql',
);
const SHARED_HELPER_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260811130000_bind_commission_payout_idempotency_to_intent.sql',
);
const CUTOVER_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260816110000_draw_down_cutover_barrier.sql',
);
const TIER_SPLIT_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260816120000_draw_down_split_order_lines_by_price_tier.sql',
);
const ALLOCATED_CENTS_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260817120000_carry_allocated_line_cents_through_lifecycle.sql',
);
const SMOKE_PATH = path.join(
  ROOT,
  'scripts',
  'smoke',
  'smoke-draw-down-quote-intent-binding.sql',
);
const IDLESS_DUPLICATE_COMMIT_PROOF_PATH = path.join(
  ROOT,
  'scripts',
  'smoke',
  'prove-draw-idless-duplicate-commit.sql',
);
const KEYED_DRAW_SMOKE_PATHS = [
  'smoke-draw-ledger-reversal.sql',
  'smoke-order-draw-lock.sql',
  'smoke-save-quote-drawn-guard.sql',
  'smoke-restore-version-drawn-guard.sql',
  'smoke-planned-holds-drawn-sync.sql',
  'smoke-auth-probe-template.sql',
].map((file) => path.join(ROOT, 'scripts', 'smoke', file));

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const ACTOR_ADMIN = '33333333-3333-3333-3333-333333333333';
const ACTOR_INACTIVE = '44444444-4444-4444-4444-444444444444';
const ACTOR_MISSING = '55555555-5555-5555-5555-555555555555';
const QUOTE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const QUOTE_B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const QUOTE_DELETED = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3';
const PRODUCT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FULL_SCHEMA_SMOKE_ADMIN = '66666666-6666-6666-6666-666666666666';
const FULL_SCHEMA_SMOKE_DRIVER = '77777777-7777-7777-7777-777777777777';

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 60 * 1024 * 1024,
    timeout: 300_000,
    killSignal: 'SIGTERM',
  });
  if (result.error) {
    if (!allowFailure) throw result.error;
    return {
      ...result,
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? String(result.error.message ?? result.error),
    };
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, {
  db = 'postgres',
  user = 'postgres',
  allowFailure = false,
  tuples = false,
} = {}) {
  const args = [
    'exec', '-i', CONTAINER, 'psql', '-U', user, '-d', db,
    '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ];
  if (tuples) args.push('-t', '-A');
  return docker(args, { input: sql, allowFailure });
}

function value(sql, db = 'postgres') {
  return psql(sql, { db, tuples: true }).stdout.trim();
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
  docker(['cp', local, `${CONTAINER}:/tmp/${remoteName}`]);
}

function selectedMigrationsThroughCandidate() {
  const enumerator = path.join(ROOT, 'scripts', 'list-post-baseline-migrations.mjs');
  const listed = spawnSync(process.execPath, [enumerator], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `could not enumerate post-baseline migrations:\n${listed.stderr}`);
  const selectorNotice = listed.stderr.trim().replace(/\r?\n/g, ' | ');
  console.log(`FULL_SCHEMA_REPLAY_SELECTOR_NOTICE ${selectorNotice || 'none'}`);
  const migrations = listed.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^supabase\/migrations\/\d{14}_[^/]+\.sql$/.test(line))
    .map((relative) => path.join(ROOT, relative));
  const candidateIndex = migrations.findIndex(
    (local) => path.resolve(local) === path.resolve(MIGRATION_PATH),
  );
  assert.notEqual(candidateIndex, -1, 'candidate is absent from the ledger-selected replay');
  return migrations.slice(0, candidateIndex + 1);
}

function applyMigrationFile(local, index, db = 'postgres') {
  const source = readFileSync(local, 'utf8');
  const executable = path.resolve(local) === path.resolve(MIGRATION_PATH)
    ? source
    : source.replace(/\r\n/g, '\n');
  if (path.resolve(local) === path.resolve(MIGRATION_PATH)) {
    assert.ok(!source.includes('\r'), 'candidate migration is not LF byte-verbatim');
  }
  const ownsTransaction = /^[ \t]*BEGIN[ \t]*;/mi.test(source);
  psql(ownsTransaction ? executable : `BEGIN;\n${executable}\nCOMMIT;`, { db });
  if ((index + 1) % 10 === 0 || path.resolve(local) === path.resolve(MIGRATION_PATH)) {
    console.log(`FULL_SCHEMA_REPLAY_PROGRESS ${index + 1} ${path.basename(local)}`);
  }
}

function restoreFullSchemaAndRunSmoke() {
  const extensions = baselineArtifact('_extensions.sql');
  const acl = baselineArtifact('_acl_lockdown.sql');
  const platformOverlay = baselineArtifact('_platform_overlay.sql');
  const cronJobs = baselineArtifact('_cron_jobs.sql');
  const migrationHistory = baselineArtifact('_migration_history.sql');
  const baselineHighWater = BASELINE_MANIFEST.migrations_high_water;
  assert.ok(
    path.basename(extensions).startsWith(baselineHighWater),
    'baseline extension artifact does not match manifest high-water',
  );

  copyIntoContainer(extensions, 'draw-baseline-extensions.sql');
  copyIntoContainer(acl, 'draw-baseline-acl.sql');
  copyIntoContainer(platformOverlay, 'draw-baseline-platform.sql');
  copyIntoContainer(cronJobs, 'draw-baseline-cron.sql');
  copyIntoContainer(migrationHistory, 'draw-baseline-history.sql');

  psql('\\i /tmp/draw-baseline-extensions.sql');
  const decompressed = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], {
    cwd: ROOT,
    maxBuffer: 60 * 1024 * 1024,
  });
  assert.equal(
    decompressed.status,
    0,
    `baseline decompression failed: ${decompressed.stderr?.toString() ?? ''}`,
  );
  psql(decompressed.stdout.toString());
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
  psql('\\i /tmp/draw-baseline-acl.sql');
  psql('\\i /tmp/draw-baseline-platform.sql', { user: 'supabase_admin' });
  psql('\\i /tmp/draw-baseline-cron.sql');
  psql(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      statements text[]
    );
    \\i /tmp/draw-baseline-history.sql
  `);

  const migrations = selectedMigrationsThroughCandidate();
  migrations.forEach((local, index) => {
    if (path.resolve(local) === path.resolve(ALLOCATED_CENTS_PATH)) {
      restoreLiveCrLfCloseRemainder('postgres');
    }
    applyMigrationFile(local, index);
  });
  assert.equal(
    path.resolve(migrations.at(-1)),
    path.resolve(MIGRATION_PATH),
    'candidate must be the final full-schema replay migration',
  );

  const smokeSql = readFileSync(SMOKE_PATH, 'utf8');
  const smoke = psql(smokeSql, { allowFailure: true });
  const smokeOutput = `${smoke.stdout}\n${smoke.stderr}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(
    smokeOutput,
    /SMOKE_PASS_ROLLBACK/,
    `full-schema rollback smoke did not reach its terminal marker:\n${smokeOutput}`,
  );
  console.log(
    `FULL_SCHEMA_DRAW_SMOKE_PASS baseline=${baselineHighWater} replayed=${migrations.length} `
      + 'money_commission_inventory=SMOKE_PASS_ROLLBACK',
  );

  psql(`
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES
  (
    '${FULL_SCHEMA_SMOKE_ADMIN}'::uuid,
    'draw-intent-registered-smokes@example.invalid',
    '{"full_name":"[SMOKE] Registered Draw Admin","role":"admin"}'::jsonb,
    now(),
    now()
  ),
  (
    '${FULL_SCHEMA_SMOKE_DRIVER}'::uuid,
    'draw-intent-auth-probe-driver@example.invalid',
    '{"full_name":"[SMOKE] Auth Probe Driver","role":"driver"}'::jsonb,
    now(),
    now()
  );
INSERT INTO public.profiles (id, email, full_name, role, is_active)
VALUES
  (
    '${FULL_SCHEMA_SMOKE_ADMIN}'::uuid,
    'draw-intent-registered-smokes@example.invalid',
    '[SMOKE] Registered Draw Admin',
    'admin',
    true
  ),
  (
    '${FULL_SCHEMA_SMOKE_DRIVER}'::uuid,
    'draw-intent-auth-probe-driver@example.invalid',
    '[SMOKE] Auth Probe Driver',
    'driver',
    true
  )
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      role = EXCLUDED.role,
      is_active = true;`);

  // The registered smokes borrow real priced catalog rows, matching production
  // without mutating product pricing. This restored database is schema-only, so
  // seed two disposable rows before the smokes run. The governed-pricing trigger
  // is disabled for this seed statement only and must be enabled again before
  // any behavior under test executes.
  psql(`
BEGIN;
ALTER TABLE public.products
  DISABLE TRIGGER trigger_y_require_governed_product_pricing;
INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price)
VALUES
  ('[PROVER] Draw Intent Priced A', 'gal', 3.00, 10.00),
  ('[PROVER] Draw Intent Priced B', 'gal', 4.00, 8.00);
ALTER TABLE public.products
  ENABLE TRIGGER trigger_y_require_governed_product_pricing;
DO $seed_check$
BEGIN
  IF (SELECT tgenabled
        FROM pg_trigger
       WHERE tgrelid = 'public.products'::regclass
         AND tgname = 'trigger_y_require_governed_product_pricing')
       IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'FULL_SCHEMA_PRICED_CATALOG_SEED_FAIL: governed pricing trigger is not enabled';
  END IF;
END
$seed_check$;
COMMIT;`);
  console.log('FULL_SCHEMA_PRICED_CATALOG_SEED_PASS count=2 trigger=enabled');

  for (const smokePath of KEYED_DRAW_SMOKE_PATHS) {
    const keyedSmoke = psql(readFileSync(smokePath, 'utf8'), { allowFailure: true });
    const keyedOutput = `${keyedSmoke.stdout}\n${keyedSmoke.stderr}`;
    assert.notEqual(keyedSmoke.status, 0, `${path.basename(smokePath)} unexpectedly committed`);
    assert.match(
      keyedOutput,
      /SMOKE_PASS_ROLLBACK/,
      `${path.basename(smokePath)} did not reach its terminal marker:\n${keyedOutput}`,
    );
  }
  console.log(`FULL_SCHEMA_KEYED_DRAW_SMOKES_PASS count=${KEYED_DRAW_SMOKE_PATHS.length}`);

  const commitProof = psql(
    readFileSync(IDLESS_DUPLICATE_COMMIT_PROOF_PATH, 'utf8'),
    { allowFailure: true },
  );
  const commitOutput = `${commitProof.stdout}\n${commitProof.stderr}`;
  assert.equal(
    commitProof.status,
    0,
    `id-less duplicate-product commit proof failed:\n${commitOutput}`,
  );
  assert.match(
    commitOutput,
    /FULL_SCHEMA_IDLESS_DUPLICATE_COMMIT_PASS/,
    `id-less duplicate-product commit proof missed its post-COMMIT marker:\n${commitOutput}`,
  );
  console.log('FULL_SCHEMA_IDLESS_DUPLICATE_COMMIT_PASS');
}

function concurrentCall(sql, db = 'postgres') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db,
        '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
      ],
      { cwd: ROOT },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function extractSharedHelper() {
  const source = readFileSync(SHARED_HELPER_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency_intent(');
  const endMarker = '-- ---------------------------------------------------------------------------\n-- Identity-check helper';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'could not extract the real shared intent helper');
  return source.slice(start, end);
}

function extractFunctionStatement(source, name) {
  const starts = [
    `CREATE OR REPLACE FUNCTION public.${name}(`,
    `CREATE FUNCTION public.${name}(`,
  ].map((marker) => source.indexOf(marker)).filter((index) => index >= 0);
  const start = Math.min(...starts);
  const bodyStart = source.indexOf('AS $function$', start);
  const endMarker = '\n$function$;';
  const end = source.indexOf(endMarker, bodyStart);
  assert.ok(Number.isFinite(start) && start >= 0 && bodyStart > start && end > bodyStart,
    `could not extract ${name}`);
  return source.slice(start, end + endMarker.length);
}

function restoreLiveCrLfCloseRemainder(db) {
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
  `, { db });
  console.log('FULL_SCHEMA_LIVE_BODY_RESTORED _close_undelivered_order_remainder_20260718 crlf=true');
}

function extractReviewedPrerequisites() {
  const cutover = readFileSync(CUTOVER_PATH, 'utf8').replace(/\r\n/g, '\n');
  const tierSplit = readFileSync(TIER_SPLIT_PATH, 'utf8');
  const allocatedCents = readFileSync(ALLOCATED_CENTS_PATH, 'utf8');
  return [
    extractFunctionStatement(cutover, 'draw_down_quote'),
    extractFunctionStatement(tierSplit, '_draw_down_quote_below_cost_impl_20260810'),
    extractFunctionStatement(allocatedCents, '_allocated_cumulative_cents'),
    extractFunctionStatement(allocatedCents, '_allocated_delivery_cents'),
    extractFunctionStatement(allocatedCents, '_complete_delivery_authorized_impl'),
    extractFunctionStatement(allocatedCents, '_create_invoice_for_unbilled_delivery_impl_20260718'),
    extractFunctionStatement(allocatedCents, '_close_undelivered_order_remainder_20260718'),
  ].join('\n\n');
}

const FIXTURE = `
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$roles$;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL
);
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  result jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  request_fingerprint text,
  request_actor_id uuid
);
CREATE TABLE public.proof_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  draws jsonb NOT NULL
);

INSERT INTO public.profiles(id, role, is_active) VALUES
  ('${ACTOR_A}', 'sales_rep', true),
  ('${ACTOR_B}', 'sales_rep', true),
  ('${ACTOR_ADMIN}', 'admin', true),
  ('${ACTOR_INACTIVE}', 'sales_rep', false);
INSERT INTO public.quotes(id, created_by, deleted_at) VALUES
  ('${QUOTE_A}', '${ACTOR_B}', NULL),
  ('${QUOTE_B}', '${ACTOR_B}', NULL),
  ('${QUOTE_DELETED}', '${ACTOR_B}', now());

CREATE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  SELECT result INTO v_result
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND operation = p_operation AND expires_at > now();
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

CREATE FUNCTION public._begin_below_cost_money_write(
  p_operation text,
  p_actor uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN RETURN; END; $function$;

CREATE FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_result jsonb;
BEGIN
  PERFORM 1 FROM public.quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  INSERT INTO public.proof_effects(quote_id, actor_id, draws)
  VALUES (p_quote_id, v_actor, p_draws)
  RETURNING id INTO v_order_id;
  IF current_setting('crx.proof_delay', true) = 'on' THEN
    PERFORM pg_sleep(1);
  END IF;
  v_result := jsonb_build_object('success', true, 'order_id', v_order_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  TO postgres;

CREATE FUNCTION public.draw_down_quote(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION 'DRAW_DOWN_CUTOVER_IN_PROGRESS';
  END IF;
  PERFORM public._begin_below_cost_money_write('draw_down_quote');
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  TO authenticated, service_role;
`;

function callSql({
  actor = ACTOR_A,
  performedBy = actor,
  quote = QUOTE_A,
  quantity = '1',
  key,
  delay = false,
}) {
  const performedBySql = performedBy === null ? 'NULL' : `'${performedBy}'::uuid`;
  return `
SELECT set_config('request.jwt.claim.sub', '${actor}', false);
SELECT set_config('crx.proof_delay', '${delay ? 'on' : 'off'}', false);
SELECT 'RESULT=' || public.draw_down_quote(
  '${quote}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', ${quantity})),
  ${performedBySql},
  '${key}',
  NULL
)::text;
`;
}

function resultId(run) {
  return /RESULT=.*"order_id": "([0-9a-f-]{36})"/.exec(run.stdout)?.[1];
}

function bootstrap(db, migration) {
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  psql(`BEGIN;\n${migration}\nCOMMIT;`, { db });
  const standIn = extractFunctionStatement(
    FIXTURE,
    '_draw_down_quote_below_cost_impl_20260810',
  ).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  psql(standIn, { db });
}

function proveAuthorization(db) {
  const admin = psql(`BEGIN;${callSql({ actor: ACTOR_ADMIN, key: 'draw-admin' })}ROLLBACK;`, {
    db,
    tuples: true,
  });
  assert.ok(resultId(admin), 'active admin could not draw a colleague booking');

  const authMissing = psql(`
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 1)),
  NULL,
  'draw-no-auth',
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(authMissing.status, 0, 'missing auth was accepted');
  assert.match(authMissing.stderr, /AUTH_REQUIRED/);

  const actorMismatch = psql(callSql({
    actor: ACTOR_A,
    performedBy: ACTOR_B,
    key: 'draw-actor-param-mismatch',
  }), { db, allowFailure: true, tuples: true });
  assert.notEqual(actorMismatch.status, 0, 'mismatched p_performed_by was accepted');
  assert.match(actorMismatch.stderr, /ACTOR_MISMATCH/);

  for (const [actor, label] of [
    [ACTOR_INACTIVE, 'inactive profile'],
    [ACTOR_MISSING, 'missing profile'],
  ]) {
    const refused = psql(callSql({ actor, key: `draw-${label.replace(' ', '-')}` }), {
      db,
      allowFailure: true,
      tuples: true,
    });
    assert.notEqual(refused.status, 0, `${label} was accepted`);
    assert.match(refused.stderr, /INSUFFICIENT_ROLE/);
  }
}

function proveSequential(db) {
  const keyless = psql(`BEGIN;
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 1)),
  '${ACTOR_A}'::uuid,
  NULL,
  NULL
)::text;`, { db, allowFailure: true, tuples: true });
  assert.notEqual(keyless.status, 0, 'keyless money request reached the preserved implementation');
  assert.match(keyless.stderr, /IDEMPOTENCY_KEY_REQUIRED/);

  const empty = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid, '[]'::jsonb, '${ACTOR_A}'::uuid, 'draw-empty', NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(empty.status, 0, 'empty keyed request bypassed the outer guard');
  assert.match(empty.stderr, /EMPTY_DRAW/);

  const malformedProduct = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', 'not-a-uuid', 'quantity', 1)),
  '${ACTOR_A}'::uuid,
  'draw-malformed-product',
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(malformedProduct.status, 0, 'malformed product id reached the UUID cast');
  assert.match(malformedProduct.stderr, /BOOKING_PRODUCT_INVALID/);

  const nonFiniteGuard = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 'NaN')),
  '${ACTOR_A}'::uuid,
  'draw-nonfinite',
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(nonFiniteGuard.status, 0, 'non-finite keyed request bypassed the outer guard');
  assert.match(nonFiniteGuard.stderr, /BOOKING_QUANTITY_INVALID/);

  const nonNumeric = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 'abc')),
  '${ACTOR_A}'::uuid,
  'draw-nonnumeric',
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(nonNumeric.status, 0, 'non-numeric keyed request bypassed the outer guard');
  assert.match(nonNumeric.stderr, /BOOKING_QUANTITY_INVALID/);

  const first = psql(callSql({ key: 'draw-sequential' }), { db, tuples: true });
  const replay = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT 'RESULT=' || public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('quantity', 1.00, 'product_id', '${PRODUCT}'::uuid)),
  '${ACTOR_A}'::uuid,
  'draw-sequential',
  'retry metadata is not mutation identity'
)::text;`, { db, tuples: true });
  assert.equal(resultId(replay), resultId(first), 'numeric-equivalent exact replay changed order id');

  const changed = psql(callSql({ quantity: '2', key: 'draw-sequential' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(changed.status, 0, 'changed draw quantity replayed stale success');
  assert.match(changed.stderr, /IDEMPOTENCY_INTENT_MISMATCH/);

  const actor = psql(callSql({ actor: ACTOR_B, key: 'draw-sequential' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(actor.status, 0, 'different actor replayed stale success');
  assert.match(actor.stderr, /IDEMPOTENCY_ACTOR_MISMATCH/);

  const deleted = psql(callSql({ actor: ACTOR_B, quote: QUOTE_DELETED, key: 'draw-deleted' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(deleted.status, 0, 'soft-deleted quote reached replay/work');
  assert.match(deleted.stderr, /Quote not found/);

  const nonFinite = psql(callSql({ quantity: "'NaN'", key: 'draw-non-finite' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(nonFinite.status, 0, 'non-finite draw quantity was accepted');
  assert.match(nonFinite.stderr, /BOOKING_QUANTITY_INVALID/);

  assert.equal(value('SELECT count(*) FROM public.proof_effects;', db), '1');
  assert.equal(
    value("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='draw-sequential' AND request_actor_id IS NOT NULL AND request_fingerprint IS NOT NULL;", db),
    '1',
  );
  assert.equal(
    value("SELECT has_function_privilege('authenticated', 'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    'f',
  );
  assert.equal(
    value("SELECT has_function_privilege('authenticated', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    't',
  );
  assert.equal(
    value("SELECT has_function_privilege('service_role', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    'f',
  );
}

async function proveConcurrency(db) {
  const different = await Promise.all([
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-different', delay: true }), db),
    concurrentCall(callSql({ quote: QUOTE_B, key: 'draw-race-different', delay: true }), db),
  ]);
  assert.equal(different.filter((run) => run.status === 0).length, 1);
  const loser = different.find((run) => run.status !== 0);
  assert.match(loser?.stderr ?? '', /IDEMPOTENCY_INTENT_MISMATCH/);
  assert.equal(
    value(`SELECT count(*) FROM public.proof_effects WHERE quote_id IN ('${QUOTE_A}', '${QUOTE_B}') AND id <> (SELECT (result->>'order_id')::uuid FROM public.idempotency_keys WHERE idempotency_key='draw-sequential');`, db),
    '1',
    'different-intent same-key race performed more than once',
  );

  const same = await Promise.all([
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-same', delay: true }), db),
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-same', delay: true }), db),
  ]);
  for (const run of same) assert.equal(run.status, 0, run.stderr);
  assert.ok(resultId(same[0]) && resultId(same[1]));
  assert.equal(resultId(same[0]), resultId(same[1]));
  assert.equal(
    value("SELECT count(*) FROM public.proof_effects WHERE id = (SELECT (result->>'order_id')::uuid FROM public.idempotency_keys WHERE idempotency_key='draw-race-same');", db),
    '1',
  );
}

function proveMutation(migration) {
  psql('CREATE DATABASE draw_intent_mutant TEMPLATE template0;');
  const db = 'draw_intent_mutant';
  const broken = migration.replace(
    "'draws', v_canonical_draws",
    "'draws', '[]'::jsonb /* 'draws', v_canonical_draws */",
  );
  assert.notEqual(broken, migration, 'fingerprint mutation was not planted');
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  const blocked = psql(`BEGIN;\n${broken}\nCOMMIT;`, { db, allowFailure: true });
  assert.notEqual(blocked.status, 0, 'broken fingerprint passed the exact outer-body gate');
  assert.match(blocked.stderr, /reviewed intent helper or wrapper body changed/);
  console.log('MUTATION_DETECTED: removing draw quantities from identity is refused postflight');
}

function provePrerequisiteBodyGuard(migration) {
  psql('CREATE DATABASE draw_prerequisite_mutant TEMPLATE template0;');
  const db = 'draw_prerequisite_mutant';
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  const reviewed = extractReviewedPrerequisites();
  psql(reviewed, { db });
  const mutated = extractFunctionStatement(
    readFileSync(TIER_SPLIT_PATH, 'utf8'),
    '_draw_down_quote_below_cost_impl_20260810',
  ).replace('-- TIERSPLIT<<<', '-- MUTATED TIERSPLIT<<<');
  psql(mutated, { db });
  const blocked = psql(`BEGIN;\n${migration}\nCOMMIT;`, { db, allowFailure: true });
  assert.notEqual(blocked.status, 0, 'drifted pricing body passed the prerequisite hash gate');
  assert.match(blocked.stderr, /reviewed pricing\/lifecycle prerequisite body drifted/);
  console.log('MUTATION_DETECTED: drifted tier-split body is refused before wrapping');
}

function proveIntentBoundaryGuards(migration) {
  const helper = extractSharedHelper();
  const setup = (db) => {
    psql(`CREATE DATABASE ${db} TEMPLATE template0;`);
    psql(FIXTURE, { db });
    psql(helper, { db });
    psql(extractReviewedPrerequisites(), { db });
  };
  const expectBlocked = (db, message, pattern) => {
    const blocked = psql(`BEGIN;\n${migration}\nCOMMIT;`, { db, allowFailure: true });
    assert.notEqual(blocked.status, 0, message);
    assert.match(blocked.stderr, pattern);
  };

  setup('draw_helper_null_mutant');
  const nullHelper = helper.replace(
    "  RETURN jsonb_build_object('found', true, 'result', v_existing.result);",
    "  RETURN NULL; -- RETURN jsonb_build_object('found', true, 'result', v_existing.result);",
  );
  assert.notEqual(nullHelper, helper, 'NULL-returning helper mutation was not planted');
  psql(nullHelper, { db: 'draw_helper_null_mutant' });
  expectBlocked(
    'draw_helper_null_mutant',
    'NULL-returning intent helper passed the exact-body gate',
    /reviewed intent helper or governed wrapper body drifted/,
  );

  setup('draw_helper_compare_mutant');
  const comparisonHelper = helper
    .replace(
      'IF v_existing.request_actor_id IS DISTINCT FROM p_actor THEN',
      'IF false /* v_existing.request_actor_id IS DISTINCT FROM p_actor */ THEN',
    )
    .replace(
      'IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN',
      'IF false /* v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint */ THEN',
    );
  assert.notEqual(comparisonHelper, helper, 'actor/fingerprint comparison mutation was not planted');
  psql(comparisonHelper, { db: 'draw_helper_compare_mutant' });
  expectBlocked(
    'draw_helper_compare_mutant',
    'disabled actor/fingerprint comparisons passed the exact-body gate',
    /reviewed intent helper or governed wrapper body drifted/,
  );

  setup('draw_wrapper_comment_mutant');
  const reviewedWrapper = extractFunctionStatement(
    readFileSync(CUTOVER_PATH, 'utf8').replace(/\r\n/g, '\n'),
    'draw_down_quote',
  );
  const wrapperCalls = `  PERFORM public._begin_below_cost_money_write(
    'draw_down_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );`;
  const commentWrapper = reviewedWrapper.replace(
    wrapperCalls,
    `  -- MUTATION: _begin_below_cost_money_write and
  -- _draw_down_quote_below_cost_impl_20260810 were moved into comments.
  RETURN jsonb_build_object('mutated', true);`,
  );
  assert.notEqual(commentWrapper, reviewedWrapper, 'comment-only wrapper mutation was not planted');
  psql(commentWrapper, { db: 'draw_wrapper_comment_mutant' });
  expectBlocked(
    'draw_wrapper_comment_mutant',
    'comment-only governed wrapper calls passed the exact-body gate',
    /reviewed intent helper or governed wrapper body drifted/,
  );

  setup('draw_helper_overload_mutant');
  psql(`
CREATE FUNCTION public.check_idempotency_intent(p_key text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ SELECT NULL::jsonb $function$;
REVOKE ALL ON FUNCTION public.check_idempotency_intent(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_idempotency_intent(text) TO postgres;
`, { db: 'draw_helper_overload_mutant' });
  expectBlocked(
    'draw_helper_overload_mutant',
    'extra intent-helper overload passed the overload gate',
    /reviewed intent helper overload, owner, security, search_path, or grants drifted/,
  );

  console.log('MUTATION_DETECTED: intent helper body, comparisons, wrapper calls, and overload drift are refused');
}

function proveTransactionGuard(migration) {
  psql('CREATE DATABASE draw_transaction_guard TEMPLATE template0;');
  const db = 'draw_transaction_guard';
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  const blocked = psql(migration, { db, allowFailure: true });
  assert.notEqual(blocked.status, 0, 'autocommit execution bypassed the transaction guard');
  assert.match(blocked.stderr, /crx_draw_intent_transaction_guard/);
  assert.equal(
    value("SELECT to_regprocedure('public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)') IS NULL;", db),
    't',
  );
  console.log('MUTATION_DETECTED: autocommit execution is refused before the cutover lock');
}

function proveIsolationGuard(migration) {
  psql('CREATE DATABASE draw_isolation_guard TEMPLATE template0;');
  const db = 'draw_isolation_guard';
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  const blocked = psql(
    `BEGIN ISOLATION LEVEL REPEATABLE READ;\n${migration}\nCOMMIT;`,
    { db, allowFailure: true },
  );
  assert.notEqual(blocked.status, 0, 'repeatable-read execution bypassed the stale-snapshot guard');
  assert.match(blocked.stderr, /transaction isolation must be read committed/);
  assert.equal(
    value("SELECT to_regprocedure('public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)') IS NULL;", db),
    't',
  );
  console.log('MUTATION_DETECTED: repeatable-read execution is refused before the legacy-receipt scan');
}

async function proveLegacyReceiptPreflight(migration) {
  psql('CREATE DATABASE draw_legacy_receipt TEMPLATE template0;');
  const db = 'draw_legacy_receipt';
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  const inFlightDraw = concurrentCall(`
    BEGIN;
    SELECT pg_advisory_xact_lock_shared(20260816, 1);
    INSERT INTO public.idempotency_keys(idempotency_key, operation, result, expires_at)
    VALUES (
      'legacy-draw-receipt',
      'draw_down_quote',
      jsonb_build_object('order_id', gen_random_uuid()),
      now() + interval '1 hour'
    );
    SELECT pg_sleep(0.75);
    COMMIT;
  `, db);
  let barrierHeld = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    barrierHeld = value(`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory'
           AND mode = 'ShareLock'
           AND granted
           AND classid::text = '20260816'
           AND objid::text = '1'
      );
    `, db) === 't';
    if (barrierHeld) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(barrierHeld, 'could not observe the simulated in-flight draw barrier');
  const blocked = psql(`BEGIN;\n${migration}\nCOMMIT;`, { db, allowFailure: true });
  const completedDraw = await inFlightDraw;
  assert.equal(completedDraw.status, 0, `simulated in-flight draw failed: ${completedDraw.stderr}`);
  assert.notEqual(blocked.status, 0, 'unexpired legacy receipt did not block cutover');
  assert.match(blocked.stderr, /unexpired legacy draw_down_quote receipts exist/);
  assert.equal(
    value("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'legacy-draw-receipt';", db),
    '1',
  );
  console.log('MUTATION_DETECTED: exclusive cutover lock drains and detects an in-flight legacy receipt');
}

async function main() {
  for (const file of [
    MIGRATION_PATH,
    SHARED_HELPER_PATH,
    CUTOVER_PATH,
    TIER_SPLIT_PATH,
    ALLOCATED_CENTS_PATH,
    SMOKE_PATH,
    ...KEYED_DRAW_SMOKE_PATHS,
  ]) {
    assert.ok(existsSync(file), `missing checked-in proof input: ${file}`);
  }
  const migration = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(migration, /check_idempotency_intent/);
  assert.match(migration, /request_fingerprint = v_fingerprint/);

  try {
    docker([
      'run', '--rm', '-d', '--name', CONTAINER, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m',
      '-e', 'POSTGRES_PASSWORD=proof-only',
      IMAGE,
    ]);
    let readyStreak = 0;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const ready = docker(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { allowFailure: true },
      );
      readyStreak = ready.status === 0 ? readyStreak + 1 : 0;
      if (readyStreak >= 3) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (attempt === 179) throw new Error('PostgreSQL container did not become ready');
    }

    psql('CREATE DATABASE draw_wrapper TEMPLATE template0;');
    bootstrap('draw_wrapper', migration);
    proveAuthorization('draw_wrapper');
    proveSequential('draw_wrapper');
    await proveConcurrency('draw_wrapper');
    proveMutation(migration);
    proveIntentBoundaryGuards(migration);
    provePrerequisiteBodyGuard(migration);
    proveTransactionGuard(migration);
    proveIsolationGuard(migration);
    await proveLegacyReceiptPreflight(migration);
    restoreFullSchemaAndRunSmoke();

    console.log('DRAW_DOWN_INTENT_BINDING_PROOF_OK');
    console.log('  migration applied verbatim with preflight/postflight');
    console.log('  admin/rep allow, missing/inactive/auth/actor refusals: PASS');
    console.log('  key required plus keyed numeric, finite and empty guards: PASS');
    console.log('  exact replay, changed/non-finite quantity, changed receipt actor, deleted quote: PASS');
    console.log('  different-intent and same-intent concurrent key races: PASS');
    console.log('  exact helper/wrapper/pricing/lifecycle hashes and drift mutations: PASS');
    console.log('  single-transaction apply guard: PASS');
    console.log('  read-committed isolation guard and stale-snapshot refusal: PASS');
    console.log('  exclusive cutover drain plus unexpired legacy receipt refusal: PASS');
    console.log('  restored full schema + real money/commission/inventory rollback smokes: PASS');
    console.log('  duplicate refusal + supported id-less multi-line deferred-FK COMMIT: PASS');
    console.log('  network: none; storage: tmpfs; live Supabase: untouched');
  } finally {
    docker(['rm', '-f', CONTAINER], { allowFailure: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
