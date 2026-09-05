import assert from 'node:assert/strict';
import test from 'node:test';
import { routineReferencesIn } from './migration-routine-references.mjs';

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
});
