-- predicate: profile role-lock guard covers INSERT, not only UPDATE
--
-- GREEN AS OF 2026-08-07 (evening): the fix migration was applied live as
-- `20260807215532_profile_role_lock_covers_insert` and this predicate was
-- verified 2 rows red before the apply and 0 rows after. It now stands as the
-- permanent regression alarm for the INSERT arm (see KNOWN LIMIT below).
--
-- Live state 2026-08-07, which is exactly what the two INSERT-arm rows below fire on:
--   trg_guard_profile_role_lock -> BEFORE UPDATE ON public.profiles FOR EACH ROW
--     (tgtype 19 = ROW|BEFORE|UPDATE; the target is 23 = ROW|BEFORE|INSERT|UPDATE)
--   _guard_profile_role_lock body has no TG_OP branch at all
--
-- Background — KNOWN_ISSUES §0d ("Follow-ups this exposed", bullet 1). §0d was
-- an escalation-to-admin path: delete your own `profiles` row through the
-- unguarded `profile_public_view`, then re-insert it with `role = 'admin'`.
-- `20260729125227_secure_profile_public_directory` closed the DELETE half. The
-- INSERT half was left open: `profiles_insert` is
-- `TO authenticated WITH CHECK (auth.uid() = id OR is_admin())` with no role
-- pin, `profiles_role_check` permits `'admin'`, and the role-lock trigger is
-- BEFORE UPDATE only, so it never fires on INSERT.
--
-- Why a standing sweep and not just the migration's own postflight: a
-- postflight `DO $$ ... $$` runs once, at apply time. The failure mode that
-- actually costs something here is a LATER `CREATE OR REPLACE FUNCTION`
-- re-emitting the pre-fix body, or a later migration re-creating the trigger
-- with only `BEFORE UPDATE` — the pending-migration overlap-clobber class,
-- which a one-shot postflight cannot see. Both restore full escalation
-- silently. This re-checks on every sweep run.
--
-- Rows returned = violations. Six reasons:
--   guard_function_missing        -- `public._guard_profile_role_lock()` no longer resolves
--   trigger_missing_or_disabled   -- trigger gone, or tgenabled <> 'O' (a DISABLEd
--                                    trigger still shows a perfect pg_get_triggerdef,
--                                    so enablement is checked from tgenabled directly)
--   trigger_not_insert_and_update -- tgtype <> 23; this is the arm that is RED today
--   insert_arm_missing_in_body    -- the body has no executable TG_OP='INSERT' branch
--                                    raising the insert lock; also RED today
--   update_arm_weakened           -- INVERSE check: the pre-existing four-column
--                                    UPDATE lock (role/is_active/denied_pages/full_name
--                                    gated on is_admin()) must survive. Trading the
--                                    UPDATE lock for the INSERT lock would be a net
--                                    loss, and a sweep looking only for the new arm
--                                    would never notice.
--   not_secdef_or_no_search_path  -- SECURITY DEFINER dropped, or search_path is no
--                                    longer exactly `public, pg_temp`
--
-- Body checks read comment- and literal-stripped text (`code_src`), following
-- `office-only-pricing-secdef-gates.sql`. Without that, a body that deletes the
-- INSERT arm and leaves its text behind in a `--` comment or parked in a string
-- literal satisfies every regex while the escalation is fully reopened. The
-- strips are naive and may over-blank; that is the safe direction — over-
-- stripping can only delete a real match and raise a false alarm, never
-- manufacture a guard that is not there. Note the dollar-quote tag class is
-- `[^$]` (tags may contain digits, e.g. `$phase3_x$`) and both leading
-- quantifiers are non-greedy, because Postgres POSIX regex takes greediness for
-- the whole expression from its FIRST quantifier.
--
-- KNOWN LIMIT — this is a regression ALARM, not a proof of enforcement. It reads
-- catalog text, so it establishes the arm is present, executable rather than
-- inert, and wired to the right trigger events. It cannot establish that the arm
-- is REACHABLE (an arm buried under `IF false THEN`, or after an unconditional
-- RETURN, would pass). Whenever this body is re-emitted, prove it the way the
-- migration's postflight does: impersonate a real active NON-admin
-- (`set_config('request.jwt.claims', ...)` + `SET LOCAL ROLE authenticated`),
-- attempt the own-id `role='admin'` insert, and confirm SQLSTATE 42501. A
-- service_role or postgres attempt proves nothing — `auth.uid()` is NULL for
-- those and the INSERT arm deliberately does not fire on them.

