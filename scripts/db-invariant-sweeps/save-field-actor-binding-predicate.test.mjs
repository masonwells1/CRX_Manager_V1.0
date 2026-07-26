#!/usr/bin/env node
/**
 * Disposable PG17 proof for the narrow save_field actor-binding predicate. It
 * starts from the live-shaped five-argument unsafe body, adversarially proves
 * token/dead-string and post-write guards still fail, then applies the exact
 * checked-in migration and requires zero rows. No Supabase URL is contacted.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'save-field-actor-binding.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260725234503_harden_section1_number_and_field_actor.sql');
const PREFIX = 'crx-save-field-actor-predicate-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const VIOLATION = 'save_field(uuid, jsonb, jsonb, uuid, text)';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result;
}
function psql(sql) {
  return docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tAX'], { input: sql });
}
function rows() {
  const text = psql(readFileSync(PREDICATE, 'utf8')).stdout.trim();
  return text ? text.split(/\r?\n/) : [];
}
function createSaveField(body) {
  psql(`
CREATE OR REPLACE FUNCTION public.save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_field_id uuid := gen_random_uuid(); v_actor uuid;
BEGIN
${body}
  RETURN v_field_id;
END;
$function$;
`);
}

try {
  assert.ok(existsSync(PREDICATE), `missing predicate: ${PREDICATE}`);
  assert.ok(existsSync(MIGRATION), `missing exact migration: ${MIGRATION}`);
  docker(['run', '--detach', '--name', CONTAINER, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m', '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine']);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  psql(`
CREATE EXTENSION pgcrypto;
CREATE SCHEMA auth;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, is_active boolean, created_at timestamptz DEFAULT now());
CREATE TABLE public.application_records (record_number text); CREATE TABLE public.commission_payments (payment_number text); CREATE TABLE public.cycle_counts (count_number text); CREATE TABLE public.deliveries (delivery_number text); CREATE TABLE public.jobs (job_number text); CREATE TABLE public.purchase_orders (po_number text);
CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_name text);
CREATE TABLE public.fields (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, field_name text, legal_description text, county text, state text, total_acres numeric, fsa_farm_number text, fsa_tract_number text, fsa_field_number text, crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean);
CREATE TABLE public.field_billing_defaults (field_id uuid, customer_id uuid, split_pct numeric, is_primary boolean, notes text, price_override_cents bigint, pricing_note text);
CREATE TABLE public.activity_feed (event_type text, description text, performed_by uuid, related_entity_type text, related_entity_id uuid);
CREATE TABLE public.idempotency_keys (idempotency_key text, operation text, result jsonb);
CREATE FUNCTION public.require_admin_or_sales_rep() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE FUNCTION public.check_idempotency(text, text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.save_idempotency(text, text, jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000001', 'admin', true, now());
`);
  createSaveField(`
  /* v_actor := auth.uid();
     IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
       RAISE EXCEPTION 'ACTOR_MISMATCH';
     END IF;
     INSERT INTO activity_feed (performed_by) VALUES (v_actor); */
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'comment fake guard', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'full fake bind/guard in a block comment must be unsafe');
  createSaveField(`
  PERFORM 'v_actor := auth.uid(); IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION ''ACTOR_MISMATCH''; END IF; INSERT INTO activity_feed (performed_by) VALUES (v_actor);';
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'dead-string fake guard', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'full fake bind/guard in a dead string must be unsafe');
  createSaveField(`
  PERFORM $dead$
    v_actor := auth.uid();
    IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
    INSERT INTO activity_feed (performed_by) VALUES (v_actor);
  $dead$;
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'tagged dollar fake guard', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'full fake bind/guard in a tagged dollar-quoted literal must be unsafe');
  createSaveField(`
  PERFORM $$
    v_actor := auth.uid();
    IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
    INSERT INTO activity_feed (performed_by) VALUES (v_actor);
  $$;
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'untagged dollar fake guard', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'full fake bind/guard in an untagged dollar-quoted literal must be unsafe');
  createSaveField(`
  /* $dead$ */
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'comment bracket attack', p_performed_by, 'field', v_field_id);
  /* $dead$ */
  v_actor := auth.uid();
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'later safe-looking sink', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'comment-contained dollar tokens must not bracket away an unsafe executable sink');
  createSaveField(`
  PERFORM '$dead$';
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'string bracket attack', p_performed_by, 'field', v_field_id);
  PERFORM '$dead$';
  v_actor := auth.uid();
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'later safe-looking sink', v_actor, 'field', v_field_id);`);
  assert.deepEqual(rows(), [VIOLATION], 'string-contained dollar tokens must not bracket away an unsafe executable sink');
  createSaveField(`
  v_actor := auth.uid();
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('field_saved', 'late guard', p_performed_by, 'field', v_field_id);
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;`);
  assert.deepEqual(rows(), [VIOLATION], 'a guard after the caller-trusted write must be unsafe');
  psql(readFileSync(MIGRATION, 'utf8'));
  assert.equal(
    psql("SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure").stdout.trim(),
    '10a53c6b4c218a3836b0a5269fc558cc214eb8741a2df6669133885919f50ff2',
    'exact migration must emit the reviewed SHA-256 body'
  );
  assert.deepEqual(rows(), [], 'exact migration must satisfy the narrow actor-binding contract');
  const secureDefinition = psql("SELECT pg_get_functiondef('public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure)").stdout;
  const alteredDefinition = secureDefinition.replace('RETURN v_field_id;', 'RETURN v_field_id ;');
  assert.notEqual(alteredDefinition, secureDefinition, 'secure-body alteration fixture must modify the definition');
  psql(alteredDefinition);
  assert.deepEqual(rows(), [VIOLATION], 'any alteration to the reviewed secure body must fail closed');
  console.log('SAVE_FIELD_ACTOR_BINDING_PREDICATE_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) docker(['rm', '--force', CONTAINER], { allowFailure: true });
}
