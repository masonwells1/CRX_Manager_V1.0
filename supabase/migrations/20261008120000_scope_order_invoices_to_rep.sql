-- Written 2026-10-08. Apply status is tracked only in docs/reference/migration-history.md (row 938).
-- Rep scoping for order invoices (Mason 2026-10-06): a sales rep bills only customers
-- assigned to them, and only under their own name. Admins are unrestricted.
--
-- create_invoice_from_order and create_split_invoices_from_order (both granted to
-- authenticated, both admitting admins and sales reps) checked only the caller's role. A
-- sales rep could bill any customer's order, and could record any salesman (directly through
-- p_salesman_id, or through the COALESCE(p_salesman_id, orders.salesman_id) fallback both
-- implementations write). save_invoice and post_invoice_group already refuse both.
--
-- This file re-emits only the two public wrappers, starting from their verbatim live bodies:
--   1. For a caller where public.is_sales_rep() is true, before any lock, idempotency
--      lookup or claim, invoice number or write:
--        - create_invoice_from_order: the rep must be customers.assigned_sales_rep of the
--          order's customer;
--        - create_split_invoices_from_order: the rep must be the assigned rep of EVERY
--          customer the split could bill - the order's customer plus every candidate field
--          owner (field_billing_defaults when the field has any, else fields.customer_id),
--          including owners whose share nets to zero (strict on purpose; post_invoice_group
--          already refuses a rep any group member that is not theirs);
--        - the salesman the RPC will record, COALESCE(p_salesman_id, orders.salesman_id),
--          must be NULL or the caller.
--      Refusals are bare CUSTOMER_SCOPE_DENIED / SALESMAN_SCOPE_DENIED (P0001), the same
--      text save_invoice raises.
--   2. Each wrapper re-checks the invoices it actually returns (created or replayed): this
--      closes the window between the unlocked pre-check read and the implementation's
--      order lock, and scopes an idempotent replay the way save_invoice does (including a
--      replayed invoice whose salesman was changed after it was created). A refusal here
--      comes after the implementation drew its invoice number: the invoice rows roll back,
--      the number does not. Only a change committed inside that window reaches it (an admin
--      moving the order's customer or salesman), and the result is a gap in invoice
--      numbering, never an out-of-scope invoice. A field_billing_defaults change in that
--      window (which live RLS lets sales reps make) cannot bill a different customer either:
--      the existing lineage guard (trg_guard_invoice_terminal_order) refuses any order
--      invoice whose customer is not the order's, again after a number is drawn. The
--      re-check covers the invoices actually written; a candidate owner whose share nets to
--      zero gets no invoice, so it is checked only by the strict pre-check (Mason's rule is
--      about who is billed, and that set is exactly the returned invoices).
--   3. The split wrapper also gets the CRX-LIFE-001 type allow-list (chemical_sale or
--      misc_charge, ORDER_INVOICE_TYPE_NOT_ALLOWED / 23514) right after its role gate, so
--      a refused split no longer draws an invoice number (nextval in the invoice_number
--      default is not rolled back) before the invoices CHECK refuses it.
--   4. The split wrapper now REQUIRES its idempotency key (Codex P1 on PR #891; CRX hard
--      rule: mutating RPCs accept AND enforce p_idempotency_key). Its first statement is
--      the exact check create_invoice_from_order already makes first: a NULL, empty or
--      all-whitespace key is IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order
--      (22023), before the role gate, any lock, claim, invoice number or write. Before this,
--      a NULL key skipped the claim (and _bind_completed_lifecycle_idempotency returns at
--      once for NULL) and still created invoices, so a caller that lost the response could
--      not replay safely. Every caller already sends a key (read live 2026-10-09: the one
--      SQL caller, _complete_delivery_authorized_impl, passes
--      COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit' after finding the
--      delivery by id, so never NULL or blank; the one app caller, OrderDetail.tsx, passes a
--      useIdempotencyKey key; no edge function or cron job calls it).
-- complete_delivery is not re-emitted: its one call into the split wrapper is inside
-- BEGIN ... EXCEPTION WHEN OTHERS, so a refusal there flags the order for split billing and
-- notifies admins; the delivery itself always completes. The idempotency request shapes
-- and contract names are byte-identical, so existing keys keep replaying.
-- NOT covered here (open, needs Mason's decision, see KNOWN_ISSUES): complete_delivery's
-- auto-invoice for an order WITHOUT field allocations is a direct INSERT that never calls
-- either wrapper, so a rep completing another rep's customer's last delivery still gets a
-- draft for that customer. This file does not by itself enforce the rule system-wide.
--
-- idempotency-body-check: exempt - both wrappers require the key as their first statement
-- and keep their existing idempotency: create_invoice_from_order delegates to
-- _create_invoice_from_order_idem_impl_20260721 (check_idempotency before any write,
-- save_idempotency after); create_split_invoices_from_order claims the key with
-- _claim_bound_lifecycle_idempotency before any write and binds the result with
-- _bind_completed_lifecycle_idempotency after it. The new checks run before both.
--
-- No rows are changed. No GRANT or REVOKE: CREATE OR REPLACE keeps the live OID, owner
-- and exact ACL, and the postflight proves it.
-- ORDERING: strict. Apply after every older pending migration. In particular PR #889's
-- 20261007150000, 20261007150050, 20261007150100 and 20261007150200 MUST be applied live
-- first: applying this file before them raises the ledger high-water above their stamps and
-- strands them (they would then need renumbering). The pending-set guard reads only files on
-- origin/main, so it cannot enforce this while #889 is unmerged; the preflight below does
-- (PREFLIGHT_PR889_NOT_APPLIED: all four must be in the ledger by name, as
-- scripts/apply-migration-file.mjs records them). If #889 is renumbered or dropped, change
-- that check in the same change. Still re-read the live ledger immediately before applying.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE crx_rep_scope_order_invoice_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid AS cifo_oid,
       to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')::oid AS split_oid;

DO $preflight$
DECLARE
  v_cifo oid := to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)');
  v_split oid := to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)');
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF to_regclass('pg_temp.crx_rep_scope_order_invoice_tx') IS NULL THEN
    RAISE EXCEPTION 'CRX_REP_SCOPE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.crx_rep_scope_order_invoice_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CRX_REP_SCOPE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- Every md5 pin strips carriage returns: live stores the idem impl's body with CRLF and a
  -- replay stores LF. The two wrappers have none, so for them this IS the raw md5.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = 'a1a91643bd8866823ae359f7e0ec290e'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_cifo) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_invoice_from_order contract';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '398030fbb64006b4750e7e89a61b6cb9'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_split) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_split_invoices_from_order contract';
  END IF;

  -- The delegates the wrappers call, the role helper the scope rule keys on, and the one
  -- internal caller (complete_delivery's auto-split, inside EXCEPTION WHEN OTHERS).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = '3d393fb8639dbcb2aa38574ca9679eee'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = '454e04c4e199549a4f5be9975e397e17'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT: expected the exact reviewed create_invoice_from_order implementations';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = 'f671f1a3f5406cff52aedd8a5fb40b31'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_INVOICE_DELEGATE_DRIFT: expected the exact reviewed split provenance implementation (its owner rule is what the scope pre-check mirrors)';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = 'fcb3133010fe3f4f56e3be31f709d102' AND p.prosecdef
        AND p.provolatile = 's' AND p.proowner = 'postgres'::regrole
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.is_sales_rep()'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ROLE_HELPER_DRIFT: expected the exact reviewed public.is_sales_rep()';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = 'f8de9f000e40f7bfd8f792012f04fee0'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'a1e9a043f27d3566f8ecf6d5e3a809ab'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT: expected the exact reviewed complete_delivery wrapper and implementation (its auto-split call must stay inside EXCEPTION WHEN OTHERS)';
  END IF;

  IF (SELECT count(*)
        FROM (VALUES ('customers', 'id'),
                     ('customers', 'assigned_sales_rep'),
                     ('orders', 'id'),
                     ('orders', 'customer_id'),
                     ('orders', 'salesman_id'),
                     ('order_items', 'id'),
                     ('order_items', 'order_id'),
                     ('invoices', 'id'),
                     ('invoices', 'customer_id'),
                     ('invoices', 'salesman_id'),
                     ('fields', 'id'),
                     ('field_billing_defaults', 'field_id'),
                     ('field_billing_defaults', 'customer_id'),
                     ('fields', 'customer_id'),
                     ('order_item_field_allocations', 'field_id'),
                     ('order_item_field_allocations', 'order_item_id')) AS want(table_name, column_name)
        JOIN pg_attribute a
          ON a.attrelid = to_regclass('public.' || want.table_name)
         AND a.attname = want.column_name
         AND a.atttypid = 'uuid'::regtype
         AND a.attnum > 0
         AND NOT a.attisdropped) <> 16 THEN
    RAISE EXCEPTION 'PREFLIGHT_SCOPE_COLUMNS_MISSING: a customer, order, line, invoice, field or allocation column the scope rule reads is missing or not uuid';
  END IF;

  -- Apply order (see the ORDERING header): PR #889's four migrations must already be in the
  -- ledger, by the name scripts/apply-migration-file.mjs records (the file stem; its version
  -- column is the apply time, so it cannot be used). Applying this file first strands them.
  IF (SELECT count(DISTINCT m.name)
        FROM supabase_migrations.schema_migrations m
       WHERE m.name IN ('20261007150000_record_deliveries_billed_outside_crx',
                        '20261007150050_lock_soft_deleted_orders',
                        '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man',
                        '20261007150200_release_reservations_of_deleted_spring_orders')) <> 4 THEN
    RAISE EXCEPTION 'PREFLIGHT_PR889_NOT_APPLIED: apply PR #889''s 20261007150000, 150050, 150100 and 150200 live first; applying this file before them strands them';
  END IF;
END
$preflight$;

-- No GRANT/REVOKE on purpose: CREATE OR REPLACE keeps this OID's owner and ACL; the postflight
-- asserts EXECUTE is exactly {authenticated, postgres, service_role} and anon cannot execute.
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
DECLARE
  v_actor uuid := auth.uid();
  v_scope_rep boolean := false;
  v_order_customer_id uuid;
  v_order_salesman_id uuid;
  v_invoice_id uuid;
  v_invoice_customer_id uuid;
  v_invoice_salesman_id uuid;
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
  -- Rep scope (Mason 2026-10-06): a sales rep bills only a customer assigned to them and
  -- only under their own name; the salesman recorded is COALESCE(p_salesman_id,
  -- orders.salesman_id). Admins are unrestricted. Runs before any lock, replay lookup,
  -- invoice number or write.
  v_scope_rep := public.is_sales_rep();
  IF v_scope_rep THEN
    SELECT o.customer_id, o.salesman_id
      INTO v_order_customer_id, v_order_salesman_id
      FROM public.orders o
     WHERE o.id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order not found: %', p_order_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customers c
                    WHERE c.id = v_order_customer_id AND c.assigned_sales_rep = v_actor) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF COALESCE(p_salesman_id, v_order_salesman_id) IS NOT NULL
       AND COALESCE(p_salesman_id, v_order_salesman_id) IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;
  v_invoice_id := public._create_invoice_from_order_idem_impl_20260721(
    p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key
  );
  -- Authoritative re-check of the invoice actually created or replayed: closes the window
  -- between the unlocked read above and the implementation's order lock, and scopes an
  -- idempotent replay like save_invoice does.
  IF v_scope_rep THEN
    SELECT i.customer_id, i.salesman_id INTO v_invoice_customer_id, v_invoice_salesman_id
      FROM public.invoices i WHERE i.id = v_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customers c
                    WHERE c.id = v_invoice_customer_id AND c.assigned_sales_rep = v_actor) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF v_invoice_salesman_id IS NOT NULL AND v_invoice_salesman_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;
  RETURN v_invoice_id;
