-- OWNER-APPROVED GO-LIVE DATA STEP — supplier vendor spelling resolution for Phase 1b.
-- Apply only through the sanctioned migration review/proof gate.
-- Prerequisite: 20260718225511_supplier_price_evidence_phase1b.sql.
--
-- Owner decision (Mason, 2026-07-17; reaffirmed in the Phase 1b build request):
--   * canonical vendor "The Andersons" owns "Andersons" and "The Anderson's"
--   * active canonical vendor record "Van Diest Supply" owns aliases
--     "Van Deist" and "Van Diest"
--
-- This step is reversible and non-destructive. It does not rename, merge,
-- soft-delete, or delete any vendor row. It only records reviewed aliases and
-- legacy purchase-order text resolution. If review rejects these mappings before
-- they are used, remove only rows bearing the review note below; original vendor
-- and purchase-order data remains unchanged.

DO $migration$
DECLARE
  v_andersons_id uuid;
  v_van_diest_id uuid;
  v_count integer;
  v_review_note constant text :=
    'Owner-approved Phase 1b canonical vendor spelling resolution (2026-07-17)';
BEGIN
  SELECT count(*)::integer
  INTO v_count
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('The Andersons')
    AND deleted_at IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_CANONICAL_NOT_UNIQUE: The Andersons (%)', v_count;
  END IF;
  SELECT id INTO v_andersons_id
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('The Andersons')
    AND deleted_at IS NULL;

  SELECT count(*)::integer
  INTO v_count
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('Van Diest Supply')
    AND deleted_at IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_CANONICAL_NOT_UNIQUE: Van Diest Supply (%)', v_count;
  END IF;
  SELECT id INTO v_van_diest_id
  FROM public.vendors
  WHERE lower(btrim(name)) = lower('Van Diest Supply')
    AND deleted_at IS NULL;

  IF EXISTS (
    SELECT 1
    FROM public.vendor_aliases a
    WHERE a.alias_normalized IN (
      public.normalize_vendor_alias('Andersons'),
      public.normalize_vendor_alias('The Anderson''s')
    )
      AND (
        a.review_status <> 'approved'
        OR a.vendor_id IS DISTINCT FROM v_andersons_id
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_ALIAS_CONFLICT: The Andersons';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.vendor_aliases a
    WHERE a.alias_normalized IN (
      public.normalize_vendor_alias('Van Deist'),
      public.normalize_vendor_alias('Van Diest')
    )
      AND (
        a.review_status <> 'approved'
        OR a.vendor_id IS DISTINCT FROM v_van_diest_id
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_ALIAS_CONFLICT: Van Diest Supply';
  END IF;

  INSERT INTO public.vendor_aliases(
    vendor_id, proposed_vendor_id, alias_raw, alias_display, source,
    review_status, review_note, reviewed_at
  ) VALUES
    (v_andersons_id, v_andersons_id, 'Andersons', 'Andersons', 'manual',
      'approved', v_review_note, now()),
    (v_andersons_id, v_andersons_id, 'The Anderson''s', 'The Anderson''s', 'manual',
      'approved', v_review_note, now()),
    (v_van_diest_id, v_van_diest_id, 'Van Deist', 'Van Deist', 'manual',
      'approved', v_review_note, now()),
    (v_van_diest_id, v_van_diest_id, 'Van Diest', 'Van Diest', 'manual',
      'approved', v_review_note, now())
  ON CONFLICT (alias_normalized) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text IN (
      public.normalize_vendor_alias('Andersons'),
      public.normalize_vendor_alias('The Anderson''s')
    )
      AND (
        r.review_status <> 'approved'
        OR r.vendor_id IS DISTINCT FROM v_andersons_id
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_CONFLICT: The Andersons';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text IN (
      public.normalize_vendor_alias('Van Deist'),
      public.normalize_vendor_alias('Van Diest')
    )
      AND (
        r.review_status <> 'approved'
        OR r.vendor_id IS DISTINCT FROM v_van_diest_id
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_CONFLICT: Van Diest Supply';
  END IF;

  INSERT INTO public.legacy_vendor_resolution(
    original_text, vendor_id, confidence, review_status, source_table,
    review_note, reviewed_at
  ) VALUES
    ('Andersons', v_andersons_id, 1, 'approved', 'purchase_orders', v_review_note, now()),
    ('The Anderson''s', v_andersons_id, 1, 'approved', 'purchase_orders', v_review_note, now()),
    ('Van Deist', v_van_diest_id, 1, 'approved', 'purchase_orders', v_review_note, now()),
    ('Van Diest', v_van_diest_id, 1, 'approved', 'purchase_orders', v_review_note, now())
  ON CONFLICT (normalized_text) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendor_aliases a
    WHERE a.alias_normalized = public.normalize_vendor_alias('Andersons')
      AND a.review_status = 'approved'
      AND a.vendor_id = v_andersons_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.vendor_aliases a
    WHERE a.alias_normalized = public.normalize_vendor_alias('The Anderson''s')
      AND a.review_status = 'approved'
      AND a.vendor_id = v_andersons_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.vendor_aliases a
    WHERE a.alias_normalized = public.normalize_vendor_alias('Van Deist')
      AND a.review_status = 'approved'
      AND a.vendor_id = v_van_diest_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.vendor_aliases a
    WHERE a.alias_normalized = public.normalize_vendor_alias('Van Diest')
      AND a.review_status = 'approved'
      AND a.vendor_id = v_van_diest_id
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_VENDOR_ALIAS_STAGE_VERIFY_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text = public.normalize_vendor_alias('Andersons')
      AND r.review_status = 'approved'
      AND r.vendor_id = v_andersons_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text = public.normalize_vendor_alias('The Anderson''s')
      AND r.review_status = 'approved'
      AND r.vendor_id = v_andersons_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text = public.normalize_vendor_alias('Van Deist')
      AND r.review_status = 'approved'
      AND r.vendor_id = v_van_diest_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.legacy_vendor_resolution r
    WHERE r.normalized_text = public.normalize_vendor_alias('Van Diest')
      AND r.review_status = 'approved'
      AND r.vendor_id = v_van_diest_id
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LEGACY_VENDOR_STAGE_VERIFY_FAILED';
  END IF;
END;
$migration$;
