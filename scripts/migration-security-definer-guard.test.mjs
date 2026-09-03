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
  assert.deepEqual(securityDefinerMissingAnonRevokes(definition('REVOKE EXECUTE ON FUNCTION public.post_return_credit(uuid) FROM anon;')), ['post_return_credit']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;')), []);
});

test('does not accept a commented, quoted, wrong-overload, or later-regranted revoke', () => {
  const commented = definition('-- REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  const quoted = definition("SELECT 'REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;';");
  const wrongOverload = definition('REVOKE ALL ON FUNCTION public.post_return_credit(text) FROM PUBLIC, anon;');
  const regranted = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO PUBLIC;');
  for (const sql of [commented, quoted, wrongOverload, regranted]) assert.deepEqual(securityDefinerMissingAnonRevokes(sql), ['post_return_credit']);
});

test('fails closed for quoted names and unsupported ACL forms that can restore execution', () => {
  const quoted = `CREATE FUNCTION public."danger-fn"() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(quoted), ['danger-fn']);
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon WITH GRANT OPTION;`),
    ['unparseable-security-definer-sql'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;`),
    ['unparseable-security-definer-sql'],
  );
});

test('tracks ALTER FUNCTION SECURITY DEFINER and keeps quoted identities distinct', () => {
  const altered = 'ALTER FUNCTION public.escalate(uuid) SECURITY DEFINER;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(altered), ['escalate']);
  const routine = 'ALTER ROUTINE public.routine_escalate(uuid) SECURITY DEFINER;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(routine), ['routine_escalate']);
  const quoted = 'CREATE FUNCTION public."Case"() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT; $$;\nREVOKE ALL ON FUNCTION public."case"() FROM PUBLIC, anon;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(quoted), ['Case']);
  const escaped = 'CREATE FUNCTION public."danger""name"() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT; $$;\nREVOKE ALL ON FUNCTION public."danger""name"() FROM PUBLIC, anon;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(escaped), []);
});

test('fails closed for search-path-sensitive targets and quoted role lookalikes', () => {
  const unqualifiedRoutine = 'ALTER ROUTINE routine_escalate(uuid) SECURITY DEFINER;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(unqualifiedRoutine), ['unparseable-security-definer-sql']);
  const unqualifiedAcl = `${definition()}\nSET search_path = private, public;\nREVOKE ALL ON FUNCTION post_return_credit(uuid) FROM PUBLIC, anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(unqualifiedAcl), ['unparseable-security-definer-sql']);
  const quotedRoles = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM "PUBLIC", "anon";');
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedRoles), ['unparseable-security-definer-sql']);
});

test('does not treat quoted SQL identifiers as executable ACL commands', () => {
  const counterfeit = `${definition()}\nSELECT 1 AS "REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;";`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(counterfeit), ['post_return_credit']);
});

test('resets ACL state after DROP and tracks SECURITY DEFINER procedures', () => {
  const recreated = `${definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;')}\nDROP FUNCTION public.post_return_credit(uuid);\n${definition()}`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(recreated), ['post_return_credit']);
  const procedure = 'CREATE PROCEDURE public.escalate_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END; $$;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(procedure), ['escalate_proc']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(`${procedure}\nREVOKE ALL ON PROCEDURE public.escalate_proc(uuid) FROM PUBLIC, anon;`), []);
});

test('fails closed for quoted grant recipients and dynamic DO-block ACL changes', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  const quotedGrant = `${safe}\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO "anon";`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedGrant), ['unparseable-security-definer-sql']);
  const dynamicGrant = `${safe}\nDO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon'; END; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(dynamicGrant), ['unparseable-security-definer-sql']);
  const languageFirst = `${safe}\nDO LANGUAGE plpgsql $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon'; END; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(languageFirst), ['unparseable-security-definer-sql']);
});

test('fails closed for quoted schema and argument-type identities', () => {
  const schemaDecoy = `${definition()}\nREVOKE ALL ON FUNCTION "PUBLIC".post_return_credit(uuid) FROM PUBLIC, anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(schemaDecoy), ['unparseable-security-definer-sql']);
  const quotedType = 'CREATE FUNCTION public.type_decoy("Domain") RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT; $$;\nREVOKE ALL ON FUNCTION public.type_decoy("Domain") FROM PUBLIC, anon;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedType), ['unparseable-security-definer-sql']);
});

test('fails closed for ACL suffixes, quoted semicolons, and routine ownership changes', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  assert.deepEqual(securityDefinerMissingAnonRevokes(`${safe}\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon GRANTED BY CURRENT_USER;`), ['unparseable-security-definer-sql']);
  assert.deepEqual(securityDefinerMissingAnonRevokes('CREATE FUNCTION public.quoted_return() RETURNS public."text;shadow" LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL; $$;'), ['quoted_return']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(`${safe}\nALTER FUNCTION public.post_return_credit(uuid) OWNER TO anon;`), ['unparseable-security-definer-sql']);
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nALTER FUNCTION public.post_return_credit(uuid) RENAME TO exposed;\nGRANT EXECUTE ON FUNCTION public.exposed(uuid) TO PUBLIC, anon;`),
    ['exposed'],
  );
});

test('does not demand an anon revoke for invoker-security functions', () => {
  assert.deepEqual(securityDefinerMissingAnonRevokes('CREATE FUNCTION public.safe_fn() RETURNS void LANGUAGE sql AS $$ SELECT; $$;'), []);
});

test('the return-credit migration makes its anon revocations mechanically visible', () => {
  const migration = readFileSync('supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql', 'utf8');
  assert.deepEqual(securityDefinerMissingAnonRevokes(migration), []);
});
