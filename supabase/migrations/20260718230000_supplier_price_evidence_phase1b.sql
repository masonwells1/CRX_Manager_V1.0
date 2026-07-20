-- idempotency-body-check: exempt
-- LIVE — Supplier Pricing Phase 1b supplier-evidence MVP.
-- Applied as submitted migration 20260718230000_supplier_price_evidence_phase1b;
-- reconciled to live ledger version 20260718225511 under the B7 rule.
-- Prerequisites (already live):
--   * 20260717042803 / 20260717120000_supplier_pricing_phase1a
--   * 20260717112011 / 20260717120500_supplier_pricing_zero_cost_guard
--   * 20260717171331 / 20260717170000_restore_legacy_pricing_version_compat
--   * 20260718154131 / 20260718124517_harden_supplier_pricing_cent_scale_and_trigger
-- Purpose:
--   * manual-only supplier quote staging + approval (NO OCR / AI parsing)
--   * reviewed vendor aliases and legacy purchase-order vendor resolution
--   * confirmed product/supplier links with a directional unit conversion
--   * append-only supplier price observations
--   * additive Gate-0 purchase-order-line cost provenance snapshots
--   * read models for supplier comparison, worksheet evidence, and product history
-- Safety:
--   * every new table has RLS and a policy
--   * browser writes are RPC-owned; authenticated table mutation grants stay revoked
--   * mutating RPCs require a non-blank idempotency key and strict actor equality
--   * source PDFs may be retained for audit but are never parsed
--   * no function in this migration changes products.current_cost or sell prices

