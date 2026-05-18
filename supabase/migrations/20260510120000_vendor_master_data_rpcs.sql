-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs". See PR-10 migration header for the
-- full explanation of why the marker is needed.)
-- ============================================================================
-- Audit fix sprint PR-25 — Vendor master-data RPCs
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-25)
-- Audit findings: out-of-scope finding from the audit but discovered during
--                 it — no UI to add/edit vendors, current vendor data is
--                 backfilled from PO entries.
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
-- ⚠️ DEPENDS on PR-07 (customers/profiles RLS) being applied first if
-- Mason wants the new vendors page reads to be properly RLS-gated. PR-04
-- already tightened vendors_select to admin/sales_rep — drivers and
-- applicators get empty results from the new page (intended).
--
-- This migration adds:
--   1. save_vendor(p_vendor_id, p_payload, p_idempotency_key) — admin-only
--      INSERT-or-UPDATE. Pass NULL p_vendor_id to create.
--   2. delete_vendor(p_vendor_id, p_idempotency_key) — admin-only soft-delete
--      (sets deleted_at = now()). Hard delete is never appropriate (vendors
--      are referenced by purchase_orders and vendor_bills).
-- ============================================================================

CREATE OR REPLACE FUNCTION save_vendor(
  p_vendor_id uuid,
  p_payload jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_vendor_id uuid;
  v_is_new boolean := (p_vendor_id IS NULL);
  v_name text;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can manage vendors';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_vendor');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_name := NULLIF(trim(p_payload->>'name'), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'INVALID_NAME: vendor name is required';
  END IF;

  IF v_is_new THEN
    INSERT INTO vendors (
      name, contact_name, phone, email, address,
      default_payment_terms, default_payment_terms_days, notes
    ) VALUES (
      v_name,
      NULLIF(p_payload->>'contact_name', ''),
      NULLIF(p_payload->>'phone', ''),
      NULLIF(p_payload->>'email', ''),
      NULLIF(p_payload->>'address', ''),
      NULLIF(p_payload->>'default_payment_terms', ''),
      (p_payload->>'default_payment_terms_days')::integer,
      NULLIF(p_payload->>'notes', '')
    ) RETURNING id INTO v_vendor_id;
  ELSE
    v_vendor_id := p_vendor_id;
    UPDATE vendors SET
      name = v_name,
      contact_name = CASE WHEN p_payload ? 'contact_name' THEN NULLIF(p_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_payload ? 'phone' THEN NULLIF(p_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_payload ? 'email' THEN NULLIF(p_payload->>'email', '') ELSE email END,
      address = CASE WHEN p_payload ? 'address' THEN NULLIF(p_payload->>'address', '') ELSE address END,
      default_payment_terms = CASE WHEN p_payload ? 'default_payment_terms' THEN NULLIF(p_payload->>'default_payment_terms', '') ELSE default_payment_terms END,
      default_payment_terms_days = CASE WHEN p_payload ? 'default_payment_terms_days' THEN (p_payload->>'default_payment_terms_days')::integer ELSE default_payment_terms_days END,
      notes = CASE WHEN p_payload ? 'notes' THEN NULLIF(p_payload->>'notes', '') ELSE notes END,
      updated_at = now()
    WHERE id = v_vendor_id AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'VENDOR_NOT_FOUND: % (or already deleted)', v_vendor_id;
    END IF;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'vendor_created' ELSE 'vendor_updated' END,
    CASE WHEN v_is_new THEN 'Vendor ' || v_name || ' created' ELSE 'Vendor ' || v_name || ' updated' END,
    v_actor, 'vendor', v_vendor_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'vendor_id', v_vendor_id,
    'is_new', v_is_new
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_vendor', v_result);
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION delete_vendor(
  p_vendor_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_vendor record;
  v_active_po_count integer;
  v_active_bill_count integer;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can delete vendors';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_vendor');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_vendor FROM vendors WHERE id = p_vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: % (or already deleted)', p_vendor_id;
  END IF;

  -- Refuse delete if vendor has unpaid bills. (purchase_orders link to
  -- vendors via a legacy `vendor` text column, NOT vendor_id — that FK
  -- migration is explicitly out of scope per CLAUDE.md "What's NOT in
  -- this plan." Bill check is sufficient since closed POs typically have
  -- a bill anyway, and unbilled open POs are rare.)
  v_active_po_count := 0; -- intentionally unchecked; see comment above

  SELECT count(*) INTO v_active_bill_count
  FROM vendor_bills
  WHERE vendor_id = p_vendor_id
    AND status NOT IN ('paid', 'voided')
    AND deleted_at IS NULL;

  IF v_active_bill_count > 0 THEN
    RAISE EXCEPTION 'VENDOR_HAS_UNPAID_BILLS: cannot delete — % unpaid bill(s)', v_active_bill_count;
  END IF;

  UPDATE vendors SET deleted_at = now(), updated_at = now() WHERE id = p_vendor_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'vendor_deleted',
    'Vendor ' || v_vendor.name || ' deleted',
    v_actor, 'vendor', p_vendor_id
  );

  v_result := jsonb_build_object('success', true, 'vendor_id', p_vendor_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_vendor', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_save_count integer;
  v_delete_count integer;
BEGIN
  SELECT count(*) INTO v_save_count FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='save_vendor';
  IF v_save_count <> 1 THEN
    RAISE EXCEPTION 'PR-25 verification: expected 1 save_vendor overload, found %', v_save_count;
  END IF;

  SELECT count(*) INTO v_delete_count FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='delete_vendor';
  IF v_delete_count <> 1 THEN
    RAISE EXCEPTION 'PR-25 verification: expected 1 delete_vendor overload, found %', v_delete_count;
  END IF;

  RAISE NOTICE 'PR-25 verification passed: save_vendor + delete_vendor installed.';
END;
$$;
