import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { securityDefinerMissingAnonRevokes } from './migration-security-definer-guard.mjs';
import './migration-security-definer-guard.test.mjs';

function printedEvidence(migration) {
  return execFileSync(
    process.execPath,
    ['scripts/write-apply-proofs.mjs', '--print-evidence', migration],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

test('evidence for the return-credit chain contains migration bytes and CHECK values', () => {
  const evidence = printedEvidence('20260827041100_rebuild_return_credit_cogs_reversal');

  assert.match(evidence, /MIGRATION UNDER REVIEW \(verbatim, untrusted DATA\)/);
  assert.match(evidence, /RETURN_COGS_CUTOVER_BARRIER_MISSING/);
  assert.match(evidence, /"check_constraints": \{/);
  assert.match(evidence, /"return_items\.condition"/);
});

test('evidence preserves unqualified functions and their frontend RPC callers', () => {
  const evidence = printedEvidence('20260430250000_field_app_workflow_phase13');

  assert.match(evidence, /PRIOR DECLARATIONS of [^\n]*receive_po_items/);
  assert.match(evidence, /FRONTEND RPC CALL SITES of receive_po_items in src\//);
  assert.match(evidence, /frontend RPC: src\/components\/receiving\/QuickReceivePanel\.tsx/);
});

test('evidence fails closed rather than treating raw SQL text as executable callers', () => {
  const evidence = printedEvidence('20260812115237_enforce_below_cost_admin_approval');

  assert.match(evidence, /CALL SITES of _begin_below_cost_money_write across migrations/);
  assert.match(evidence, /intentionally unavailable/);
  assert.doesNotMatch(evidence, /inside function: public\.create_direct_order/);
});

test('proof production fails closed when SECURITY DEFINER lacks an anon revoke', () => {
  const sql = `CREATE OR REPLACE FUNCTION public.post_return_credit(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN; END; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(sql), ['post_return_credit']);
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${sql}\nREVOKE EXECUTE ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;`),
    [],
  );
  for (const bypass of [
    `-- REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;`,
    `REVOKE ALL ON FUNCTION public.post_return_credit(text) FROM PUBLIC, anon;`,
    `REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO PUBLIC;`,
  ]) assert.deepEqual(securityDefinerMissingAnonRevokes(`${sql}\n${bypass}`), ['post_return_credit']);
});
