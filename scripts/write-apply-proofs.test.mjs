import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { securityDefinerMissingAnonRevokes } from './migration-security-definer-guard.mjs';
import { buildMigrationReviewerExecArgs } from './migration-proof-reviewer-launch.mjs';
import { CODEX_REVIEW_PERMISSION_CONFIG, CODEX_REVIEW_PERMISSION_PROFILE } from './write-codex-push-proof.mjs';
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

  assert.match(evidence, /ROUTINE DEFINITION AND ACL HISTORY of [^\n]*receive_po_items/);
  assert.match(evidence, /APPLICATION RPC CALL SITES of receive_po_items in src\/ and supabase\/functions\//);
  assert.match(evidence, /frontend RPC: src\/components\/receiving\/QuickReceivePanel\.tsx/);
});

test('evidence includes source history for existing routines changed by ALTER', () => {
  const evidence = printedEvidence('20260319000000_fix_trigger_functions_search_path');
  assert.match(evidence, /ROUTINE DEFINITION AND ACL HISTORY of [^\n]*_enforce_return_status_transition/);
  assert.match(evidence, /ALTER FUNCTION public\._enforce_return_status_transition\(\) SET search_path/);
  assert.match(evidence, /CREATE(?: OR REPLACE)? FUNCTION public\._enforce_return_status_transition\(/);
});

test('evidence includes edge-function callers and review launch permits its Git-free packet', () => {
  const evidence = printedEvidence('20260714230100_blend_ticket_access_and_atomicity');
  assert.match(evidence, /edge-function RPC: supabase\/functions\/process-blend-ticket\/index\.ts:1168/);
  const args = buildMigrationReviewerExecArgs({ reviewCwd: 'C:/tmp/review', model: 'gpt-5.6-sol', effort: 'high', platform: 'win32' });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args[args.indexOf('-C') + 1], 'C:/tmp/review');
  assert.ok(args.includes(`default_permissions="${CODEX_REVIEW_PERMISSION_PROFILE}"`));
  assert.ok(args.includes(CODEX_REVIEW_PERMISSION_CONFIG));
  assert.ok(args.includes('windows.sandbox="elevated"'));
  assert.equal(args.at(-1), '-');
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
    `REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO PUBLIC;`,
  ]) assert.deepEqual(securityDefinerMissingAnonRevokes(`${sql}\n${bypass}`), ['post_return_credit']);
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${sql}\nREVOKE ALL ON FUNCTION public.post_return_credit(text) FROM PUBLIC, anon;`),
    ['unparseable-security-definer-sql'],
  );
});
