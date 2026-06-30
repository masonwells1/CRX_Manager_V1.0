-- Migration: §1 AI Label-Data Backfill
-- Creates product_label_drafts staging table + max_label_rate columns on products
-- + commit/reject RPCs + coverage-report RPC
-- Applied: LOCAL only — not for production until manually reviewed.

-- ─────────────────────────────────────────────
-- 1. Add missing columns to products
-- ─────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS max_label_rate      numeric      NULL,
  ADD COLUMN IF NOT EXISTS max_label_rate_unit text         NULL;

-- ─────────────────────────────────────────────
-- 2. Staging table: product_label_drafts
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_label_drafts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Drafted values (NULL = not extracted)
  signal_word          text        NULL,
  rei_hours            integer     NULL,
  phi_days             integer     NULL,
  epa_registration     text        NULL,
  max_label_rate       numeric     NULL,
  max_label_rate_unit  text        NULL,
  -- Provenance
  source_note          text        NOT NULL DEFAULT '',   -- e.g. "Vision OCR from label_image.jpg"
  confidence           text        NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  -- Workflow status
  status               text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','edited','rejected','needs_manual')),
  -- Admin who ran the backfill
  created_by           uuid        NOT NULL REFERENCES auth.users(id),
  -- Admin who reviewed (NULL until reviewed)
  reviewed_by          uuid        NULL     REFERENCES auth.users(id),
  reviewed_at          timestamptz NULL,
  -- Idempotency key for the backfill run that produced this draft
  run_idempotency_key  text        NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_label_drafts_product_id
  ON product_label_drafts(product_id);
CREATE INDEX IF NOT EXISTS idx_product_label_drafts_status
  ON product_label_drafts(status);

-- Trigger: keep updated_at fresh
CREATE OR REPLACE FUNCTION trg_product_label_drafts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_product_label_drafts_updated_at ON product_label_drafts;
CREATE TRIGGER set_product_label_drafts_updated_at
  BEFORE UPDATE ON product_label_drafts
  FOR EACH ROW EXECUTE FUNCTION trg_product_label_drafts_updated_at();

-- ─────────────────────────────────────────────
-- 3. RLS — admin-only
-- ─────────────────────────────────────────────
ALTER TABLE product_label_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_select_product_label_drafts"  ON product_label_drafts;
DROP POLICY IF EXISTS "admin_insert_product_label_drafts"  ON product_label_drafts;
DROP POLICY IF EXISTS "admin_update_product_label_drafts"  ON product_label_drafts;
DROP POLICY IF EXISTS "admin_delete_product_label_drafts"  ON product_label_drafts;

CREATE POLICY "admin_select_product_label_drafts"
  ON product_label_drafts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    )
  );

CREATE POLICY "admin_insert_product_label_drafts"
  ON product_label_drafts FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    )
  );

CREATE POLICY "admin_update_product_label_drafts"
  ON product_label_drafts FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    )
  );

CREATE POLICY "admin_delete_product_label_drafts"
  ON product_label_drafts FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin' AND is_active = true
    )
  );

