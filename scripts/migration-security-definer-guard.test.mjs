import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { executableSql, securityDefinerMissingAnonRevokes } from './migration-security-definer-guard.mjs';

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
  for (const sql of [commented, quoted, regranted]) assert.deepEqual(securityDefinerMissingAnonRevokes(sql), ['post_return_credit']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(wrongOverload), ['unparseable-security-definer-sql']);
});

test('fails closed for role definitions and canonical role membership changes', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  for (const membershipChange of [
    'ALTER GROUP authenticated ADD USER anon;',
    'GRANT authenticated TO anon;',
    'GRANT authenticated, service_role TO anon WITH ADMIN OPTION;',
    'GRANT "authenticated" TO "anon";',
    'REVOKE ADMIN OPTION FOR authenticated FROM anon;',
    'REVOKE authenticated FROM anon;',
  ]) {
    assert.deepEqual(
      securityDefinerMissingAnonRevokes(membershipChange),
      ['unparseable-security-definer-sql'],
    );
    assert.deepEqual(
      securityDefinerMissingAnonRevokes(`${safe}\n${membershipChange}`),
      ['unparseable-security-definer-sql'],
    );
  }
});

test('fails closed for ownership mutations and direct system-catalog writes', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  for (const mutation of [
    'REASSIGN OWNED BY CURRENT_USER TO anon;',
    'ALTER TABLE public.customers OWNER TO anon;',
    "UPDATE pg_catalog.pg_proc SET proconfig = ARRAY['search_path=attacker'] WHERE proname = 'post_return_credit';",
    'UPDATE pg_proc SET proacl = NULL;',
    'DELETE FROM pg_catalog.pg_default_acl;',
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\n${mutation}`),
    ['unparseable-security-definer-sql'],
  );
});

test('fails closed for quoted catalog targets and catalog mutations hidden in executable bodies', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  for (const mutation of [
    'UPDATE "pg_catalog".pg_proc SET proacl = NULL;',
    'UPDATE pg_catalog."pg_auth_members" SET roleid = member;',
    'DELETE FROM "pg_catalog"."pg_policy";',
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\n${mutation}`),
    ['unparseable-security-definer-sql'],
  );
  for (const wrapper of [
    `DO $$ BEGIN UPDATE pg_catalog.pg_proc SET proacl = NULL; END; $$;`,
    `CREATE FUNCTION public.catalog_body_probe() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE pg_catalog.pg_proc SET proacl = NULL; END; $$;`,
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\n${wrapper}`),
    ['unparseable-security-definer-sql'],
  );
});

test('fails closed for MERGE, TRUNCATE, and COPY mutations targeting system catalogs', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  for (const mutation of [
    'MERGE INTO pg_catalog.pg_proc AS target USING public.source AS source ON false WHEN MATCHED THEN UPDATE SET proacl = NULL;',
    'TRUNCATE TABLE "pg_catalog".pg_default_acl;',
    'COPY pg_catalog.pg_auth_members FROM STDIN;',
    'DO $$ BEGIN MERGE INTO pg_catalog.pg_proc AS target USING public.source AS source ON false WHEN MATCHED THEN UPDATE SET proacl = NULL; END; $$;',
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\n${mutation}`),
    ['unparseable-security-definer-sql'],
  );
});

test('fails closed for quoted names and unsupported ACL forms that can restore execution', () => {
  const quoted = `CREATE FUNCTION public."danger-fn"() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT; $$;`;
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

test('fails closed when a quoted routine identifier immediately follows FUNCTION', () => {
  const adjacent = `CREATE FUNCTION"public"."danger"()
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ DELETE FROM public.customers $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(adjacent), ['unparseable-security-definer-sql']);
});

test('fails closed for SECURITY DEFINER ALTERs and unmatched quoted identities', () => {
  const altered = 'ALTER FUNCTION public.escalate(uuid) SECURITY DEFINER;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(altered), ['unparseable-security-definer-sql']);
  const routine = 'ALTER ROUTINE public.routine_escalate(uuid) SECURITY DEFINER;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(routine), ['unparseable-security-definer-sql']);
  const quoted = 'CREATE FUNCTION public."Case"() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT; $$;\nREVOKE ALL ON FUNCTION public."case"() FROM PUBLIC, anon;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(quoted), ['unparseable-security-definer-sql']);
  const escaped = 'CREATE FUNCTION public."danger""name"() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT; $$;\nREVOKE ALL ON FUNCTION public."danger""name"() FROM PUBLIC, anon;';
  assert.deepEqual(securityDefinerMissingAnonRevokes(escaped), []);
});

test('fails closed when quoted identifiers contain semicolons before SECURITY DEFINER', () => {
  const quotedSchema = `CREATE FUNCTION "public".hidden()
RETURNS TABLE ("x;y" text) LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ SELECT 'ok'::text $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedSchema), ['unparseable-security-definer-sql']);
});

