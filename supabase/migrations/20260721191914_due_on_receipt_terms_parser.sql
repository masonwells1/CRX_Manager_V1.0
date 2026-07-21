CREATE OR REPLACE FUNCTION public.parse_payment_terms_days(p_terms text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_match text;
  v_days  numeric;                   -- numeric (arbitrary precision), NOT integer: a pasted
                                     -- giant number ('Net 9999999999') would overflow an
                                     -- integer cast and RAISE before the clamp — Codex P2.
BEGIN
  IF lower(btrim(COALESCE(p_terms, ''))) IN (
    'due on receipt', 'due upon receipt', 'receipt', 'immediately'
  ) THEN
    RETURN 0;
  END IF;

  -- first run of digits anywhere in the string: 'net_30' -> 30, 'Net 30' -> 30,
  -- 'Net 45' -> 45, '2/10 Net 30' -> 2 (rare; acceptable — no such live value)
  v_match := (regexp_match(COALESCE(p_terms, ''), '(\d+)'))[1];
  IF v_match IS NULL THEN
    RETURN 30;                       -- NULL / blank / no number -> default Net 30
  END IF;
  v_days := v_match::numeric;        -- numeric never overflows on an oversized digit run
  IF v_days < 1 OR v_days > 365 THEN
    RETURN 30;                       -- clamp a typo'd/pasted 'net 3000' etc. back to default
  END IF;
  RETURN v_days::integer;            -- safe: guaranteed 1..365
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.parse_payment_terms_days(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.parse_payment_terms_days(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.parse_payment_terms_days(text) TO authenticated, service_role;
