-- P1-C (review 2026-05-29): release inventory holds when a planned quote is cancelled.
--
-- APPLIED LIVE 2026-05-30 as version 20260530020514 (from branch
-- fix/review-2026-05-29, cherry-picked to main). File renamed to the applied
-- version stamp per the B7 rule so tooling never re-applies it.
--
-- Bug: release_holds_on_quote_status_change fired only when a quote moved into
-- ('accepted','declined','expired'). But the quote state machine also allows
-- draft/sent/revised -> cancelled (verified live 2026-05-29: the trigger body
-- omits 'cancelled'). A planned quote (is_planned=true) reserves inventory via
-- inventory_holds linked by source_id; cancelling it left those holds
-- is_active=true forever — phantom reservations that silently shrink Net Free
-- inventory and can block real sales. Latent today (0 orphaned holds in prod),
-- but one quote-cancel away. Violates the documented rule: "Voided/declined/
-- expired/cancelled paths must release inventory holds."
--
-- Fix: add 'cancelled' to both the NEW.status entry-set and the OLD.status
-- exclusion-set so a transition INTO cancelled releases the holds exactly once.
-- Body otherwise reproduced verbatim from the live definition.

CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_released_count integer := 0;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired', 'cancelled')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired', 'cancelled') THEN
    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count > 0 THEN
      INSERT INTO public.activity_feed (event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id)
      VALUES ('inventory_holds_released',
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')',
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
