import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migrationName = '20260905210000_bind_create_inventory_hold_receipt_to_intent.sql';
const migration = source('supabase', 'migrations', migrationName);
const smoke = source('scripts', 'smoke', 'smoke-create-inventory-hold-intent-binding.sql');
const prover = source('scripts', 'smoke', 'prove-create-inventory-hold-intent-binding-real-schema.mjs');
const specs = JSON.parse(source('scripts', 'smoke', 'smoke-specs.json')) as {
  specs: Record<string, { chain: string; container_only?: boolean; container_prover?: string; covers: string[] }>;
};

const publicSignature = 'create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)';
const implName = '_create_inventory_hold_intent_impl_20260905';

/**
 * The executable contract of the wrapper migration. Every clause is a guard
 * the candidate must carry; the mutation tests below prove each clause is
 * load-bearing by deleting it and watching the contract fail.
 */
function hasIntentBindingContract(sql: string) {
  const wrapperStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_inventory_hold(');
  const wrapperEnd = sql.indexOf('$function$;', wrapperStart);
  if (wrapperStart < 0 || wrapperEnd < 0) return false;
  const wrapper = sql.slice(wrapperStart, wrapperEnd);
  const guardOrder = [
    "RAISE EXCEPTION 'AUTH_REQUIRED'",
    "RAISE EXCEPTION 'ACTOR_MISMATCH'",
    "RAISE EXCEPTION 'INSUFFICIENT_ROLE'",
    "RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key'",
    'public.check_idempotency_intent(',
    "RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'",
    `public.${implName}(`,
    'request_actor_id = v_actor, request_fingerprint = v_fingerprint',
    "RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'",
  ].map((marker) => wrapper.indexOf(marker));
  const ordered = guardOrder.every((pos, i) => pos >= 0 && (i === 0 || pos > guardOrder[i - 1]));

  return ordered
    && wrapper.includes('v_actor uuid := auth.uid();')
    && wrapper.includes('p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor')
    && wrapper.includes('AND is_active = true')
    && wrapper.includes("AND role IN ('admin', 'sales_rep')")
    && !/v_role\s+NOT IN/.test(wrapper)
    && wrapper.includes("p_idempotency_key !~ '[^[:space:]]'")
    && wrapper.includes('p_idempotency_key COLLATE "C" !~ \'[!-~]\'')
    && wrapper.includes("encode(extensions.digest(convert_to(jsonb_build_object(")
    && ["'actor_id', v_actor", "'product_id', p_product_id", "'customer_id', p_customer_id",
      "'quantity', trim_scale(p_quantity)", "'hold_type', p_hold_type", "'expires_at', p_expires_at",
      "'notes', p_notes", "'force', COALESCE(p_force, false)", "'force_reason', p_force_reason"]
      .every((field) => wrapper.includes(field))
    && wrapper.includes("p_idempotency_key, 'create_inventory_hold', v_actor, v_fingerprint")
    && wrapper.includes("AND operation = 'create_inventory_hold';")
    && wrapper.includes('p_force boolean DEFAULT false')
    && wrapper.includes('p_force_reason text DEFAULT NULL::text')
    && wrapper.includes('p_idempotency_key text DEFAULT NULL::text')
    && wrapper.includes('SECURITY DEFINER')
    && wrapper.includes('SET search_path = public, pg_temp')
    && sql.includes(`ALTER FUNCTION public.${publicSignature} OWNER TO postgres;`)
    && sql.includes(`REVOKE ALL ON FUNCTION public.${publicSignature} FROM PUBLIC, anon;`)
    && sql.includes(`GRANT EXECUTE ON FUNCTION public.${publicSignature} TO authenticated, service_role;`)
    && sql.includes(`REVOKE ALL ON FUNCTION public.${implName}(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)\n  FROM PUBLIC, anon, authenticated, service_role;`)
    && sql.includes(`GRANT EXECUTE ON FUNCTION public.${implName}(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text)\n  TO postgres;`)
    && sql.includes(`RENAME TO ${implName};`)
    && sql.includes("SET LOCAL lock_timeout = '10s';")
    && sql.indexOf("SET LOCAL lock_timeout = '10s';") < sql.indexOf('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;')
    && sql.includes('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;')
    && sql.includes("encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')")
    && sql.includes("'3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09'")
    && sql.includes("'a5cc7fcc729039f067bbfd570928d8b20989a9ae6d44ae5f69c6bda1e53de2d6'")
    && sql.includes('PREFLIGHT_BODY')
    && sql.includes('PREFLIGHT_OVERLOAD')
    && sql.includes('PREFLIGHT_STATE')
    && sql.includes('PREFLIGHT_ARGS')
    && sql.includes("RAISE EXCEPTION\n      'PREFLIGHT_LEGACY_RECEIPTS:")
    && sql.includes('POSTFLIGHT_ACL')
    && sql.includes('POSTFLIGHT_ARGS')
    && sql.includes('POSTFLIGHT_BODY')
    && sql.includes("v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';")
    && sql.includes('p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text\';')
    && sql.includes('-- idempotency-body-check: exempt')
    && sql.includes('-- caller-analysis: create_inventory_hold ::');
}

describe('create_inventory_hold receipt binding (20260905210000)', () => {
  it('is the newest migration on disk and still marked NOT APPLIED', () => {
    const ordered = readdirSync(join(root, 'supabase', 'migrations'))
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .sort();
    expect(ordered[ordered.length - 1]).toBe(migrationName);
    expect(migration).toContain('STATUS: NOT APPLIED');
  });

  it('serializes on the key and binds the receipt before delegating to the renamed live body', () => {
    expect(hasIntentBindingContract(migration)).toBe(true);
  });

  it('fails its executable contract when any load-bearing guard is removed', () => {
    const mutations: Array<[string, string]> = [
      ['public.check_idempotency_intent(', 'public.check_idempotency('],
      ['request_actor_id = v_actor, request_fingerprint = v_fingerprint', 'request_actor_id = NULL, request_fingerprint = NULL'],
      ["RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'", "RAISE NOTICE 'IDEMPOTENCY_RECEIPT_MISSING'"],
      ["RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key'", "RAISE NOTICE 'key missing'"],
      ["RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'", "RAISE NOTICE 'IDEMPOTENCY_RESULT_INVALID'"],
      ['AND is_active = true', ''],
      ["AND role IN ('admin', 'sales_rep')", ''],
      ["RAISE EXCEPTION 'ACTOR_MISMATCH'", "RAISE EXCEPTION 'actor mismatch'"],
      ['p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor', 'false'],
      ["'quantity', trim_scale(p_quantity)", "'quantity', 0"],
      ["'notes', p_notes", "'notes', NULL"],
      ["'force', COALESCE(p_force, false)", "'force', false"],
      ['extensions.digest(', 'public.digest('],
      ['FROM PUBLIC, anon, authenticated, service_role;', 'FROM PUBLIC, anon;'],
      ['LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;', ''],
      ["SET LOCAL lock_timeout = '10s';", ''],
      ["'3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09'", "'0000000000000000000000000000000000000000000000000000000000000000'"],
      ['PREFLIGHT_BODY', 'PREFLIGHT_SKIPPED'],
      ['POSTFLIGHT_ACL', 'POSTFLIGHT_SKIPPED'],
      ['PREFLIGHT_ARGS', 'PREFLIGHT_SKIPPED'],
      ['POSTFLIGHT_ARGS', 'POSTFLIGHT_SKIPPED'],
      // Downgrading the legacy-receipt abort back to a notice must fail the contract.
      ["RAISE EXCEPTION\n      'PREFLIGHT_LEGACY_RECEIPTS:", "RAISE NOTICE\n      'PREFLIGHT_LEGACY_RECEIPTS:"],
      ["v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';", "v_helper_sig text := 'public.check_idempotency(text,text)';"],
      ['SET search_path = public, pg_temp\nAS $function$', 'AS $function$'],
    ];
    for (const [from, to] of mutations) {
      expect(migration, `mutation source missing: ${from}`).toContain(from);
      expect(hasIntentBindingContract(migration.split(from).join(to)), `contract survived removing: ${from}`).toBe(false);
    }
    // Reordering: calling the impl BEFORE the receipt check must fail.
    const implCall = migration.indexOf(`public.${implName}(\n    p_product_id`);
    const intentCall = migration.indexOf('v_replay := public.check_idempotency_intent(');
    expect(implCall).toBeGreaterThan(intentCall);
    const intentMarker = 'v_replay := public.check_idempotency_intent(';
    const implMarker = `v_result := public.${implName}(`;
    const reordered = migration
      .replace(intentMarker, '@@SWAP@@')
      .replace(implMarker, intentMarker)
      .replace('@@SWAP@@', implMarker);
    expect(reordered.indexOf(implMarker)).toBeLessThan(reordered.indexOf(intentMarker));
    expect(hasIntentBindingContract(reordered)).toBe(false);
  });

  it('is proven by a container chain that covers the wrapper, the impl and the helper', () => {
    const spec = specs.specs.create_inventory_hold;
    expect(spec).toBeDefined();
    expect(spec.chain).toBe('smoke-create-inventory-hold-intent-binding.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-create-inventory-hold-intent-binding-real-schema.mjs');
    expect(spec.covers).toEqual(expect.arrayContaining(['create_inventory_hold', implName, 'check_idempotency_intent']));

    for (const token of [
      'IDEMPOTENCY_INTENT_MISMATCH', 'IDEMPOTENCY_ACTOR_MISMATCH', 'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE', 'INSUFFICIENT_ROLE', 'AUTH_REQUIRED', 'ACTOR_MISMATCH',
      'INSUFFICIENT_HOLD_INVENTORY', 'FORCE_REQUIRES_ADMIN', "RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'",
    ]) {
      expect(smoke).toContain(token);
    }
    expect(smoke).toContain('GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL');
    expect(smoke).toContain("has_function_privilege(v_role, v_impl_sig, 'EXECUTE')");

    expect(prover).toContain("assert.match(before.s2Error, /IDEMPOTENCY_CONCURRENT_REPLAY_RETRY/");
    expect(prover).toContain("assert.match(r.output, /PREFLIGHT_LEGACY_RECEIPTS: 1 unexpired unbound create_inventory_hold receipt/");
    expect(prover).toContain("assert.equal(shaAfterRefusal, liveSha, 'the refused apply changed the live body')");
    expect(prover).toContain("assert.equal(after.s2Code, 0, `expected the wrapper loser to succeed by replay");
    expect(prover).toContain("assert.equal(after.holds, 1, 'expected the wrapper to leave exactly one hold for one key')");
    expect(prover).toContain("assert.equal(after.id1, after.id2, 'expected both racing sessions to return the same hold_id')");
    expect(prover).toContain("assert.equal(rollbackPass(r.output), false, `hold smoke chain unexpectedly PASSED against the live body");
    expect(prover).toContain('3c86421e62db4cd51b86f62b9345155c12df2696e6956e751dd97883bf684d09');
    expect(prover).toContain("'--network', 'none'");
  });
});