-- ─────────────────────────────────────────────
-- 4. RPC: create_label_draft
--    Inserts a draft for one product.
--    If a draft already exists for this product + run key, returns the existing id (idempotent).
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_label_draft(
  p_product_id           uuid,
  p_signal_word          text     DEFAULT NULL,
  p_rei_hours            integer  DEFAULT NULL,
  p_phi_days             integer  DEFAULT NULL,
  p_epa_registration     text     DEFAULT NULL,
  p_max_label_rate       numeric  DEFAULT NULL,
  p_max_label_rate_unit  text     DEFAULT NULL,
  p_source_note          text     DEFAULT '',
  p_confidence           text     DEFAULT 'low',
  p_status               text     DEFAULT 'pending',
  p_idempotency_key      text     DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id   uuid := auth.uid();
  v_draft_id  uuid;
  v_cached    jsonb;
BEGIN
  -- Auth gate: admin only
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- Idempotency: return cached result if same key already processed
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'create_label_draft';
    IF FOUND THEN
      RETURN (v_cached->>'draft_id')::uuid;
    END IF;
  END IF;

  -- Insert the draft
  INSERT INTO product_label_drafts (
    product_id, signal_word, rei_hours, phi_days, epa_registration,
    max_label_rate, max_label_rate_unit,
    source_note, confidence, status, created_by, run_idempotency_key
  ) VALUES (
    p_product_id, p_signal_word, p_rei_hours, p_phi_days, p_epa_registration,
    p_max_label_rate, p_max_label_rate_unit,
    p_source_note, p_confidence, p_status, v_user_id, p_idempotency_key
  )
  RETURNING id INTO v_draft_id;

  -- Store idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_label_draft', jsonb_build_object('draft_id', v_draft_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_draft_id;
END;
$$;

-- ─────────────────────────────────────────────
-- 5. RPC: commit_label_draft
--    Accepts an admin decision (accept / edit / reject) on one draft.
--    For 'accepted' or 'edited': writes values to products, but ONLY if:
--      - the field is currently NULL, OR
--      - p_force_overwrite = true (explicit human confirm for non-empty fields)
--    Idempotent via idempotency_keys.
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION commit_label_draft(
  p_draft_id        uuid,
  p_decision        text,        -- 'accepted' | 'edited' | 'rejected'
  -- edited values (used only when p_decision = 'edited'; pass NULL to skip a field)
  p_signal_word          text     DEFAULT NULL,
  p_rei_hours            integer  DEFAULT NULL,
  p_phi_days             integer  DEFAULT NULL,
  p_epa_registration     text     DEFAULT NULL,
  p_max_label_rate       numeric  DEFAULT NULL,
  p_max_label_rate_unit  text     DEFAULT NULL,
  p_force_overwrite  boolean  DEFAULT false,
  p_idempotency_key  text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_cached   jsonb;
  v_draft    product_label_drafts%ROWTYPE;
  v_product  products%ROWTYPE;
  v_new_sw   text;
  v_new_rei  integer;
  v_new_phi  integer;
  v_new_epa  text;
  v_new_mlr  numeric;
  v_new_mlru text;
  v_skipped  text[] := '{}';
  v_applied  text[] := '{}';
  v_result   jsonb;
BEGIN
  -- Auth gate
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- Validate decision
  IF p_decision NOT IN ('accepted', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_DECISION: must be accepted, edited, or rejected';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'commit_label_draft';
    IF FOUND THEN
      RETURN v_cached;
    END IF;
  END IF;

  -- Load draft (with lock for safety)
  SELECT * INTO v_draft FROM product_label_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND: %', p_draft_id;
  END IF;

  -- Don't re-commit already-decided drafts (unless idempotency key matched above)
  IF v_draft.status IN ('accepted', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'DRAFT_ALREADY_DECIDED: draft % has status %', p_draft_id, v_draft.status;
  END IF;

  -- Load product
  SELECT * INTO v_product FROM products WHERE id = v_draft.product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', v_draft.product_id;
  END IF;

  -- For accepted/edited: resolve which values to write
  IF p_decision IN ('accepted', 'edited') THEN
    -- Use edited override if provided, else draft value
    IF p_decision = 'edited' THEN
      v_new_sw   := p_signal_word;
      v_new_rei  := p_rei_hours;
      v_new_phi  := p_phi_days;
      v_new_epa  := p_epa_registration;
      v_new_mlr  := p_max_label_rate;
      v_new_mlru := p_max_label_rate_unit;
    ELSE
      v_new_sw   := v_draft.signal_word;
      v_new_rei  := v_draft.rei_hours;
      v_new_phi  := v_draft.phi_days;
      v_new_epa  := v_draft.epa_registration;
      v_new_mlr  := v_draft.max_label_rate;
      v_new_mlru := v_draft.max_label_rate_unit;
    END IF;

    -- No-overwrite guard: if product field is non-empty and p_force_overwrite=false → skip that field
    -- signal_word
    IF v_new_sw IS NOT NULL THEN
      IF v_product.signal_word IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'signal_word');
      ELSE
        v_skipped := array_append(v_skipped, 'signal_word');
        v_new_sw  := v_product.signal_word; -- keep existing
      END IF;
    END IF;
    -- rei_hours
    IF v_new_rei IS NOT NULL THEN
      IF v_product.rei_hours IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'rei_hours');
      ELSE
        v_skipped := array_append(v_skipped, 'rei_hours');
        v_new_rei := v_product.rei_hours;
      END IF;
    END IF;
    -- phi_days
    IF v_new_phi IS NOT NULL THEN
      IF v_product.phi_days IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'phi_days');
      ELSE
        v_skipped := array_append(v_skipped, 'phi_days');
        v_new_phi := v_product.phi_days;
      END IF;
    END IF;
    -- epa_registration
    IF v_new_epa IS NOT NULL THEN
      IF v_product.epa_registration IS NULL OR p_force_overwrite THEN
        v_applied := array_append(v_applied, 'epa_registration');
      ELSE
        v_skipped := array_append(v_skipped, 'epa_registration');
        v_new_epa := v_product.epa_registration;
      END IF;
    END IF;
    -- max_label_rate + max_label_rate_unit (ATOMIC PAIR — only ever written TOGETHER, from ONE source.
    -- A one-sided draft (rate without unit, or unit without rate) is never partially applied, so a new
    -- unit can never glue onto an old rate (or vice versa), even under force-overwrite.)
    IF v_new_mlr IS NOT NULL OR v_new_mlru IS NOT NULL THEN
      IF v_new_mlr IS NOT NULL AND v_new_mlru IS NOT NULL
         AND ((v_product.max_label_rate IS NULL AND v_product.max_label_rate_unit IS NULL) OR p_force_overwrite) THEN
        -- both sides present AND (target pair empty OR explicit force): apply the pair together
        v_applied := array_append(v_applied, 'max_label_rate');
        v_applied := array_append(v_applied, 'max_label_rate_unit');
      ELSE
        -- one-sided draft, OR target pair non-empty without force: skip the pair, keep the existing pair intact
        IF v_new_mlr  IS NOT NULL THEN v_skipped := array_append(v_skipped, 'max_label_rate'); END IF;
        IF v_new_mlru IS NOT NULL THEN v_skipped := array_append(v_skipped, 'max_label_rate_unit'); END IF;
        v_new_mlr  := v_product.max_label_rate;       -- revert BOTH to existing so the stored pair stays consistent
        v_new_mlru := v_product.max_label_rate_unit;
      END IF;
    END IF;

    -- Write to products
    UPDATE products
    SET
      signal_word         = COALESCE(v_new_sw,   signal_word),
      rei_hours           = COALESCE(v_new_rei,  rei_hours),
      phi_days            = COALESCE(v_new_phi,  phi_days),
      epa_registration    = COALESCE(v_new_epa,  epa_registration),
      max_label_rate      = COALESCE(v_new_mlr,  max_label_rate),
      max_label_rate_unit = COALESCE(v_new_mlru, max_label_rate_unit),
      updated_at          = now()
    WHERE id = v_draft.product_id;
  END IF;

  -- Mark draft as decided
  UPDATE product_label_drafts
  SET status      = p_decision,
      reviewed_by  = v_user_id,
      reviewed_at  = now(),
      -- If edited, store the final values that were written
      signal_word          = CASE WHEN p_decision = 'edited' THEN p_signal_word         ELSE signal_word         END,
      rei_hours            = CASE WHEN p_decision = 'edited' THEN p_rei_hours            ELSE rei_hours            END,
      phi_days             = CASE WHEN p_decision = 'edited' THEN p_phi_days             ELSE phi_days             END,
      epa_registration     = CASE WHEN p_decision = 'edited' THEN p_epa_registration    ELSE epa_registration     END,
      max_label_rate       = CASE WHEN p_decision = 'edited' THEN p_max_label_rate      ELSE max_label_rate       END,
      max_label_rate_unit  = CASE WHEN p_decision = 'edited' THEN p_max_label_rate_unit ELSE max_label_rate_unit  END
  WHERE id = p_draft_id;

  v_result := jsonb_build_object(
    'draft_id',   p_draft_id,
    'product_id', v_draft.product_id,
    'decision',   p_decision,
    'applied',    to_jsonb(v_applied),
    'skipped',    to_jsonb(v_skipped)
  );

  -- Store idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'commit_label_draft', v_result)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────
