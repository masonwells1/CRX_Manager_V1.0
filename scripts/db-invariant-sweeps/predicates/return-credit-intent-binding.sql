-- predicate: return-credit-intent-binding
-- The six return RPC entry points must be the exact reviewed actor/intent
-- wrappers from 20260812130145. Their renamed business implementations and
-- the existing check_idempotency_intent helper must remain browser-inaccessible.
-- The shared credit reversal helper must be the exact due-date-aware wrapper.
-- Contract: EXPECT ZERO rows.

WITH expected(signature, body_sha256) AS (
  VALUES
    ('create_return(jsonb,jsonb,text)', 'ce29f6ff02f49923aca668dd497bededb9e82fdee2d0470efc535ec701e61251'),
    ('approve_return(uuid,uuid,text)', '20c75d49ff570c03ca1c9216cfaf9d5a7beb26f2be07ae50c7304afda758a5f8'),
    ('reject_return(uuid,uuid,text)', '77ab212fd0df5796c22994b6b520b4efd327f53d188d62885ec1c768eb103af4'),
    ('cancel_return(uuid,text,uuid,text)', '7207a20de54e00922daeedc13b3ade2526df381f29e4736078e9401be101c53b'),
    ('receive_return(uuid,uuid,text)', '80873cb93b67293a811f6be91efb224f7f4dd085fa8c4282267336be430b8b6a'),
    ('issue_return_credit(uuid,uuid,text)', 'b93b4948fd138e6e65031b81959c7311f2846d354af45a8a882c09f1514a6314')
), protected_expected(signature, body_sha256) AS (
  VALUES
    ('_reverse_credit_memo_application(uuid,uuid,text,text)', '744c48493d549f9bc2297270bfdc0977935a4f29ed44fe2e336c8a6fce6ecbf8'),
    ('snapshot_invoice_line_shares_on_post()', 'f12078a7b476444df206f0e9baa21fff26ee5cda9ef6a96dabf772909984f42a'),
    ('check_idempotency_intent(text,text,uuid,text)', '71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8')
), public_actual AS (
  SELECT p.oid,
         p.oid::regprocedure::text AS signature,
         encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') AS body_sha256,
         p.prosecdef,
         p.proconfig,
         pg_get_userbyid(p.proowner) AS function_owner
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN (
       'create_return', 'approve_return', 'reject_return',
       'cancel_return', 'receive_return', 'issue_return_credit'
     )
), private_expected(signature) AS (
  VALUES
    ('_create_return_intent_impl_20260812(jsonb,jsonb,text)'),
    ('_approve_return_intent_impl_20260812(uuid,uuid,text)'),
    ('_reject_return_intent_impl_20260812(uuid,uuid,text)'),
    ('_cancel_return_intent_impl_20260812(uuid,text,uuid,text)'),
    ('_receive_return_intent_impl_20260812(uuid,uuid,text)'),
    ('_issue_return_credit_intent_impl_20260812(uuid,uuid,text)'),
    ('_reverse_credit_memo_application_status_impl_20260812(uuid,uuid,text,text)')
), private_actual AS (
  SELECT p.oid, p.oid::regprocedure::text AS signature
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname LIKE '%\_impl\_20260812' ESCAPE '\'
)
SELECT 'return-credit-wrapper:' || e.signature AS violation_key,
       'public return RPC body/config/grants drifted from the exact reviewed actor-and-intent wrapper' AS reason
  FROM expected e
  LEFT JOIN public_actual a ON a.signature = e.signature
 WHERE a.oid IS NULL
    OR a.body_sha256 IS DISTINCT FROM e.body_sha256
    OR a.function_owner IS DISTINCT FROM 'postgres'
    OR NOT a.prosecdef
    OR a.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
    OR NOT has_function_privilege('authenticated', a.oid, 'EXECUTE')
    OR has_function_privilege('anon', a.oid, 'EXECUTE')

UNION ALL

SELECT 'return-credit-wrapper:unexpected-overload:' || a.signature,
       'unexpected public return RPC overload bypasses the reviewed wrapper' AS reason
  FROM public_actual a
  LEFT JOIN expected e ON e.signature = a.signature
 WHERE e.signature IS NULL

UNION ALL

SELECT 'return-credit-private:' || e.signature,
       'private return implementation is missing or executable by a PostgREST role' AS reason
  FROM private_expected e
  LEFT JOIN private_actual a ON a.signature = e.signature
 WHERE a.oid IS NULL
    OR has_function_privilege('anon', a.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', a.oid, 'EXECUTE')
    OR has_function_privilege('service_role', a.oid, 'EXECUTE')

UNION ALL

SELECT 'return-credit-reversal:due-date-status' AS violation_key,
       'shared reversal helper is missing or no longer the exact reviewed overdue/posted status wrapper' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_proc p
    WHERE p.oid = to_regprocedure('public._reverse_credit_memo_application(uuid,uuid,text,text)')
      AND encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = (
        SELECT body_sha256 FROM protected_expected
         WHERE signature = '_reverse_credit_memo_application(uuid,uuid,text,text)'
      )
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
 )

UNION ALL

SELECT 'return-credit-reversal:snapshot-suppression' AS violation_key,
       'split post snapshot trigger no longer has the exact reviewed reversal-only suppression guard' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.snapshot_invoice_line_shares_on_post()')
      AND encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = (
        SELECT body_sha256 FROM protected_expected
         WHERE signature = 'snapshot_invoice_line_shares_on_post()'
      )
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
 )

UNION ALL

SELECT 'check_idempotency_intent:contract' AS violation_key,
       'receipt-binding helper body, overload count, owner, security mode, search path, or grants drifted' AS reason
 WHERE (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = 'check_idempotency_intent') <> 1
    OR NOT EXISTS (
      SELECT 1
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)')
         AND encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = (
           SELECT body_sha256 FROM protected_expected
            WHERE signature = 'check_idempotency_intent(text,text,uuid,text)'
         )
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
    );