test('allows only the fixed SECURITY DEFINER search path on routine ALTERs', () => {
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) RESET search_path;'),
    ['unparseable-security-definer-sql'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) SET search_path = public;'),
    ['unparseable-security-definer-sql'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) SET search_path = public, pg_temp;'),
    [],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) RESET ALL;'),
    ['unparseable-security-definer-sql'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) SET search_path FROM CURRENT;'),
    ['unparseable-security-definer-sql'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('ALTER FUNCTION public.existing(uuid) SET statement_timeout = 5000;'),
    ['unparseable-security-definer-sql'],
  );
});

test('requires the fixed search path for every SECURITY DEFINER creation form', () => {
  const routines = [
    {
      kind: 'FUNCTION',
      name: 'created_function',
      declaration: 'RETURNS void LANGUAGE sql',
      revoke: 'REVOKE ALL ON FUNCTION public.created_function() FROM PUBLIC, anon;',
    },
    {
      kind: 'PROCEDURE',
      name: 'created_procedure',
      declaration: 'LANGUAGE plpgsql',
      revoke: 'REVOKE ALL ON PROCEDURE public.created_procedure() FROM PUBLIC, anon;',
    },
    {
      kind: 'OR REPLACE PROCEDURE',
      name: 'replaced_procedure',
      declaration: 'LANGUAGE sql',
      revoke: 'REVOKE ALL ON PROCEDURE public.replaced_procedure() FROM PUBLIC, anon;',
    },
  ];
  for (const routine of routines) {
    const unsafe = `CREATE ${routine.kind} public.${routine.name}() ${routine.declaration} SECURITY DEFINER AS $$ SELECT 1; $$;`;
    const safe = `CREATE ${routine.kind} public.${routine.name}() ${routine.declaration} SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 1; $$;`;
    const widened = `CREATE ${routine.kind} public.${routine.name}() ${routine.declaration} SECURITY DEFINER SET search_path = public, pg_temp, attacker AS $$ SELECT 1; $$;`;
    const fromCurrentOverride = `CREATE ${routine.kind} public.${routine.name}() ${routine.declaration} SECURITY DEFINER SET search_path = public, pg_temp SET search_path FROM CURRENT AS $$ SELECT 1; $$;`;
    const quotedOverride = `CREATE ${routine.kind} public.${routine.name}() ${routine.declaration} SECURITY DEFINER SET search_path = public, pg_temp SET "search_path" = attacker, public AS $$ SELECT 1; $$;`;
    assert.deepEqual(securityDefinerMissingAnonRevokes(`${unsafe}\n${routine.revoke}`), ['unparseable-security-definer-sql']);
    assert.deepEqual(securityDefinerMissingAnonRevokes(`${safe}\n${routine.revoke}`), []);
    assert.deepEqual(securityDefinerMissingAnonRevokes(`${widened}\n${routine.revoke}`), ['unparseable-security-definer-sql']);
    assert.deepEqual(securityDefinerMissingAnonRevokes(`${fromCurrentOverride}\n${routine.revoke}`), ['unparseable-security-definer-sql']);
    assert.deepEqual(securityDefinerMissingAnonRevokes(`${quotedOverride}\n${routine.revoke}`), ['unparseable-security-definer-sql']);
  }
  const quotedOutputColumn = `CREATE FUNCTION public.quoted_output_path_decoy()
RETURNS TABLE ("SET search_path = public, pg_temp AS" integer)
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;
REVOKE ALL ON FUNCTION public.quoted_output_path_decoy() FROM PUBLIC, anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedOutputColumn), ['unparseable-security-definer-sql']);
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

test('keeps quoted control-character routine identities distinct during ACL tracking', () => {
  const securityDefiner = 'CREATE FUNCTION public."GRANT"() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT; $$;';
  const invokerDecoy = 'CREATE FUNCTION public."\u0001RANT"() RETURNS void LANGUAGE sql AS $$ SELECT; $$;';
  const decoyRevoke = 'REVOKE ALL ON FUNCTION public."\u0001RANT"() FROM PUBLIC, anon;';
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${securityDefiner}\n${invokerDecoy}\n${decoyRevoke}`),
    ['GRANT'],
  );
});

