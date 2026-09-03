-- Fix PR-comment audit finding #198: a system-generated invoice due date must
-- age from the date it is posted, not from its editable accounting invoice_date.
-- The approved 2026-07-16 contract defines posting date in America/Chicago.
--
-- due_date alone cannot distinguish an operator override from the legacy
-- CURRENT_DATE + 30 value created by transfer_job_to_invoice. Add explicit
-- provenance and preserve every pre-provenance non-null value as `legacy`.
-- Historical transfer logs prove creation but do not prove that an operator did
-- not later select the same date, so date equality is never used as provenance.
-- New system values are recalculated on every post/repost; explicit and legacy
-- values remain unchanged.
--
-- The migration re-emits five exact live bodies:
--   * _save_invoice_scoped_impl records explicit/null intent from save_invoice.
--   * update_field_app_invoice_billing records field-app billing-editor intent.
--   * unpost_invoice clears only a system-generated date before a later repost.
--   * _post_invoice_impl_20260714 serves normal single, group, and batch posts.
--   * _post_deleted_delivery_recovery_invoice_20260719 serves recovery posting.
--
-- Accounting-period checks continue to use invoice_date. Public wrappers,
-- idempotency contracts, money math, customer scope, and audit effects remain
-- unchanged. No money amount or posted invoice date is backfilled.

DO $preflight$
DECLARE
  v_normal regprocedure := to_regprocedure(
    'public._post_invoice_impl_20260714(uuid,text)'
  );
  v_recovery regprocedure := to_regprocedure(
    'public._post_deleted_delivery_recovery_invoice_20260719(uuid)'
  );
  v_terms regprocedure := to_regprocedure(
    'public.parse_payment_terms_days(text)'
  );
  v_save regprocedure := to_regprocedure(
    'public._save_invoice_scoped_impl(jsonb,jsonb,text)'
  );
  v_save_public regprocedure := to_regprocedure(
    'public.save_invoice(jsonb,jsonb,text)'
  );
  v_save_below_cost regprocedure := to_regprocedure(
    'public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)'
  );
  v_save_intent regprocedure := to_regprocedure(
    'public._save_invoice_intent_impl_20260802(jsonb,jsonb,text)'
  );
  v_save_governed_split regprocedure := to_regprocedure(
    'public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'
  );
  v_save_split_provenance regprocedure := to_regprocedure(
    'public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)'
  );
  v_field_billing regprocedure := to_regprocedure(
    'public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text)'
  );
  v_unpost regprocedure := to_regprocedure(
    'public.unpost_invoice(uuid,uuid,text)'
  );
  v_updated_at_trigger_function regprocedure := to_regprocedure(
    'public.update_updated_at()'
  );
  v_terminal_order_trigger_function regprocedure := to_regprocedure(
    'public.guard_invoice_terminal_order()'
  );
