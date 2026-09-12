#!/usr/bin/env node
/** Real detector/catalog/matcher mutation proof; only a named, networkless disposable database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSweepQuery, functionContractSql, subtractAllowlist } from './allowlist-match.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const container = `crx-actor-allowlist-${process.pid}-${Date.now().toString(36)}`;
const predicate = { name: 'actor-forgery', sql: readFileSync(new URL('./predicates/actor-forgery.sql', import.meta.url), 'utf8') };
const deliveryKey = 'complete_delivery(p_signed_by text, p_performed_by uuid)';
const wrapperKey = 'wrapped_actor(p_performed_by uuid)';
const delegateKey = 'public.owner_only_actor(p_performed_by uuid)';
let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`Disposable Docker command failed: ${result.stderr || result.stdout}`);
  return result;
}
function psql(sql) {
  return docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-tAX', '-v', 'ON_ERROR_STOP=1'], { input: sql }).stdout.trim();
}
function catalog(keys) { return JSON.parse(psql(`SELECT COALESCE(json_agg(c), '[]'::json) FROM (${functionContractSql(keys)}) AS c;`)); }
function pin(violation_key, suspect_param, dependencies) {
  const keys = [`public.${violation_key}`, 'auth.uid()', ...dependencies];
  const contracts = catalog(keys);
  check(contracts.length === keys.length, 'every fixture dependency is resolved by exact identity');
  return { predicate: predicate.name, violation_key, suspect_param,
    reviewed_contracts: Object.fromEntries(contracts.map((row) => [row.function_key, row.contract_md5])) };
}
function sweep(entries) {
  const packet = JSON.parse(psql(buildSweepQuery(predicate, entries)));
  check(packet.predicate === predicate.name && Array.isArray(packet.rows) && Array.isArray(packet.function_contracts), 'actual wrapped SELECT returns one detector/catalog packet');
  return { ...packet, remaining: subtractAllowlist(packet.rows, entries, packet.function_contracts) };
}
const uid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const delegateSafe = `CREATE OR REPLACE FUNCTION public.owner_only_actor(p_performed_by uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (auth.uid());
END;
$body$;`;
const deliverySafe = `CREATE OR REPLACE FUNCTION public.complete_delivery(p_signed_by text, p_performed_by uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  PERFORM public.signature_name(p_signed_by);
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (v_actor);
END;
$body$;`;

try {
  docker(['run', '--detach', '--name', container, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m', '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine']);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  check(ready, 'disposable PostgreSQL started');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  psql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE alternate_owner; CREATE ROLE inherited_execute;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
CREATE TABLE public.financial_audit_log(actor_user_id uuid);
CREATE FUNCTION public.signature_name(p_signed_by text) RETURNS text LANGUAGE sql AS 'SELECT $1';
${delegateSafe}
REVOKE ALL ON FUNCTION public.owner_only_actor(uuid) FROM PUBLIC;
CREATE FUNCTION public.wrapped_actor(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
BEGIN PERFORM public.owner_only_actor(p_performed_by); END;
$body$;
${deliverySafe}`);

  const entries = [pin(deliveryKey, 'p_signed_by', []), pin(wrapperKey, 'p_performed_by', [delegateKey])];
  let result = sweep(entries);
  check(result.rows.some((row) => row.violation_key === deliveryKey && row.suspect_param === 'p_signed_by'), 'real detector flags signature-text forwarding');
  check(result.rows.some((row) => row.violation_key === wrapperKey), 'real detector flags guarded delegate forwarding');
  check(result.remaining.length === 0, 'reviewed harmless fixture findings are exempted');

  const deliveryUnsafe = deliverySafe.replace("  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;\n", '')
    .replace('VALUES (v_actor)', 'VALUES (p_performed_by)');
  psql(deliveryUnsafe);
  result = sweep(entries);
  check(result.rows.some((row) => row.violation_key === deliveryKey && row.suspect_param === 'p_performed_by'), 'removing real actor guard produces a different actor finding under the SAME function identity');
  check(result.remaining.some((row) => row.violation_key === deliveryKey), 'changed public body is not hidden by its previous exemption');
  psql(`SET request.jwt.claim.sub = '${uid}'; SELECT public.complete_delivery('signature data', '${other}');`);
  check(psql('SELECT actor_user_id::text FROM public.financial_audit_log;') === other, 'public-body mutant actually forges actor in disposable DB');
  psql(`TRUNCATE public.financial_audit_log; ${deliverySafe}`);

  const before = catalog([`public.${wrapperKey}`])[0].contract_md5;
  psql(delegateSafe.replace("  IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;\n", '')
    .replace('VALUES (auth.uid())', 'VALUES (p_performed_by)'));
  check(catalog([`public.${wrapperKey}`])[0].contract_md5 === before, 'delegate mutation leaves public wrapper contract unchanged');
  result = sweep(entries);
  check(result.remaining.some((row) => row.violation_key === wrapperKey), 'only changing private authorization helper invalidates wrapper exemption');
  psql(`SET request.jwt.claim.sub = '${uid}'; SELECT public.wrapped_actor('${other}');`);
  check(psql('SELECT actor_user_id::text FROM public.financial_audit_log;') === other, 'private-helper mutant actually permits forged actor through unchanged public wrapper');
  psql(`TRUNCATE public.financial_audit_log; ${delegateSafe}`);
  check(sweep(entries).remaining.length === 0, 'restoring reviewed definitions restores exact contract matching');

  psql('GRANT EXECUTE ON FUNCTION public.owner_only_actor(uuid) TO authenticated;');
  check(sweep(entries).remaining.some((row) => row.violation_key === wrapperKey), 'new direct EXECUTE grant invalidates exemption');
  psql('REVOKE EXECUTE ON FUNCTION public.owner_only_actor(uuid) FROM authenticated;');
  psql('GRANT EXECUTE ON FUNCTION public.owner_only_actor(uuid) TO inherited_execute;');
  // Pin this explicit fixture ACL, then mutate ONLY inheritance, not the function ACL/body.
  const inheritedEntries = [entries[0], pin(wrapperKey, 'p_performed_by', [delegateKey])];
  check(sweep(inheritedEntries).remaining.length === 0, 'reviewed fixture role ACL has no Data API access');
  psql('GRANT inherited_execute TO authenticated;');
  check(sweep(inheritedEntries).remaining.some((row) => row.violation_key === wrapperKey), 'effective EXECUTE inheritance drift invalidates exception with raw function ACL unchanged');
  psql('REVOKE inherited_execute FROM authenticated; REVOKE EXECUTE ON FUNCTION public.owner_only_actor(uuid) FROM inherited_execute;');
  check(sweep(entries).remaining.length === 0, 'ACL restoration returns to reviewed contract');

  psql('ALTER FUNCTION public.owner_only_actor(uuid) OWNER TO alternate_owner;');
  check(sweep(entries).remaining.some((row) => row.violation_key === wrapperKey), 'owner drift invalidates dependency exception');
  psql('ALTER FUNCTION public.owner_only_actor(uuid) OWNER TO postgres;');
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT ''${other}''::uuid';`);
  check(sweep(entries).remaining.length > 0, 'changed identity source fails closed');
  psql('DROP FUNCTION public.wrapped_actor(uuid); DROP FUNCTION public.owner_only_actor(uuid);');
  const missing = catalog(Object.keys(entries[1].reviewed_contracts));
  check(subtractAllowlist([{ violation_key: wrapperKey, suspect_param: 'p_performed_by' }], [entries[1]], missing).length === 1, 'missing exact dependency fails closed');
  console.log(`ACTOR_ALLOWLIST_DISPOSABLE_PROOF_PASS ${checks} checks; actual public/helper actor forgery observed and rejected by standing matcher`);
} finally {
  docker(['stop', '--time', '1', container], { allowFailure: true });
  docker(['rm', container], { allowFailure: true });
}
