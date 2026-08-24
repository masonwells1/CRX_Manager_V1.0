import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH =
  'supabase/migrations/20260819232000_bind_draw_down_receipts_to_intent.sql';
const CUTOVER_PATH =
  'supabase/migrations/20260816110000_draw_down_cutover_barrier.sql';
const INTENT_HELPER_PATH =
  'supabase/migrations/20260811130000_bind_commission_payout_idempotency_to_intent.sql';
const TIER_SPLIT_PATH =
  'supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql';
const ALLOCATED_CENTS_PATH =
  'supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const SMOKE_PATH =
  'scripts/smoke/smoke-draw-down-quote-intent-binding.sql';
const PROVER_PATH =
  'scripts/smoke/prove-draw-down-quote-intent-binding.mjs';
const IDLESS_DUPLICATE_COMMIT_PROOF_PATH =
  'scripts/smoke/prove-draw-idless-duplicate-commit.sql';
const KEYED_DRAW_SMOKES = [
  ['scripts/smoke/smoke-draw-ledger-reversal.sql', [
    'smk-dlr-s1-first-', 'smk-dlr-s1-redraw-', 'smk-dlr-s2-first-',
    'smk-dlr-s2-final-', 'smk-dlr-s2-redraw-',
  ]],
  ['scripts/smoke/smoke-order-draw-lock.sql', ['smk-odl-first-', 'smk-odl-final-']],
  ['scripts/smoke/smoke-save-quote-drawn-guard.sql', ['smk-sqdg-first-', 'smk-sqdg-final-']],
  ['scripts/smoke/smoke-restore-version-drawn-guard.sql', ['smk-rvdg-first-', 'smk-rvdg-final-']],
  ['scripts/smoke/smoke-planned-holds-drawn-sync.sql', ['smk-phds-draw-']],
  // Six textual occurrences = the documented signature plus five real calls;
  // only the positive control is keyed because auth/role gates precede the key.
  ['scripts/smoke/smoke-auth-probe-template.sql', ["smk-apt-' || v_suffix)"], 6],
] as const;

const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const cutoverSql = readFileSync(CUTOVER_PATH, 'utf8');
const intentHelperSql = readFileSync(INTENT_HELPER_PATH, 'utf8');
const tierSplitSql = readFileSync(TIER_SPLIT_PATH, 'utf8');
const allocatedCentsSql = readFileSync(ALLOCATED_CENTS_PATH, 'utf8');
const smokeSql = readFileSync(SMOKE_PATH, 'utf8');
const proverSource = readFileSync(PROVER_PATH, 'utf8');
const idlessDuplicateCommitProof = readFileSync(IDLESS_DUPLICATE_COMMIT_PROOF_PATH, 'utf8');
const quoteBuilder = readFileSync('src/pages/QuoteBuilder.tsx', 'utf8').replace(/\r\n/g, '\n');
const smokeSpecs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8'));
const gitAttributes = readFileSync('.gitattributes', 'utf8').replace(/\r\n/g, '\n');
const migrationHistory = readFileSync('docs/reference/migration-history.md', 'utf8');

