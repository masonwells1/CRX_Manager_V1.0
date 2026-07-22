-- Ledger-parity replay of the assertion-only closeout migration.
-- A concurrent overnight apply repeated the same fail-closed checks after the
-- first apply had already succeeded. This file preserves both live ledger rows.
-- It changes no data, function body, grant, or feature flag.

DO $migration_checks$
BEGIN
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'preview_product_cost_basis_changes'
  ) <> 1 OR to_regprocedure(
    'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'preview_product_cost_basis_changes overload drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'apply_product_cost_basis_change_set'
  ) <> 1 OR to_regprocedure(
    'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'apply_product_cost_basis_change_set overload drift';
  END IF;

  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = '_product_cost_basis_row_required'
  ) <> 1 OR to_regprocedure(
    'public._product_cost_basis_row_required(text,text,jsonb,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION '_product_cost_basis_row_required overload drift';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'authenticated',
       'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'authenticated',
       'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public._product_cost_basis_row_required(text,text,jsonb,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'supplier cost-basis follow-up grant drift';
  END IF;
END;
$migration_checks$;
