-- ============================================================================
-- crm_set_primary_contact — atomic primary-contact promotion.
-- ----------------------------------------------------------------------------
-- Promotes exactly one customer_contacts row to primary inside a single locked
-- transaction so the partial unique index (customer_id) WHERE is_primary can
-- never observe two primaries mid-update. The current primary is unset BEFORE
-- the target is set; both rows are locked FOR UPDATE so concurrent promotions
-- serialize on the same rows instead of racing the index. Convergent: a replay
-- (or promoting the already-primary contact) settles to the same single-primary
-- state, so no p_idempotency_key is required.
--
-- SECURITY INVOKER: the caller's own RLS (customer_contacts_update, scoped to
-- the assigned sales rep or admin) decides which contacts may be promoted — the
-- function grants no ambient authority. Additive only: it changes no existing
-- object and creates only this function.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_primary_customer_contact(
  p_customer_id uuid,
  p_contact_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_target_id uuid;
  v_current_primary_id uuid;
BEGIN
  -- Lock the target row first. A missing row (wrong customer, or not visible
  -- under the caller's RLS) is a hard error, not a silent no-op.
  SELECT id INTO v_target_id
  FROM public.customer_contacts
  WHERE customer_id = p_customer_id
    AND id = p_contact_id
  FOR UPDATE;

  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'CONTACT_NOT_FOUND';
  END IF;

  -- Lock the existing primary (if any, and different from the target) before
  -- mutating so two concurrent promotions serialize here.
  SELECT id INTO v_current_primary_id
  FROM public.customer_contacts
  WHERE customer_id = p_customer_id
    AND is_primary
    AND id <> p_contact_id
  FOR UPDATE;

  -- Unset the old primary BEFORE setting the new one: the partial unique index
  -- on (customer_id) WHERE is_primary forbids two primaries even momentarily.
  IF v_current_primary_id IS NOT NULL THEN
    UPDATE public.customer_contacts
    SET is_primary = false
    WHERE id = v_current_primary_id;
  END IF;

  UPDATE public.customer_contacts
  SET is_primary = true,
      is_active = true
  WHERE id = p_contact_id;

  RETURN jsonb_build_object('success', true, 'contact_id', p_contact_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_customer_contact(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_primary_customer_contact(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_primary_customer_contact(uuid, uuid) IS
  'Atomically promotes one customer contact to primary (unset old, then set target) under the caller''s RLS; convergent, so replays settle to the same single-primary state.';
