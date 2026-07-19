/**
 * Disposable, network-isolated proof for per-line split billing Phase 2.
 *
 * Safety:
 * - creates a unique container whose name must begin crx-per-line-p2-proof-;
 * - uses --network none and a tmpfs PostgreSQL data directory;
 * - uses the fixed database name crx_per_line_p2_disposable, which the SQL
 *   proof also checks before creating fixtures;
 * - loads checked-in Phase 1, relational-guard, and Phase 2 migrations verbatim; and
 * - removes the exact container in finally on PASS or FAIL.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-per-line-p2-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const DATABASE = 'crx_per_line_p2_disposable';
const PASSWORD = 'per-line-p2-disposable-only';
if (process.argv.length > 2) {
  fail(`unknown argument(s): ${process.argv.slice(2).join(', ')}`);
}

const files = {
  setup: path.join(ROOT, 'scripts', 'smoke', 'setup-per-line-split-billing-phase2.sql'),
  legacyPreview: path.join(ROOT, 'supabase', 'migrations', '20260630180000_field_app_pricing_unit_fix.sql'),
  preflight: path.join(ROOT, 'supabase', 'migrations', '20260718205500_per_line_split_billing_phase1_preflight.sql'),
  phase1: path.join(ROOT, 'supabase', 'migrations', '20260718210000_per_line_split_billing_phase1_schema.sql'),
  guards: path.join(ROOT, 'supabase', 'migrations', '20260718210500_per_line_split_billing_relational_guards.sql'),
  phase2: path.join(ROOT, 'supabase', 'migrations', '20260718211000_per_line_split_billing_phase2_calculator.sql'),
  smoke: path.join(ROOT, 'scripts', 'smoke', 'smoke-per-line-split-billing-phase2.sql'),
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
  console.log(`[phase2-proof] container=${CONTAINER} network=none database=${DATABASE}`);
  console.log('[phase2-proof] loading minimal schema + proving Phase 1 stale-object refusal');
  psql(read('setup'));
  psql(readCanonicalLegacyPreview());

  console.log('[phase2-proof] proving Phase 1 preflight rejects an unsafe function ownership collision');
  psql(`
    CREATE FUNCTION public.trg_invoice_line_share_post_snapshots_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    AS $$ BEGIN RETURN NEW; END $$;
    ALTER FUNCTION public.trg_invoice_line_share_post_snapshots_immutable()
      OWNER TO authenticated;
  `);
  const staleFunctionAttempt = psql(read('preflight'), { allowFailure: true });
  const staleFunctionOutput = `${staleFunctionAttempt.stdout || ''}${staleFunctionAttempt.stderr || ''}`;
  psql('DROP FUNCTION public.trg_invoice_line_share_post_snapshots_immutable();');
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

  console.log('[phase2-proof] loading preflight + Phase 1 migrations verbatim');
  psql(read('preflight'));
  psql(`
    INSERT INTO public.app_settings (setting_key, setting_value, description)
    VALUES ('feature_per_line_split_billing', 'true', 'stale enabled proof fixture');
  `);
  psql(read('phase1'));

  console.log('[phase2-proof] loading relational guard migration verbatim');
  psql(read('guards'));

  console.log('[phase2-proof] proving Phase 2 rejects a stale enabled flag');
  const enabledAttempt = psql(read('phase2'), { allowFailure: true });
  const enabledOutput = `${enabledAttempt.stdout || ''}${enabledAttempt.stderr || ''}`;
  if (enabledAttempt.status === 0 || !enabledOutput.includes('PER_LINE_PHASE2_REQUIRES_DISABLED_FLAG')) {
    fail('Phase 2 did not fail closed on a stale enabled feature flag', enabledOutput.trim());
  }
  psql(`
    UPDATE public.app_settings
       SET setting_value = 'false'
     WHERE setting_key = 'feature_per_line_split_billing';
  `);

  console.log('[phase2-proof] proving Phase 2 rejects a pre-existing private legacy helper');
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
    fail('Phase 2 trusted a pre-existing private legacy helper', privateDriftOutput.trim());
  }
  psql('DROP FUNCTION public._preview_field_app_invoice_split_legacy_20260718(jsonb,jsonb,uuid,uuid);');

  console.log('[phase2-proof] proving Phase 2 rejects a drifted public legacy body');
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
    fail('Phase 2 trusted a drifted public legacy preview body', bodyDriftOutput.trim());
  }
  psql(readCanonicalLegacyPreview());

  console.log('[phase2-proof] loading Phase 2 migration verbatim with flag OFF');
  psql(read('phase2'));

  const featureState = psql(`
    SELECT setting_value
    FROM public.app_settings
    WHERE setting_key = 'feature_per_line_split_billing';
  `).stdout.trim();
  if (featureState !== 'false') {
    fail(`Phase 2 migration changed the feature flag: ${featureState || '<missing>'}`);
  }

  console.log('[phase2-proof] running rollback-only hard proofs');
  const proof = psql(read('smoke'), { allowFailure: true });
  const output = `${proof.stdout || ''}${proof.stderr || ''}`;
  if (proof.status === 0 || !output.includes('SMOKE_PASS_ROLLBACK')) {
    fail('Phase 2 rollback proof did not reach its PASS marker', output.trim());
  }

  console.log('PROOF — Ran: network-isolated PostgreSQL 17 container; loaded checked-in Phase 1 preflight + Phase 1 + relational guards + Phase 2 migrations verbatim; executed rollback-only Phase 2 SQL proof.');
  console.log('PROOF — Saw: stale Phase 1 objects and unsafe same-signature function ownership rejected before install; installed function owner/definer/search-path/volatility/language/ACL posture asserted; stale enabled flag rejected before Phase 2 install; pre-existing private helper, drifted public legacy body, and authenticated caller-owned predictable temp helper rejected; feature OFF delegated unchanged; owning-vs-other sales-rep job/invoice/field scope; exact null-safe invoice/job binding and direct-invoice field binding; 50/50; exact 3-way; 1-cent; one final money rounding after full-precision conversion; signed half-cent sales -13 => -7/-6 plus signed COGS -25 => -13/-12 persisted through the durable graph; penny-exact residual COGS preserving a 1c source across 50/50 children; exact job-chemical identity/quantity/unit/price/COGS snapshots, including coherent quantity/price/provenance rewrite rejection, duplicate products, ignored browser price tampering, rejected nullable/negative frozen prices, and a reconciled ounce-unit price pair; complete job-field-set enforcement; exact durable job-chemical/service completeness; frozen job/invoice application-service identity; customer-supplied $0/COGS; non-job manual -> customer/season/lifecycle-bound quote -> tier with quote prices normalized from their paired unit, unconvertible quote units rejected, complete contributing-field coverage required, zero-share-field quotes ignored, missing product cost rejected while explicit zero cost remains valid, ambiguous quote price/source rejected, and stale/unrelated quotes ignored; source-season service pricing; per-person override; default effective prices remain bound to their base; 100/0 zero row; exact flat-fee output persisted with production-shaped non-null child quantity 1, kind/basis coupling, and tamper rejection; job/default/fallback ownership; job field/chemical identity rejection; exact grouped and ungrouped child-invoice membership; share/item quantity, rounded acres, effective price, chemical product, service identity, pricing unit, per-unit COGS, allocated COGS, amount, and header-cost parity; immutable posted source/item identity/unit/COGS; zero-sendable rejection plus valid suppressed-zero snapshot; exact group-customer set; unshared item; source cents/quantity/acres/COGS; invoice header and pre-post integrity rejection; hashes bind product/service identity, price provenance, allocated COGS, override modes, and reasons; Mode A/vector/role rejection; one public preview overload; private calculator not browser-executable; cleanup failure is fatal.');
}

try {
  run();
} finally {
  assertSafeContainerName();
  const removed = docker(['rm', '--force', CONTAINER], { allowFailure: true });
  if (removed.status === 0) {
    console.log(`[phase2-proof] removed disposable container ${CONTAINER}`);
  } else {
    fail(`Could not remove disposable container ${CONTAINER}`, removed.stderr || removed.stdout);
  }
}
