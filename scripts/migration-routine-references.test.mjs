import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicRoutineDdlIn, routineReferencesIn } from './migration-routine-references.mjs';

test('captures PostgreSQL routine names that regular expressions silently omit', () => {
  const result = routineReferencesIn(`
    CREATE FUNCTION public.price$check() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
    GRANT EXECUTE ON FUNCTION "public"."return-credit"(), "public"."café routine"() TO authenticated;
  `);

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)),
    ['price$check', 'return-credit', 'café routine'],
  );
});

test('fails closed for a routine header whose target cannot be parsed', () => {
  const result = routineReferencesIn('CREATE FUNCTION public.() RETURNS void LANGUAGE sql AS $$ SELECT; $$;');
  assert.match(result.error || '', /unparseable routine header/);
});

test('keeps quoted semicolons and Unicode dollar tags out of routine boundaries', () => {
  const result = routineReferencesIn(`
    CREATE FUNCTION "public"."x;y"() RETURNS void LANGUAGE sql AS $é$ SELECT ';'; $é$;
    REVOKE EXECUTE ON FUNCTION "public"."x;y"() FROM anon;
  `);

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)),
    ['x;y', 'x;y'],
  );
});

test('captures the complete named dollar-quoted routine body before its statement terminator', () => {
  const result = routineReferencesIn(`
    CREATE FUNCTION public.named_body() RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      PERFORM 1;
      DELETE FROM public.audit_log WHERE false;
    END;
    $body$;
    REVOKE EXECUTE ON FUNCTION public.named_body() FROM anon;
  `);

  assert.equal(result.error, null);
  assert.equal(result.entries.length, 2);
  assert.match(result.entries[0].statement, /DELETE FROM public\.audit_log/);
  assert.match(result.entries[0].statement, /\$body\$;/);
});

test('captures routine declarations and ACLs separated by nested PostgreSQL comments', () => {
  const result = routineReferencesIn(`
    CREATE /* outer ; /* nested ; */ still outer */ FUNCTION public.nested_comment() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
    REVOKE /* outer /* nested */ still outer */ EXECUTE ON FUNCTION public.nested_comment() FROM anon;
  `);

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)),
    ['nested_comment', 'nested_comment'],
  );
  assert.match(result.entries[0].statement, /SELECT; \$\$;/);
});

test('captures complete named routine bodies despite leading and interstitial comments', () => {
  for (const sql of [
    `/* lead */ CREATE FUNCTION public.leading_comment_body() RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN PERFORM 1; DELETE FROM public.audit_log WHERE false; END;
    $body$;`,
    `CREATE /* interstitial */ FUNCTION public.interstitial_comment_body() RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN PERFORM 1; DELETE FROM public.audit_log WHERE false; END;
    $body$;`,
  ]) {
    const result = routineReferencesIn(sql);
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].statement, /DELETE FROM public\.audit_log/);
  }
});

test('keeps escaped quotes and semicolons inside PostgreSQL escape strings', () => {
  const result = routineReferencesIn(String.raw`
    SELECT E'escaped quote: \' ; not a statement boundary';
    CREATE FUNCTION public.escape_string() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
    REVOKE EXECUTE ON FUNCTION public.escape_string() FROM anon;
  `);

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)),
    ['escape_string', 'escape_string'],
  );
});

test('does not end an escape string at a backslash-escaped quote', () => {
  const escapedQuote = '\\';
  const result = routineReferencesIn(`
    SELECT E'escaped quote: ${escapedQuote}' ; not a statement boundary';
    CREATE FUNCTION public.escape_string_quote() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
    REVOKE EXECUTE ON FUNCTION public.escape_string_quote() FROM anon;
  `);

  assert.equal(result.error, null);
  assert.deepEqual(
    result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)),
    ['escape_string_quote', 'escape_string_quote'],
  );
});

test('preserves UTF-16 offsets while masking comments', () => {
  const result = routineReferencesIn(`
    /* 🚜 comment */ CREATE FUNCTION public.utf16_offset() RETURNS void LANGUAGE sql AS $$ SELECT; $$;
  `);
  assert.equal(result.error, null);
  assert.deepEqual(result.entries.flatMap(({ routines }) => routines.map(({ key }) => key)), ['utf16_offset']);
});

test('fails closed for schema-wide routine execute ACLs', () => {
  for (const statement of [
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;',
    'REVOKE ALL PRIVILEGES ON ALL PROCEDURES IN SCHEMA public FROM anon;',
    'GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO PUBLIC;',
  ]) {
    const result = routineReferencesIn(statement);
    assert.match(result.error || '', /schema-wide routine EXECUTE ACL/);
  }
});

test('identifies catalog-derived or dynamically constructed routine DDL for a fail-closed proof flow', () => {
  const catalogDerived = dynamicRoutineDdlIn(`
    DO $$ DECLARE definition text; BEGIN
      definition := pg_get_functiondef('public.example()'::regprocedure);
      EXECUTE definition;
    END; $$;
  `);
  assert.equal(catalogDerived.error, null);
  assert.equal(catalogDerived.entries.length, 1);

  const constructed = dynamicRoutineDdlIn(`
    DO $$ BEGIN
      EXECUTE format('CREATE FUNCTION public.example() RETURNS void LANGUAGE sql AS %L', 'SELECT');
    END; $$;
  `);
  assert.equal(constructed.error, null);
  assert.equal(constructed.entries.length, 1);

  const ordinaryDynamicSql = dynamicRoutineDdlIn(`DO $$ BEGIN EXECUTE 'SELECT 1'; END; $$;`);
  assert.deepEqual(ordinaryDynamicSql, { entries: [], error: null });
});