END;
$function$;

-- No GRANT/REVOKE on purpose: CREATE OR REPLACE keeps this OID's owner and ACL; the postflight
-- asserts EXECUTE is exactly {authenticated, postgres, service_role} and anon cannot execute.
CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL::uuid,
  p_invoice_type text DEFAULT 'chemical_sale'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'create_split_invoices_from_order_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
  v_claim_nonce uuid := gen_random_uuid();
  v_has_split_evidence boolean := false;
  v_scope_rep boolean := false;
  v_order_customer_id uuid;
  v_order_salesman_id uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- CRX-LIFE-001 type allow-list, before any claim, lock or insert: a refused split must not
  -- draw an invoice number (nextval in the invoice_number default is not rolled back).
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rep scope (Mason 2026-10-06): a sales rep must be the assigned rep of the order's customer
  -- AND of every field owner this split could bill (mirrors the provenance impl's owner rule:
  -- field_billing_defaults when present, else fields.customer_id), and may record only
  -- themselves (or no one) as salesman. Admins unrestricted. Before any claim, lock or number.
  v_scope_rep := public.is_sales_rep();
  IF v_scope_rep THEN
    SELECT o.customer_id, o.salesman_id
      INTO v_order_customer_id, v_order_salesman_id
      FROM public.orders o
     WHERE o.id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order not found: %', p_order_id;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM (
          SELECT v_order_customer_id AS customer_id
          UNION
          SELECT fbd.customer_id
            FROM public.order_item_field_allocations oifa
            JOIN public.order_items oi ON oi.id = oifa.order_item_id
            JOIN public.field_billing_defaults fbd ON fbd.field_id = oifa.field_id
           WHERE oi.order_id = p_order_id
          UNION
          SELECT f.customer_id
            FROM public.order_item_field_allocations oifa
            JOIN public.order_items oi ON oi.id = oifa.order_item_id
            JOIN public.fields f ON f.id = oifa.field_id
           WHERE oi.order_id = p_order_id
             AND NOT EXISTS (SELECT 1 FROM public.field_billing_defaults d WHERE d.field_id = oifa.field_id)
        ) owners
       WHERE NOT EXISTS (SELECT 1 FROM public.customers c
                          WHERE c.id = owners.customer_id AND c.assigned_sales_rep = v_actor)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF COALESCE(p_salesman_id, v_order_salesman_id) IS NOT NULL
       AND COALESCE(p_salesman_id, v_order_salesman_id) IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request
    );
  END IF;

  PERFORM 1
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = p_order_id
  ) INTO v_has_split_evidence;

  IF v_replay IS NOT NULL THEN
    SELECT COALESCE(
             array_agg(replayed.invoice_id ORDER BY replayed.ordinality),
             '{}'::uuid[]
           )
      INTO v_invoice_ids
      FROM (
        SELECT value::uuid AS invoice_id, ordinality
          FROM jsonb_array_elements_text(v_replay) WITH ORDINALITY
      ) replayed;
  ELSE
    INSERT INTO public.split_invoice_creation_claims (
      transaction_id,
      order_id,
      claim_nonce
    ) VALUES (
      pg_current_xact_id(),
      p_order_id,
      v_claim_nonce
    );

    v_invoice_ids := public._create_split_invoices_from_order_provenance_impl_20260719(
      p_order_id,
      p_salesman_id,
      p_invoice_type,
      NULL::text
    );

    INSERT INTO public.split_invoice_provenance (
      invoice_id,
      order_id,
      invoice_group_id,
      customer_id,
      invoice_type,
      season,
      total_amount_cents,
      content_claim,
      provenance_nonce,
      created_by
    )
    SELECT
      i.id,
      i.order_id,
      i.invoice_group_id,
      i.customer_id,
      i.invoice_type,
      i.season,
      i.total_amount_cents,
      public._split_invoice_content_claim(i.id),
      gen_random_uuid(),
      v_actor
    FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
    JOIN public.invoices i ON i.id = returned.invoice_id
    WHERE i.order_id = p_order_id
      AND i.invoice_group_id IS NOT NULL
      AND v_has_split_evidence
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  -- Authoritative re-check of every invoice actually created or replayed (race + replay).
  IF v_scope_rep THEN
    IF EXISTS (SELECT 1
                 FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
                 JOIN public.invoices i ON i.id = returned.invoice_id
                WHERE NOT EXISTS (SELECT 1 FROM public.customers c
                                   WHERE c.id = i.customer_id AND c.assigned_sales_rep = v_actor)) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF EXISTS (SELECT 1
                 FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
                 JOIN public.invoices i ON i.id = returned.invoice_id
                WHERE i.salesman_id IS NOT NULL AND i.salesman_id IS DISTINCT FROM v_actor) THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
        WHERE returned.invoice_id IS NULL
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(DISTINCT returned.invoice_id)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
        WHERE i.order_id = p_order_id
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH: every returned invoice must belong exactly to the requested order';
  END IF;

  IF v_has_split_evidence
     AND cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
         JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
        WHERE i.order_id = p_order_id
          AND i.invoice_group_id IS NOT NULL
          AND p.order_id = i.order_id
          AND p.invoice_group_id = i.invoice_group_id
          AND p.customer_id = i.customer_id
          AND p.invoice_type = i.invoice_type
          AND p.season = i.season
          AND p.total_amount_cents = i.total_amount_cents
          AND p.content_claim = public._split_invoice_content_claim(i.id)
          AND p.contract_version = 'split_invoice_provenance_v1'
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_REPLAY_MISMATCH: returned split invoice content does not match its exact private claim';
  END IF;

  IF v_replay IS NULL THEN
    DELETE FROM public.split_invoice_creation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND order_id = p_order_id
       AND claim_nonce = v_claim_nonce;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_CREATION_CLAIM_LOST';
    END IF;

    PERFORM public._bind_completed_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request,
      to_jsonb(v_invoice_ids)
    );
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

