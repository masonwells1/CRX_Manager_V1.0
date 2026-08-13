import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(path.join(root, 'supabase/migrations/20260812130145_bind_return_receipts_to_intent_and_restore_overdue.sql'), 'utf8');
const predicate = readFileSync(path.join(root, 'scripts/db-invariant-sweeps/predicates/return-credit-intent-binding.sql'), 'utf8');
const lifecyclePredicate = readFileSync(path.join(root, 'scripts/db-invariant-sweeps/predicates/returns-lifecycle-rpc-owned.sql'), 'utf8');
const returnsSource = readFileSync(path.join(root, 'src/pages/Returns.tsx'), 'utf8').replace(/\r\n/g, '\n');
const invoiceSource = readFileSync(path.join(root, 'src/pages/InvoiceDetail.tsx'), 'utf8').replace(/\r\n/g, '\n');
const schemaDoc = readFileSync(path.join(root, 'docs/reference/database-schema.md'), 'utf8');
const rpcDoc = readFileSync(path.join(root, 'docs/reference/rpc-functions.md'), 'utf8');
const docDriftCheck = readFileSync(path.join(root, 'scripts/check-doc-drift.mjs'), 'utf8');
const smoke = readFileSync(path.join(root, 'scripts/smoke/smoke-return-credit-chain.sql'), 'utf8');
const realSchemaProver = readFileSync(path.join(root, 'scripts/smoke/verify-return-credit-real-schema.mjs'), 'utf8');
const smokeSpecs = JSON.parse(readFileSync(path.join(root, 'scripts/smoke/smoke-specs.json'), 'utf8'));

const wrapperNames = [
  'create_return', 'approve_return', 'reject_return', 'cancel_return',
  'receive_return', 'issue_return_credit', '_reverse_credit_memo_application',
];

function bodyFor(sql: string, functionName: string): string {
  const startToken = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
  const start = sql.indexOf(startToken);
  if (start < 0) throw new Error(`missing ${functionName}`);
  const bodyStartToken = 'AS $function$';
  const bodyStart = sql.indexOf(bodyStartToken, start);
  const bodyEnd = sql.indexOf('$function$;', bodyStart + bodyStartToken.length);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error(`missing body for ${functionName}`);
  return sql.slice(bodyStart + bodyStartToken.length, bodyEnd);
}

