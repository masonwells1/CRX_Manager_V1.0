/**
 * Disposable PostgreSQL 17 behavioral proof for the parked transfer invoice
 * intent wrapper. The container has --network none and tmpfs storage: it cannot
 * contact Supabase or retain data. A compact faithful fixture stands in for the
 * large Chicago-date body; the static proof separately pins the real preimage.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWrappable } from '../../.claude/hooks/migration-wrappability-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '20260908120000_bind_transfer_invoice_intent.sql');
const name = `crx-transfer-intent-${process.pid}`;
const image = 'postgres:17-alpine';
const temp = mkdtempSync(path.join(os.tmpdir(), 'crx-transfer-intent-'));
const DOCKER_TIMEOUT_MS = 10 * 60 * 1000;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? DOCKER_TIMEOUT_MS,
  });
  if (result.error && !options.allowFailure) {
    const code = result.error.code ? ` (${result.error.code})` : '';
    throw new Error(`docker ${args.join(' ')} could not complete${code}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}
function sql(source) {
  return docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: source }).stdout;
}
function scalar(source) {
  return docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atqc', source]).stdout.trim();
}
async function ready() {
  for (let i = 0; i < 40; i += 1) {
    if (docker(['exec', name, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('disposable PostgreSQL did not become ready');
}

const setup = `
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, is_active boolean NOT NULL);
CREATE TABLE public.idempotency_keys (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  result jsonb,
  request_actor_id uuid,
  request_fingerprint text,
  expires_at timestamptz
);
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No direct client access to idempotency keys"
  ON public.idempotency_keys
  FOR ALL
  TO public
  USING (false)
  WITH CHECK (false);
GRANT SELECT ON public.idempotency_keys TO anon;
GRANT ALL ON public.idempotency_keys TO authenticated, service_role;
CREATE TABLE public.transfer_calls (count integer NOT NULL);
INSERT INTO public.transfer_calls VALUES (0);
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', true),
  ('00000000-0000-0000-0000-000000000002', 'sales_rep', true),
  ('00000000-0000-0000-0000-000000000003', 'sales_rep', false);
CREATE FUNCTION public.check_idempotency_intent(p_key text, p_operation text, p_actor uuid, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fixture_helper$
DECLARE v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_key, 0));
  DELETE FROM public.idempotency_keys WHERE idempotency_key = p_key AND expires_at < now();
  SELECT * INTO v_existing FROM public.idempotency_keys WHERE idempotency_key = p_key;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
  END IF;
  IF v_existing.request_actor_id IS NULL AND v_existing.request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
  END IF;
  IF v_existing.request_actor_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
  END IF;
  IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
  END IF;
  RETURN jsonb_build_object('found', true, 'result', v_existing.result);
END;
$fixture_helper$;
REVOKE ALL ON FUNCTION public.check_idempotency_intent(text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_idempotency_intent(text,text,uuid,text) TO postgres;
COMMENT ON FUNCTION public.check_idempotency_intent(text,text,uuid,text) IS
  'Intent-bound idempotency receipt check. NULL = no receipt; {"found":true,"result":...} = exact actor+intent replay; raises IDEMPOTENCY_ACTOR_MISMATCH / IDEMPOTENCY_INTENT_MISMATCH otherwise. Callers must already have authorized the actor.';
CREATE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fixture_transfer$
DECLARE v_result jsonb;
BEGIN
  UPDATE public.transfer_calls SET count = count + 1;
  v_result := CASE WHEN p_job_id = '20000000-0000-0000-0000-000000000001'::uuid
    THEN jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', gen_random_uuid(),
                            'invoice_ids', jsonb_build_array(gen_random_uuid(), gen_random_uuid()))
    ELSE jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', gen_random_uuid()) END;
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_keys(idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'transfer_job_to_invoice', v_result, now() + interval '1 hour');
  END IF;
  RETURN v_result;
END;
$fixture_transfer$;
REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) TO authenticated, service_role;
`;

try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m', '-e', 'POSTGRES_PASSWORD=postgres', image]);
  await ready();
  sql(setup);

  const fixtureTransferMd5 = scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.transfer_job_to_invoice(uuid,uuid,text)'::regprocedure");
  const fixtureHelperMd5 = scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.check_idempotency_intent(text,text,uuid,text)'::regprocedure");
  const fixtureHelperSha = scalar("SELECT encode(extensions.digest(convert_to(prosrc, 'UTF8'), 'sha256'), 'hex') FROM pg_proc WHERE oid = 'public.check_idempotency_intent(text,text,uuid,text)'::regprocedure");
  assert.match(fixtureTransferMd5, /^[0-9a-f]{32}$/);
  assert.match(fixtureHelperMd5, /^[0-9a-f]{32}$/);
  assert.match(fixtureHelperSha, /^[0-9a-f]{64}$/);

  const staged = readFileSync(migrationPath, 'utf8')
    .replaceAll('85cd07a0a6b978cb066edab7df369fea', fixtureTransferMd5)
    .replaceAll('edc73be809069669e8441eba7acf443d', fixtureHelperMd5)
    .replaceAll('71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8', fixtureHelperSha);
  assertWrappable(staged, path.basename(migrationPath));
  const stagedPath = path.join(temp, 'migration.sql');
  writeFileSync(stagedPath, staged, 'utf8');
  docker(['cp', stagedPath, `${name}:/tmp/migration.sql`]);

  // The SQL enforces the sanctioned runner's one-transaction assumption.
  // Autocommit must fail before installing a guard or renaming the public RPC.
  let refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /crx_transfer_invoice_intent_transaction_guard/);
  assert.equal(scalar("SELECT to_regprocedure('public.prevent_unwrapped_transfer_invoice_receipt_20260908()') IS NULL"), 't');
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.transfer_job_to_invoice(uuid,uuid,text)'::regprocedure"), fixtureTransferMd5);

  // Every first-apply drift guard must visibly refuse without renaming the
  // public function. These are independent disposable attempts, then cleanup.
  sql('ALTER TABLE public.idempotency_keys DISABLE ROW LEVEL SECURITY');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY');

  sql('DROP POLICY "No direct client access to idempotency keys" ON public.idempotency_keys');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('CREATE POLICY "No direct client access to idempotency keys" ON public.idempotency_keys FOR ALL TO public USING (false) WITH CHECK (false)');

  sql('GRANT INSERT ON public.idempotency_keys TO anon');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('REVOKE INSERT ON public.idempotency_keys FROM anon');

  sql('ALTER ROLE authenticated BYPASSRLS');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('ALTER ROLE authenticated NOBYPASSRLS');

  sql('CREATE ROLE drifted_bypass BYPASSRLS; GRANT drifted_bypass TO authenticated');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('REVOKE drifted_bypass FROM authenticated; DROP ROLE drifted_bypass');

  sql('CREATE ROLE drifted_receipt_owner; ALTER TABLE public.idempotency_keys OWNER TO drifted_receipt_owner');
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /idempotency receipt owner, RLS, deny policy, role posture, or client write ACL drifted/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('ALTER TABLE public.idempotency_keys OWNER TO postgres; DROP ROLE drifted_receipt_owner');

  sql("INSERT INTO public.idempotency_keys(idempotency_key, operation, result, expires_at) VALUES ('legacy', 'transfer_job_to_invoice', '{}'::jsonb, now() + interval '1 hour')");
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /unexpired legacy transfer_job_to_invoice receipts exist/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql("DELETE FROM public.idempotency_keys WHERE idempotency_key = 'legacy'");
  sql("INSERT INTO public.idempotency_keys(idempotency_key, operation, result, expires_at) VALUES ('legacy-null-expiry', 'transfer_job_to_invoice', '{}'::jsonb, NULL)");
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /unexpired legacy transfer_job_to_invoice receipts exist/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql("DELETE FROM public.idempotency_keys WHERE idempotency_key = 'legacy-null-expiry'");
  sql("CREATE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text, p_extra text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /transfer function overload drift detected/);
  assert.equal(scalar("SELECT to_regprocedure('public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)') IS NULL"), 't');
  sql('DROP FUNCTION public.transfer_job_to_invoice(uuid,uuid,text,text)');
  sql("CREATE FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(p_job_id uuid, p_performed_by uuid, p_idempotency_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
  refused = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql'], { allowFailure: true });
  assert.match(refused.stderr, /private transfer implementation drifted/);
  sql('DROP FUNCTION public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)');
  docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql']);

  // A transaction that cached the legacy body before cutover can reach its
  // receipt INSERT after the DDL commits. The permanent trigger must reject
  // that unbound receipt and roll the whole stale implementation call back.
  refused = docker([
    'exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT public._transfer_job_to_invoice_intent_impl_20260908('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'stale-cutover')",
  ], { allowFailure: true });
  assert.match(refused.stderr, /TRANSFER_INVOICE_INTENT_CUTOVER_RETRY/);
  assert.equal(scalar('SELECT count FROM public.transfer_calls'), '0', 'stale implementation work must roll back');
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'stale-cutover'"), '0', 'stale unbound receipt must not land');
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.idempotency_keys'::regclass AND tgname = 'trg_idempotency_keys_require_transfer_intent_20260908' AND NOT tgisinternal AND tgenabled = 'O'"), '1');

  // Exact replay runs the implementation once; altered job or actor reaches the helper mismatch.
  sql(`
DO $proof$
DECLARE
  v_actor uuid := '00000000-0000-0000-0000-000000000001';
  v_other uuid := '00000000-0000-0000-0000-000000000002';
  v_job uuid := '10000000-0000-0000-0000-000000000001';
  v_other_job uuid := '20000000-0000-0000-0000-000000000001';
  v_one jsonb;
  v_two jsonb;
  v_split jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, v_actor, NULL); RAISE EXCEPTION 'missing key accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, v_actor, '   '); RAISE EXCEPTION 'blank key accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, v_other, 'actor'); RAISE EXCEPTION 'forged actor accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'ACTOR_MISMATCH' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, '00000000-0000-0000-0000-000000000003', 'inactive'); RAISE EXCEPTION 'inactive actor accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'INSUFFICIENT_ROLE' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  v_one := public.transfer_job_to_invoice(v_job, v_actor, 'exact-replay');
  v_two := public.transfer_job_to_invoice(v_job, v_actor, 'exact-replay');
  IF v_one IS DISTINCT FROM v_two OR (SELECT count FROM public.transfer_calls) <> 1 THEN
    RAISE EXCEPTION 'exact replay did not return the original result exactly once';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = 'exact-replay'
                 AND request_actor_id = v_actor AND request_fingerprint IS NOT NULL) THEN
    RAISE EXCEPTION 'receipt was not bound to actor and fingerprint';
  END IF;
  BEGIN PERFORM public.transfer_job_to_invoice(v_other_job, v_actor, 'exact-replay'); RAISE EXCEPTION 'job mismatch replay accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'IDEMPOTENCY_INTENT_MISMATCH' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, v_other, 'exact-replay'); RAISE EXCEPTION 'actor mismatch replay accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'IDEMPOTENCY_ACTOR_MISMATCH' THEN RAISE; END IF; END;
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result, request_actor_id, request_fingerprint, expires_at)
  VALUES ('cross-op', 'other_operation', '{}'::jsonb, v_actor, 'other', now() + interval '1 hour');
  BEGIN PERFORM public.transfer_job_to_invoice(v_job, v_actor, 'cross-op'); RAISE EXCEPTION 'cross-operation key reuse accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'IDEMPOTENCY_CROSS_OP_KEY_REUSE' THEN RAISE; END IF; END;
  v_split := public.transfer_job_to_invoice(v_other_job, v_actor, 'split-replay');
  IF v_split -> 'invoice_ids' IS NULL OR public.transfer_job_to_invoice(v_other_job, v_actor, 'split-replay') IS DISTINCT FROM v_split
     OR (SELECT count FROM public.transfer_calls) <> 2 THEN
    RAISE EXCEPTION 'split result was not preserved exactly or was executed twice';
  END IF;
END;
$proof$;
  `);
  // Replay the same migration: exact wrapper state is accepted, not re-wrapped.
  docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/migration.sql']);
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'transfer_job_to_invoice'"), '1');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_transfer_job_to_invoice_intent_impl_20260908'"), '1');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'prevent_unwrapped_transfer_invoice_receipt_20260908'"), '1');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public._transfer_job_to_invoice_intent_impl_20260908(uuid,uuid,text)', 'EXECUTE')"), 'f');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.prevent_unwrapped_transfer_invoice_receipt_20260908()', 'EXECUTE')"), 'f');
  console.log('TRANSFER_INVOICE_INTENT_BINDING_PROOF_PASS');
} finally {
  docker(['rm', '--force', name], { allowFailure: true });
  rmSync(temp, { recursive: true, force: true });
}