CREATE OR REPLACE FUNCTION public.normalize_vendor_alias(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $function$
  SELECT lower(
    regexp_replace(
      regexp_replace(btrim(p_value), '[[:punct:]]+', '', 'g'),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
$function$;

REVOKE ALL ON FUNCTION public.normalize_vendor_alias(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.vendor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
  proposed_vendor_id uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
  alias_raw text NOT NULL CHECK (btrim(alias_raw) <> ''),
  alias_normalized text GENERATED ALWAYS AS (public.normalize_vendor_alias(alias_raw)) STORED,
  alias_display text NOT NULL CHECK (btrim(alias_display) <> ''),
  source text NOT NULL CHECK (source IN ('legacy_product', 'legacy_po', 'import', 'manual')),
  review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  review_note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_aliases_review_shape CHECK (
    (review_status = 'pending' AND vendor_id IS NULL AND reviewed_at IS NULL)
    OR (review_status = 'approved' AND vendor_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (review_status = 'rejected' AND vendor_id IS NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_aliases_normalized
  ON public.vendor_aliases(alias_normalized);
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_vendor
  ON public.vendor_aliases(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_review_queue
  ON public.vendor_aliases(review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.legacy_vendor_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_text text NOT NULL CHECK (btrim(original_text) <> ''),
  normalized_text text GENERATED ALWAYS AS (public.normalize_vendor_alias(original_text)) STORED,
  vendor_id uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
  confidence numeric(5,4) NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  source_table text NOT NULL CHECK (source_table IN ('products', 'purchase_orders')),
  review_note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_vendor_resolution_review_shape CHECK (
    (review_status = 'pending' AND vendor_id IS NULL AND reviewed_at IS NULL)
    OR (review_status = 'approved' AND vendor_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (review_status = 'rejected' AND vendor_id IS NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_legacy_vendor_resolution_normalized
  ON public.legacy_vendor_resolution(normalized_text);
CREATE INDEX IF NOT EXISTS idx_legacy_vendor_resolution_vendor
  ON public.legacy_vendor_resolution(vendor_id) WHERE vendor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.product_supplier_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
  supplier_sku text,
  supplier_product_name text NOT NULL CHECK (btrim(supplier_product_name) <> ''),
  supplier_uom text,
  supplier_pack_description text,
  inventory_units_per_supplier_unit numeric(20,8),
  -- Compatibility label retained from the rev-5 handoff. New code must use the
  -- directional column above so the multiply/divide direction is unambiguous.
  conversion_factor numeric(20,8)
    GENERATED ALWAYS AS (inventory_units_per_supplier_unit) STORED,
  conversion_unit text,
  comparison_status text NOT NULL DEFAULT 'pending'
    CHECK (comparison_status IN ('pending', 'comparable', 'not_comparable')),
  comparison_note text,
  link_status text NOT NULL DEFAULT 'pending'
    CHECK (link_status IN ('pending', 'confirmed', 'rejected')),
  is_reusable boolean GENERATED ALWAYS AS (
    link_status = 'confirmed'
    AND NULLIF(btrim(supplier_sku), '') IS NOT NULL
    AND NULLIF(btrim(supplier_uom), '') IS NOT NULL
    AND NULLIF(btrim(supplier_pack_description), '') IS NOT NULL
  ) STORED,
  is_active boolean NOT NULL DEFAULT true,
  is_preferred boolean NOT NULL DEFAULT false,
  match_confidence numeric(5,4) CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
  confirmed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  confirmed_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_supplier_links_supplier_sku_nonblank
    CHECK (supplier_sku IS NULL OR btrim(supplier_sku) <> ''),
  CONSTRAINT product_supplier_links_conversion_positive
    CHECK (inventory_units_per_supplier_unit IS NULL OR inventory_units_per_supplier_unit > 0),
  CONSTRAINT product_supplier_links_confirmation_shape CHECK (
    (link_status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (link_status <> 'confirmed')
  ),
  CONSTRAINT product_supplier_links_comparable_shape CHECK (
    comparison_status <> 'comparable'
    OR (
      link_status = 'confirmed'
      AND inventory_units_per_supplier_unit IS NOT NULL
      AND NULLIF(btrim(conversion_unit), '') IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_supplier_links_sku
  ON public.product_supplier_links(product_id, vendor_id, lower(supplier_sku))
  WHERE supplier_sku IS NOT NULL AND btrim(supplier_sku) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_supplier_links_preferred
  ON public.product_supplier_links(product_id)
  WHERE is_active AND is_preferred AND link_status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_product_supplier_links_vendor
  ON public.product_supplier_links(vendor_id, is_active, link_status);
CREATE INDEX IF NOT EXISTS idx_product_supplier_links_product
  ON public.product_supplier_links(product_id, is_active, link_status);

CREATE TABLE IF NOT EXISTS public.supplier_price_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
  document_date date NOT NULL,
  ingestion_method text NOT NULL
    CHECK (ingestion_method IN ('quote_sheet', 'quick_quote')),
  format_version text NOT NULL CHECK (btrim(format_version) <> ''),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'needs_review', 'approved', 'rejected', 'partially_approved')),
  source_document_path text,
  source_document_name text,
  source_document_mime text,
  request_fingerprint text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  eligible_row_count integer NOT NULL DEFAULT 0 CHECK (eligible_row_count >= 0),
  approved_observation_count integer NOT NULL DEFAULT 0 CHECK (approved_observation_count >= 0),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_price_imports_source_document_shape CHECK (
    source_document_path IS NULL
    OR (
      NULLIF(btrim(source_document_name), '') IS NOT NULL
      AND source_document_mime = 'application/pdf'
    )
  ),
  CONSTRAINT supplier_price_imports_review_shape CHECK (
    (status IN ('draft', 'needs_review') AND approved_at IS NULL AND rejected_at IS NULL)
    OR (status IN ('approved', 'partially_approved') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_price_imports_review_queue
  ON public.supplier_price_imports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_imports_vendor
  ON public.supplier_price_imports(vendor_id, document_date DESC);

CREATE TABLE IF NOT EXISTS public.supplier_price_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.supplier_price_imports(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number > 0),
  submitted_row jsonb NOT NULL,
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  vendor_id uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
  product_supplier_link_id uuid REFERENCES public.product_supplier_links(id) ON DELETE RESTRICT,
  supplier_sku text,
  supplier_product_name text,
  cost_cents bigint CHECK (cost_cents IS NULL OR cost_cents > 0),
  price_unit text,
  package_quantity numeric(20,8) CHECK (package_quantity IS NULL OR package_quantity > 0),
  effective_from date,
  effective_to date,
  price_kind text CHECK (price_kind IS NULL OR price_kind IN ('list', 'quote', 'contract', 'promo', 'manual')),
  row_status text NOT NULL
    CHECK (row_status IN ('new', 'changed', 'cannot_compare', 'invalid', 'unchanged', 'duplicate', 'approved', 'rejected')),
  validation_errors text[] NOT NULL DEFAULT ARRAY[]::text[],
  reviewer_note text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  observation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_price_import_rows_effective_range
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CONSTRAINT supplier_price_import_rows_approved_shape CHECK (
    row_status <> 'approved'
    OR (observation_id IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  UNIQUE (import_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_supplier_price_import_rows_import
  ON public.supplier_price_import_rows(import_id, row_number);
CREATE INDEX IF NOT EXISTS idx_supplier_price_import_rows_link
  ON public.supplier_price_import_rows(product_supplier_link_id)
  WHERE product_supplier_link_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.supplier_price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE RESTRICT,
  product_supplier_link_id uuid NOT NULL REFERENCES public.product_supplier_links(id) ON DELETE RESTRICT,
  import_id uuid NOT NULL REFERENCES public.supplier_price_imports(id) ON DELETE RESTRICT,
  import_row_id uuid NOT NULL REFERENCES public.supplier_price_import_rows(id) ON DELETE RESTRICT,
  price_kind text NOT NULL CHECK (price_kind IN ('list', 'quote', 'contract', 'promo', 'manual')),
  cost_cents bigint NOT NULL CHECK (cost_cents > 0),
  price_unit text NOT NULL CHECK (btrim(price_unit) <> ''),
  package_quantity numeric(20,8) NOT NULL DEFAULT 1 CHECK (package_quantity > 0),
  effective_from date NOT NULL,
  effective_to date,
  observed_at timestamptz NOT NULL DEFAULT now(),
  supersedes_observation_id uuid REFERENCES public.supplier_price_observations(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_price_observations_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT supplier_price_observations_not_self_superseding
    CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id <> id),
  UNIQUE (import_row_id)
);

ALTER TABLE public.supplier_price_import_rows
  DROP CONSTRAINT IF EXISTS supplier_price_import_rows_observation_id_fkey;
ALTER TABLE public.supplier_price_import_rows
  ADD CONSTRAINT supplier_price_import_rows_observation_id_fkey
  FOREIGN KEY (observation_id)
  REFERENCES public.supplier_price_observations(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_observations_supersedes
  ON public.supplier_price_observations(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_price_observations_product_date
  ON public.supplier_price_observations(product_id, effective_from DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_observations_vendor_date
  ON public.supplier_price_observations(vendor_id, effective_from DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_price_observations_link_date
  ON public.supplier_price_observations(product_supplier_link_id, effective_from DESC, created_at DESC);

-- Gate-0 feed-forward only. No costing engine or automatic PO cost selection is
-- introduced here; future work may populate these nullable snapshots.
ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS product_supplier_link_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_price_observation_id uuid,
  ADD COLUMN IF NOT EXISTS inventory_units_per_supplier_unit_snapshot numeric(20,8),
  ADD COLUMN IF NOT EXISTS cost_provenance text,
  ADD COLUMN IF NOT EXISTS cost_snapshot_at timestamptz;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_order_items_product_supplier_link_id_fkey'
      AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD CONSTRAINT purchase_order_items_product_supplier_link_id_fkey
      FOREIGN KEY (product_supplier_link_id)
      REFERENCES public.product_supplier_links(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_order_items_supplier_price_observation_id_fkey'
      AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD CONSTRAINT purchase_order_items_supplier_price_observation_id_fkey
      FOREIGN KEY (supplier_price_observation_id)
      REFERENCES public.supplier_price_observations(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_order_items_supplier_unit_snapshot_positive'
      AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD CONSTRAINT purchase_order_items_supplier_unit_snapshot_positive
      CHECK (
        inventory_units_per_supplier_unit_snapshot IS NULL
        OR inventory_units_per_supplier_unit_snapshot > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_order_items_cost_provenance_check'
      AND conrelid = 'public.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE public.purchase_order_items
      ADD CONSTRAINT purchase_order_items_cost_provenance_check
      CHECK (
        cost_provenance IS NULL
        OR cost_provenance IN ('manual', 'supplier_observation', 'legacy')
      );
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_supplier_link
  ON public.purchase_order_items(product_supplier_link_id)
  WHERE product_supplier_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_supplier_observation
  ON public.purchase_order_items(supplier_price_observation_id)
  WHERE supplier_price_observation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_supplier_evidence_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_supplier_evidence_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;

DO $triggers$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'vendor_aliases',
    'legacy_vendor_resolution',
    'product_supplier_links',
    'supplier_price_imports',
    'supplier_price_import_rows'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || v_table || '_updated_at', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_supplier_evidence_updated_at()',
      'trg_' || v_table || '_updated_at',
      v_table
    );
  END LOOP;
END;
$triggers$;

CREATE OR REPLACE FUNCTION public.guard_supplier_price_observation_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'SUPPLIER_PRICE_OBSERVATION_IMMUTABLE';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_supplier_price_observation_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_supplier_price_observations_immutable
  ON public.supplier_price_observations;
CREATE TRIGGER trg_supplier_price_observations_immutable
  BEFORE UPDATE OR DELETE ON public.supplier_price_observations
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_price_observation_immutable();

CREATE OR REPLACE FUNCTION public.validate_supplier_price_observation_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_link public.product_supplier_links%ROWTYPE;
  v_row public.supplier_price_import_rows%ROWTYPE;
  v_prior public.supplier_price_observations%ROWTYPE;
BEGIN
  SELECT * INTO v_link
  FROM public.product_supplier_links
  WHERE id = NEW.product_supplier_link_id;
  IF NOT FOUND
     OR v_link.product_id IS DISTINCT FROM NEW.product_id
     OR v_link.vendor_id IS DISTINCT FROM NEW.vendor_id THEN
    RAISE EXCEPTION 'SUPPLIER_LINK_MISMATCH';
  END IF;

  SELECT * INTO v_row
  FROM public.supplier_price_import_rows
  WHERE id = NEW.import_row_id;
  IF NOT FOUND
     OR v_row.import_id IS DISTINCT FROM NEW.import_id
     OR v_row.product_id IS DISTINCT FROM NEW.product_id
     OR v_row.vendor_id IS DISTINCT FROM NEW.vendor_id
     OR v_row.product_supplier_link_id IS DISTINCT FROM NEW.product_supplier_link_id THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_PROVENANCE_MISMATCH';
  END IF;

  IF NEW.supersedes_observation_id IS NOT NULL THEN
    SELECT * INTO v_prior
    FROM public.supplier_price_observations
    WHERE id = NEW.supersedes_observation_id;
    IF NOT FOUND
       OR v_prior.product_id IS DISTINCT FROM NEW.product_id
       OR v_prior.vendor_id IS DISTINCT FROM NEW.vendor_id
       OR v_prior.product_supplier_link_id IS DISTINCT FROM NEW.product_supplier_link_id THEN
      RAISE EXCEPTION 'SUPPLIER_SUPERSESSION_MISMATCH';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_supplier_price_observation_insert()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_supplier_price_observations_validate_insert
  ON public.supplier_price_observations;
CREATE TRIGGER trg_supplier_price_observations_validate_insert
  BEFORE INSERT ON public.supplier_price_observations
  FOR EACH ROW EXECUTE FUNCTION public.validate_supplier_price_observation_insert();

ALTER TABLE public.vendor_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_vendor_resolution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_supplier_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_price_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_price_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_price_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_aliases_select ON public.vendor_aliases;
CREATE POLICY vendor_aliases_select ON public.vendor_aliases
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS legacy_vendor_resolution_select ON public.legacy_vendor_resolution;
CREATE POLICY legacy_vendor_resolution_select ON public.legacy_vendor_resolution
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS product_supplier_links_select ON public.product_supplier_links;
CREATE POLICY product_supplier_links_select ON public.product_supplier_links
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS supplier_price_imports_select ON public.supplier_price_imports;
CREATE POLICY supplier_price_imports_select ON public.supplier_price_imports
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS supplier_price_import_rows_select ON public.supplier_price_import_rows;
CREATE POLICY supplier_price_import_rows_select ON public.supplier_price_import_rows
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS supplier_price_observations_select ON public.supplier_price_observations;
CREATE POLICY supplier_price_observations_select ON public.supplier_price_observations
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS supplier_price_observations_insert ON public.supplier_price_observations;
CREATE POLICY supplier_price_observations_insert ON public.supplier_price_observations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND created_by = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.vendor_aliases FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.legacy_vendor_resolution FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.product_supplier_links FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.supplier_price_imports FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.supplier_price_import_rows FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.supplier_price_observations FROM PUBLIC, anon, authenticated, service_role;

-- Private audit bucket. A source PDF is retained only; no RPC or Edge Function
-- reads its bytes, and no OCR/AI extraction route exists.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'supplier-price-evidence',
  'supplier-price-evidence',
  false,
  26214400,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS supplier_price_evidence_objects_select ON storage.objects;
CREATE POLICY supplier_price_evidence_objects_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'supplier-price-evidence'
    AND (public.is_admin() OR public.is_sales_rep())
  );

DROP POLICY IF EXISTS supplier_price_evidence_objects_insert ON storage.objects;
CREATE POLICY supplier_price_evidence_objects_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'supplier-price-evidence'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE OR REPLACE FUNCTION public.get_supplier_quote_sheet(p_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_vendor public.vendors%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REQUIRED';
  END IF;

  SELECT * INTO v_vendor
  FROM public.vendors
  WHERE id = p_vendor_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'VENDOR_NOT_FOUND'; END IF;

  SELECT jsonb_build_object(
    'format_version', 'crx-supplier-quote-phase1b-v1',
    'vendor_id', v_vendor.id,
    'vendor_name', v_vendor.name,
    'generated_at', now(),
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
      'product_supplier_link_id', l.id,
      'product_id', p.id,
      'vendor_id', l.vendor_id,
      'supplier_sku', l.supplier_sku,
      'product_name', p.product_name,
      'supplier_product_name', l.supplier_product_name,
      'supplier_uom', l.supplier_uom,
      'supplier_pack_description', l.supplier_pack_description,
      'inventory_unit', p.inventory_unit,
      'inventory_units_per_supplier_unit', l.inventory_units_per_supplier_unit,
      'comparison_status', l.comparison_status,
      'last_cost', CASE WHEN latest.cost_cents IS NULL THEN NULL ELSE public._format_pricing_dollars(latest.cost_cents) END,
      'last_effective_date', latest.effective_from,
      'new_cost', '',
      'effective_date', current_date,
      'price_kind', 'quote'
    ) ORDER BY p.product_name, l.supplier_sku), '[]'::jsonb)
  ) INTO v_result
  FROM public.product_supplier_links l
  JOIN public.products p ON p.id = l.product_id AND p.is_active
  LEFT JOIN LATERAL (
    SELECT o.cost_cents, o.effective_from
    FROM public.supplier_price_observations o
    WHERE o.product_supplier_link_id = l.id
      AND o.effective_from <= current_date
      AND (o.effective_to IS NULL OR o.effective_to >= current_date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.supplier_price_observations correction
        WHERE correction.supersedes_observation_id = o.id
      )
    ORDER BY o.effective_from DESC, o.observed_at DESC, o.id DESC
    LIMIT 1
  ) latest ON true
  WHERE l.vendor_id = p_vendor_id
    AND l.is_active
    AND l.is_reusable;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_supplier_market_evidence(p_product_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REQUIRED';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (o.product_supplier_link_id)
      o.product_id,
      o.vendor_id,
      o.product_supplier_link_id,
      o.cost_cents,
      o.package_quantity,
      o.effective_from,
      o.observed_at,
      l.inventory_units_per_supplier_unit,
      l.comparison_status,
      v.name AS vendor_name,
      CASE
        WHEN l.comparison_status = 'comparable'
         AND l.inventory_units_per_supplier_unit > 0
        THEN round(o.cost_cents::numeric / o.package_quantity / l.inventory_units_per_supplier_unit)::bigint
        ELSE NULL
      END AS normalized_cost_cents
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l ON l.id = o.product_supplier_link_id AND l.is_active
    JOIN public.vendors v ON v.id = o.vendor_id AND v.deleted_at IS NULL
    WHERE (p_product_ids IS NULL OR o.product_id = ANY(p_product_ids))
      AND o.effective_from <= current_date
      AND (o.effective_to IS NULL OR o.effective_to >= current_date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.supplier_price_observations correction
        WHERE correction.supersedes_observation_id = o.id
      )
    ORDER BY o.product_supplier_link_id, o.effective_from DESC, o.observed_at DESC, o.id DESC
  ), ranked AS (
    SELECT latest.*,
      dense_rank() OVER (
        PARTITION BY product_id
        ORDER BY normalized_cost_cents ASC NULLS LAST, effective_from DESC
      ) AS price_rank
    FROM latest
  ), product_summary AS (
    SELECT
      product_id,
      count(*)::integer AS supplier_quote_count,
      count(*) FILTER (WHERE normalized_cost_cents IS NOT NULL)::integer AS comparable_quote_count,
      min(normalized_cost_cents) AS replacement_cost_cents,
      max(effective_from) FILTER (WHERE normalized_cost_cents IS NOT NULL AND price_rank = 1) AS replacement_cost_as_of,
      min(vendor_name) FILTER (WHERE normalized_cost_cents IS NOT NULL AND price_rank = 1) AS best_supplier,
      jsonb_agg(jsonb_build_object(
        'vendor_id', vendor_id,
        'vendor_name', vendor_name,
        'product_supplier_link_id', product_supplier_link_id,
        'quoted_package_cost_cents', cost_cents,
        'normalized_cost_cents', normalized_cost_cents,
        'effective_from', effective_from,
        'comparison_status', CASE WHEN normalized_cost_cents IS NULL THEN 'cannot_compare' ELSE 'comparable' END,
        'is_best_comparable', normalized_cost_cents IS NOT NULL AND price_rank = 1
      ) ORDER BY normalized_cost_cents ASC NULLS LAST, vendor_name) AS suppliers
    FROM ranked
    GROUP BY product_id
  ), purchase_lines AS (
    SELECT
      poi.id,
      poi.product_id,
      poi.unit_cost_cents,
      poi.quantity_received,
      COALESCE(po.submitted_date, po.created_at::date) AS purchase_date
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND po.status <> 'cancelled'
      AND (p_product_ids IS NULL OR poi.product_id = ANY(p_product_ids))
  ), purchase_summary AS (
    SELECT
      product_id,
      (array_agg(unit_cost_cents ORDER BY purchase_date DESC, id DESC))[1] AS last_paid_cents,
      (array_agg(purchase_date ORDER BY purchase_date DESC, id DESC))[1] AS last_paid_as_of,
      round(
        sum(unit_cost_cents::numeric * quantity_received)
          FILTER (WHERE purchase_date >= current_date - 365)
        / NULLIF(
          sum(quantity_received) FILTER (WHERE purchase_date >= current_date - 365),
          0
        )
      )::bigint AS recent_po_weighted_average_cents
    FROM purchase_lines
    GROUP BY product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id,
    'supplier_quote_count', COALESCE(s.supplier_quote_count, 0),
    'comparable_quote_count', COALESCE(s.comparable_quote_count, 0),
    'replacement_cost_cents', s.replacement_cost_cents,
    'replacement_cost_as_of', s.replacement_cost_as_of,
    'best_supplier', s.best_supplier,
    'last_paid_cents', purchase.last_paid_cents,
    'last_paid_as_of', purchase.last_paid_as_of,
    'recent_po_weighted_average_cents', purchase.recent_po_weighted_average_cents,
    'recent_po_window', 'trailing_12_months',
    'comparison_status', CASE
      WHEN COALESCE(s.supplier_quote_count, 0) = 0 THEN 'no_evidence'
      WHEN COALESCE(s.comparable_quote_count, 0) = 0 THEN 'cannot_compare'
      ELSE 'comparable'
    END,
    'suppliers', COALESCE(s.suppliers, '[]'::jsonb)
  ) ORDER BY p.product_name, p.id), '[]'::jsonb)
  INTO v_result
  FROM public.products p
  LEFT JOIN product_summary s ON s.product_id = p.id
  LEFT JOIN purchase_summary purchase ON purchase.product_id = p.id
  WHERE p.is_active
    AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids));

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_supplier_pricing_workspace(
  p_product_id uuid DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REQUIRED';
  END IF;

  SELECT jsonb_build_object(
    'vendors', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) ORDER BY v.name), '[]'::jsonb)
      FROM public.vendors v WHERE v.deleted_at IS NULL
    ),
    'products', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', p.id, 'product_name', p.product_name, 'sku', p.sku, 'inventory_unit', p.inventory_unit
      ) ORDER BY p.product_name), '[]'::jsonb)
      FROM public.products p
      WHERE p.is_active AND (p_product_id IS NULL OR p.id = p_product_id)
    ),
    'links', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', l.id,
        'product_id', l.product_id,
        'product_name', p.product_name,
        'vendor_id', l.vendor_id,
        'vendor_name', v.name,
        'supplier_sku', l.supplier_sku,
        'supplier_product_name', l.supplier_product_name,
        'supplier_uom', l.supplier_uom,
        'supplier_pack_description', l.supplier_pack_description,
        'inventory_units_per_supplier_unit', l.inventory_units_per_supplier_unit,
        'conversion_unit', l.conversion_unit,
        'comparison_status', l.comparison_status,
        'comparison_note', l.comparison_note,
        'link_status', l.link_status,
        'is_reusable', l.is_reusable,
        'is_preferred', l.is_preferred,
        'is_active', l.is_active
      ) ORDER BY p.product_name, v.name, l.supplier_sku), '[]'::jsonb)
      FROM public.product_supplier_links l
      JOIN public.products p ON p.id = l.product_id
      JOIN public.vendors v ON v.id = l.vendor_id
      WHERE (p_product_id IS NULL OR l.product_id = p_product_id)
        AND (p_vendor_id IS NULL OR l.vendor_id = p_vendor_id)
    ),
    'imports', (
      SELECT COALESCE(jsonb_agg(import_row ORDER BY (import_row->>'created_at') DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id', i.id,
          'vendor_id', i.vendor_id,
          'vendor_name', v.name,
          'document_date', i.document_date,
          'ingestion_method', i.ingestion_method,
          'status', i.status,
          'row_count', i.row_count,
          'eligible_row_count', i.eligible_row_count,
          'approved_observation_count', i.approved_observation_count,
          'source_document_name', i.source_document_name,
          'created_at', i.created_at
        ) AS import_row
        FROM public.supplier_price_imports i
        JOIN public.vendors v ON v.id = i.vendor_id
        WHERE (p_vendor_id IS NULL OR i.vendor_id = p_vendor_id)
        ORDER BY i.created_at DESC
        LIMIT 50
      ) recent
    ),
    'aliases', CASE WHEN public.is_admin() THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id,
        'vendor_id', a.vendor_id,
        'proposed_vendor_id', a.proposed_vendor_id,
        'alias_raw', a.alias_raw,
        'alias_normalized', a.alias_normalized,
        'alias_display', a.alias_display,
        'source', a.source,
        'review_status', a.review_status,
        'review_note', a.review_note,
        'created_at', a.created_at
      ) ORDER BY a.review_status, a.alias_display), '[]'::jsonb)
      FROM public.vendor_aliases a
    ) ELSE '[]'::jsonb END,
    'evidence', public.get_supplier_market_evidence(
      CASE WHEN p_product_id IS NULL THEN NULL ELSE ARRAY[p_product_id] END
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_supplier_price_import(p_import_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REQUIRED';
  END IF;

  SELECT jsonb_build_object(
    'id', i.id,
    'vendor_id', i.vendor_id,
    'vendor_name', v.name,
    'document_date', i.document_date,
    'ingestion_method', i.ingestion_method,
    'format_version', i.format_version,
    'status', i.status,
    'source_document_name', i.source_document_name,
    'row_count', i.row_count,
    'eligible_row_count', i.eligible_row_count,
    'approved_observation_count', i.approved_observation_count,
    'created_at', i.created_at,
    'rows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id,
        'row_number', r.row_number,
        'product_id', r.product_id,
        'product_name', p.product_name,
        'product_supplier_link_id', r.product_supplier_link_id,
        'supplier_sku', r.supplier_sku,
        'supplier_product_name', r.supplier_product_name,
        'cost_cents', r.cost_cents,
        'price_unit', r.price_unit,
        'package_quantity', r.package_quantity,
        'effective_from', r.effective_from,
        'effective_to', r.effective_to,
        'price_kind', r.price_kind,
        'row_status', r.row_status,
        'validation_errors', r.validation_errors,
        'observation_id', r.observation_id
      ) ORDER BY r.row_number), '[]'::jsonb)
      FROM public.supplier_price_import_rows r
      LEFT JOIN public.products p ON p.id = r.product_id
      WHERE r.import_id = i.id
    )
  ) INTO v_result
  FROM public.supplier_price_imports i
  JOIN public.vendors v ON v.id = i.vendor_id
  WHERE i.id = p_import_id;

  IF v_result IS NULL THEN RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_FOUND'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_product_price_history(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REQUIRED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
  END IF;

  WITH history_points AS (
    SELECT
      'supplier_observation'::text AS stream,
      o.id::text AS source_id,
      o.vendor_id,
      v.name AS supplier_name,
      o.cost_cents,
      CASE
        WHEN l.comparison_status = 'comparable'
         AND l.inventory_units_per_supplier_unit > 0
        THEN round(o.cost_cents::numeric / o.package_quantity / l.inventory_units_per_supplier_unit)::bigint
        ELSE NULL
      END AS normalized_cost_cents,
      o.effective_from::timestamptz AS occurred_at,
      o.price_kind AS detail,
      jsonb_build_object(
        'import_id', o.import_id,
        'import_row_id', o.import_row_id,
        'product_supplier_link_id', o.product_supplier_link_id,
        'price_unit', o.price_unit,
        'package_quantity', o.package_quantity
      ) AS provenance
    FROM public.supplier_price_observations o
    JOIN public.product_supplier_links l ON l.id = o.product_supplier_link_id
    JOIN public.vendors v ON v.id = o.vendor_id
    WHERE o.product_id = p_product_id

    UNION ALL

    SELECT
      'selected_cost_basis'::text,
      ch.id::text,
      NULL::uuid,
      NULL::text,
      round(ch.new_cost * 100)::bigint,
      round(ch.new_cost * 100)::bigint,
      ch.changed_at,
      COALESCE(ch.change_note, ch.change_source, 'Product pricing history'),
      jsonb_build_object('change_set_id', ch.change_set_id, 'changed_by', ch.changed_by)
    FROM public.cost_history ch
    WHERE ch.product_id = p_product_id
      AND ch.new_cost IS NOT NULL

    UNION ALL

    SELECT
      'actual_purchase'::text,
      poi.id::text,
      resolved.vendor_id,
      COALESCE(v.name, 'supplier unknown'),
      poi.unit_cost_cents,
      CASE
        WHEN poi.inventory_units_per_supplier_unit_snapshot > 0
        THEN round(poi.unit_cost_cents::numeric / poi.inventory_units_per_supplier_unit_snapshot)::bigint
        ELSE NULL
      END,
      COALESCE(po.submitted_date::timestamptz, po.created_at),
      'actual_purchase',
      jsonb_build_object(
        'purchase_order_id', po.id,
        'purchase_order_item_id', poi.id,
        'po_number', po.po_number,
        'legacy_vendor_text', po.vendor,
        'resolution_status', CASE WHEN resolved.vendor_id IS NULL THEN 'supplier unknown' ELSE 'reviewed' END,
        'cost_provenance', poi.cost_provenance
      )
    FROM public.purchase_order_items poi
    JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN public.legacy_vendor_resolution resolved
      ON resolved.normalized_text = public.normalize_vendor_alias(po.vendor)
     AND resolved.review_status = 'approved'
    LEFT JOIN public.vendors v ON v.id = resolved.vendor_id
    WHERE poi.product_id = p_product_id
      AND poi.quantity_received > 0
      AND poi.unit_cost_cents IS NOT NULL
      AND po.status <> 'cancelled'
  )
  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'summary', COALESCE(
      public.get_supplier_market_evidence(ARRAY[p_product_id])->0,
      jsonb_build_object(
        'product_id', p_product_id,
        'supplier_quote_count', 0,
        'comparable_quote_count', 0,
        'replacement_cost_cents', NULL,
        'replacement_cost_as_of', NULL,
        'best_supplier', NULL,
        'last_paid_cents', NULL,
        'last_paid_as_of', NULL,
        'recent_po_weighted_average_cents', NULL,
        'recent_po_window', 'trailing_12_months',
        'comparison_status', 'no_evidence',
        'suppliers', '[]'::jsonb
      )
    ),
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.vendor_id, 'name', s.supplier_name) ORDER BY s.supplier_name)
      FROM (
        SELECT DISTINCT vendor_id, supplier_name
        FROM history_points
        WHERE vendor_id IS NOT NULL
      ) s
    ), '[]'::jsonb),
    'points', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stream', h.stream,
        'source_id', h.source_id,
        'vendor_id', h.vendor_id,
        'supplier_name', h.supplier_name,
        'cost_cents', h.cost_cents,
        'normalized_cost_cents', h.normalized_cost_cents,
        'occurred_at', h.occurred_at,
        'detail', h.detail,
        'provenance', h.provenance
      ) ORDER BY h.occurred_at, h.stream, h.source_id)
      FROM history_points h
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_product_supplier_link(
  p_product_id uuid,
  p_vendor_id uuid,
  p_supplier_sku text,
  p_supplier_product_name text,
  p_supplier_uom text,
  p_supplier_pack_description text,
  p_inventory_units_per_supplier_unit text,
  p_conversion_unit text,
  p_comparison_status text,
  p_comparison_note text,
  p_is_preferred boolean,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_link_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_units numeric(20,8);
  v_product public.products%ROWTYPE;
  v_link_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_supplier_sku), '') IS NULL
     OR NULLIF(btrim(p_supplier_uom), '') IS NULL
     OR NULLIF(btrim(p_supplier_pack_description), '') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_LINK_REUSE_FIELDS_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_supplier_product_name), '') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_PRODUCT_NAME_REQUIRED';
  END IF;
  IF p_comparison_status NOT IN ('pending', 'comparable', 'not_comparable') THEN
    RAISE EXCEPTION 'SUPPLIER_COMPARISON_STATUS_INVALID';
  END IF;

  IF NULLIF(btrim(COALESCE(p_inventory_units_per_supplier_unit, '')), '') IS NOT NULL THEN
    IF btrim(p_inventory_units_per_supplier_unit) !~ '^[0-9]+([.][0-9]{1,8})?$' THEN
      RAISE EXCEPTION 'SUPPLIER_CONVERSION_INVALID';
    END IF;
    v_units := btrim(p_inventory_units_per_supplier_unit)::numeric(20,8);
    IF v_units <= 0 THEN RAISE EXCEPTION 'SUPPLIER_CONVERSION_INVALID'; END IF;
  END IF;
  IF p_comparison_status = 'comparable'
     AND (v_units IS NULL OR NULLIF(btrim(COALESCE(p_conversion_unit, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'SUPPLIER_COMPARISON_REQUIRES_CONVERSION';
  END IF;

  SELECT * INTO v_product
  FROM public.products
  WHERE id = p_product_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
  IF p_comparison_status = 'comparable'
     AND (
       NULLIF(btrim(COALESCE(v_product.inventory_unit, '')), '') IS NULL
       OR lower(btrim(p_conversion_unit)) IS DISTINCT FROM lower(btrim(v_product.inventory_unit))
     ) THEN
    RAISE EXCEPTION 'SUPPLIER_CONVERSION_UNIT_MUST_MATCH_INVENTORY_UNIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'link_id', p_link_id,
    'product_id', p_product_id,
    'vendor_id', p_vendor_id,
    'supplier_sku', btrim(p_supplier_sku),
    'supplier_product_name', btrim(p_supplier_product_name),
    'supplier_uom', btrim(p_supplier_uom),
    'supplier_pack_description', btrim(p_supplier_pack_description),
    'inventory_units_per_supplier_unit', v_units,
    'conversion_unit', NULLIF(btrim(COALESCE(p_conversion_unit, '')), ''),
    'comparison_status', p_comparison_status,
    'comparison_note', NULLIF(btrim(COALESCE(p_comparison_note, '')), ''),
    'is_preferred', p_is_preferred
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'upsert_product_supplier_link');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- Approved observations normalize through this link. Once that history exists,
  -- changing the product, package, or conversion in place would silently rewrite
  -- the meaning of old evidence. Require a new link for a changed supplier pack.
  IF p_link_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.product_supplier_links l
    WHERE l.id = p_link_id
      AND EXISTS (
        SELECT 1
        FROM public.supplier_price_observations observation
        WHERE observation.product_supplier_link_id = l.id
      )
      AND (
        l.product_id IS DISTINCT FROM p_product_id
        OR l.vendor_id IS DISTINCT FROM p_vendor_id
        OR l.supplier_sku IS DISTINCT FROM btrim(p_supplier_sku)
        OR l.supplier_product_name IS DISTINCT FROM btrim(p_supplier_product_name)
        OR l.supplier_uom IS DISTINCT FROM btrim(p_supplier_uom)
        OR l.supplier_pack_description IS DISTINCT FROM btrim(p_supplier_pack_description)
        OR l.inventory_units_per_supplier_unit IS DISTINCT FROM v_units
        OR l.conversion_unit IS DISTINCT FROM NULLIF(btrim(COALESCE(p_conversion_unit, '')), '')
        OR l.comparison_status IS DISTINCT FROM p_comparison_status
      )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LINK_WITH_HISTORY_IMMUTABLE';
  END IF;

  IF p_is_preferred THEN
    UPDATE public.product_supplier_links
    SET is_preferred = false
    WHERE product_id = p_product_id
      AND is_preferred
      AND (p_link_id IS NULL OR id <> p_link_id);
  END IF;

  IF p_link_id IS NULL THEN
    INSERT INTO public.product_supplier_links(
      product_id, vendor_id, supplier_sku, supplier_product_name,
      supplier_uom, supplier_pack_description,
      inventory_units_per_supplier_unit, conversion_unit,
      comparison_status, comparison_note,
      link_status, is_preferred, match_confidence,
      confirmed_by, confirmed_at, created_by
    ) VALUES (
      p_product_id, p_vendor_id, btrim(p_supplier_sku), btrim(p_supplier_product_name),
      btrim(p_supplier_uom), btrim(p_supplier_pack_description),
      v_units, NULLIF(btrim(COALESCE(p_conversion_unit, '')), ''),
      p_comparison_status, NULLIF(btrim(COALESCE(p_comparison_note, '')), ''),
      'confirmed', p_is_preferred, 1,
      v_actor, now(), v_actor
    ) RETURNING id INTO v_link_id;
  ELSE
    UPDATE public.product_supplier_links
    SET product_id = p_product_id,
        vendor_id = p_vendor_id,
        supplier_sku = btrim(p_supplier_sku),
        supplier_product_name = btrim(p_supplier_product_name),
        supplier_uom = btrim(p_supplier_uom),
        supplier_pack_description = btrim(p_supplier_pack_description),
        inventory_units_per_supplier_unit = v_units,
        conversion_unit = NULLIF(btrim(COALESCE(p_conversion_unit, '')), ''),
        comparison_status = p_comparison_status,
        comparison_note = NULLIF(btrim(COALESCE(p_comparison_note, '')), ''),
        link_status = 'confirmed',
        is_active = true,
        is_preferred = p_is_preferred,
        match_confidence = 1,
        confirmed_by = v_actor,
        confirmed_at = now()
    WHERE id = p_link_id
    RETURNING id INTO v_link_id;
    IF v_link_id IS NULL THEN RAISE EXCEPTION 'SUPPLIER_LINK_NOT_FOUND'; END IF;
  END IF;

  SELECT jsonb_build_object(
    'id', l.id,
    'product_id', l.product_id,
    'vendor_id', l.vendor_id,
    'supplier_sku', l.supplier_sku,
    'supplier_product_name', l.supplier_product_name,
    'supplier_uom', l.supplier_uom,
    'supplier_pack_description', l.supplier_pack_description,
    'inventory_units_per_supplier_unit', l.inventory_units_per_supplier_unit,
    'conversion_unit', l.conversion_unit,
    'comparison_status', l.comparison_status,
    'link_status', l.link_status,
    'is_reusable', l.is_reusable,
    'is_preferred', l.is_preferred
  ) INTO v_result
  FROM public.product_supplier_links l
  WHERE l.id = v_link_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'upsert_product_supplier_link',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_supplier_price_import(
  p_vendor_id uuid,
  p_document_date date,
  p_ingestion_method text,
  p_format_version text,
  p_source_document_path text,
  p_source_document_name text,
  p_source_document_mime text,
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_import_id uuid;
  v_row jsonb;
  v_sequence integer;
  v_link public.product_supplier_links%ROWTYPE;
  v_cost_cents bigint;
  v_effective_from date;
  v_effective_to date;
  v_package_quantity numeric(20,8);
  v_price_kind text;
  v_price_unit text;
  v_status text;
  v_errors text[];
  v_link_id uuid;
  v_result jsonb;
  v_row_count integer;
  v_eligible_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_document_date IS NULL THEN RAISE EXCEPTION 'DOCUMENT_DATE_REQUIRED'; END IF;
  IF p_ingestion_method NOT IN ('quote_sheet', 'quick_quote') THEN
    RAISE EXCEPTION 'SUPPLIER_INGESTION_METHOD_INVALID';
  END IF;
  IF NULLIF(btrim(p_format_version), '') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_FORMAT_VERSION_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROWS_REQUIRED';
  END IF;
  v_row_count := jsonb_array_length(p_rows);
  IF v_row_count < 1 OR v_row_count > 5000 THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROW_COUNT_INVALID';
  END IF;
  IF p_source_document_path IS NOT NULL AND (
    NULLIF(btrim(COALESCE(p_source_document_name, '')), '') IS NULL
    OR p_source_document_mime IS DISTINCT FROM 'application/pdf'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_INVALID';
  END IF;
  IF p_source_document_path IS NOT NULL AND (
    split_part(p_source_document_path, '/', 1) IS DISTINCT FROM v_actor::text
    OR NOT EXISTS (
      SELECT 1
      FROM storage.objects object
      WHERE object.bucket_id = 'supplier-price-evidence'
        AND object.name = p_source_document_path
    )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_NOT_OWNED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_id', p_vendor_id,
    'document_date', p_document_date,
    'ingestion_method', p_ingestion_method,
    'format_version', p_format_version,
    'source_document_path', p_source_document_path,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  INSERT INTO public.supplier_price_imports(
    vendor_id, document_date, ingestion_method, format_version, status,
    source_document_path, source_document_name, source_document_mime,
    request_fingerprint, idempotency_key, row_count, created_by
  ) VALUES (
    p_vendor_id, p_document_date, p_ingestion_method, p_format_version, 'draft',
    NULLIF(btrim(COALESCE(p_source_document_path, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_name, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_mime, '')), ''),
    v_request_fp, p_idempotency_key, v_row_count, v_actor
  ) RETURNING id INTO v_import_id;

  FOR v_row, v_sequence IN
    SELECT value, ordinality::integer
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_errors := ARRAY[]::text[];
    v_status := 'new';
    v_cost_cents := NULL;
    v_effective_from := NULL;
    v_effective_to := NULL;
    v_package_quantity := NULL;
    v_link_id := NULL;
    v_link := NULL;
    v_price_kind := lower(COALESCE(NULLIF(btrim(v_row->>'price_kind'), ''), 'quote'));
    v_price_unit := NULLIF(btrim(COALESCE(v_row->>'price_unit', '')), '');

    IF lower(COALESCE(v_row->>'has_formula', 'false')) = 'true' THEN
      v_errors := array_append(v_errors, 'FORMULA_NOT_ALLOWED');
    END IF;

    BEGIN
      v_link_id := NULLIF(btrim(COALESCE(v_row->>'product_supplier_link_id', '')), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_errors := array_append(v_errors, 'LINK_ID_INVALID');
    END;

    IF v_link_id IS NOT NULL THEN
      SELECT * INTO v_link
      FROM public.product_supplier_links
      WHERE id = v_link_id AND is_active;
      IF NOT FOUND OR v_link.vendor_id IS DISTINCT FROM p_vendor_id THEN
        v_errors := array_append(v_errors, 'LINK_VENDOR_MISMATCH');
        v_link_id := NULL;
        v_link := NULL;
      ELSIF NOT v_link.is_reusable THEN
        v_errors := array_append(v_errors, 'LINK_NOT_CONFIRMED_FOR_REUSE');
      ELSE
        IF v_price_unit IS NULL THEN v_price_unit := v_link.supplier_uom; END IF;
      END IF;
    ELSE
      v_errors := array_append(v_errors, 'LINK_REQUIRED');
    END IF;

    BEGIN
      v_cost_cents := public._parse_pricing_dollars(btrim(COALESCE(v_row->>'new_cost', '')));
      IF v_cost_cents <= 0 THEN
        v_errors := array_append(v_errors, 'COST_MUST_BE_POSITIVE');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := array_append(v_errors, 'COST_INVALID');
      v_cost_cents := NULL;
    END;

    IF v_price_kind NOT IN ('list', 'quote', 'contract', 'promo', 'manual') THEN
      v_errors := array_append(v_errors, 'PRICE_KIND_INVALID');
      v_price_kind := NULL;
    END IF;
    IF v_price_unit IS NULL THEN
      v_errors := array_append(v_errors, 'PRICE_UNIT_REQUIRED');
    END IF;

    BEGIN
      v_package_quantity := COALESCE(NULLIF(btrim(v_row->>'package_quantity'), '')::numeric, 1);
      IF v_package_quantity <= 0 THEN
        v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      END IF;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      v_package_quantity := NULL;
    END;

    BEGIN
      v_effective_from := COALESCE(NULLIF(btrim(v_row->>'effective_date'), '')::date, p_document_date);
      v_effective_to := NULLIF(btrim(COALESCE(v_row->>'effective_to', '')), '')::date;
      IF v_effective_to IS NOT NULL AND v_effective_to < v_effective_from THEN
        v_errors := array_append(v_errors, 'EFFECTIVE_RANGE_INVALID');
      END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      v_errors := array_append(v_errors, 'EFFECTIVE_DATE_INVALID');
      v_effective_from := NULL;
      v_effective_to := NULL;
    END;

    IF cardinality(v_errors) > 0 THEN
      v_status := 'invalid';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_import_rows prior
      WHERE prior.import_id = v_import_id
        AND prior.product_supplier_link_id = v_link_id
        AND prior.cost_cents = v_cost_cents
        AND prior.effective_from = v_effective_from
        AND prior.price_kind = v_price_kind
    ) THEN
      v_status := 'duplicate';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
        AND o.cost_cents = v_cost_cents
        AND o.effective_from = v_effective_from
        AND o.price_kind = v_price_kind
        AND o.price_unit = v_price_unit
        AND o.package_quantity = v_package_quantity
    ) THEN
      v_status := 'unchanged';
    ELSIF v_link.comparison_status <> 'comparable' THEN
      v_status := 'cannot_compare';
    ELSIF EXISTS (
      SELECT 1
      FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
    ) THEN
      v_status := 'changed';
    END IF;

    INSERT INTO public.supplier_price_import_rows(
      import_id, row_number, submitted_row,
      product_id, vendor_id, product_supplier_link_id,
      supplier_sku, supplier_product_name,
      cost_cents, price_unit, package_quantity,
      effective_from, effective_to, price_kind,
      row_status, validation_errors
    ) VALUES (
      v_import_id, v_sequence, v_row,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.product_id END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE p_vendor_id END,
      v_link_id,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_sku END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_product_name END,
      v_cost_cents, v_price_unit, v_package_quantity,
      v_effective_from, v_effective_to, v_price_kind,
      v_status, v_errors
    );
  END LOOP;

  SELECT count(*)::integer INTO v_eligible_count
  FROM public.supplier_price_import_rows
  WHERE import_id = v_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare');

  UPDATE public.supplier_price_imports
  SET status = 'needs_review',
      eligible_row_count = v_eligible_count
  WHERE id = v_import_id;

  v_result := public.get_supplier_price_import(v_import_id);
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_supplier_price_import(
  p_import_id uuid,
  p_row_ids uuid[],
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_import public.supplier_price_imports%ROWTYPE;
  v_row public.supplier_price_import_rows%ROWTYPE;
  v_observation_id uuid;
  v_approved_count integer := 0;
  v_eligible_count integer;
  v_nonterminal_count integer;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_row_ids IS NULL OR cardinality(p_row_ids) = 0 THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_ROWS_REQUIRED';
  END IF;
  IF cardinality(p_row_ids) <> (
    SELECT count(DISTINCT row_id)
    FROM unnest(p_row_ids) AS selected(row_id)
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_DUPLICATE_ROW_IDS';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'import_id', p_import_id,
    'row_ids', to_jsonb(p_row_ids)
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'approve_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_import
  FROM public.supplier_price_imports
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_FOUND'; END IF;
  IF v_import.status <> 'needs_review' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_NOT_REVIEWABLE';
  END IF;

  SELECT count(*)::integer INTO v_eligible_count
  FROM public.supplier_price_import_rows
  WHERE import_id = p_import_id
    AND id = ANY(p_row_ids)
    AND row_status IN ('new', 'changed', 'cannot_compare');
  IF v_eligible_count <> cardinality(p_row_ids) THEN
    RAISE EXCEPTION 'SUPPLIER_APPROVAL_ROW_NOT_ELIGIBLE';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.supplier_price_import_rows
    WHERE import_id = p_import_id
      AND id = ANY(p_row_ids)
      AND row_status IN ('new', 'changed', 'cannot_compare')
    ORDER BY row_number
    FOR UPDATE
  LOOP
    INSERT INTO public.supplier_price_observations(
      product_id, vendor_id, product_supplier_link_id,
      import_id, import_row_id,
      price_kind, cost_cents, price_unit, package_quantity,
      effective_from, effective_to, observed_at, created_by
    ) VALUES (
      v_row.product_id, v_row.vendor_id, v_row.product_supplier_link_id,
      p_import_id, v_row.id,
      v_row.price_kind, v_row.cost_cents, v_row.price_unit, v_row.package_quantity,
      v_row.effective_from, v_row.effective_to, now(), v_actor
    ) RETURNING id INTO v_observation_id;

    UPDATE public.supplier_price_import_rows
    SET row_status = 'approved',
        reviewed_by = v_actor,
        reviewed_at = now(),
        observation_id = v_observation_id
    WHERE id = v_row.id;
    v_approved_count := v_approved_count + 1;
  END LOOP;

  UPDATE public.supplier_price_import_rows
  SET row_status = 'rejected',
      reviewed_by = v_actor,
      reviewed_at = now(),
      reviewer_note = COALESCE(reviewer_note, 'Not selected during import approval')
  WHERE import_id = p_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare')
    AND NOT (id = ANY(p_row_ids));

  SELECT count(*)::integer INTO v_nonterminal_count
  FROM public.supplier_price_import_rows
  WHERE import_id = p_import_id
    AND row_status IN ('invalid', 'rejected');

  UPDATE public.supplier_price_imports
  SET status = CASE WHEN v_nonterminal_count = 0 THEN 'approved' ELSE 'partially_approved' END,
      approved_by = v_actor,
      approved_at = now(),
      approved_observation_count = v_approved_count
  WHERE id = p_import_id;

  v_result := public.get_supplier_price_import(p_import_id)
    || jsonb_build_object(
      'approved_count', v_approved_count,
      'sell_prices_changed', 0,
      'summary', format(
        'You are adding %s supplier observations. You are changing ZERO sell prices.',
        v_approved_count
      )
    );
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'approve_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_vendor_alias(
  p_alias_raw text,
  p_alias_display text,
  p_proposed_vendor_id uuid,
  p_source text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_alias_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_alias_raw), '') IS NULL OR NULLIF(btrim(p_alias_display), '') IS NULL THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_TEXT_REQUIRED';
  END IF;
  IF p_source NOT IN ('legacy_product', 'legacy_po', 'import', 'manual') THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_SOURCE_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_proposed_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'alias_raw', p_alias_raw,
    'alias_display', p_alias_display,
    'proposed_vendor_id', p_proposed_vendor_id,
    'source', p_source
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_vendor_alias');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  INSERT INTO public.vendor_aliases(
    proposed_vendor_id, alias_raw, alias_display, source,
    review_status, created_by
  ) VALUES (
    p_proposed_vendor_id, btrim(p_alias_raw), btrim(p_alias_display), p_source,
    'pending', v_actor
  ) RETURNING id INTO v_alias_id;

  SELECT to_jsonb(a) INTO v_result
  FROM public.vendor_aliases a WHERE a.id = v_alias_id;
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_vendor_alias',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_vendor_alias(
  p_alias_id uuid,
  p_vendor_id uuid,
  p_decision text,
  p_review_note text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'VENDOR_ALIAS_DECISION_INVALID';
  END IF;
  IF p_decision = 'approved' AND NOT EXISTS (
    SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'alias_id', p_alias_id,
    'vendor_id', p_vendor_id,
    'decision', p_decision,
    'review_note', p_review_note
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'review_vendor_alias');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  UPDATE public.vendor_aliases AS alias
  SET vendor_id = CASE WHEN p_decision = 'approved' THEN p_vendor_id ELSE NULL END,
      review_status = p_decision,
      review_note = NULLIF(btrim(COALESCE(p_review_note, '')), ''),
      reviewed_by = v_actor,
      reviewed_at = now()
  WHERE id = p_alias_id
    AND review_status = 'pending'
  RETURNING to_jsonb(alias) INTO v_result;
  IF v_result IS NULL THEN RAISE EXCEPTION 'VENDOR_ALIAS_NOT_PENDING'; END IF;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'review_vendor_alias',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_request_fp, 'response', v_result)
  );
  RETURN v_result;
END;
$function$;

-- Correction / supersession (plan section 3: "Corrections supersede; nothing is
-- edited in place"). A fat-fingered approved quote is NEVER edited or deleted.
-- Instead this appends a NEW observation whose supersedes_observation_id points at
-- the original, carrying the corrected cost. The read models already exclude any
-- observation that has a superseding row, so the corrected value becomes current
-- and the original drops out of "cheapest"/"replacement cost" automatically.
--
-- To preserve the append-only 1:1 observation<->import_row provenance (import_id and
-- import_row_id are NOT NULL, and import_row_id is UNIQUE), a correction is recorded
-- as its own single-row 'quick_quote' import so the new observation has honest
-- provenance without reusing the original row. Only the CURRENT (non-superseded)
-- observation may be corrected, so a chain A<-B<-C always corrects C and produces D,
-- keeping the "latest, non-superseded" read-model result single-valued.
CREATE OR REPLACE FUNCTION public.correct_supplier_price_observation(
  p_observation_id uuid,
  p_corrected_cost text,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_reason text;
  v_cost_cents bigint;
  v_original public.supplier_price_observations%ROWTYPE;
  v_import_id uuid;
  v_row_id uuid;
  v_observation_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'CORRECTION_REASON_REQUIRED'; END IF;

  -- Single dollars->cents boundary, reusing the same parser the staging path uses.
  BEGIN
    v_cost_cents := public._parse_pricing_dollars(btrim(COALESCE(p_corrected_cost, '')));
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'CORRECTION_COST_INVALID';
  END;
  IF v_cost_cents IS NULL OR v_cost_cents <= 0 THEN
    RAISE EXCEPTION 'CORRECTION_COST_MUST_BE_POSITIVE';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'observation_id', p_observation_id,
    'cost_cents', v_cost_cents,
    'reason', v_reason
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'correct_supplier_price_observation');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  SELECT * INTO v_original
  FROM public.supplier_price_observations
  WHERE id = p_observation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_OBSERVATION_NOT_FOUND'; END IF;

  -- Only the current observation is correctable; a re-correction extends the chain.
  IF EXISTS (
    SELECT 1
    FROM public.supplier_price_observations correction
    WHERE correction.supersedes_observation_id = v_original.id
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_OBSERVATION_ALREADY_SUPERSEDED';
  END IF;

  IF v_cost_cents = v_original.cost_cents THEN
    RAISE EXCEPTION 'CORRECTION_MUST_CHANGE_COST';
  END IF;

  INSERT INTO public.supplier_price_imports(
    vendor_id, document_date, ingestion_method, format_version, status,
    request_fingerprint, idempotency_key, row_count, eligible_row_count,
    approved_observation_count, created_by, approved_by, approved_at
  ) VALUES (
    v_original.vendor_id, current_date, 'quick_quote',
    'crx-supplier-correction-phase1b-v1', 'approved',
    v_request_fp, 'correction:' || p_idempotency_key, 1, 1, 1,
    v_actor, v_actor, now()
  ) RETURNING id INTO v_import_id;

  -- Row first (not yet approved: the approved-shape CHECK needs observation_id, which
  -- only exists after the observation is inserted below).
  INSERT INTO public.supplier_price_import_rows(
    import_id, row_number, submitted_row,
    product_id, vendor_id, product_supplier_link_id,
    supplier_sku, supplier_product_name,
    cost_cents, price_unit, package_quantity,
    effective_from, effective_to, price_kind,
    row_status, validation_errors
  ) VALUES (
    v_import_id, 1,
    jsonb_build_object(
      'correction_of_observation_id', v_original.id,
      'reason', v_reason,
      'new_cost', public._format_pricing_dollars(v_cost_cents),
      'prior_cost', public._format_pricing_dollars(v_original.cost_cents)
    ),
    v_original.product_id, v_original.vendor_id, v_original.product_supplier_link_id,
    NULL, NULL,
    v_cost_cents, v_original.price_unit, v_original.package_quantity,
    v_original.effective_from, v_original.effective_to, v_original.price_kind,
    'changed', ARRAY[]::text[]
  ) RETURNING id INTO v_row_id;

  -- Superseding observation. The validate/no-cycle trigger confirms the product,
  -- vendor, and link all match the original before the row is written.
  INSERT INTO public.supplier_price_observations(
    product_id, vendor_id, product_supplier_link_id,
    import_id, import_row_id,
    price_kind, cost_cents, price_unit, package_quantity,
    effective_from, effective_to, observed_at,
    supersedes_observation_id, created_by
  ) VALUES (
    v_original.product_id, v_original.vendor_id, v_original.product_supplier_link_id,
    v_import_id, v_row_id,
    v_original.price_kind, v_cost_cents, v_original.price_unit, v_original.package_quantity,
    v_original.effective_from, v_original.effective_to, now(),
    v_original.id, v_actor
  ) RETURNING id INTO v_observation_id;

  UPDATE public.supplier_price_import_rows
  SET row_status = 'approved',
      reviewed_by = v_actor,
      reviewed_at = now(),
      reviewer_note = v_reason,
      observation_id = v_observation_id
  WHERE id = v_row_id;

  SELECT jsonb_build_object(
    'observation_id', o.id,
    'supersedes_observation_id', o.supersedes_observation_id,
    'product_id', o.product_id,
    'vendor_id', o.vendor_id,
    'product_supplier_link_id', o.product_supplier_link_id,
    'cost_cents', o.cost_cents,
    'price_unit', o.price_unit,
    'package_quantity', o.package_quantity,
    'price_kind', o.price_kind,
    'effective_from', o.effective_from,
    'effective_to', o.effective_to,
    'import_id', o.import_id,
    'import_row_id', o.import_row_id,
    'reason', v_reason,
    'sell_prices_changed', 0,
    'summary', format(
      'Correction recorded. The prior quote is superseded and no sell price changed. New supplier cost: $%s.',
      public._format_pricing_dollars(o.cost_cents)
    )
  ) INTO v_result
  FROM public.supplier_price_observations o
  WHERE o.id = v_observation_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'correct_supplier_price_observation',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_supplier_quote_sheet(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_market_evidence(uuid[])
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_pricing_workspace(uuid, uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_supplier_price_import(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_product_price_history(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_product_supplier_link(
  uuid, uuid, text, text, text, text, text, text, text, text, boolean, uuid, text, uuid
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stage_supplier_price_import(
  uuid, date, text, text, text, text, text, jsonb, uuid, text
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_supplier_price_import(uuid, uuid[], uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_vendor_alias(uuid, uuid, text, text, uuid, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_supplier_quote_sheet(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_market_evidence(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_pricing_workspace(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_import(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_price_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_product_supplier_link(
  uuid, uuid, text, text, text, text, text, text, text, text, boolean, uuid, text, uuid
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stage_supplier_price_import(
  uuid, date, text, text, text, text, text, jsonb, uuid, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_supplier_price_import(uuid, uuid[], uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.stage_vendor_alias(text, text, uuid, text, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_vendor_alias(uuid, uuid, text, text, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)
  TO authenticated;

-- Apply-time structural proof retained as replay/rebuild verification.
DO $verify$
DECLARE
  v_table text;
  v_missing text[] := ARRAY[]::text[];
  v_count integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'vendor_aliases',
    'legacy_vendor_resolution',
    'product_supplier_links',
    'supplier_price_imports',
    'supplier_price_import_rows',
    'supplier_price_observations'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND c.relkind = 'r' AND c.relrowsecurity
    ) THEN
      v_missing := array_append(v_missing, v_table || ':RLS');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = v_table
    ) THEN
      v_missing := array_append(v_missing, v_table || ':policy');
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.supplier_price_observations'::regclass
      AND tgname = 'trg_supplier_price_observations_immutable'
      AND NOT tgisinternal
  ) THEN
    v_missing := array_append(v_missing, 'supplier_price_observations:immutable_trigger');
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_supplier_quote_sheet',
      'get_supplier_market_evidence',
      'get_supplier_pricing_workspace',
      'get_supplier_price_import',
      'get_product_price_history',
      'upsert_product_supplier_link',
      'stage_supplier_price_import',
      'approve_supplier_price_import',
      'stage_vendor_alias',
      'review_vendor_alias',
      'correct_supplier_price_observation'
    );
  IF v_count <> 11 THEN
    v_missing := array_append(v_missing, format('supplier_rpc_count:%s', v_count));
  END IF;

  IF has_function_privilege('anon', 'public.approve_supplier_price_import(uuid,uuid[],uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stage_supplier_price_import(uuid,date,text,text,text,text,text,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.correct_supplier_price_observation(uuid,text,text,uuid,text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = 'public.review_vendor_alias(uuid,uuid,text,text,uuid,text)'::regprocedure
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    v_missing := array_append(v_missing, 'supplier_rpc_acl');
  END IF;

  IF v_missing <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'SUPPLIER_PRICING_PHASE1B_VERIFY_FAILED: %', array_to_string(v_missing, ', ');
  END IF;
END;
$verify$;
