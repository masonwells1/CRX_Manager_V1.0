-- Keep order-level invoice recovery aligned with the return-credit billing
-- predicate used by delivery recovery and the UI. A credit memo reverses a
-- recognized sale; it is not itself proof that the order has been billed.
-- Soft-deleted invoices likewise do not cover the order.
--
-- This file intentionally rewrites only one exact guard in each pinned private
-- implementation. The preflight aborts on any current-source or contract drift,
-- and the postflight pins the exact resulting bodies and private grants.

DO $preflight$
DECLARE
  v_order regprocedure := to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)');
  v_split regprocedure := to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)');
  v_order_old text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'');';
  v_split_old text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'');';
BEGIN
  IF v_order IS NULL OR v_split IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_create_invoice_from_order_impl_20260718') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_create_split_invoices_from_order_provenance_impl_20260719') <> 1 THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_PREFLIGHT_OVERLOAD_DRIFT';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_order
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '1280d2461c9e79712900a7208fc2fcd760ccd9b4448f7fb3fc89a5523196bfc5'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_order_old, ''))) / length(v_order_old) = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_split
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid[]'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '4e17b8eb18b544ebab5785f88c2346f76528a3a490c0a31b5f765b06db24d351'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_split_old, ''))) / length(v_split_old) = 1
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE r.rolname IN ('anon','authenticated','service_role')
         AND (has_function_privilege(r.oid, v_order, 'EXECUTE')
              OR has_function_privilege(r.oid, v_split, 'EXECUTE'))
     ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_PREFLIGHT_CONTRACT_DRIFT';
  END IF;
END;
$preflight$;

DO $rewrite$
DECLARE
  v_order_old text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'');';
  v_order_new text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
  v_split_old text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'');';
  v_split_new text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
  v_src text;
BEGIN
  SELECT p.prosrc INTO STRICT v_src
  FROM pg_proc p
  WHERE p.oid = 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'::regprocedure;
  v_src := replace(v_src, v_order_old, v_order_new);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public._create_invoice_from_order_impl_20260718(p_order_id uuid, p_salesman_id uuid DEFAULT NULL, p_invoice_type text DEFAULT ''chemical_sale'', p_idempotency_key text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS %L',
    v_src
  );

  SELECT p.prosrc INTO STRICT v_src
  FROM pg_proc p
  WHERE p.oid = 'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'::regprocedure;
  v_src := replace(v_src, v_split_old, v_split_new);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(p_order_id uuid, p_salesman_id uuid DEFAULT NULL, p_invoice_type text DEFAULT ''chemical_sale'', p_idempotency_key text DEFAULT NULL) RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS %L',
    v_src
  );
END;
$rewrite$;

REVOKE ALL ON FUNCTION public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_order regprocedure := 'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'::regprocedure;
  v_split regprocedure := 'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'::regprocedure;
  v_order_new text := E'SELECT COUNT(*) INTO v_existing_count\n    FROM invoices\n   WHERE order_id = p_order_id\n     AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
  v_split_new text := E'SELECT COUNT(*) INTO v_existing_count FROM invoices\n    WHERE order_id = p_order_id AND status NOT IN (''voided'', ''cancelled'')\n     AND invoice_type <> ''credit_memo''\n     AND deleted_at IS NULL;';
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_order
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             'c8b12fc25025e598846b6b2fbdfe4e0fd0e30078086b17194807f1428b9d0d7e'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_order_new, ''))) / length(v_order_new) = 1
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_split
         AND p.proargtypes = '2950 2950 25 25'::oidvector
         AND p.prorettype = 'uuid[]'::regtype
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '9d3de61eb30e9b9435556da45fe17c15a1b83285c917e3a5e7c2893cb4428104'
         AND (length(p.prosrc) - length(replace(p.prosrc, v_split_new, ''))) / length(v_split_new) = 1
     )
     OR EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE r.rolname IN ('anon','authenticated','service_role')
         AND (has_function_privilege(r.oid, v_order, 'EXECUTE')
              OR has_function_privilege(r.oid, v_split, 'EXECUTE'))
     ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ORDER_GATE_POSTFLIGHT_CONTRACT_DRIFT';
  END IF;
END;
$postflight$;