test('does not treat dollar signs inside identifiers as dollar quote delimiters', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  const regranted = `${safe}\nSELECT 1 AS x$tag$;\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon;\nSELECT 1 AS x$tag$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(regranted), ['post_return_credit']);
});

test('does not treat dollar signs after Unicode identifiers as dollar quote delimiters', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  const regranted = `${safe}\nSELECT 1 AS é$tag$;\nGRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon;\nSELECT 1 AS x$tag$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(regranted), ['post_return_credit']);
});

test('recognizes Unicode dollar-quote tags before evaluating SECURITY DEFINER ACLs', () => {
  const definition = `CREATE FUNCTION public.unicode_tag_probe()
RETURNS void AS $é$ DELETE FROM public.customers; $é$
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp;`;
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${definition}\nREVOKE ALL ON FUNCTION public.unicode_tag_probe() FROM PUBLIC;`),
    ['unicode_tag_probe'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${definition}\nREVOKE ALL ON FUNCTION public.unicode_tag_probe() FROM PUBLIC, anon;`),
    [],
  );
});

test('resets ACL state after DROP and tracks SECURITY DEFINER procedures', () => {
  const recreated = `${definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;')}\nDROP FUNCTION public.post_return_credit(uuid);\n${definition()}`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(recreated), ['post_return_credit']);
  const procedure = 'CREATE PROCEDURE public.escalate_proc(p_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN NULL; END; $$;';
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
  const directGrantAll = `${safe}\nDO $$ BEGIN GRANT ALL ON FUNCTION public.post_return_credit(uuid) TO anon; END; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(directGrantAll), ['unparseable-security-definer-sql']);
  const directGrantAllPrivileges = `${safe}\nDO $$ BEGIN GRANT ALL PRIVILEGES ON FUNCTION public.post_return_credit(uuid) TO anon; END; $$;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(directGrantAllPrivileges), ['unparseable-security-definer-sql']);
});

test('normalizes PostgreSQL routine type aliases and rejects unmatched public ACL events', () => {
  const integerDefinition = `CREATE FUNCTION public.alias_target(p_id int) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT; $$;`;
  const revoked = `${integerDefinition}\nREVOKE ALL ON FUNCTION public.alias_target(integer) FROM PUBLIC, anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(revoked), []);
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${revoked}\nGRANT EXECUTE ON FUNCTION public.alias_target(int4) TO anon;`),
    ['alias_target'],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${integerDefinition}\nREVOKE ALL ON FUNCTION public.alias_target(text) FROM PUBLIC, anon;`),
    ['unparseable-security-definer-sql'],
  );
});

test('tracks PostgreSQL-equivalent quoted routine names and pg_catalog argument types', () => {
  const quotedName = `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
CREATE OR REPLACE FUNCTION public."f"() RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ SELECT; $$;
REVOKE ALL ON FUNCTION public."f"() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.f() TO anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(quotedName), ['f']);

  const qualifiedType = `CREATE FUNCTION public.type_identity(p_id pg_catalog.uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ SELECT; $$;
REVOKE ALL ON FUNCTION public.type_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.type_identity(pg_catalog.uuid) TO anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(qualifiedType), ['type_identity']);
});

test('fails closed when a SECURITY DEFINER body changes or dynamically selects search_path', () => {
  const header = `CREATE FUNCTION public.body_path_probe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$`;
  const revoke = 'REVOKE ALL ON FUNCTION public.body_path_probe() FROM PUBLIC, anon;';
  for (const body of [
    'BEGIN SET LOCAL search_path = attacker, public; END;',
    "BEGIN SET SCHEMA 'attacker, public'; END;",
    "BEGIN SET LOCAL SCHEMA 'attacker, public'; END;",
    "BEGIN PERFORM set_config('search_path', p_schema, true); END;",
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${header}\n${body}\n$$;\n${revoke}`),
    ['unparseable-security-definer-sql'],
  );
});

