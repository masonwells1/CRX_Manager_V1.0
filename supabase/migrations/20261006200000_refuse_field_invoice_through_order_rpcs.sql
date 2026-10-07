-- STATUS: NOT APPLIED.
-- CRX-LIFE-001: the order pipeline must never create a field_application invoice.
--
-- create_invoice_from_order and create_split_invoices_from_order (both granted to
-- authenticated, both admitting admins and sales reps) took a caller-supplied
-- p_invoice_type and inserted it unchanged. A sales rep could therefore pass
-- 'field_application' and get an order-backed field invoice with no field, grower
-- share, job, blend ticket or season workflow behind it. The only UPDATE-side guard,
-- trg_enforce_field_application_type_lock, never fires on INSERT.
--
-- This file closes it in two layers:
--   1. invoices_field_application_has_no_order: a table CHECK that a field_application
--      invoice never carries an order_id. Only postgres can write invoices, so this binds
--      every SECURITY DEFINER writer, including the split RPC's direct INSERT and any
--      future path. Every live field-invoice creator (save_field_app_invoice,
--      save_field_app_split_invoice, transfer_job_to_invoice, create_invoice_from_blend_ticket)
--      leaves order_id NULL. Live 2026-10-07: 13 invoices, 0 field_application rows with an
--      order_id, so the constraint is added VALID; the preflight re-checks that at apply time.
--   2. create_invoice_from_order refuses any type other than chemical_sale or misc_charge
--      with ORDER_INVOICE_TYPE_NOT_ALLOWED, before any lock or idempotency lookup.
--      misc_charge stays allowed: save_invoice already retypes order invoices between the
--      two, and the e2e seed and the govern smoke chain use it. credit_memo is refused too:
--      credit memos come only from issue_return_credit, and no caller sends it here.
--
-- The split RPC is deliberately NOT re-emitted. Its field_application INSERT now fails on
-- the CHECK (SQLSTATE 23514) and its claim/lock work rolls back with it; a credit_memo
-- split can never produce a row (positive totals vs invoices_credit_memo_total_nonpositive).
-- Re-copying its 5k-character idempotency body would add risk without adding protection.
--
-- No rows are changed. No GRANT or REVOKE: CREATE OR REPLACE keeps the live OID, owner
-- and exact ACL, and the postflight proves it.
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE crx_life_001_order_invoice_type_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid AS function_oid;

DO $preflight$
DECLARE v_oid oid := to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)');
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '9ef2d1f8fd901ff7979487d3d60d4d71'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_invoice_from_order contract';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.invoices'::regclass
                AND conname = 'invoices_field_application_has_no_order') THEN
    RAISE EXCEPTION 'PREFLIGHT_FIELD_INVOICE_ORDER_CHECK_EXISTS: invoices_field_application_has_no_order is already installed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices
              WHERE invoice_type = 'field_application' AND order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_BACKED_FIELD_INVOICE_EXISTS: repair order-backed field_application invoices before adding the check';
  END IF;
END
$preflight$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_field_application_has_no_order
  CHECK (invoice_type <> 'field_application' OR order_id IS NULL);

CREATE OR REPLACE FUNCTION public.create_invoice_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order'
      USING ERRCODE = '22023';
  END IF;
  -- Field invoices come only from the field-application, job-transfer and blend-ticket
  -- workflows, and credit memos only from issue_return_credit (CRX-LIFE-001).
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN public._create_invoice_from_order_idem_impl_20260721(
    p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key
  );
END;
$function$;

DO $postflight$
DECLARE v_oid oid := to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)');
BEGIN
  IF to_regclass('pg_temp.crx_life_001_order_invoice_type_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.crx_life_001_order_invoice_type_tx)
          IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CRX_LIFE_001_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF v_oid IS DISTINCT FROM (SELECT function_oid FROM pg_temp.crx_life_001_order_invoice_type_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_IDENTITY: the replace must preserve the function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = 'a1a91643bd8866823ae359f7e0ec290e'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_CONTRACT: public create_invoice_from_order body, signature or access drifted';
  END IF;
  IF (SELECT c.convalidated AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) = 'CHECK (((invoice_type <> ''field_application''::text) OR (order_id IS NULL)))'
        FROM pg_constraint c
       WHERE c.conrelid = 'public.invoices'::regclass
         AND c.conname = 'invoices_field_application_has_no_order') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_FIELD_INVOICE_ORDER_CHECK: invoices_field_application_has_no_order is missing, unvalidated or different';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: order invoices refuse field_application and credit_memo; field invoices can never carry an order';
END
$postflight$;