function expectOrdered(source: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `${marker} is missing`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function functionBodySha256(source: string, name: string): string {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalizedSource.match(new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION public\\.${escaped}\\([\\s\\S]*?AS \\$function\\$(\\n[\\s\\S]*?\\n)\\$function\\$;`,
  ));
  expect(match, `${name} body is missing`).not.toBeNull();
  return createHash('sha256').update(match![1], 'utf8').digest('hex');
}

function expectHashBoundToVariable(
  variable: string,
  expectedHash: string,
  occurrences: number,
): void {
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = migrationSql.match(new RegExp(
    `(?:p\\.oid = ${escapedVariable}\\)|convert_to\\(${escapedVariable}, 'UTF8'\\))[\\s\\S]{0,160}?IS DISTINCT FROM '${expectedHash}'`,
    'g',
  ));
  expect(matches, `${expectedHash} is not bound to ${variable}`).toHaveLength(occurrences);
}

describe('draw_down_quote actor and intent binding migration', () => {
  it('wraps the governed entry point without copying or replacing money math', () => {
    expect(migrationSql).toContain(
      'ALTER FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  RENAME TO _draw_down_quote_intent_impl_20260819;',
    );
    expect(migrationSql).toContain(
      'v_result := public._draw_down_quote_intent_impl_20260819(',
    );
    expect(migrationSql).not.toContain(
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );

    expect(cutoverSql).toContain('pg_try_advisory_xact_lock_shared(20260816, 1)');
    expect(cutoverSql).toContain('_begin_below_cost_money_write');
    expect(cutoverSql).toContain('_draw_down_quote_below_cost_impl_20260810');
    expect(tierSplitSql).toContain('-- TIERSPLIT<<< emit one order line per booked price tier.');
    expect(tierSplitSql).toContain('quote_item_id       -- PROVENANCE');
  });

  it('pins every reviewed idempotency, wrapper, pricing, and lifecycle body', () => {
    for (const path of [
      INTENT_HELPER_PATH,
      ALLOCATED_CENTS_PATH,
      MIGRATION_PATH,
      SMOKE_PATH,
      PROVER_PATH,
    ]) {
      expect(gitAttributes).toContain(`${path} text eol=lf`);
    }
    expect(allocatedCentsSql).not.toContain('\r');
    // The intent-helper migration is already applied and must never be edited
    // merely to normalize this existing Windows checkout. Its live pg_proc body
    // was separately read and proven LF-only before its exact hash was pinned.
    expect(migrationSql).not.toContain('\r');
    expect(smokeSql).not.toContain('\r');
    expect(proverSource).not.toContain('\r');
    const migrationFileHash = createHash('sha256').update(migrationSql, 'utf8').digest('hex');
    expect(migrationHistory).toContain(`SQL sha256: \`${migrationFileHash}\``);

    const helperHash = functionBodySha256(intentHelperSql, 'check_idempotency_intent');
    const privateWrapperHash = functionBodySha256(cutoverSql, 'draw_down_quote');
    const outerWrapperHash = functionBodySha256(migrationSql, 'draw_down_quote');
    const moneyImplHash = functionBodySha256(
      tierSplitSql,
      '_draw_down_quote_below_cost_impl_20260810',
    );
    const allocCumulativeHash = functionBodySha256(allocatedCentsSql, '_allocated_cumulative_cents');
    const allocDeliveryHash = functionBodySha256(allocatedCentsSql, '_allocated_delivery_cents');
    const completeDeliveryHash = functionBodySha256(
      allocatedCentsSql,
      '_complete_delivery_authorized_impl',
    );
    const backfillInvoiceHash = functionBodySha256(
      allocatedCentsSql,
      '_create_invoice_for_unbilled_delivery_impl_20260718',
    );
    const closeRemainderHash = functionBodySha256(
      allocatedCentsSql,
      '_close_undelivered_order_remainder_20260718',
    );

    expectHashBoundToVariable('v_intent_helper', helperHash, 1);
    expectHashBoundToVariable('v_helper_src', helperHash, 1);
    expectHashBoundToVariable('v_src', privateWrapperHash, 1);
    expectHashBoundToVariable('v_private_src', privateWrapperHash, 1);
    expectHashBoundToVariable('v_outer_src', outerWrapperHash, 1);
    expectHashBoundToVariable('v_money_impl', moneyImplHash, 2);
    expectHashBoundToVariable('v_alloc_cumulative', allocCumulativeHash, 2);
    expectHashBoundToVariable('v_alloc_delivery', allocDeliveryHash, 2);
    expectHashBoundToVariable('v_complete_delivery', completeDeliveryHash, 2);
    expectHashBoundToVariable('v_backfill_invoice', backfillInvoiceHash, 2);
    expectHashBoundToVariable('v_close_remainder', closeRemainderHash, 2);
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed pricing/lifecycle prerequisite body drifted',
    );
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed pricing/lifecycle prerequisite body changed',
    );
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed intent helper or governed wrapper body drifted',
    );
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed intent helper or wrapper body changed',
    );
    expect(migrationSql.match(/p\.proname = 'check_idempotency_intent'\) <> 1/g)).toHaveLength(2);
    expect(migrationSql.match(/p\.proacl = ARRAY\['postgres=X\/postgres'\]::aclitem\[\]/g)).toHaveLength(2);
    expect(proverSource).toContain('NULL-returning intent helper passed the exact-body gate');
    expect(proverSource).toContain('disabled actor/fingerprint comparisons passed the exact-body gate');
    expect(proverSource).toContain('comment-only governed wrapper calls passed the exact-body gate');
    expect(proverSource).toContain('extra intent-helper overload passed the overload gate');
  });

  it('fails closed before replay and preserves cross-representative coverage', () => {
    expectOrdered(migrationSql, [
      'CREATE TEMP TABLE crx_draw_intent_transaction_guard',
      'INSERT INTO crx_draw_intent_transaction_guard(marker) VALUES (true);',
      "SET LOCAL lock_timeout = '15s';",
      'SELECT pg_advisory_xact_lock(20260816, 1);',
      'DO $preflight$',
    ]);
    expectOrdered(migrationSql, [
      '-- DRAW_DOWN_INTENT_BARRIER<<<',
      '-- DRAW_DOWN_INTENT_AUTHZ<<<',
      '-- DRAW_DOWN_INTENT_KEY_LOCK<<<',
      '-- DRAW_DOWN_INTENT_REPLAY<<<',
      '-- DRAW_DOWN_INTENT_LIVE_QUOTE<<<',
      "WHERE id = p_quote_id\n     AND deleted_at IS NULL\n   FOR UPDATE;",
      '-- DRAW_DOWN_INTENT_FIRST_CALL<<<',
      '-- DRAW_DOWN_INTENT_BIND<<<',
    ]);
    expect(migrationSql).toContain('v_actor uuid := auth.uid();');
    expect(migrationSql).toContain("RAISE EXCEPTION 'AUTH_REQUIRED';");
    expect(migrationSql).toContain("RAISE EXCEPTION 'ACTOR_MISMATCH';");
    expect(migrationSql).toContain("v_actor_role NOT IN ('admin', 'sales_rep')");
    expect(migrationSql).toContain("RAISE EXCEPTION 'INSUFFICIENT_ROLE';");
    expect(migrationSql).toContain("RAISE EXCEPTION 'Quote not found';");
    expect(migrationSql).not.toContain('NOT_QUOTE_OWNER');
    expect(migrationSql).not.toMatch(/created_by\s+(?:=|IS DISTINCT FROM)\s+v_actor/);
    expect(migrationSql).toContain(
      "hashtextextended('crx:idempotency:' || p_idempotency_key, 0)",
    );
    expect(migrationSql).toContain(
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key',
    );
    expect(migrationSql).toContain('p_idempotency_key COLLATE "C" !~ \'^[!-~]{1,200}$\'');
    expect(migrationSql).not.toContain("p_idempotency_key COLLATE \"C\" !~ '[!-~]'");
    expect(migrationSql).toContain("operation = 'draw_down_quote'\n       AND expires_at > now()");
    expect(migrationSql).toContain('unexpired legacy draw_down_quote receipts exist');
    expect(migrationSql).toContain("current_setting('transaction_isolation')");
  });

  it('binds the key to actor, quote, ordered canonical draws, and the saved result', () => {
    const fingerprintStart = migrationSql.indexOf('v_fingerprint := encode(');
    const replayStart = migrationSql.indexOf('v_replay := public.check_idempotency_intent(');
    const fingerprintBlock = migrationSql.slice(fingerprintStart, replayStart);

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(replayStart).toBeGreaterThan(fingerprintStart);
    expect(fingerprintBlock).toContain("'actor_id', v_actor");
    expect(fingerprintBlock).toContain("'quote_id', p_quote_id");
    expect(fingerprintBlock).toContain("'draws', v_canonical_draws");
    expect(fingerprintBlock).not.toContain('p_below_cost_reason');
    expect(migrationSql).toContain('trim_scale((d.value ->> \'quantity\')::numeric)');
    expect(migrationSql).toContain("pg_input_is_valid(d.value ->> 'product_id', 'uuid')");
    expect(migrationSql).toContain(
      "RAISE EXCEPTION\n      'BOOKING_PRODUCT_INVALID: draw product id must be a UUID';",
    );
    expect(migrationSql).toContain("pg_input_is_valid(d.value ->> 'quantity', 'numeric')");
    expect(migrationSql).toContain("'NaN'::numeric");
    expect(migrationSql).toContain("'Infinity'::numeric");
    expect(migrationSql).toContain(
      "RAISE EXCEPTION\n      'BOOKING_QUANTITY_INVALID: draw quantity must be finite';",
    );
    expect(migrationSql).toContain('ORDER BY d.ordinality');
    expect(migrationSql).toContain("'draw_down_quote',\n    v_actor,\n    v_fingerprint");
    expect(migrationSql).toContain("NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL");
    expect(migrationSql).toContain('SET request_fingerprint = v_fingerprint,\n         request_actor_id = v_actor');
    expect(migrationSql).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';");
    expectOrdered(migrationSql, [
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key',
      "'BOOKING_PRODUCT_INVALID: draw product id must be a UUID'",
      "'BOOKING_QUANTITY_INVALID: draw quantity must be finite'",
      'v_fingerprint := encode(',
    ]);
    expect(migrationSql).not.toContain(
      'RETURN public._draw_down_quote_intent_impl_20260819(\n      p_quote_id, p_draws, p_performed_by, NULL',
    );
  });

  it('retires rejected draw keys and gives the operator a safe recovery path', () => {
    const drawStart = quoteBuilder.indexOf('const handleDrawDown = async () => {');
    const drawEnd = quoteBuilder.indexOf('const handleConvertToOrder = async () => {', drawStart);
    const drawHandler = quoteBuilder.slice(drawStart, drawEnd);

    expect(drawStart).toBeGreaterThan(-1);
    expect(drawEnd).toBeGreaterThan(drawStart);
    expect(quoteBuilder).toContain(
      "import { getIdempotencyBindingRejection, getIdempotencyMismatchResult } from '../lib/idempotency';",
    );
    expect(drawHandler).toContain('const bindingRejection = getIdempotencyBindingRejection(error);');
    const rejectionHandler = drawHandler.slice(drawHandler.indexOf('if (bindingRejection) {'));
    expectOrdered(rejectionHandler, [
      'if (bindingRejection) {',
      'drawDownIdem.resetKey();',
      "getIdempotencyMismatchResult(error, 'draw_down_quote')",
      'if (committedOrderId) {',
      'navigate(`/orders/${committedOrderId}`);',
      'const balanceReloaded = await openDrawDownModal();',
    ]);
    expect(drawHandler).toContain('const authError = rpcAuthErrorMessage(error);');
    expect(drawHandler).toContain('Only active administrators and sales representatives can draw down bookings.');
    expect(drawHandler).toContain('RpcErrorCodes.BOOKING_QUANTITY_INVALID');
    expect(drawHandler).toContain('RpcErrorCodes.BOOKING_PRODUCT_INVALID');
    expect(drawHandler).toContain('Check Orders for this booking before drawing again.');
    expect(drawHandler).not.toContain("toast('error', 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(drawHandler).not.toContain("toast('error', 'IDEMPOTENCY_ACTOR_MISMATCH'");
    expect(quoteBuilder).toContain('const loadGeneration = ++initialLoadGenerationRef.current;');
    expect(quoteBuilder).toContain('setInstalledLoadGeneration(loadGeneration);');
    expect(quoteBuilder).toContain('initialLoadGenerationRef.current !== installedLoadGeneration');
    expect(quoteBuilder).toContain('suppressDirtyUntilReloadSettlesRef.current = false;');
  });

  it('keeps the private chain private and exposes only the reviewed wrapper', () => {
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  TO postgres;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  TO authenticated;',
    );
    expect(migrationSql).toContain("has_function_privilege('service_role', v_wrapper, 'EXECUTE')");
    expect(migrationSql).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(migrationSql).toContain("pg_get_userbyid(p.proowner) = 'postgres'");
  });

  it('registers a rollback chain that mutation-tests replay, actor, money, and inventory', () => {
    const spec = smokeSpecs.specs.draw_down_quote_intent_binding;
    expect(spec).toBeDefined();
    expect(spec.chain).toBe('smoke-draw-down-quote-intent-binding.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-draw-down-quote-intent-binding.mjs');
    expect(spec.covers).toContain('draw_down_quote');
    expect(spec.area).toEqual(
      expect.arrayContaining(['pricing', 'inventory', 'security', 'idempotency']),
    );

    expect(smokeSql).toContain("'quantity', 1.00");
    expect(smokeSql).toContain("'quantity', 2");
    expect(smokeSql).toContain('IDEMPOTENCY_INTENT_MISMATCH');
    expect(smokeSql).toContain('IDEMPOTENCY_ACTOR_MISMATCH');
    expect(smokeSql).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(smokeSql).toContain("E'smk-control\\ncharacter'");
    expect(smokeSql).toContain("U&'smk-\\2603'");
    expect(smokeSql).toContain("repeat('a', 201)");
    expect(smokeSql).toContain('request_actor_id = v_rep_a');
    expect(smokeSql).toContain('request_fingerprint IS NOT NULL');
    expect(smokeSql).toContain('oi.price_per_unit = 10.00');
    expect(smokeSql).toContain('oi.cost_at_time_cents = 500');
    expect(smokeSql).toContain('c.commission_amount = 5.00');
    expect(smokeSql).toContain('c.recipient_user_id = v_rep_a');
    expect(smokeSql).toContain('i.quantity_prebooked = 1');
    expect(smokeSql).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';");
    expect(proverSource).toContain("const smokeSql = readFileSync(SMOKE_PATH, 'utf8');");
    expect(proverSource).toContain('/SMOKE_PASS_ROLLBACK/');
    expect(proverSource).toContain('listed.stderr.trim()');
    expect(proverSource).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ;');
    expect(proverSource).toContain('repeatable-read execution is refused before the legacy-receipt scan');
    expect(proverSource).toContain('exclusive cutover lock drains and detects');
    expect(proverSource).toContain('restoreFullSchemaAndRunSmoke();');
  });

  it('keeps every registered post-cutover draw smoke on unique retry keys', () => {
    for (const [path, drawKeys, expectedCalls = drawKeys.length] of KEYED_DRAW_SMOKES) {
      const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      expect(proverSource).toContain(path.slice(path.lastIndexOf('/') + 1));
      expect(source.match(/\bdraw_down_quote\(/g), path).toHaveLength(expectedCalls);
      for (const drawKey of drawKeys) {
        expect(source, `${path} is missing ${drawKey}`).toContain(`'${drawKey}`);
      }
    }
    for (const path of [
      'scripts/smoke/smoke-order-draw-lock.sql',
      'scripts/smoke/smoke-save-quote-drawn-guard.sql',
    ]) {
      const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      expect(source).toContain('as postgres after the migration under test is\n-- applied. Once the pending 20260819232000 cutover is also present');
      expect(source).toContain('service_role cannot execute it');
      expect(source).not.toContain('postgres/service_role');
    }
    for (const path of [
      'scripts/smoke/smoke-restore-version-drawn-guard.sql',
      'scripts/smoke/smoke-planned-holds-drawn-sync.sql',
    ]) {
      const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      expect(source).toContain('HOW TO RUN: CONTAINER ONLY through');
      expect(source).toContain('Do not run this chain against live before that sequence is applied');
      expect(source).toContain('service_role cannot execute it');
    }
    const restoreSmoke = readFileSync(
      'scripts/smoke/smoke-restore-version-drawn-guard.sql',
      'utf8',
    );
    const plannedHoldsSmoke = readFileSync(
      'scripts/smoke/smoke-planned-holds-drawn-sync.sql',
      'utf8',
    );
    expect(restoreSmoke).not.toContain('expected BOOKING_OVERDRAWN');
    expect(restoreSmoke.match(/expected QUOTE_RESTORE_BLOCKED_BY_DRAW/g)).toHaveLength(2);
    expect(plannedHoldsSmoke).toContain("v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%'");
    expect(plannedHoldsSmoke).toContain(
      'refused restore changed holds pa=% pb=% (expected 200/100)',
    );
    expect(smokeSpecs.specs.restore_quote_version.description).toContain(
      'every version restore fails closed with QUOTE_RESTORE_BLOCKED_BY_DRAW',
    );
    expect(smokeSpecs.specs.restore_quote_version.container_only).toBe(true);
    expect(smokeSpecs.specs.restore_quote_version.container_prover)
      .toBe('prove-draw-down-quote-intent-binding.mjs');
    expect(smokeSpecs.specs.create_planned_holds.description).toContain(
      'leaves synchronized holds unchanged',
    );
    expect(smokeSpecs.specs.create_planned_holds.container_only).toBe(true);
    expect(smokeSpecs.specs.create_planned_holds.container_prover)
      .toBe('prove-draw-down-quote-intent-binding.mjs');
    expect(proverSource).toContain('FULL_SCHEMA_KEYED_DRAW_SMOKES_PASS');
  });

  it('refuses ambiguous duplicates and checks the supported id-less save through COMMIT', () => {
    expect(idlessDuplicateCommitProof).toContain('BEGIN;');
    expect(idlessDuplicateCommitProof).toContain('COMMIT;');
    expect(idlessDuplicateCommitProof).toContain('FULL_SCHEMA_IDLESS_DUPLICATE_COMMIT_PASS');
    expect(idlessDuplicateCommitProof).toContain("'section_name', 'Early'");
    expect(idlessDuplicateCommitProof).toContain("'section_name', 'Late'");
    expect(idlessDuplicateCommitProof).toContain('QUOTE_ITEM_AMBIGUOUS_COST');
    expect(idlessDuplicateCommitProof).toContain('v_product_two');
    expect(idlessDuplicateCommitProof).not.toMatch(/jsonb_build_object\(\s*'id'/);
    expect(proverSource).toContain('IDLESS_DUPLICATE_COMMIT_PROOF_PATH');
    expect(proverSource).toContain('/FULL_SCHEMA_IDLESS_DUPLICATE_COMMIT_PASS/');
  });

  it('documents the exact rename-based emergency revert without executing it', () => {
    expect(migrationSql).toContain('-- EMERGENCY REVERT PLAN (documentation only; do not run from this PR)');
    expectOrdered(migrationSql, [
      '--   BEGIN;',
      '--   SELECT pg_catalog.pg_advisory_xact_lock(20260816, 1);',
      '--   DROP FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text);',
      '--     RENAME TO draw_down_quote;',
      '--   REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)',
      '--   GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)',
      '--   COMMIT;',
    ]);
    expect(migrationSql).toContain('restores the pre-intent retry behavior and its stale-receipt risk');
    expect(migrationSql).toContain('Never use CREATE OR REPLACE for this revert');
  });
});