test('excludes OUT-only parameters from PostgreSQL function identities', () => {
  const withOutput = 'CREATE FUNCTION public.output_target(p_id uuid, OUT p_result text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT NULL; $$;';
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${withOutput}\nREVOKE ALL ON FUNCTION public.output_target(uuid) FROM PUBLIC, anon;`),
    [],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${withOutput}\nREVOKE ALL ON FUNCTION public.output_target(uuid, text) FROM PUBLIC, anon;`),
    ['unparseable-security-definer-sql'],
  );
});

test('fails closed for dynamic ACLs inside transient helper routines', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  const helper = `${safe}
CREATE FUNCTION public.restore_acl() RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.post_return_credit(uuid) TO anon'; END;
$$;
SELECT public.restore_acl();
DROP FUNCTION public.restore_acl();`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(helper), ['unparseable-security-definer-sql']);
});

test('fails closed for existing-routine grants and nonstandard string parsing', () => {
  assert.deepEqual(
    securityDefinerMissingAnonRevokes('GRANT EXECUTE ON FUNCTION public.existing_secdef(uuid) TO anon;'),
    ['unparseable-security-definer-sql'],
  );
  const nonstandardStrings = String.raw`SET standard_conforming_strings = off;
CREATE FUNCTION public.string_decoy() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT; $$;
SELECT 'counterfeit \' REVOKE ALL ON FUNCTION public.string_decoy() FROM PUBLIC, anon;';`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(nonstandardStrings), ['unparseable-security-definer-sql']);
});

test('allows unrelated table and schema grants while rejecting malformed routine grants', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nGRANT SELECT ON TABLE public.customers TO authenticated;\nGRANT USAGE ON SCHEMA public TO authenticated;`),
    [],
  );
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;`),
    ['unparseable-security-definer-sql'],
  );
});

test('fails closed for comment-separated string-mode changes', () => {
  const commentSeparated = String.raw`SET/**/standard_conforming_strings=off;
CREATE OR REPLACE FUNCTION public.post_return_credit(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ BEGIN RETURN; END; $$;
SELECT 'counterfeit \' REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;';`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(commentSeparated), ['unparseable-security-definer-sql']);
});

test('fails closed for set_config string-mode changes', () => {
  const throughSetConfig = `${definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;')}\nSELECT set_config('standard_conforming_strings', 'off', false);`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(throughSetConfig), ['unparseable-security-definer-sql']);
});

