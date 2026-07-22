-- Supplier Pricing Phase 1b closeout: review the exact historical purchase-order
-- vendor text "Wells Ag Supply" against the existing active canonical vendor.
--
-- Owner approved this mapping on 2026-07-21 after the Wells operational pilot.
-- This is evidence stewardship only: it inserts one reviewed resolution row and
-- does not rewrite purchase orders, products, costs, tier prices, or observations.

DO $migration$
DECLARE
  v_wells_id uuid;
  v_canonical_count integer;
  v_legacy_po_count integer;
  v_product_prices_before jsonb;
  v_product_prices_after jsonb;
  v_review_note constant text :=
    'Owner-approved Wells Phase 1b legacy purchase history resolution (2026-07-21)';
BEGIN
  SELECT count(*)::integer
  INTO v_canonical_count
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('Wells Ag Supply')
    AND deleted_at IS NULL;

  IF v_canonical_count <> 1 THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_CANONICAL_NOT_UNIQUE: Wells Ag Supply (%)',
      v_canonical_count;
  END IF;

  SELECT id
  INTO v_wells_id
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('Wells Ag Supply')
    AND deleted_at IS NULL;

  SELECT count(*)::integer
  INTO v_legacy_po_count
  FROM public.purchase_orders
  WHERE public.normalize_vendor_alias(vendor) =
    public.normalize_vendor_alias('Wells Ag Supply');

  IF v_legacy_po_count = 0 THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_SOURCE_NOT_FOUND: Wells Ag Supply';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.legacy_vendor_resolution resolution
    WHERE resolution.normalized_text =
      public.normalize_vendor_alias('Wells Ag Supply')
      AND (
        resolution.review_status <> 'approved'
        OR resolution.vendor_id IS DISTINCT FROM v_wells_id
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_CONFLICT: Wells Ag Supply';
  END IF;

  SELECT jsonb_build_object(
    'product_count', count(*),
    'current_cost', sum(product.current_cost),
    'tier1_price', sum(product.tier1_price),
    'tier2_price', sum(product.tier2_price),
    'tier3_price', sum(product.tier3_price)
  )
  INTO v_product_prices_before
  FROM public.products product
  WHERE EXISTS (
    SELECT 1
    FROM public.product_supplier_links link
    WHERE link.product_id = product.id
      AND link.vendor_id = v_wells_id
  );

  INSERT INTO public.legacy_vendor_resolution(
    original_text,
    vendor_id,
    confidence,
    review_status,
    source_table,
    review_note,
    reviewed_at
  ) VALUES (
    'Wells Ag Supply',
    v_wells_id,
    1,
    'approved',
    'purchase_orders',
    v_review_note,
    now()
  )
  ON CONFLICT (normalized_text) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.legacy_vendor_resolution resolution
    WHERE resolution.normalized_text =
      public.normalize_vendor_alias('Wells Ag Supply')
      AND resolution.original_text = 'Wells Ag Supply'
      AND resolution.review_status = 'approved'
      AND resolution.vendor_id = v_wells_id
      AND resolution.source_table = 'purchase_orders'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_VERIFY_FAILED: Wells Ag Supply';
  END IF;

  SELECT jsonb_build_object(
    'product_count', count(*),
    'current_cost', sum(product.current_cost),
    'tier1_price', sum(product.tier1_price),
    'tier2_price', sum(product.tier2_price),
    'tier3_price', sum(product.tier3_price)
  )
  INTO v_product_prices_after
  FROM public.products product
  WHERE EXISTS (
    SELECT 1
    FROM public.product_supplier_links link
    WHERE link.product_id = product.id
      AND link.vendor_id = v_wells_id
  );

  IF v_product_prices_after IS DISTINCT FROM v_product_prices_before THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_PRICE_INVARIANT_FAILED: Wells Ag Supply';
  END IF;
END;
$migration$;