BEGIN
  IF v_normal IS NULL
     OR v_recovery IS NULL
     OR v_terms IS NULL
     OR v_save IS NULL
     OR v_save_public IS NULL
     OR v_save_below_cost IS NULL
     OR v_save_intent IS NULL
     OR v_save_governed_split IS NULL
     OR v_save_split_provenance IS NULL
     OR v_field_billing IS NULL
     OR v_unpost IS NULL
     OR v_updated_at_trigger_function IS NULL
     OR v_terminal_order_trigger_function IS NULL
     OR EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'invoices'
         AND column_name = 'due_date_source'
     )
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_invoice_impl_20260714'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_deleted_delivery_recovery_invoice_20260719'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'parse_payment_terms_days'
     ) <> 1 THEN
    RAISE EXCEPTION 'INVOICE_DUE_DATE_POSTING_PREFLIGHT_SIGNATURE_DRIFT';
  END IF;

  -- The provenance backfill must not make every historical invoice look newly
  -- edited. It also has to pass legitimate draft recovery invoices whose source
  -- order was soft-deleted: the terminal-order trigger intentionally rejects any
  -- later ordinary UPDATE once the recovery writer's transaction-local capability
  -- is gone. Pin both exact triggers, both functions, and table ownership before
  -- suspending only those triggers for the due_date_source-only backfill.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.invoices'::regclass
         AND t.tgname = 'set_invoices_updated_at'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 19
         AND t.tgfoid = v_updated_at_trigger_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_updated_at_trigger_function
         AND p.prorettype = 'trigger'::regtype
         AND NOT p.prosecdef
         AND p.provolatile = 'v'
         AND position('NEW.updated_at = now();' IN p.prosrc) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.invoices'::regclass
         AND t.tgname = 'trg_guard_invoice_terminal_order'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 23
         AND t.tgnargs = 0
         AND t.tgfoid = v_terminal_order_trigger_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_terminal_order_trigger_function
         AND p.prorettype = 'trigger'::regtype
         AND p.pronargs = 0
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = '12e1161cc8ceb4eef7105b1bdd8b1b0d25f76b29dfacf385c6701016f65d14fb'
         AND position('invoice_delivery_recovery_capabilities' IN p.prosrc) > 0
         AND position('ORDER_INVOICE_TERMINAL' IN p.prosrc) > 0
     )
     OR current_user <> (
       SELECT pg_get_userbyid(c.relowner)
       FROM pg_class c
       WHERE c.oid = 'public.invoices'::regclass
     ) THEN
    RAISE EXCEPTION 'INVOICE_DUE_DATE_POSTING_PREFLIGHT_BACKFILL_TRIGGER_DRIFT';
  END IF;

  IF (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'save_invoice',
           '_save_invoice_below_cost_impl_20260810',
           '_save_invoice_intent_impl_20260802',
           '_save_invoice_governed_split_guard_impl_20260720',
           '_save_invoice_split_provenance_impl_20260719',
           '_save_invoice_scoped_impl'
         )
     ) <> 6
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'update_field_app_invoice_billing'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'unpost_invoice'
     ) <> 1 THEN
    RAISE EXCEPTION 'INVOICE_DUE_DATE_POSTING_PREFLIGHT_SIGNATURE_DRIFT';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_normal
         AND p.proargtypes = '2950 25'::oidvector
         AND p.proargnames = ARRAY['p_invoice_id', 'p_idempotency_key']::text[]
         AND p.pronargdefaults = 1
         AND p.prorettype = 'void'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = 'f3e0dc65b1e565257a0342199f45e467c5db3a5ff81251db43141f13e95747c3'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_recovery
         AND p.proargtypes = '2950'::oidvector
         AND p.proargnames = ARRAY['p_invoice_id']::text[]
         AND p.pronargdefaults = 0
         AND p.prorettype = 'void'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = 'f581dfe487296a5b48e600988a6903b947b44140e3c4a3d4e9b5ee8e933c8c99'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_terms
         AND p.proargtypes = '25'::oidvector
         AND p.prorettype = 'integer'::regtype
         AND NOT p.prosecdef
         AND p.provolatile = 'i'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save
         AND p.proargtypes = '3802 3802 25'::oidvector
         AND p.proargnames = ARRAY['p_invoice', 'p_items', 'p_idempotency_key']::text[]
         AND p.pronargdefaults = 2
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = 'cab2bde1aa6bf26d918639cfb8d328ac579d0b7f5429123aa24710a1a835866e'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_field_billing
         AND p.proargtypes = '2951 25 25 25 1082 25 25 3802 2950 25'::oidvector
         AND p.proargnames = ARRAY[
           'p_invoice_ids', 'p_purchase_order_ref', 'p_payment_terms',
           'p_header_notes', 'p_due_date', 'p_footer_notes',
           'p_internal_notes', 'p_discounts', 'p_performed_by',
           'p_idempotency_key'
         ]::text[]
         AND p.pronargdefaults = 9
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = '57dbda49bc4f96a9afcfed6e22cd83ae74d4d8ade171ff87c2b5d595a261c700'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_unpost
         AND p.proargtypes = '2950 2950 25'::oidvector
         AND p.proargnames = ARRAY[
           'p_invoice_id', 'p_performed_by', 'p_idempotency_key'
         ]::text[]
         AND p.pronargdefaults = 1
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = 'e10a91958b0c482d90601a7d4ee9bce39b7fc123a20c8f66e4b73ee9cf53e041'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_normal, v_recovery, v_save)
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee <> p.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_field_billing, v_unpost)
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee NOT IN (
           p.proowner,
           'authenticated'::regrole,
           'service_role'::regrole
         )
     )
     OR NOT has_function_privilege(
       'authenticated', v_field_billing, 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', v_field_billing, 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', v_unpost, 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', v_unpost, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'INVOICE_DUE_DATE_POSTING_PREFLIGHT_CONTRACT_DRIFT';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_invoice_customer_scope_impl'
         AND position(
               'public._post_invoice_impl_20260714' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_invoice_group_customer_scope_impl'
         AND position(
               'public._post_invoice_impl_20260714' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_invoice_idem_impl_20260721'
         AND position(
               'public._post_deleted_delivery_recovery_invoice_20260719' IN p.prosrc
             ) > 0
         AND position(
               'public._post_invoice_public_impl_20260718' IN p.prosrc
             ) > 0
     )
     -- save_invoice has accumulated deliberate security and governance wrappers.
     -- Pin every adjacent edge instead of assuming a direct public-to-scoped call.
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_public
         AND position(
               'RETURN public._save_invoice_below_cost_impl_20260810(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_below_cost
         AND position(
               'RETURN public._save_invoice_intent_impl_20260802(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_intent
         AND position(
               'RETURN public._save_invoice_governed_split_guard_impl_20260720(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_governed_split
         AND position(
               'v_saved_id := public._save_invoice_split_provenance_impl_20260719(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_split_provenance
         AND position(
               'RETURN public._save_invoice_scoped_impl(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'batch_post_invoices'
         AND position('public.post_invoice' IN p.prosrc) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'unpost_invoice_group'
         AND position('unpost_invoice(' IN p.prosrc) > 0
     ) THEN
    RAISE EXCEPTION 'INVOICE_DUE_DATE_POSTING_PREFLIGHT_ROUTING_DRIFT';
  END IF;
END;
$preflight$;

ALTER TABLE public.invoices
  ADD COLUMN due_date_source text;

COMMENT ON COLUMN public.invoices.due_date_source IS
  'Due-date provenance: system is recomputed from the Chicago posting date on each post; explicit is an operator override; legacy preserves a non-null value that predates provenance.';

-- NULL dates are unambiguously system defaults. Preserve every historical
-- non-null date as legacy: even the exact transfer_job_to_invoice +30 shape may
-- have been selected later by an operator, and no audit row records that intent.
-- Suspend only the two pinned triggers that would otherwise mutate updated_at
-- or reject a valid recovery draft. ALTER TABLE holds an ACCESS EXCLUSIVE lock,
-- so no concurrent writer can pass through while they are disabled. Every other
-- invoice guard remains active, and both triggers are restored on either path.
DO $backfill$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.invoices DISABLE TRIGGER set_invoices_updated_at';
    EXECUTE 'ALTER TABLE public.invoices DISABLE TRIGGER trg_guard_invoice_terminal_order';
    UPDATE public.invoices
       SET due_date_source = CASE
         WHEN due_date IS NULL THEN 'system'
         ELSE 'legacy'
       END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order';
    EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER set_invoices_updated_at';
    RAISE;
  END;
  EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order';
  EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER set_invoices_updated_at';
END;
$backfill$;

ALTER TABLE public.invoices
  ALTER COLUMN due_date_source SET DEFAULT 'system',
  ALTER COLUMN due_date_source SET NOT NULL;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_due_date_source_chk
  CHECK (
    due_date_source IN ('system', 'explicit', 'legacy')
    AND (due_date_source = 'system' OR due_date IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public._save_invoice_scoped_impl(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_invoice_status text;
  v_cached jsonb;
  v_forward_items jsonb := '[]'::jsonb;
  v_lineage jsonb := '[]'::jsonb;
  v_result uuid;
  v_restored integer := 0;
  v_due_date_source text := NULLIF(p_invoice->>'due_date_source', '');
  v_switch_to_system boolean :=
    (
      p_invoice ? 'due_date_source'
      AND NULLIF(p_invoice->>'due_date_source', '') = 'system'
    )
    OR (
      NOT (p_invoice ? 'due_date_source')
      AND p_invoice ? 'due_date'
      AND NULLIF(p_invoice->>'due_date', '') IS NULL
    );
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_cached IS NOT NULL THEN
      RETURN (v_cached->>'invoice_id')::uuid;
    END IF;
  END IF;

  IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'INVOICE_ITEMS_MUST_BE_ARRAY';
  END IF;

  IF p_invoice ? 'due_date_source' THEN
    IF v_due_date_source IS NULL
       OR v_due_date_source NOT IN ('system', 'explicit', 'legacy') THEN
      RAISE EXCEPTION 'INVOICE_DUE_DATE_SOURCE_INVALID';
    END IF;
    IF (v_due_date_source = 'system' AND NULLIF(p_invoice->>'due_date', '') IS NOT NULL)
       OR (v_due_date_source <> 'system' AND NULLIF(p_invoice->>'due_date', '') IS NULL) THEN
      RAISE EXCEPTION 'INVOICE_DUE_DATE_SOURCE_MISMATCH';
    END IF;
  END IF;

  SELECT COALESCE(
           jsonb_agg(incoming.item || jsonb_build_object('sort_order', incoming.ordinality - 1)
                     ORDER BY incoming.ordinality),
           '[]'::jsonb
         )
    INTO v_forward_items
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS incoming(item, ordinality);

  IF v_invoice_id IS NOT NULL THEN
    SELECT i.status
      INTO v_invoice_status
    FROM public.invoices i
    WHERE i.id = v_invoice_id
    FOR UPDATE;
  END IF;

  IF v_invoice_status IN ('draft', 'unposted') THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
      GROUP BY incoming.item->>'id'
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_DUPLICATE';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.invoice_items ii
          WHERE ii.id = (incoming.item->>'id')::uuid
            AND ii.invoice_id = v_invoice_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_forward_items) AS incoming(item)
          WHERE incoming.item->>'id' = ii.id::text
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_LINE_REQUIRED: void and reissue instead of deleting an order-linked line';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      JOIN jsonb_array_elements(v_forward_items) AS incoming(item)
        ON incoming.item->>'id' = ii.id::text
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND (
          (incoming.item->>'product_id')::uuid IS DISTINCT FROM ii.product_id
          OR incoming.item->>'unit_size' IS DISTINCT FROM ii.unit_size
          OR (incoming.item->>'order_item_id')::uuid IS DISTINCT FROM ii.order_item_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_IDENTITY_IMMUTABLE: void and reissue to change product, unit, or order line';
    END IF;

    SELECT COALESCE(
             jsonb_agg(jsonb_build_object(
               'sort_order', incoming.ordinality - 1,
               'source_item_id', ii.id,
               'order_item_id', ii.order_item_id,
               'product_id', ii.product_id,
               'unit_size', ii.unit_size,
               'cost_cents', ii.cost_cents,
               'created_at', ii.created_at,
               'tote_number', ii.tote_number,
               'vendor', ii.vendor,
               'warehouse', ii.warehouse
             ) ORDER BY incoming.ordinality),
             '[]'::jsonb
           )
      INTO v_lineage
    FROM jsonb_array_elements(v_forward_items) WITH ORDINALITY AS incoming(item, ordinality)
    JOIN public.invoice_items ii
      ON ii.id = NULLIF(incoming.item->>'id', '')::uuid
     AND ii.invoice_id = v_invoice_id
     AND ii.order_item_id IS NOT NULL
     AND ii.quantity > 0;
  END IF;

  -- The historical delegate writes due_date before this wrapper records its
  -- provenance. Stage an existing explicit/legacy -> system transition in one
  -- constraint-safe statement so the delegate cannot create an intermediate
  -- non-system + NULL row. Any later error rolls this statement back with the
  -- surrounding save transaction; old callers that send only due_date=NULL
  -- retain their established system-default meaning.
  IF v_invoice_status IN ('draft', 'unposted') AND v_switch_to_system THEN
    UPDATE public.invoices i
       SET due_date = NULL,
           due_date_source = 'system',
           updated_at = now()
     WHERE i.id = v_invoice_id
       AND i.status IN ('draft', 'unposted')
       AND i.due_date_source IS DISTINCT FROM 'system';
  END IF;

  v_result := public._save_invoice_lineage_unaware_impl_20260827(
    p_invoice,
    v_forward_items,
    p_idempotency_key
  );

  IF jsonb_array_length(v_lineage) > 0 THEN
    WITH preserved AS (
      SELECT
        (entry->>'sort_order')::integer AS sort_order,
        (entry->>'source_item_id')::uuid AS source_item_id,
        (entry->>'order_item_id')::uuid AS order_item_id,
        (entry->>'product_id')::uuid AS product_id,
        entry->>'unit_size' AS unit_size,
        (entry->>'cost_cents')::bigint AS cost_cents,
        (entry->>'created_at')::timestamptz AS created_at,
        entry->>'tote_number' AS tote_number,
        entry->>'vendor' AS vendor,
        entry->>'warehouse' AS warehouse
      FROM jsonb_array_elements(v_lineage) AS saved(entry)
    )
    UPDATE public.invoice_items ii
       SET id = preserved.source_item_id,
           order_item_id = preserved.order_item_id,
           cost_cents = preserved.cost_cents,
           created_at = preserved.created_at,
           tote_number = preserved.tote_number,
           vendor = preserved.vendor,
           warehouse = preserved.warehouse
      FROM preserved
     WHERE ii.invoice_id = v_result
       AND ii.sort_order = preserved.sort_order
       AND ii.product_id IS NOT DISTINCT FROM preserved.product_id
       AND ii.unit_size IS NOT DISTINCT FROM preserved.unit_size;
    GET DIAGNOSTICS v_restored = ROW_COUNT;

    IF v_restored <> jsonb_array_length(v_lineage) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_RESTORE_FAILED';
    END IF;
  END IF;

  UPDATE public.invoices i
     SET total_cost_cents = COALESCE((
           SELECT SUM(
             CASE WHEN ii.is_application_fee
               THEN ii.cost_cents
               ELSE ROUND(ii.cost_cents * ii.quantity)::bigint
             END
           )::bigint
           FROM public.invoice_items ii
           WHERE ii.invoice_id = v_result
         ), 0),
         due_date_source = CASE
           WHEN p_invoice ? 'due_date_source' THEN v_due_date_source
           WHEN p_invoice ? 'due_date' THEN
             CASE WHEN NULLIF(p_invoice->>'due_date', '') IS NULL
               THEN 'system'
               ELSE 'explicit'
             END
           ELSE i.due_date_source
         END,
         updated_at = now()
   WHERE i.id = v_result
     AND i.status IN ('draft', 'unposted');

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text) IS
  'Internal invoice writer. Preserves generated-line identity and records explicit versus system due-date intent; use public.save_invoice.';

CREATE OR REPLACE FUNCTION public.update_field_app_invoice_billing(
  p_invoice_ids        uuid[],
  p_purchase_order_ref text DEFAULT NULL,
  p_payment_terms      text DEFAULT NULL,
  p_header_notes       text DEFAULT NULL,
  p_due_date           date DEFAULT NULL,
  p_footer_notes       text DEFAULT NULL,
  p_internal_notes     text DEFAULT NULL,
  p_discounts          jsonb DEFAULT '{}'::jsonb,
  p_performed_by       uuid DEFAULT NULL,
  p_idempotency_key    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_expected int;
  v_updated  int;
  v_existing jsonb;
  v_result   jsonb;
  v_disc     jsonb := COALESCE(p_discounts, '{}'::jsonb);
  v_id       uuid;
  v_amount   bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoice billing details';
  END IF;

  v_expected := COALESCE(array_length(p_invoice_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'At least one invoice id is required';
  END IF;

  FOR v_id, v_amount IN
    SELECT key::uuid, COALESCE((value->>'amount_cents')::bigint, 0)
      FROM jsonb_each(v_disc)
  LOOP
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'Discount Earned cannot be negative for invoice %', v_id;
    END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'update_field_app_invoice_billing';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- The field-app editor sends a date only for Custom mode. NULL means the
  -- normal terms-based system date and must be recalculated when posted.
  UPDATE invoices i SET
    purchase_order_ref    = p_purchase_order_ref,
    payment_terms         = p_payment_terms,
    header_notes          = p_header_notes,
    due_date              = p_due_date,
    due_date_source       = CASE
      WHEN p_due_date IS NULL THEN 'system'
      WHEN i.due_date_source = 'legacy'
        AND p_due_date IS NOT DISTINCT FROM i.due_date THEN 'legacy'
      ELSE 'explicit'
    END,
    footer_notes          = p_footer_notes,
    internal_notes        = p_internal_notes,
    discount_earned_cents = COALESCE((v_disc -> i.id::text ->> 'amount_cents')::bigint, 0),
    discount_date         = (v_disc -> i.id::text ->> 'date')::date,
    updated_at            = now()
  WHERE i.id = ANY(p_invoice_ids)
    AND i.invoice_type = 'field_application'
    AND i.status IN ('draft', 'unposted');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'Invoice billing update affected % of % invoice(s) — some are not editable field-application invoices', v_updated, v_expected;
  END IF;

  v_result := jsonb_build_object('updated', v_updated);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'update_field_app_invoice_billing', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unpost_invoice(
  p_invoice_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_actor_role text;
  v_existing jsonb;
  v_result jsonb;
  v_alloc_count int := 0;
  v_prepay_count int := 0;
  v_rup_voided int := 0;
  v_credit_app_count int := 0;
BEGIN
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unpost_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    IF v_inv.status IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Invoice % is not posted (status: %); there is nothing to unpost', v_inv.invoice_number, v_inv.status;
    ELSE
      RAISE EXCEPTION 'Cannot unpost a % invoice (%). Only a posted, unpaid invoice can be returned to the Unposted list.', v_inv.status, v_inv.invoice_number;
    END IF;
  END IF;

  SELECT count(*) INTO v_alloc_count FROM invoice_line_allocations WHERE invoice_id = p_invoice_id;
  SELECT count(*) INTO v_prepay_count FROM prepay_applications WHERE invoice_id = p_invoice_id;
  SELECT count(*) INTO v_credit_app_count FROM credit_memo_applications
   WHERE reversed_at IS NULL AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id);
  IF v_alloc_count > 0
     OR v_prepay_count > 0
     OR v_credit_app_count > 0
     OR COALESCE(v_inv.paid_amount_cents, 0) <> 0
     OR COALESCE(v_inv.prepay_applied_cents, 0) <> 0
     OR COALESCE(v_inv.write_off_cents, 0) <> 0
     OR COALESCE(v_inv.credit_applied_cents, 0) <> 0
  THEN
    RAISE EXCEPTION 'Cannot unpost invoice % — it has payments, prepay, write-offs, or applied credit. Reverse those first (or void the invoice instead).', v_inv.invoice_number;
  END IF;

  PERFORM check_period_open(v_inv.invoice_date);

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE invoices SET
    status      = 'unposted',
    posted_by   = NULL,
    posted_at   = NULL,
    due_date    = CASE WHEN v_inv.due_date_source = 'system' THEN NULL ELSE due_date END,
    updated_at  = now()
  WHERE id = p_invoice_id;
  PERFORM set_config('app.admin_override', 'false', true);

  UPDATE rup_sales_records SET
    voided_at = now(),
    voided_by = auth.uid(),
    void_reason = 'Invoice ' || v_inv.invoice_number || ' unposted'
  WHERE invoice_id = p_invoice_id
    AND voided_at IS NULL;
  GET DIAGNOSTICS v_rup_voided = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_unposted', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'posted_at', v_inv.posted_at),
    jsonb_build_object('status', 'unposted', 'unposted_at', now()::text, 'rup_rows_voided', v_rup_voided),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Unposted ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — $' || (COALESCE(v_inv.total_amount_cents,0) / 100.0)::numeric(12,2)
      || CASE WHEN v_rup_voided > 0 THEN '; ' || v_rup_voided || ' RUP sale row(s) voided' ELSE '' END
  );

  IF v_rup_voided > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_user_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'rup_sales_voided', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
      jsonb_build_object('rows_voided', v_rup_voided, 'reason', 'invoice_unposted'),
      0,
      v_rup_voided || ' RUP sale row(s) voided for invoice ' || v_inv.invoice_number || ' on unpost'
    );
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_unposted',
    'Unposted invoice ' || v_inv.invoice_number || ' — returned to the Unposted list',
    COALESCE(p_performed_by, auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_inv.invoice_number,
    'previous_status', v_inv.status,
    'status', 'unposted',
    'rup_rows_voided', v_rup_voided
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unpost_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.unpost_invoice(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid, uuid, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._post_invoice_impl_20260714(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb; v_terms_days integer; v_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  -- PRICING_INCOMPLETE gate (sell-side #2): never post an invoice for a still-
  -- unpriced rush order. Cleared by price_order (v2). Dormant until v1b.
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;

  -- A8: derive due_date from the payment terms; default Net 30 when blank/unparseable.
  -- The invoice-level override (invoices.payment_terms — the documented per-invoice terms that
  -- the PDF prints) WINS over the customer default; fall back to customers.payment_terms when
  -- the invoice override is blank. Provenance, rather than nullability, distinguishes a
  -- system default from an explicit/legacy date that must remain unchanged.
  SELECT parse_payment_terms_days(COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms))
    INTO v_terms_days
  FROM customers c WHERE c.id = v_inv.customer_id;

  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now(),
    due_date = CASE WHEN v_inv.due_date_source = 'system'
      THEN (v_posting_date + (v_terms_days || ' days')::interval)::date
      ELSE due_date
    END
    WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._post_deleted_delivery_recovery_invoice_20260719(
  p_invoice_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record;
  v_order_status text;
  v_order_pricing text;
  v_order_deleted_at timestamptz;
  v_order_id uuid;
  v_order_customer_id uuid;
  v_terms_days integer;
  v_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED_FOR_DELETED_DELIVERY_RECOVERY';
  END IF;

  SELECT order_id INTO v_order_id
    FROM public.invoices
   WHERE id = p_invoice_id AND deleted_at IS NULL;
  IF NOT FOUND OR v_order_id IS NULL THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_SOURCE_REQUIRED';
  END IF;

  -- Preserve the repository's order -> invoice lock hierarchy. Holding the
  -- order through posting also prevents a customer-lineage change between
  -- validation and RUP/audit generation.
  SELECT status, pricing_status, deleted_at, customer_id
    INTO v_order_status, v_order_pricing, v_order_deleted_at, v_order_customer_id
    FROM public.orders
   WHERE id = v_order_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_order_deleted_at IS NULL
     OR v_order_status NOT IN ('fulfilled', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ORDER_INVALID';
  END IF;

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.order_id IS DISTINCT FROM v_order_id
     OR v_inv.customer_id IS DISTINCT FROM v_order_customer_id THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_CUSTOMER_LINEAGE_INVALID';
  END IF;
  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status;
  END IF;
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.delivery_id IS NULL THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_SOURCE_REQUIRED';
  END IF;
  IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.deliveries d
     WHERE d.id = v_inv.delivery_id
       AND d.order_id = v_inv.order_id
       AND d.customer_id = v_inv.customer_id
       AND d.status = 'completed'
       AND d.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_LINEAGE_INVALID';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_inv.delivery_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.delivery_items di
         LEFT JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND (
            oi.id IS NULL
            OR oi.order_id IS DISTINCT FROM v_inv.order_id
            OR oi.product_id IS DISTINCT FROM di.product_id
            OR COALESCE(di.quantity_delivered, 0) <= 0
            OR di.quantity_delivered > COALESCE(di.quantity, 0)
          )
     ) THEN
    RAISE EXCEPTION 'DELETED_DELIVERY_RECOVERY_ITEMS_INVALID: historical recovery lines failed order/product/quantity validation';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.delivery_items di
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR v_inv.total_amount_cents IS DISTINCT FROM (
       SELECT COALESCE(SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint), 0)
         FROM public.delivery_items di
         JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR v_inv.total_cost_cents IS DISTINCT FROM (
       SELECT COALESCE(SUM(ROUND(di.quantity_delivered * COALESCE(oi.cost_per_unit, 0) * 100)::bigint), 0)
         FROM public.delivery_items di
         JOIN public.order_items oi ON oi.id = di.order_item_id
        WHERE di.delivery_id = v_inv.delivery_id
          AND COALESCE(di.quantity_delivered, 0) > 0
     )
     OR EXISTS (
       WITH delivered AS (
         SELECT di.order_item_id, di.product_id,
                SUM(di.quantity_delivered) AS quantity,
                SUM(ROUND(di.quantity_delivered * oi.price_per_unit * 100)::bigint) AS extended_cents,
                ROUND(MAX(oi.price_per_unit) * 100)::bigint AS unit_price_cents,
                ROUND(MAX(COALESCE(oi.cost_per_unit, 0)) * 100)::bigint AS cost_cents
           FROM public.delivery_items di
           JOIN public.order_items oi ON oi.id = di.order_item_id
          WHERE di.delivery_id = v_inv.delivery_id
            AND COALESCE(di.quantity_delivered, 0) > 0
          GROUP BY di.order_item_id, di.product_id
       ), billed AS (
         SELECT ii.order_item_id, ii.product_id,
                SUM(ii.quantity) AS quantity,
                SUM(ii.extended_cents) AS extended_cents,
                MIN(ii.unit_price_cents) AS min_unit_price_cents,
                MAX(ii.unit_price_cents) AS max_unit_price_cents,
                MIN(ii.cost_cents) AS min_cost_cents,
                MAX(ii.cost_cents) AS max_cost_cents
           FROM public.invoice_items ii
          WHERE ii.invoice_id = p_invoice_id
          GROUP BY ii.order_item_id, ii.product_id
       )
       SELECT 1
         FROM delivered d
         FULL JOIN billed b
           ON b.order_item_id = d.order_item_id
          AND b.product_id = d.product_id
        WHERE d.order_item_id IS NULL
           OR b.order_item_id IS NULL
           OR d.quantity IS DISTINCT FROM b.quantity
           OR d.extended_cents IS DISTINCT FROM b.extended_cents
           OR d.unit_price_cents IS DISTINCT FROM b.min_unit_price_cents
           OR d.unit_price_cents IS DISTINCT FROM b.max_unit_price_cents
           OR d.cost_cents IS DISTINCT FROM b.min_cost_cents
           OR d.cost_cents IS DISTINCT FROM b.max_cost_cents
     ) THEN
    RAISE EXCEPTION 'DELIVERY_INVOICE_CONTENT_MISMATCH: recovery invoice must exactly match delivered quantities and cents';
  END IF;

  PERFORM public.check_period_open(v_inv.invoice_date);
  SELECT public.parse_payment_terms_days(
           COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms)
         )
    INTO v_terms_days
    FROM public.customers c
   WHERE c.id = v_inv.customer_id;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'poster';
  INSERT INTO public.invoice_delivery_recovery_capabilities (
    transaction_id, purpose, delivery_id, actor_id
  ) VALUES (txid_current(), 'poster', v_inv.delivery_id, auth.uid());

  BEGIN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.invoices
       SET status = 'posted',
           posted_by = auth.uid(),
           posted_at = now(),
           updated_at = now(),
           due_date = CASE WHEN v_inv.due_date_source = 'system'
             THEN (v_posting_date + (v_terms_days || ' days')::interval)::date
             ELSE due_date
           END
     WHERE id = p_invoice_id;
    PERFORM set_config('app.admin_override', 'false', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.admin_override', 'false', true);
    DELETE FROM public.invoice_delivery_recovery_capabilities
     WHERE transaction_id = txid_current() AND purpose = 'poster';
    RAISE;
  END;

  DELETE FROM public.invoice_delivery_recovery_capabilities
   WHERE transaction_id = txid_current() AND purpose = 'poster';

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_id,
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    jsonb_build_object('status', v_inv.status),
    jsonb_build_object('status', 'posted', 'posted_at', now()::text),
    v_inv.total_amount_cents,
    'Posted historical completed-delivery recovery invoice ' || v_inv.invoice_number
  );
  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'invoice_posted',
    'Posted historical completed-delivery recovery invoice ' || v_inv.invoice_number,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );
  PERFORM public.generate_rup_sales_records(p_invoice_id);
END;
$function$;

REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._post_deleted_delivery_recovery_invoice_20260719(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_normal regprocedure := 'public._post_invoice_impl_20260714(uuid,text)'::regprocedure;
  v_recovery regprocedure := 'public._post_deleted_delivery_recovery_invoice_20260719(uuid)'::regprocedure;
  v_save regprocedure := 'public._save_invoice_scoped_impl(jsonb,jsonb,text)'::regprocedure;
  v_save_public regprocedure := 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;
  v_save_below_cost regprocedure := 'public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)'::regprocedure;
  v_save_intent regprocedure := 'public._save_invoice_intent_impl_20260802(jsonb,jsonb,text)'::regprocedure;
  v_save_governed_split regprocedure := 'public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)'::regprocedure;
  v_save_split_provenance regprocedure := 'public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)'::regprocedure;
  v_field_billing regprocedure := 'public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text)'::regprocedure;
  v_unpost regprocedure := 'public.unpost_invoice(uuid,uuid,text)'::regprocedure;
  v_updated_at_trigger_function regprocedure := 'public.update_updated_at()'::regprocedure;
  v_terminal_order_trigger_function regprocedure := 'public.guard_invoice_terminal_order()'::regprocedure;
  v_normal_hash text;
  v_recovery_hash text;
  v_save_hash text;
  v_field_billing_hash text;
  v_unpost_hash text;
BEGIN
  SELECT encode(
           sha256(
             convert_to(
               replace(p.prosrc, chr(13) || chr(10), chr(10)),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_normal_hash
    FROM pg_proc p
   WHERE p.oid = v_normal;

  SELECT encode(
           sha256(
             convert_to(
               replace(p.prosrc, chr(13) || chr(10), chr(10)),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_recovery_hash
   FROM pg_proc p
   WHERE p.oid = v_recovery;

  SELECT encode(
           sha256(
             convert_to(
               replace(p.prosrc, chr(13) || chr(10), chr(10)),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_save_hash
    FROM pg_proc p
   WHERE p.oid = v_save;

  SELECT encode(
           sha256(
             convert_to(
               replace(p.prosrc, chr(13) || chr(10), chr(10)),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_field_billing_hash
    FROM pg_proc p
   WHERE p.oid = v_field_billing;

  SELECT encode(
           sha256(
             convert_to(
               replace(p.prosrc, chr(13) || chr(10), chr(10)),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_unpost_hash
    FROM pg_proc p
   WHERE p.oid = v_unpost;

  IF v_normal_hash IS DISTINCT FROM '973374598bcf255808edb4af5444817bda7206a45a0e092128df6bbc6dc9d9b9'
     OR v_recovery_hash IS DISTINCT FROM '7831288229860f6601499a0b621308d915b4ae8ece123e43fce30dc034b3980b'
     OR v_save_hash IS DISTINCT FROM '0d423e115721d5e10c8c3feb9e1e1f61100ce3e34b5ca3cf60163a6833034ab7'
     OR v_field_billing_hash IS DISTINCT FROM 'c354f16186a59ac07a6dc3c9b54c05a1cdd4552fed7740bd120c7f3eb0f9bde4'
     OR v_unpost_hash IS DISTINCT FROM 'b370e012ffa787efae7762555d42a72c90128271d64e47c182d5d5d24155a1ea'
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'invoices'
         AND c.column_name = 'due_date_source'
         AND c.data_type = 'text'
         AND c.is_nullable = 'NO'
         AND c.column_default = '''system''::text'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint c
       WHERE c.conrelid = 'public.invoices'::regclass
         AND c.conname = 'invoices_due_date_source_chk'
         AND c.contype = 'c'
         AND c.convalidated
         AND position('system' IN pg_get_constraintdef(c.oid)) > 0
         AND position('explicit' IN pg_get_constraintdef(c.oid)) > 0
         AND position('legacy' IN pg_get_constraintdef(c.oid)) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.invoices'::regclass
         AND t.tgname = 'set_invoices_updated_at'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 19
         AND t.tgfoid = v_updated_at_trigger_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.invoices'::regclass
         AND t.tgname = 'trg_guard_invoice_terminal_order'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 23
         AND t.tgnargs = 0
         AND t.tgfoid = v_terminal_order_trigger_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_terminal_order_trigger_function
         AND p.prorettype = 'trigger'::regtype
         AND p.pronargs = 0
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND encode(
               sha256(
                 convert_to(
                   replace(p.prosrc, chr(13) || chr(10), chr(10)),
                   'UTF8'
                 )
               ),
               'hex'
             ) = '12e1161cc8ceb4eef7105b1bdd8b1b0d25f76b29dfacf385c6701016f65d14fb'
     )
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_invoice_impl_20260714'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = '_post_deleted_delivery_recovery_invoice_20260719'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'save_invoice',
           '_save_invoice_below_cost_impl_20260810',
           '_save_invoice_intent_impl_20260802',
           '_save_invoice_governed_split_guard_impl_20260720',
           '_save_invoice_split_provenance_impl_20260719',
           '_save_invoice_scoped_impl'
         )
     ) <> 6
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'update_field_app_invoice_billing'
     ) <> 1
     OR (
       SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'unpost_invoice'
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_normal
         AND p.proargtypes = '2950 25'::oidvector
         AND p.proargnames = ARRAY['p_invoice_id', 'p_idempotency_key']::text[]
         AND p.pronargdefaults = 1
         AND p.prorettype = 'void'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position(
               'v_posting_date date := (now() AT TIME ZONE ''America/Chicago'')::date;' IN p.prosrc
             ) > 0
         AND position(
               'v_inv.invoice_date + (v_terms_days' IN p.prosrc
             ) = 0
         AND position(
               'v_inv.due_date_source = ''system''' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_recovery
         AND p.proargtypes = '2950'::oidvector
         AND p.proargnames = ARRAY['p_invoice_id']::text[]
         AND p.pronargdefaults = 0
         AND p.prorettype = 'void'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position(
               'v_posting_date date := (now() AT TIME ZONE ''America/Chicago'')::date;' IN p.prosrc
             ) > 0
         AND position(
               'v_inv.invoice_date + (v_terms_days' IN p.prosrc
             ) = 0
         AND position(
               'v_inv.due_date_source = ''system''' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save
         AND p.proargtypes = '3802 3802 25'::oidvector
         AND p.proargnames = ARRAY['p_invoice', 'p_items', 'p_idempotency_key']::text[]
         AND p.pronargdefaults = 2
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position('p_invoice ? ''due_date_source''' IN p.prosrc) > 0
         AND position(
               'v_due_date_source NOT IN (''system'', ''explicit'', ''legacy'')' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_public
         AND position(
               'RETURN public._save_invoice_below_cost_impl_20260810(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_below_cost
         AND position(
               'RETURN public._save_invoice_intent_impl_20260802(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_intent
         AND position(
               'RETURN public._save_invoice_governed_split_guard_impl_20260720(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_governed_split
         AND position(
               'v_saved_id := public._save_invoice_split_provenance_impl_20260719(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_save_split_provenance
         AND position(
               'RETURN public._save_invoice_scoped_impl(' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_field_billing
         AND p.proargtypes = '2951 25 25 25 1082 25 25 3802 2950 25'::oidvector
         AND p.proargnames = ARRAY[
           'p_invoice_ids', 'p_purchase_order_ref', 'p_payment_terms',
           'p_header_notes', 'p_due_date', 'p_footer_notes',
           'p_internal_notes', 'p_discounts', 'p_performed_by',
           'p_idempotency_key'
         ]::text[]
         AND p.pronargdefaults = 9
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position(
               'WHEN i.due_date_source = ''legacy''' IN p.prosrc
             ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_proc p
       WHERE p.oid = v_unpost
         AND p.proargtypes = '2950 2950 25'::oidvector
         AND p.proargnames = ARRAY[
           'p_invoice_id', 'p_performed_by', 'p_idempotency_key'
         ]::text[]
         AND p.pronargdefaults = 1
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position(
               'CASE WHEN v_inv.due_date_source = ''system'' THEN NULL ELSE due_date END' IN p.prosrc
             ) > 0
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_normal, v_recovery, v_save)
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee <> p.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_field_billing, v_unpost)
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee NOT IN (
           p.proowner,
           'authenticated'::regrole,
           'service_role'::regrole
         )
     )
     OR NOT has_function_privilege('authenticated', v_field_billing, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_field_billing, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_unpost, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_unpost, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM public.invoices i
       WHERE i.due_date_source NOT IN ('system', 'explicit', 'legacy')
          OR (i.due_date_source <> 'system' AND i.due_date IS NULL)
     ) THEN
    RAISE EXCEPTION
      'INVOICE_DUE_DATE_POSTING_POSTFLIGHT_FAILED: normal %, recovery %, save %, field billing %, unpost %',
      v_normal_hash,
      v_recovery_hash,
      v_save_hash,
      v_field_billing_hash,
      v_unpost_hash;
  END IF;
END;
$postflight$;