test('rejects executable string-mode changes after comment normalization', () => {
  assert.equal(executableSql('SET/**/standard_conforming_strings=off; SELECT 1;'), null);
  assert.equal(executableSql('SET "standard_conforming_strings" = off; SELECT 1;'), null);
  assert.equal(executableSql("SELECT set_config('standard_conforming_strings', 'off', false);"), null);
  assert.equal(executableSql(String.raw`SELECT set_config(E'standard\x5fconforming\x5fstrings', 'off', false);`), null);
  assert.equal(executableSql('SELECT "set_config"(\'standard_conforming_strings\', \'off\', false);'), null);
  assert.equal(executableSql('SELECT pg_catalog."set_config"(\'standard_conforming_strings\', \'off\', false);'), null);
  assert.equal(executableSql("SELECT set_config('standard_' || 'conforming_strings', 'off', false);"), null);
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
  assert.deepEqual(securityDefinerMissingAnonRevokes('CREATE FUNCTION public.quoted_return() RETURNS public."text;shadow" LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT NULL; $$;'), ['quoted_return']);
  assert.deepEqual(securityDefinerMissingAnonRevokes(`${safe}\nALTER FUNCTION public.post_return_credit(uuid) OWNER TO anon;`), ['unparseable-security-definer-sql']);
  assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nALTER FUNCTION public.post_return_credit(uuid) RENAME TO exposed;\nGRANT EXECUTE ON FUNCTION public.exposed(uuid) TO PUBLIC, anon;`),
    ['exposed'],
  );
});

test('fails closed for routine attributes outside the fixed search_path or exact rename forms', () => {
  const safe = definition('REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;');
  for (const attribute of [
    'LEAKPROOF',
    'NOT LEAKPROOF',
    'IMMUTABLE',
    'STABLE',
    'VOLATILE',
    'PARALLEL SAFE',
    'PARALLEL RESTRICTED',
    'COST 1',
    'ROWS 1',
    'DEPENDS ON EXTENSION pgcrypto',
  ]) assert.deepEqual(
    securityDefinerMissingAnonRevokes(`${safe}\nALTER FUNCTION public.post_return_credit(uuid) ${attribute};`),
    ['unparseable-security-definer-sql'],
    attribute,
  );
});

test('fails closed when a BEGIN ATOMIC routine body contains an apparent revoke', () => {
  const atomicBody = `${definition()}
CREATE PROCEDURE public.decoy_acl() LANGUAGE SQL BEGIN ATOMIC
  REVOKE ALL ON FUNCTION public.post_return_credit(uuid) FROM PUBLIC, anon;
END;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(atomicBody), ['unparseable-security-definer-sql']);
});

test('fails closed for SQL-standard RETURN bodies that can change the search path', () => {
  const returnBody = `CREATE FUNCTION public.return_body_path_probe() RETURNS text LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp RETURN set_config('search_path', 'attacker, public', true);
REVOKE ALL ON FUNCTION public.return_body_path_probe() FROM PUBLIC, anon;`;
  assert.deepEqual(securityDefinerMissingAnonRevokes(returnBody), ['unparseable-security-definer-sql']);
});

test('fails closed for Unicode-escaped search_path settings in SECURITY DEFINER bodies', () => {
  const body = (statement) => `CREATE FUNCTION public.unicode_path_probe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$ BEGIN ${statement}; END; $$;
REVOKE ALL ON FUNCTION public.unicode_path_probe() FROM PUBLIC, anon;`;
  for (const statement of [
    'SET U&"search_path" = attacker, public',
    'SET LOCAL U&"search_path" = attacker, public',
    'SET SESSION U&"search_path" = attacker, public',
    'RESET U&"search_path"',
    'SET U&"search\\005fpath" = attacker, public',
    "SET U&\"search!005fpath\" UESCAPE '!' = attacker, public",
    "PERFORM U&\"set_config\"('search_path', 'attacker, public', true)",
  ]) assert.deepEqual(securityDefinerMissingAnonRevokes(body(statement)), ['unparseable-security-definer-sql'], statement);
  assert.equal(executableSql('SET U&"standard_conforming_strings" = off;'), null);
});

test('fails closed for encoded SECURITY DEFINER bodies that can hide a search-path change', () => {
  const body = (encoded) => `CREATE FUNCTION public.encoded_path_probe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS ${encoded};
REVOKE ALL ON FUNCTION public.encoded_path_probe() FROM PUBLIC, anon;`;
  for (const encoded of [
    String.raw`E'BEGIN S\x45T search_path = attacker, public; END;'`,
    String.raw`U&'BEGIN S\0045T search_path = attacker, public; END;'`,
  ]) assert.deepEqual(securityDefinerMissingAnonRevokes(body(encoded)), ['unparseable-security-definer-sql'], encoded);
});

test('does not demand an anon revoke for invoker-security functions', () => {
  assert.deepEqual(securityDefinerMissingAnonRevokes('CREATE FUNCTION public.safe_fn() RETURNS void LANGUAGE sql AS $$ SELECT; $$;'), []);
});

test('the return-credit migration fails closed rather than guessing ACL state for existing helpers', () => {
  const migration = readFileSync('supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql', 'utf8');
  assert.deepEqual(securityDefinerMissingAnonRevokes(migration), ['unparseable-security-definer-sql']);
});