-- 6. RPC: get_label_coverage_report
--    Returns per-field coverage counts across all active products.
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_label_coverage_report()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_total   int;
  v_result  jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  SELECT count(*) INTO v_total FROM products WHERE is_active = true;

  SELECT jsonb_build_object(
    'total_active_products', v_total,
    'signal_word',       (SELECT count(*) FROM products WHERE is_active = true AND signal_word      IS NOT NULL),
    'rei_hours',         (SELECT count(*) FROM products WHERE is_active = true AND rei_hours        IS NOT NULL),
    'phi_days',          (SELECT count(*) FROM products WHERE is_active = true AND phi_days         IS NOT NULL),
    'epa_registration',  (SELECT count(*) FROM products WHERE is_active = true AND epa_registration IS NOT NULL),
    'max_label_rate',    (SELECT count(*) FROM products WHERE is_active = true AND max_label_rate   IS NOT NULL),
    'pending_drafts',    (SELECT count(*) FROM product_label_drafts WHERE status = 'pending'),
    'accepted_drafts',   (SELECT count(*) FROM product_label_drafts WHERE status IN ('accepted','edited')),
    'rejected_drafts',   (SELECT count(*) FROM product_label_drafts WHERE status = 'rejected'),
    'needs_manual',      (SELECT count(*) FROM product_label_drafts WHERE status = 'needs_manual')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────
-- 7. RPC: bulk_create_label_drafts
--    Creates drafts for multiple products from a JSON array.
--    Each element: { product_id, signal_word?, rei_hours?, phi_days?,
--                    epa_registration?, max_label_rate?, max_label_rate_unit?,
--                    source_note?, confidence?, status? }
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bulk_create_label_drafts(
  p_drafts          jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_cached   jsonb;
  v_item     jsonb;
  v_ids      uuid[] := '{}';
  v_draft_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation       = 'bulk_create_label_drafts';
    IF FOUND THEN RETURN v_cached; END IF;
  END IF;

  FOR v_item IN SELECT jsonb_array_elements(p_drafts)
  LOOP
    INSERT INTO product_label_drafts (
      product_id, signal_word, rei_hours, phi_days, epa_registration,
      max_label_rate, max_label_rate_unit,
      source_note, confidence, status, created_by, run_idempotency_key
    ) VALUES (
      (v_item->>'product_id')::uuid,
      v_item->>'signal_word',
      (v_item->>'rei_hours')::integer,
      (v_item->>'phi_days')::integer,
      v_item->>'epa_registration',
      (v_item->>'max_label_rate')::numeric,
      v_item->>'max_label_rate_unit',
      COALESCE(v_item->>'source_note', ''),
      COALESCE(v_item->>'confidence', 'low'),
      COALESCE(v_item->>'status', 'pending'),
      v_user_id,
      p_idempotency_key
    )
    RETURNING id INTO v_draft_id;
    v_ids := array_append(v_ids, v_draft_id);
  END LOOP;

  DECLARE
    v_result jsonb := jsonb_build_object('draft_ids', to_jsonb(v_ids), 'count', array_length(v_ids, 1));
  BEGIN
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO idempotency_keys (idempotency_key, operation, result)
      VALUES (p_idempotency_key, 'bulk_create_label_drafts', v_result)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN v_result;
  END;
END;
$$;

-- SECURITY DEFINER funcs: revoke the implicit PUBLIC/anon EXECUTE FIRST, then grant ONLY authenticated.
-- (Postgres leaves EXECUTE on PUBLIC by default; the in-body admin gate is the real guard, but per CRX
--  convention anon must be off the SECDEF surface so the security advisor stays clean.)
REVOKE EXECUTE ON FUNCTION create_label_draft        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION commit_label_draft        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION get_label_coverage_report FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION bulk_create_label_drafts  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION create_label_draft        TO authenticated;
GRANT  EXECUTE ON FUNCTION commit_label_draft        TO authenticated;
GRANT  EXECUTE ON FUNCTION get_label_coverage_report TO authenticated;
GRANT  EXECUTE ON FUNCTION bulk_create_label_drafts  TO authenticated;
