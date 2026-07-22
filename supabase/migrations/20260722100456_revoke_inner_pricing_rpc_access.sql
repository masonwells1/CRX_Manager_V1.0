-- Supplier Pricing workbook v2 post-review privilege repair.
--
-- Every supported Product-page, Products-list, and workbook path now enters
-- through the governed cost-basis wrappers. The retained Phase 1a engines are
-- implementation details called by those SECURITY DEFINER wrappers and must
-- not remain directly executable by browser or service roles.

REVOKE ALL ON FUNCTION public.preview_product_pricing_changes(
  text, uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_product_pricing_change_set(
  uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.apply_product_pricing_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'INNER_PRICING_RPC_EXECUTE_PRIVILEGE_DRIFT';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'GOVERNED_PRICING_WRAPPER_EXECUTE_PRIVILEGE_DRIFT';
  END IF;
END;
$postflight$;
