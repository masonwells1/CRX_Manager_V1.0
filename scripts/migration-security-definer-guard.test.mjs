import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { securityDefinerMissingAnonRevokes } from './migration-security-definer-guard.mjs';

const definition = (suffix = '') => `
CREATE OR REPLACE FUNCTION public.post_return_credit(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ BEGIN RETURN; END; $$;
${suffix}`;

test('requires a SECURITY DEFINER function to explicitly revoke anon execute', () => {
  assert.deepEqual(securityDefinerMissingAnonRevokes(definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC;')), ['post_return_credit']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(definition('REVOKE EXECUTE ON FUNCTION public.post_return_credit(uuid) FROM anon;')), []);
});

test('does not demand an anon revoke for invoker-security functions', () => {
  assert.deepEqual(securityDefinerMissingAnonRevokes('CREATE FUNCTION public.safe_fn() RETURNS void LANGUAGE sql AS $$ SELECT; $$;'), []);
});

test('the return-credit migration makes its anon revocations mechanically visible', () => {
  const migration = readFileSync('supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql', 'utf8');
  assert.deepEqual(securityDefinerMissingAnonRevokes(migration), []);
});
