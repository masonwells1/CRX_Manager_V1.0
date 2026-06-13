-- predicate (e): secdef-searchpath
-- Every SECURITY DEFINER function MUST pin search_path (CLAUDE.md Migration Safety Rule:
--   "Every SECURITY DEFINER function MUST have SET search_path = public, pg_temp"). A SECDEF
--   function with a mutable search_path is a privilege-escalation vector (an attacker who can
--   create objects in a schema earlier on the path can hijack an unqualified reference while the
--   function runs as owner).
-- Would have caught: any future migration that adds a SECDEF function and forgets the SET clause —
--   the exact class the migration-drift-reviewer checks per-diff, here enforced against LIVE state.
-- Contract: EXPECT ZERO rows. There is no legitimate allowlist case — fix the function. (Live count
--   at authoring time: 0.)

SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS violation_key,
       p.proname,
       p.proconfig
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND (p.proconfig IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%'
          ))
ORDER BY violation_key;
