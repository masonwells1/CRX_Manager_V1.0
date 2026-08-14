-- STATUS: NOT APPLIED
-- Make a caller-supplied below_cost_reason key authoritative for this request,
-- including an explicit JSON null. The applied 20260812154028 implementation
-- only returned early for a non-empty key, then recursively searched persisted
-- notes and could reuse an older "Below-cost approved:" marker as permission
-- for a later save against different locked costs.
--
-- This is a forward-only replacement. It pins the exact applied predecessor,
-- preserves the function signature, volatility, search_path and private ACL,
-- and changes only the object branch's explicit-key behavior.

DO $precondition$
DECLARE
  v_count integer;
  v_body text;
  v_security_definer boolean;
  v_volatility "char";
  v_config text[];
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = '_below_cost_reason_from_json'
    AND p.pronargs = 1
    AND p.proargtypes[0] = 'jsonb'::regtype;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_PRECONDITION: expected one public._below_cost_reason_from_json(jsonb), found %', v_count;
  END IF;
  SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig
    INTO v_body, v_security_definer, v_volatility, v_config
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = '_below_cost_reason_from_json'
    AND p.pronargs = 1
    AND p.proargtypes[0] = 'jsonb'::regtype;
  IF md5(v_body) <> '6fda4d6d7ab47a8781879205d9bdc92e' THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_PRECONDITION: predecessor body drifted; re-derive from current live source';
  END IF;
  IF v_security_definer OR v_volatility <> 'i'
     OR NOT COALESCE(v_config @> ARRAY['search_path=public, pg_temp'], false) THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_PRECONDITION: security, volatility, or search_path drifted';
  END IF;
END;
$precondition$;

CREATE OR REPLACE FUNCTION public._below_cost_reason_from_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_child jsonb;
  v_reason text;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb THEN
    RETURN NULL;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'string' THEN
      v_reason := public._below_cost_reason_from_text(p_value #>> '{}');
      IF v_reason IS NULL AND length(btrim(p_value #>> '{}')) > 0
         AND (p_value #>> '{}') NOT LIKE '%Below-cost approved:%' THEN
        RETURN NULL;
      END IF;
      RETURN v_reason;
    WHEN 'array' THEN
      FOR v_child IN SELECT value FROM jsonb_array_elements(p_value)
      LOOP
        v_reason := public._below_cost_reason_from_json(v_child);
        IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
      END LOOP;
    WHEN 'object' THEN
      IF p_value ? 'below_cost_reason' THEN
        -- Presence is the request boundary. Explicit null/blank means this
        -- attempt has no approval and must not inherit one from nested notes.
        RETURN NULLIF(btrim(p_value->>'below_cost_reason'), '');
      END IF;
      FOR v_child IN SELECT value FROM jsonb_each(p_value)
      LOOP
        v_reason := public._below_cost_reason_from_json(v_child);
        IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
      END LOOP;
    ELSE
      NULL;
  END CASE;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._below_cost_reason_from_json(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._below_cost_reason_from_json(jsonb) TO postgres;

DO $postcondition$
DECLARE
  v_count integer;
  v_body text;
  v_security_definer boolean;
  v_volatility "char";
  v_config text[];
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = '_below_cost_reason_from_json'
    AND p.pronargs = 1
    AND p.proargtypes[0] = 'jsonb'::regtype;

  IF v_count = 1 THEN
    SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig
      INTO v_body, v_security_definer, v_volatility, v_config
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = '_below_cost_reason_from_json'
      AND p.pronargs = 1
      AND p.proargtypes[0] = 'jsonb'::regtype;
  END IF;

  IF v_count <> 1 OR md5(v_body) <> 'ce11e545ea5216400d330766a951902a' THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_POSTCONDITION: installed body mismatch';
  END IF;
  IF v_security_definer OR v_volatility <> 'i'
     OR NOT COALESCE(v_config @> ARRAY['search_path=public, pg_temp'], false) THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_POSTCONDITION: security, volatility, or search_path mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_function_privilege(r.rolname, 'public._below_cost_reason_from_json(jsonb)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'FRESH_BELOW_COST_REASON_POSTCONDITION: private parser is application-role executable';
  END IF;
END;
$postcondition$;
