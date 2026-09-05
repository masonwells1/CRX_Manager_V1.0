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