WITH raw AS (
  SELECT p.oid,
         p.prosecdef,
         p.proconfig,
         regexp_replace(
           regexp_replace(coalesce(p.prosrc, ''), '/\*.*?\*/', ' ', 'gs'),
           '--[^\n]*', ' ', 'g') AS exec_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()')
),
fn AS (
  SELECT r.*, c.code_src
    FROM raw r
    CROSS JOIN LATERAL (
      SELECT regexp_replace(
               regexp_replace(
                 regexp_replace(r.exec_src, '\$([^$]*?)\$.*?\$\1\$', ' ', 'gs'),
                 '''(?:[^''\\]|''''|\\.)*''', ' ', 'g'),
               '"(?:[^"]|"")*"', ' ', 'g') AS code_src
    ) c
),
trg AS (
  SELECT t.tgtype, t.tgenabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.profiles'::regclass
     AND t.tgname = 'trg_guard_profile_role_lock'
     AND NOT t.tgisinternal
),
violation AS (
  SELECT '_guard_profile_role_lock' AS violation_key,
         'guard_function_missing' AS reason
   WHERE NOT EXISTS (SELECT 1 FROM fn)

  UNION ALL
  SELECT 'trg_guard_profile_role_lock', 'trigger_missing_or_disabled'
   WHERE NOT EXISTS (SELECT 1 FROM trg WHERE tgenabled = 'O')

  UNION ALL
  -- 23 = ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16). Today's live value is 19
  -- (no INSERT bit), so this row is the expected red.
  SELECT 'trg_guard_profile_role_lock', 'trigger_not_insert_and_update'
    FROM trg
   WHERE tgtype <> 23::smallint

  UNION ALL
  -- Shape, not error labels: a rewrite that keeps the PROFILE_INSERT_LOCK token
  -- while deleting the branch would satisfy a presence-only test. Require an
  -- executable TG_OP = 'INSERT' test AND a raise carrying the insufficient-
  -- privilege SQLSTATE. The TG_OP comparison value survives literal-stripping
  -- checks because it is matched on exec_src, where literals are retained;
  -- the branch keyword itself is matched on code_src.
  SELECT '_guard_profile_role_lock', 'insert_arm_missing_in_body'
    FROM fn
   WHERE code_src !~* 'TG_OP'
      OR exec_src !~* 'TG_OP\s*=\s*''INSERT'''
      OR exec_src !~* 'PROFILE_INSERT_LOCK'
      OR code_src !~* 'RAISE\s+EXCEPTION'
      OR exec_src !~* 'ERRCODE\s*=\s*''42501'''

  UNION ALL
  -- INVERSE: the original UPDATE lock must still be there in full.
  SELECT '_guard_profile_role_lock', 'update_arm_weakened'
    FROM fn
   WHERE code_src !~* 'OLD\.role\s+IS\s+DISTINCT\s+FROM\s+NEW\.role'
      OR code_src !~* 'OLD\.is_active\s+IS\s+DISTINCT\s+FROM\s+NEW\.is_active'
      OR code_src !~* 'OLD\.denied_pages\s+IS\s+DISTINCT\s+FROM\s+NEW\.denied_pages'
      OR code_src !~* 'OLD\.full_name\s+IS\s+DISTINCT\s+FROM\s+NEW\.full_name'
      OR code_src !~* 'NOT\s+(public\.)?is_admin\(\)'

  UNION ALL
  -- Exact search_path, not a LIKE: '%pg_temp%' would also accept
  -- 'search_path=attacker, pg_temp', the classic SECURITY DEFINER hijack.
  -- Postgres normalizes list GUCs to ', '-joined, so the exact string is safe to pin.
  SELECT '_guard_profile_role_lock', 'not_secdef_or_no_search_path'
    FROM fn
   WHERE NOT prosecdef
      OR proconfig IS NULL
      OR NOT (proconfig @> ARRAY['search_path=public, pg_temp'])
)
SELECT violation_key, reason
FROM violation
ORDER BY violation_key, reason;
