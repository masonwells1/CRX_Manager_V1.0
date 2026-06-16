-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARKED MIGRATION — NOT YET APPLIED. Awaiting Mason's approval.            ║
-- ║ Nightly Debug Mission · Cycle 4 · 2026-06-16                              ║
-- ║ Finding: delivery:enforce_delivery_items_parent_lock:terminal-states      ║
-- ║ Severity: MEDIUM (cancelled/voided deliveries' items remain writable)     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHAT'S WRONG (verified live, project rhyzpcqhnizqbxphqdkr):
--   _enforce_delivery_items_parent_lock raises DELIVERY_ITEMS_LOCKED only when the parent
--   delivery status IS IN ('in_progress','completed'). CLAUDE.md's documented rule is that
--   delivery items are editable ONLY while 'scheduled' and "locked once in_progress or beyond"
--   — and "beyond" includes the terminal states 'cancelled' and 'voided'. The current trigger
--   leaves those items writable. Combined with RLS (del_items_insert / del_items_delete WITH
--   CHECK/USING is_admin() OR is_sales_rep()), a sales_rep can directly INSERT or DELETE
--   delivery_items on a cancelled/voided delivery via PostgREST, corrupting the historical
--   record and any reporting over those items. (del_items_update is admin-only, which limits
--   blast radius to insert/delete.)
--
-- THE FIX (reproduces the live function verbatim except the two status checks):
--   Broaden both `IF v_status IN ('in_progress','completed')` to
--   `IF v_status IS NOT NULL AND v_status <> 'scheduled'` — i.e. block item writes whenever the
--   parent is in any non-scheduled (incl. terminal) state. The legitimate RPC paths
--   (complete_delivery, cancel_delivery, void_delivery) all set app.admin_override, which the
--   trigger honors at the top (early RETURN), so they are unaffected; only out-of-band direct
--   writes on non-scheduled deliveries are blocked. The IS NOT NULL guard keeps a missing/
--   not-yet-visible parent from spuriously raising.
--
-- VALIDATION: compiled against the live schema inside a rolled-back transaction (VALIDATION_OK).
--
-- ROLLBACK: re-apply the prior definition (the two checks back to IN ('in_progress','completed')).

CREATE OR REPLACE FUNCTION public._enforce_delivery_items_parent_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF _is_admin_override() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO v_status FROM deliveries WHERE id = OLD.delivery_id;
    IF v_status IS NOT NULL AND v_status <> 'scheduled' THEN
      RAISE EXCEPTION
        'DELIVERY_ITEMS_LOCKED: cannot % delivery items on a % delivery (items are editable only while scheduled)',
        lower(TG_OP), v_status;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_status FROM deliveries WHERE id = NEW.delivery_id;
    IF v_status IS NOT NULL AND v_status <> 'scheduled' THEN
      RAISE EXCEPTION
        'DELIVERY_ITEMS_LOCKED: cannot % delivery items on a % delivery (items are editable only while scheduled)',
        lower(TG_OP), v_status;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
