-- Active supplier identities must be unique under the same normalization used
-- by vendor aliases and reviewed legacy purchase-history resolutions.
--
-- This closes the punctuation/whitespace ambiguity identified during the
-- independent Phase 1b closeout review. Deleted vendors may retain historical
-- names, but restoring or creating an active normalized duplicate fails closed.

LOCK TABLE public.vendors IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
DECLARE
  v_collision text;
BEGIN
  SELECT public.normalize_vendor_alias(vendor.name)
  INTO v_collision
  FROM public.vendors vendor
  WHERE vendor.deleted_at IS NULL
  GROUP BY public.normalize_vendor_alias(vendor.name)
  HAVING count(*) > 1
  ORDER BY public.normalize_vendor_alias(vendor.name)
  LIMIT 1;

  IF v_collision IS NOT NULL THEN
    RAISE EXCEPTION 'VENDOR_ACTIVE_NORMALIZED_NAME_NOT_UNIQUE: %', v_collision;
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX vendors_active_normalized_name_key
  ON public.vendors (public.normalize_vendor_alias(name))
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.vendors_active_normalized_name_key IS
  'Prevents multiple active vendors from sharing the normalized identity used by supplier aliases and legacy purchase history.';
