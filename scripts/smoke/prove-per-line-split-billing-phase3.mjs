/**
 * Disposable, network-isolated proof for per-line split billing Phase 3.
 *
 * Safety:
 * - creates a unique container whose name must begin crx-per-line-p3-proof-;
 * - uses --network none and a tmpfs PostgreSQL data directory;
 * - uses the fixed database name crx_per_line_p3_disposable, which the SQL
 *   proof also checks before creating fixtures;
 * - loads checked-in Phase 1, relational-guard, and Phase 3 migrations verbatim; and
 * - removes the exact container in finally on PASS or FAIL.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-per-line-p3-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const DATABASE = 'crx_per_line_p3_disposable';
const PASSWORD = 'per-line-p3-disposable-only';
if (process.argv.length > 2) {
  fail(`unknown argument(s): ${process.argv.slice(2).join(', ')}`);
}

const files = {
  setup: path.join(ROOT, 'scripts', 'smoke', 'setup-per-line-split-billing-phase2.sql'),
  legacyPreview: path.join(ROOT, 'supabase', 'migrations', '20260630180000_field_app_pricing_unit_fix.sql'),
  transferSource: path.join(ROOT, 'supabase', 'migrations', '20260713060000_harden_field_split_sum100.sql'),
  preflight: path.join(ROOT, 'supabase', 'migrations', '20260720230000_per_line_split_billing_phase1_preflight.sql'),
  phase1: path.join(ROOT, 'supabase', 'migrations', '20260720231000_per_line_split_billing_phase1_schema.sql'),
  guards: path.join(ROOT, 'supabase', 'migrations', '20260720232000_per_line_split_billing_relational_guards.sql'),
  phase2: path.join(ROOT, 'supabase', 'migrations', '20260720233000_per_line_split_billing_phase2_calculator.sql'),
  phase3: path.join(ROOT, 'supabase', 'migrations', '20260720234000_per_line_split_billing_phase3_writer.sql'),
  smoke: path.join(ROOT, 'scripts', 'smoke', 'smoke-per-line-split-billing-phase3.sql'),
};

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function assertSafeContainerName() {
  if (!CONTAINER.startsWith(PREFIX) || !/^[a-z0-9][a-z0-9_.-]+$/.test(CONTAINER)) {
    fail(`refusing unsafe disposable container name: ${CONTAINER}`);
  }
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`docker could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(
      `docker ${args.join(' ')} failed with exit ${result.status}`,
      `${result.stdout || ''}${result.stderr || ''}`.trim(),
    );
  }
  return result;
}

function psql(sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', CONTAINER,
    'psql', '-U', 'postgres', '-d', DATABASE,
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql, allowFailure });
}

function read(name) {
  return readFileSync(files[name], 'utf8');
}

function readCanonicalLegacyPreview() {
  // Supabase's migration runner stores the checked-in body with LF newlines.
  // Normalize the Windows checkout before piping it into Linux PostgreSQL so
  // md5(pg_proc.prosrc) matches the live canonical fingerprint exactly.
  const source = read('legacyPreview').replace(/\r\n/g, '\n');
  const startMarker = 'CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split';
  const endMarker = '$function$;';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    fail('could not extract canonical legacy preview definition');
  }
  return `${source.slice(start, end + endMarker.length)}
REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid)
  TO authenticated, service_role;
`;
}

function readCanonicalTransfer() {
  const source = read('transferSource').replace(/\r\n/g, '\n');
  const startMarker = 'CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice';
  const endMarker = '$function$;';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) fail('could not extract canonical transfer definition');
  return `${source.slice(start, end + endMarker.length)}
REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) TO authenticated, service_role;
`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startContainer() {
  assertSafeContainerName();
  const existing = docker(['container', 'inspect', CONTAINER], { allowFailure: true });
  if (existing.status === 0) fail(`refusing to reuse container ${CONTAINER}`);

  docker([
    'run', '--detach', '--name', CONTAINER,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
    '--env', `POSTGRES_DB=${DATABASE}`,
    IMAGE,
  ]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = docker(
      ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE],
      { allowFailure: true },
    );
    if (ready.status === 0) {
      sleep(1500);
      const stable = docker(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE],
        { allowFailure: true },
      );
      if (stable.status === 0) return;
    }
    sleep(250);
  }
  fail('disposable PostgreSQL container did not become ready within 30 seconds');
}

function run() {
  startContainer();
  console.log(`[phase3-proof] container=${CONTAINER} network=none database=${DATABASE}`);
  console.log('[phase3-proof] loading minimal schema + proving Phase 1 stale-object refusal');
  psql(read('setup'));
  psql(`
    ALTER TABLE public.invoices
      ADD COLUMN invoice_number text,
      ADD COLUMN invoice_type text,
      ADD COLUMN invoice_date date,
      ADD COLUMN header_notes text,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.invoice_items
      ADD COLUMN description text NOT NULL DEFAULT '',
      ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
      ADD COLUMN rate_per_acre numeric,
      ADD COLUMN rate_unit text,
      ADD COLUMN is_application_fee boolean DEFAULT false,
      ADD COLUMN price_source text,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    CREATE SEQUENCE public.invoice_number_proof_seq;
    CREATE FUNCTION public.next_invoice_number()
    RETURNS text LANGUAGE sql VOLATILE SET search_path = public, pg_temp
    AS $$ SELECT 'INV-P3-' || nextval('public.invoice_number_proof_seq')::text $$;
    CREATE TABLE public.invoice_shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES public.customers(id),
      customer_name text,
      split_percentage numeric,
      acres numeric,
      amount_cents bigint,
      is_primary boolean,
      sort_order integer
    );
    CREATE TABLE public.field_app_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid REFERENCES public.invoices(id) ON DELETE CASCADE,
      invoice_group_id uuid,
      field_id uuid NOT NULL REFERENCES public.fields(id),
      map_number integer,
      total_acres numeric,
      planted_acres numeric,
      applied_acres numeric,
      crop_type text,
      wind_direction text,
      sort_order integer
    );
    CREATE TABLE public.field_app_location_shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES public.field_app_locations(id) ON DELETE CASCADE,
      customer_id uuid NOT NULL REFERENCES public.customers(id),
      split_pct numeric,
      acres numeric,
      amount_cents bigint
    );
    CREATE TABLE public.activity_feed (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL,
      description text,
      performed_by uuid,
      related_entity_type text,
      related_entity_id uuid
    );
    CREATE TABLE public.financial_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      operation_type text NOT NULL,
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      actor_user_id uuid NOT NULL,
      actor_role text,
      new_values jsonb,
      total_impact_cents bigint,
      description text
    );
    CREATE TABLE public.idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key text NOT NULL,
      operation text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (idempotency_key, operation)
    );
  `);
  psql(readCanonicalLegacyPreview());

  console.log('[phase3-proof] proving Phase 1 preflight rejects an unsafe function ownership collision');
  psql(`
    CREATE FUNCTION public.can_read_field_app_billing_set(uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY INVOKER
    AS $$ SELECT false $$;
    ALTER FUNCTION public.can_read_field_app_billing_set(uuid)
      OWNER TO authenticated;
  `);
  const staleFunctionAttempt = psql(read('preflight'), { allowFailure: true });
  const staleFunctionOutput = `${staleFunctionAttempt.stdout || ''}${staleFunctionAttempt.stderr || ''}`;
  psql('DROP FUNCTION public.can_read_field_app_billing_set(uuid);');
  if (
    staleFunctionAttempt.status === 0
    || !staleFunctionOutput.includes('PER_LINE_PHASE1_FUNCTION_DRIFT')
  ) {
    fail('Phase 1 preflight did not reject an unsafe function ownership collision', staleFunctionOutput.trim());
  }

  psql(`
    CREATE TABLE public.field_app_billing_sets (id uuid PRIMARY KEY);
    CREATE UNIQUE INDEX uq_field_app_billing_sets_group
      ON public.field_app_billing_sets (id);
  `);
  const staleObjectAttempt = psql(read('preflight'), { allowFailure: true });
  const staleObjectOutput = `${staleObjectAttempt.stdout || ''}${staleObjectAttempt.stderr || ''}`;
  if (
    staleObjectAttempt.status === 0
    || !staleObjectOutput.includes('PER_LINE_PHASE1_SCHEMA_DRIFT')
  ) {
    fail('Phase 1 preflight did not reject stale weaker objects', staleObjectOutput.trim());
  }
  psql('DROP TABLE public.field_app_billing_sets CASCADE;');

  psql(`
    CREATE UNIQUE INDEX uq_field_app_billing_sets_group
      ON public.invoices (id);
  `);
  const staleIndexAttempt = psql(read('preflight'), { allowFailure: true });
  const staleIndexOutput = `${staleIndexAttempt.stdout || ''}${staleIndexAttempt.stderr || ''}`;
  if (
    staleIndexAttempt.status === 0
    || !staleIndexOutput.includes('PER_LINE_PHASE1_SCHEMA_DRIFT')
  ) {
    fail('Phase 1 preflight did not reject a stale weaker index', staleIndexOutput.trim());
  }
  psql('DROP INDEX public.uq_field_app_billing_sets_group;');

  psql('ALTER TABLE public.invoices ADD COLUMN send_disposition text;');
  const staleColumnAttempt = psql(read('preflight'), { allowFailure: true });
  const staleColumnOutput = `${staleColumnAttempt.stdout || ''}${staleColumnAttempt.stderr || ''}`;
  if (
    staleColumnAttempt.status === 0
    || !staleColumnOutput.includes('PER_LINE_PHASE1_SCHEMA_DRIFT')
  ) {
    fail('Phase 1 preflight did not reject a stale invoice column', staleColumnOutput.trim());
  }
  psql('ALTER TABLE public.invoices DROP COLUMN send_disposition;');

  console.log('[phase3-proof] proving Phase 1 rejects a stale enabled flag');
  psql(read('preflight'));
  psql(`
    INSERT INTO public.app_settings (setting_key, setting_value, description)
    VALUES ('feature_per_line_split_billing', 'true', 'stale enabled proof fixture');
  `);
  const phase1EnabledAttempt = psql(read('phase1'), { allowFailure: true });
  const phase1EnabledOutput = `${phase1EnabledAttempt.stdout || ''}${phase1EnabledAttempt.stderr || ''}`;
  if (
    phase1EnabledAttempt.status === 0
    || !phase1EnabledOutput.includes('PER_LINE_SPLIT_BILLING_FLAG_MUST_BE_OFF')
  ) {
    fail('Phase 1 did not fail closed on a stale enabled feature flag', phase1EnabledOutput.trim());
  }
  const preservedEnabledFlag = psql(`
    SELECT setting_value
      FROM public.app_settings
     WHERE setting_key = 'feature_per_line_split_billing';
  `).stdout.trim();
  if (preservedEnabledFlag !== 'true') {
    fail('Phase 1 enabled-flag rejection did not preserve the pre-existing setting', preservedEnabledFlag);
  }
  psql("DELETE FROM public.app_settings WHERE setting_key = 'feature_per_line_split_billing';");

  console.log('[phase3-proof] loading Phase 1 migration verbatim with the flag absent');
  psql(read('phase1'));

  console.log('[phase3-proof] loading relational guard migration verbatim');
  psql(read('guards'));

  console.log('[phase3-proof] proving Phase 3 rejects a stale enabled flag');
  psql(`
    UPDATE public.app_settings
       SET setting_value = 'true'
     WHERE setting_key = 'feature_per_line_split_billing';
  `);
  const enabledAttempt = psql(read('phase2'), { allowFailure: true });
  const enabledOutput = `${enabledAttempt.stdout || ''}${enabledAttempt.stderr || ''}`;
  if (enabledAttempt.status === 0 || !enabledOutput.includes('PER_LINE_PHASE2_REQUIRES_DISABLED_FLAG')) {
    fail('Phase 3 did not fail closed on a stale enabled feature flag', enabledOutput.trim());
  }
  psql(`
    UPDATE public.app_settings
       SET setting_value = 'false'
     WHERE setting_key = 'feature_per_line_split_billing';
  `);

  console.log('[phase3-proof] proving Phase 3 rejects a pre-existing private legacy helper');
  psql(`
    CREATE FUNCTION public._preview_field_app_invoice_split_legacy_20260718(
      jsonb, jsonb, uuid, uuid
    ) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$ SELECT '{}'::jsonb $$;
  `);
  const privateDriftAttempt = psql(read('phase2'), { allowFailure: true });
  const privateDriftOutput = `${privateDriftAttempt.stdout || ''}${privateDriftAttempt.stderr || ''}`;
  if (privateDriftAttempt.status === 0 || !privateDriftOutput.includes('PER_LINE_LEGACY_HELPER_DRIFT')) {
    fail('Phase 3 trusted a pre-existing private legacy helper', privateDriftOutput.trim());
  }
  psql('DROP FUNCTION public._preview_field_app_invoice_split_legacy_20260718(jsonb,jsonb,uuid,uuid);');

  console.log('[phase3-proof] proving Phase 3 rejects a drifted public legacy body');
  psql(`
    CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split(
      p_locations jsonb,
      p_chemicals jsonb,
      p_application_service_id uuid DEFAULT NULL::uuid,
      p_invoice_id uuid DEFAULT NULL::uuid
    ) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$ SELECT '{"drifted":true}'::jsonb $$;
  `);
  const bodyDriftAttempt = psql(read('phase2'), { allowFailure: true });
  const bodyDriftOutput = `${bodyDriftAttempt.stdout || ''}${bodyDriftAttempt.stderr || ''}`;
  if (bodyDriftAttempt.status === 0 || !bodyDriftOutput.includes('PER_LINE_LEGACY_PREVIEW_DRIFT')) {
    fail('Phase 3 trusted a drifted public legacy preview body', bodyDriftOutput.trim());
  }
  psql(readCanonicalLegacyPreview());

  console.log('[phase3-proof] loading Phase 2 calculator verbatim with flag OFF');
  psql(read('phase2'));
  psql(readCanonicalTransfer());
  console.log('[phase3-proof] loading Phase 3 writer verbatim with flag OFF');
  psql(read('phase3'));

  const featureState = psql(`
    SELECT setting_value
    FROM public.app_settings
    WHERE setting_key = 'feature_per_line_split_billing';
  `).stdout.trim();
  if (featureState !== 'false') {
    fail(`Phase 3 migration changed the feature flag: ${featureState || '<missing>'}`);
  }

  console.log('[phase3-proof] running rollback-only hard proofs');
  const proof = psql(read('smoke'), { allowFailure: true });
  const output = `${proof.stdout || ''}${proof.stderr || ''}`;
  if (proof.status === 0 || !output.includes('SMOKE_PASS_ROLLBACK')) {
    fail('Phase 3 rollback proof did not reach its PASS marker', output.trim());
  }

  console.log('PROOF — Ran: network-isolated PostgreSQL 17 container; loaded checked-in preflight + Phase 1 + relational guards + Phase 2 calculator + Phase 3 writer verbatim; executed rollback-only Phase 3 SQL proof.');
  console.log('PROOF — Saw: all Phase 2 calculator and relational-integrity cases remained green; the Phase 3 writer persisted the calculator-only 100/0 service plan as two real invoices/items/shares, rebuilt existing grouped and single-recipient invoices without restricted-FK failure, orphaned lines, or duplicate shares, preserved a zero-dollar suppressed child, posted both group members together with an immutable zero snapshot, replayed an identical key without duplicate rows, rejected the same key with changed payload, rejected a header mismatch, blocked transfer_job_to_invoice while the feature was ON, and retained owner/definer/search-path/ACL plus cleanup-failure guards.');
}

try {
  run();
} finally {
  assertSafeContainerName();
  const removed = docker(['rm', '--force', CONTAINER], { allowFailure: true });
  if (removed.status === 0) {
    console.log(`[phase3-proof] removed disposable container ${CONTAINER}`);
  } else {
    fail(`Could not remove disposable container ${CONTAINER}`, removed.stderr || removed.stdout);
  }
}
