-- 20260629170000_unpost_invoice_group.sql
--
-- FIELD-APP PARITY remediation (Wave 2a, FIX 4 — P2 MONEY-LIFECYCLE).
-- OWNER DECISION: split-invoice UNPOST is ALL-OR-NOTHING.
--
-- THE BUG:
--   unpost_invoice (20260625130000) is single-invoice. The UI unpost of a SPLIT group
--   looped the members in JavaScript, each its own RPC/transaction — so a mid-loop
--   failure (e.g. one member is paid, or in a closed period) left the group HALF-
--   unposted: some members back to 'unposted', the failing one still 'posted'. A split
--   group must move as a unit.
--
-- THE FIX — unpost_invoice_group: the group-level inverse of post_invoice_group
-- (20260429140635 lineage), modeled on it EXACTLY:
--   * same role gate (active admin OR sales_rep on auth.uid()),
--   * same strict actor (p_performed_by must equal auth.uid(), else ACTOR_MISMATCH),
--   * same canonical idempotency_keys (operation='unpost_invoice_group'),
--   * SECURITY DEFINER + SET search_path = public, pg_temp,
--   * locks the group members FOR UPDATE, requires the group to be non-empty,
--   * then unposts EVERY member in ONE transaction by calling the existing
--     unpost_invoice per member (NULL idempotency key — the GROUP call owns
--     idempotency; the per-invoice guards/audit/money-guard run inline).
--   ALL-OR-NOTHING: unpost_invoice RAISES on any member it can't unpost (paid,
--   money applied, closed period, wrong status). Because they all run in this single
--   transaction, that exception propagates and the WHOLE group rolls back — nothing
--   changes. No half-unposted state is reachable.
--
-- WHICH MEMBERS: every non-deleted member of the group (matches post_invoice_group's
-- membership). A member that is NOT posted/overdue makes unpost_invoice raise
-- 'nothing to unpost', which (correctly) aborts the whole group — the caller should only
-- invoke this when the group is posted. (The UI only shows Unpost when posted/overdue
-- members exist, and routes to it for a group; a group with mixed states is an honest
-- error, not a silent partial.)
--
-- GRANTS: anon revoked; authenticated + service_role (mirrors post_invoice_group /
-- unpost_invoice). The in-body role gate is the real boundary. Single overload
-- (verified: no existing unpost_invoice_group). Em-dashes below are real U+2014.

CREATE OR REPLACE FUNCTION public.unpost_invoice_group(
  p_invoice_group_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_inv            record;
  v_unposted_ids   uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to unpost invoice groups';
  END IF;

  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'unpost_invoice_group';
    IF v_existing IS NOT NULL THEN
      -- Replay-safety: only return a cached result that belongs to the SAME group
      -- (the page-level idempotency key persists across navigations; if group A's call
      -- succeeded but the client timed out before reset and the user then unposts group
      -- B under the SAME key, a blind replay would report A's success while B stays
      -- posted). Refuse a mismatched replay with an honest error instead of a silent
      -- wrong-group success (Codex).
      IF (v_existing->>'invoice_group_id') IS DISTINCT FROM p_invoice_group_id::text THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: this key was already used for a different invoice group';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock the group's members for the duration of the transaction.
  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL;
  IF v_member_count = 0 THEN RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id; END IF;

  -- Unpost EVERY member in this single transaction. unpost_invoice enforces, per member,
  -- the status/money/closed-period guards and writes the append-only audit row; if ANY
  -- member cannot be unposted it RAISES and the whole transaction rolls back (all-or-nothing).
  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL ORDER BY invoice_number
  LOOP
    PERFORM unpost_invoice(v_inv.id, p_performed_by, NULL);
    v_unposted_ids := array_append(v_unposted_ids, v_inv.id);
    v_total_cents := v_total_cents + COALESCE(v_inv.total_amount_cents, 0);
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_unposted',
          'Unposted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_unposted_ids[1]);

  v_result := jsonb_build_object(
    'success',              true,
    'unposted_invoice_ids', to_jsonb(v_unposted_ids),
    'invoice_group_id',     p_invoice_group_id,
    'total_unposted_cents', v_total_cents,
    'member_count',         v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'unpost_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.unpost_invoice_group(uuid, uuid, text) IS
  'Field-app FIX 4 (Wave 2a): ALL-OR-NOTHING group inverse of post_invoice_group. '
  'Unposts every member of a split invoice group in ONE transaction via unpost_invoice; '
  'if any member can''t unpost (paid/money-applied/closed-period/wrong-status) the whole '
  'call RAISES and rolls back. Admin/sales_rep, strict-actor, idempotent, SECDEF.';