function sha256(value: string) {
  // Git may materialize SQL with CRLF on Windows while PostgreSQL stores the
  // same function body with LF. Pin semantic body text, not checkout EOLs.
  return createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function expectedHash(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = predicate.match(new RegExp(`\\('${escaped}', '([0-9a-f]{64})'\\)`));
  if (!match) throw new Error(`predicate hash missing for ${signature}`);
  return match[1];
}

function assertFrontendGuards(returnsText: string, invoiceText: string) {
  returnsText = returnsText.replace(/\r\n/g, '\n');
  invoiceText = invoiceText.replace(/\r\n/g, '\n');
  expect(returnsText).toContain("const returnIntentScope = activeReturn?.id || ''");
  for (const operation of ['approve_return', 'reject_return', 'cancel_return', 'receive_return', 'issue_return_credit']) {
    expect(returnsText).toContain(`useIdempotencyKey('${operation}', profile?.id || '', returnIntentScope)`);
  }
  expect(returnsText).toContain('JSON.stringify([returnPayload, itemsPayload])');
  expect(returnsText).toContain('unresolvedCreateIntent?.intent.intentScope ?? createIntent.intentScope');
  expect(returnsText).toContain('p_return: requestIntent.returnPayload');
  expect(returnsText).toContain('p_items: requestIntent.itemsPayload');
  expect(returnsText).toContain('setUnresolvedCreateIntent({');
  expect(returnsText).toContain('disabled={createPayloadLocked}');
  expect(returnsText).toContain('committedCreateResultFromIntentMismatch(error)');
  expect(returnsText).toContain('if (isDefinitiveRpcRejection(error))');
  expect(returnsText).toContain('createIdem.resetKey();\n              setUnresolvedCreateIntent(null);');
  expect(returnsText).toContain('createIdem.resetKey();\n        setUnresolvedCreateIntent(null);');
  expect(returnsText).toContain('cancelIdem.getKeyFor(cancelScope)');
  expect(returnsText).toContain('JSON.stringify([activeReturn.id, reason.trim()])');
  expect(returnsText).toContain('onClose={closeCreate}');
  expect(returnsText).toContain('onClick={closeCreate} disabled={creating}>Cancel</Button>');
  expect(invoiceText).toContain('Number.isInteger(applyCreditAmountCents) ? applyCreditAmountCents : null');
  expect(invoiceText).toContain('closeDisabled={applyingCredit}');
  expect(invoiceText).toContain('disabled={applyingCredit}>Cancel</Button>');
  expect(invoiceText).toContain('disabled={applyingCredit || Boolean(unresolvedApplyCreditIntent)}');
  expect(invoiceText).toContain('setUnresolvedApplyCreditIntent({');
  expect(invoiceText).toContain('setApplyCreditAmount((unresolved.amountCents / 100).toFixed(2))');
  expect(invoiceText).toContain('setUnresolvedApplyCreditIntent(null)');
  expect(invoiceText).toContain('if (isDefinitiveRpcRejection(err))');
  expect(invoiceText).toContain('applyCreditIdem.resetKey();\n        setUnresolvedApplyCreditIntent(null);');
  expect(invoiceText).toContain('applyCreditIdem.resetKey();\n      setUnresolvedApplyCreditIntent(null);');
  expect(invoiceText).not.toContain('applyCreditIdem.resetKey();\n    setShowApplyCreditModal(true)');
}

function assertExecutableProofGuards(smokeText: string, proverText: string) {
  for (const anchor of [
    'exact create retry produced % return headers',
    'changed actor raised %, expected IDEMPOTENCY_ACTOR_MISMATCH',
    'only % of six return receipts carry actor+fingerprint binding',
    'lost-response Apply Credit retry created % applications',
    'explicit reversal restored past-due invoice to %, expected overdue',
    'corrected-forward reversal restored invoice to %, expected posted',
    'unapply restored past-due invoice to %, expected overdue',
    'reversal created an extra post snapshot (count %)',
    'corrected-forward reversal created an extra post snapshot (count %)',
    'governed product pricing apply failed',
    'SMOKE_PASS_ROLLBACK',
  ]) expect(smokeText).toContain(anchor);
  expect(smokeText).not.toContain('ALTER TABLE public.products DISABLE TRIGGER');
  expect(proverText).toContain("assert.match(output, /SMOKE_PASS_ROLLBACK/");
  expect(proverText).toContain('sanitizeCliOutput');
  expect(proverText).toContain("return_number LIKE 'SMK-%'");
  expect(proverText).toContain("invoice_number LIKE 'SMK-RCC-%'");
  expect(proverText).toContain("receipt residue remained");
  expect(proverText).toContain("--schema', 'public,auth'");
  expect(proverText).toContain('rmSync(LIVE_SCHEMA, { force: true })');
  expect(proverText).toContain('const preApplyViolations = psqlValue');
  expect(proverText).toContain("if (preApplyViolations !== '0')");
  expect(proverText).toContain('RETURN_CREDIT_POSTAPPLY_LIVE_PASS');
}

function assertInvariantGuards(predicateText: string) {
  for (const anchor of [
    "OR NOT has_function_privilege('authenticated', a.oid, 'EXECUTE')",
    "OR a.function_owner IS DISTINCT FROM 'postgres'",
    "OR has_function_privilege('service_role', a.oid, 'EXECUTE')",
    "has_function_privilege('authenticated', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE')",
  ]) expect(predicateText).toContain(anchor);
}

function assertLifecycleInvariantComposition(predicateText: string) {
  for (const anchor of [
    "'_approve_return_intent_impl_20260812'",
    "'_cancel_return_intent_impl_20260812'",
    "prosrc LIKE '%_approve_return_intent_impl_20260812%'",
    "prosrc LIKE '%_cancel_return_intent_impl_20260812%'",
  ]) expect(predicateText).toContain(anchor);
}

function assertReturnsDocGuards(checkText: string, rpcText: string) {
  for (const anchor of [
    'Array.isArray(returnsStatuses) && returnsStatuses.length > 0',
    'documentedStatuses.length === returnsStatuses.length',
    'documentedStatuses.every((status, index) => status === returnsStatuses[index])',
  ]) expect(checkText).toContain(anchor);
  expect(rpcText).toContain('**APPLIED LIVE 2026-08-12:**');
  expect(rpcText).toContain('ledger version `20260812212323`');
  expect(rpcText).toContain('20260812130145_bind_return_receipts_to_intent_and_restore_overdue.sql');
}

describe('return/credit remediation durable guards', () => {
  it('pins every public SQL wrapper to the exact reviewed body', () => {
    const signatures: Record<string, string> = {
      create_return: 'create_return(jsonb,jsonb,text)',
      approve_return: 'approve_return(uuid,uuid,text)',
      reject_return: 'reject_return(uuid,uuid,text)',
      cancel_return: 'cancel_return(uuid,text,uuid,text)',
      receive_return: 'receive_return(uuid,uuid,text)',
      issue_return_credit: 'issue_return_credit(uuid,uuid,text)',
    };
    for (const [name, signature] of Object.entries(signatures)) {
      expect(sha256(bodyFor(migration, name))).toBe(expectedHash(signature));
    }
    expect(sha256(bodyFor(migration, '_reverse_credit_memo_application')))
      .toBe(expectedHash('_reverse_credit_memo_application(uuid,uuid,text,text)'));
    expect(sha256(bodyFor(migration, 'snapshot_invoice_line_shares_on_post')))
      .toBe(expectedHash('snapshot_invoice_line_shares_on_post()'));
  });

  it.each([
    ['actor binding', 'actor_id', 'actor_identity'],
    ['target binding', "'return_id', p_return_id", "'return_id', NULL"],
    ['create header payload', "'return', p_return", "'return', '{}'::jsonb"],
    ['create line payload', "'items', p_items", "'items', '[]'::jsonb"],
    ['receipt write', 'request_actor_id = v_actor', 'request_actor_id = NULL'],
  ])('mutation-kills SQL %s removal', (_label, from, to) => {
    const name = from === "'return', p_return" || from === "'items', p_items" ? 'create_return' : 'approve_return';
    const original = bodyFor(migration, name);
    const mutated = original.replace(from, to);
    expect(mutated).not.toBe(original);
    const signature = name === 'create_return' ? 'create_return(jsonb,jsonb,text)' : 'approve_return(uuid,uuid,text)';
    expect(sha256(mutated)).not.toBe(expectedHash(signature));
  });

  it('mutation-kills every frontend intent and submit-lock guard', () => {
    assertFrontendGuards(returnsSource, invoiceSource);
    const mutations: Array<[string, string, string]> = [
      ['return scope', returnsSource.replace("const returnIntentScope = activeReturn?.id || ''", "const returnIntentScope = ''"), invoiceSource],
      ['create payload scope', returnsSource.replace('JSON.stringify([returnPayload, itemsPayload])', 'JSON.stringify([returnPayload])'), invoiceSource],
      ['effective create scope', returnsSource.replace('unresolvedCreateIntent?.intent.intentScope ?? createIntent.intentScope', 'createIntent.intentScope'), invoiceSource],
      ['create unresolved state', returnsSource.replace('setUnresolvedCreateIntent({', 'void ({'), invoiceSource],
      ['create input lock', returnsSource.split('disabled={createPayloadLocked}').join('disabled={creating}'), invoiceSource],
      ['legacy create reconciliation', returnsSource.replace('committedCreateResultFromIntentMismatch(error)', 'null'), invoiceSource],
      ['create definitive unlock', returnsSource.replace('if (isDefinitiveRpcRejection(error))', 'if (false)'), invoiceSource],
      ['cancel exact scope', returnsSource.replace('cancelIdem.getKeyFor(cancelScope)', 'cancelIdem.getKey()'), invoiceSource],
      ['shared create close', returnsSource.replace('onClick={closeCreate} disabled={creating}>Cancel</Button>', 'onClick={() => setShowCreate(false)} disabled={creating}>Cancel</Button>'), invoiceSource],
      ['apply close lock', returnsSource, invoiceSource.replace('closeDisabled={applyingCredit}', 'closeDisabled={false}')],
      ['integer cents scope', returnsSource, invoiceSource.replace('Number.isInteger(applyCreditAmountCents) ? applyCreditAmountCents : null', 'null')],
      ['no reset on reopen', returnsSource, invoiceSource.replace('setShowApplyCreditModal(true);', 'applyCreditIdem.resetKey();\n    setShowApplyCreditModal(true);')],
      ['apply input lock', returnsSource, invoiceSource.split('disabled={applyingCredit || Boolean(unresolvedApplyCreditIntent)}').join('disabled={applyingCredit}')],
      ['restore exact amount', returnsSource, invoiceSource.replace('setApplyCreditAmount((unresolved.amountCents / 100).toFixed(2))', "setApplyCreditAmount('0.01')")],
      ['clear apply success', returnsSource, invoiceSource.replace('applyCreditIdem.resetKey();\n      setUnresolvedApplyCreditIntent(null);', 'applyCreditIdem.resetKey();\n      // keep stale intent')],
      ['apply definitive unlock', returnsSource, invoiceSource.replace('if (isDefinitiveRpcRejection(err))', 'if (false)')],
    ];
    for (const [label, mutatedReturns, mutatedInvoice] of mutations) {
      let killed = false;
      try { assertFrontendGuards(mutatedReturns, mutatedInvoice); } catch { killed = true; }
      expect(killed, `mutation survived: ${label}`).toBe(true);
    }
  });

  it('mutation-kills the overdue status decision in the shared reversal wrapper', () => {
    const original = bodyFor(migration, '_reverse_credit_memo_application');
    const mutated = original.replace('i.due_date < CURRENT_DATE', 'false');
    expect(mutated).not.toBe(original);
    expect(sha256(mutated)).not.toBe(expectedHash('_reverse_credit_memo_application(uuid,uuid,text,text)'));
  });

  it('mutation-kills reversal helper idempotency exemption and actor validation', () => {
    const original = bodyFor(migration, '_reverse_credit_memo_application');
    for (const [from, to] of [
      ['-- idempotency-body-check: exempt', '-- exemption removed'],
      ['IF v_session_actor IS NULL THEN', 'IF false THEN'],
      ['p_actor IS NULL OR p_actor IS DISTINCT FROM v_session_actor', 'false'],
    ]) {
      const mutated = original.replace(from, to);
      expect(mutated).not.toBe(original);
      expect(sha256(mutated)).not.toBe(expectedHash('_reverse_credit_memo_application(uuid,uuid,text,text)'));
    }
  });

  it('mutation-kills reversal-only split snapshot suppression', () => {
    const original = bodyFor(migration, 'snapshot_invoice_line_shares_on_post');
    for (const [from, to] of [
      ["current_setting('app.credit_reversal_status', true) = 'true'", 'false'],
      ['RETURN NEW;', 'NULL;'],
    ]) {
      const mutated = original.replace(from, to);
      expect(mutated).not.toBe(original);
      expect(sha256(mutated)).not.toBe(expectedHash('snapshot_invoice_line_shares_on_post()'));
    }
  });

  it('mutation-kills the narrowly scoped transition override and restoration', () => {
    const original = bodyFor(migration, '_reverse_credit_memo_application');
    expect(original).toContain("set_config('app.admin_override', 'true', true)");
    expect(original.match(/set_config\('app\.admin_override', COALESCE\(v_previous_admin_override, ''\), true\)/g)).toHaveLength(2);
    const mutated = original.replace("set_config('app.admin_override', 'true', true)", "set_config('app.admin_override', 'false', true)");
    expect(sha256(mutated)).not.toBe(sha256(original));
  });

  it('mutation-kills public/private composition in the existing Returns lifecycle invariant', () => {
    assertLifecycleInvariantComposition(lifecyclePredicate);
    for (const anchor of [
      "'_approve_return_intent_impl_20260812'",
      "'_cancel_return_intent_impl_20260812'",
      "prosrc LIKE '%_approve_return_intent_impl_20260812%'",
      "prosrc LIKE '%_cancel_return_intent_impl_20260812%'",
    ]) {
      expect(() => assertLifecycleInvariantComposition(lifecyclePredicate.replace(anchor, '__REMOVED_GUARD__'))).toThrow();
    }
  });

  it('mutation-kills migration overload, owner, security, search-path, and ACL guards', () => {
    const anchors = [
      "p.pronamespace = 'public'::regnamespace AND p.proname = v_name) <> 1",
      "pg_get_userbyid(p.proowner) = 'postgres'",
      'AND p.prosecdef',
      "p.proconfig = ARRAY['search_path=public, pg_temp']::text[]",
      "has_function_privilege('authenticated', p.oid, 'EXECUTE') = v_authenticated_execute",
      "has_function_privilege('service_role', p.oid, 'EXECUTE')",
      "NOT has_function_privilege('anon', p.oid, 'EXECUTE')",
      'IF v_src IS NULL',
    ];
    for (const anchor of anchors) {
      expect(migration).toContain(anchor);
      const mutated = migration.replace(anchor, '__REMOVED_GUARD__');
      expect(mutated).not.toBe(migration);
      expect(sha256(mutated)).not.toBe(sha256(migration));
    }
  });

  it('mutation-kills every rollback-smoke and zero-residue proof anchor', () => {
    assertExecutableProofGuards(smoke, realSchemaProver);
    for (const anchor of [
      'exact create retry produced % return headers',
      'changed actor raised %, expected IDEMPOTENCY_ACTOR_MISMATCH',
      'only % of six return receipts carry actor+fingerprint binding',
      'lost-response Apply Credit retry created % applications',
      'explicit reversal restored past-due invoice to %, expected overdue',
      'corrected-forward reversal restored invoice to %, expected posted',
      'unapply restored past-due invoice to %, expected overdue',
      'reversal created an extra post snapshot (count %)',
      'corrected-forward reversal created an extra post snapshot (count %)',
      'governed product pricing apply failed',
      'SMOKE_PASS_ROLLBACK',
    ]) {
      const mutated = smoke.split(anchor).join('__REMOVED_GUARD__');
      expect(() => assertExecutableProofGuards(mutated, realSchemaProver)).toThrow();
    }
    for (const anchor of [
      "assert.match(output, /SMOKE_PASS_ROLLBACK/",
      'sanitizeCliOutput',
      "return_number LIKE 'SMK-%'",
      "invoice_number LIKE 'SMK-RCC-%'",
      'receipt residue remained',
      "--schema', 'public,auth'",
      'rmSync(LIVE_SCHEMA, { force: true })',
      'const preApplyViolations = psqlValue',
      "if (preApplyViolations !== '0')",
      'RETURN_CREDIT_POSTAPPLY_LIVE_PASS',
    ]) {
      const mutated = realSchemaProver.split(anchor).join('__REMOVED_GUARD__');
      expect(() => assertExecutableProofGuards(smoke, mutated)).toThrow();
    }
  });

  it('mutation-kills invariant checks for private helper and browser grant drift', () => {
    assertInvariantGuards(predicate);
    for (const anchor of [
      "OR NOT has_function_privilege('authenticated', a.oid, 'EXECUTE')",
      "OR a.function_owner IS DISTINCT FROM 'postgres'",
      "OR has_function_privilege('service_role', a.oid, 'EXECUTE')",
      "has_function_privilege('authenticated', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE')",
    ]) {
      const mutated = predicate.split(anchor).join('__REMOVED_GUARD__');
      expect(() => assertInvariantGuards(mutated)).toThrow();
    }
  });

  it('schema documentation names the live Returns columns and all six statuses', () => {
    expect(schemaDoc).toContain('status: requested/approved/received/credited/rejected/cancelled');
    for (const column of ['reason', 'reason_notes', 'cancellation_reason']) {
      expect(schemaDoc).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(schemaDoc).not.toContain('return_type, reason_category');
  });

  it('keeps the canonical chain in billing, inventory, idempotency, and security slices', () => {
    expect(smokeSpecs.specs.issue_return_credit.area).toEqual(expect.arrayContaining([
      'billing', 'inventory', 'idempotency', 'security',
    ]));
  });

  it('fails closed when the Returns status registry or exact retry rollout state drifts', () => {
    assertReturnsDocGuards(docDriftCheck, rpcDoc);
    for (const anchor of [
      'Array.isArray(returnsStatuses) && returnsStatuses.length > 0',
      'documentedStatuses.length === returnsStatuses.length',
      'documentedStatuses.every((status, index) => status === returnsStatuses[index])',
    ]) {
      expect(() => assertReturnsDocGuards(docDriftCheck.replace(anchor, '__REMOVED_GUARD__'), rpcDoc)).toThrow();
    }
    for (const anchor of [
      '**APPLIED LIVE 2026-08-12:**',
      'ledger version `20260812212323`',
      '20260812130145_bind_return_receipts_to_intent_and_restore_overdue.sql',
    ]) {
      expect(() => assertReturnsDocGuards(docDriftCheck, rpcDoc.replace(anchor, '__REMOVED_GUARD__'))).toThrow();
    }
  });

  it('covers every intended wrapper in the guard fixture', () => {
    for (const name of wrapperNames) expect(migration).toContain(`FUNCTION public.${name}(`);
  });
});