DO $postflight$
DECLARE
  v_cifo oid := to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)');
  v_split oid := to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)');
  v_split_src text;
BEGIN
  IF to_regclass('pg_temp.crx_rep_scope_order_invoice_tx') IS NULL THEN
    RAISE EXCEPTION 'CRX_REP_SCOPE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.crx_rep_scope_order_invoice_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CRX_REP_SCOPE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF v_cifo IS DISTINCT FROM (SELECT cifo_oid FROM pg_temp.crx_rep_scope_order_invoice_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_IDENTITY: the replace must preserve the create_invoice_from_order OID';
  END IF;
  IF v_split IS DISTINCT FROM (SELECT split_oid FROM pg_temp.crx_rep_scope_order_invoice_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_IDENTITY: the replace must preserve the create_split_invoices_from_order OID';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '78c3444e301aec889d39dac8dceeb11c'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_cifo) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_CONTRACT: public create_invoice_from_order body, signature or access drifted';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '0ff1b8aee5be9d885b5d4c55253b03e9'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = v_split) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: public create_split_invoices_from_order body, signature or access drifted';
  END IF;

  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = '3d393fb8639dbcb2aa38574ca9679eee'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = '454e04c4e199549a4f5be9975e397e17'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'f671f1a3f5406cff52aedd8a5fb40b31'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'fcb3133010fe3f4f56e3be31f709d102' AND p.prosecdef
        AND p.provolatile = 's' AND p.proowner = 'postgres'::regrole
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.is_sales_rep()'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'f8de9f000e40f7bfd8f792012f04fee0'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'a1e9a043f27d3566f8ecf6d5e3a809ab'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELEGATE_CHANGED: an implementation, the role helper or complete_delivery changed during the apply';
  END IF;

  SELECT p.prosrc INTO v_split_src FROM pg_proc p WHERE p.oid = v_split;
  IF position('CUSTOMER_SCOPE_DENIED' IN v_split_src) = 0
     OR position('ORDER_INVOICE_TYPE_NOT_ALLOWED' IN v_split_src) = 0
     OR position('ORDER_INVOICE_TYPE_NOT_ALLOWED' IN v_split_src)
          > position('_claim_bound_lifecycle_idempotency' IN v_split_src) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: the split wrapper must refuse a disallowed type before its idempotency claim';
  END IF;
  -- Codex P1 on PR #891: the key is required, and checked before anything else.
  IF position('IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order' IN v_split_src) = 0
     OR position('IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order' IN v_split_src)
          > position('Not authenticated' IN v_split_src) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: the split wrapper must require its idempotency key before anything else';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: order invoices are scoped to the calling rep (customer + salesman); split invoices require a key and refuse non-order types before any number is drawn';
END
$postflight$;
