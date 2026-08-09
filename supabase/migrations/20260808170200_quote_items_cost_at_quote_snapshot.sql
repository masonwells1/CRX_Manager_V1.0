-- 20260808170200 — quote_items.cost_at_quote_cents snapshot (quote-time cost drift)
--
-- Defect: a quote's line cost drifts after the quote is written. save_quote's
-- recompute CTE priced cc from LIVE products.current_cost on EVERY save, and the
-- QuoteBuilder recalc overwrote a loaded line's cost with the live catalog cost.
-- So editing an old quote (fix a note, change acres) silently repriced its cost,
-- profit, and net_margin at TODAY's cost — and convert_quote_to_order then copied
-- that drifted current_cost into order_items.cost_per_unit. The quote no longer
-- answered "what did we expect to pay when we quoted this?".
--
-- Fix (mirrors order_items.cost_at_time_cents, migration 20260513050000):
--   1. Add `cost_at_quote_cents bigint NULL` to quote_items (immutable snapshot).
--   2. BEFORE INSERT trigger stamps ROUND(products.current_cost * 100)
--      UNCONDITIONALLY, ignoring any client-supplied value (a direct PostgREST
--      INSERT is rep-reachable via the qitems_insert RLS policy, so a supplied
--      value is untrusted). The ONLY exception: when the transaction-local
--      setting crx.quote_cost_snapshot_passthrough = '1' (settable only inside
--      a server-side transaction — save_quote sets it; PostgREST clients
--      cannot) AND a non-NULL value was supplied, the supplied value passes
--      through. NULL remains only when products.current_cost is NULL.
--   3. Backfill existing rows from ROUND(current_cost * 100) — current_cost is
--      the per-line numeric-dollars cost those quotes actually priced with.
--      Known edge: a legacy row with NULL current_cost stays NULL, and the
--      immutability guard below then blocks any later in-place repair — fixing
--      such a row requires a new migration that drops/recreates the guard.
--   4. CREATE OR REPLACE save_quote (base: 20260730235031, replicated in full):
--      save_quote delete+reinserts quote_items, which would wipe the snapshot on
--      every save. Before the DELETE it captures the prior lines keyed STRICTLY
--      by quote_item id, each carrying its product_id; a reinserted row keeps a
--      preserved snapshot only when the payload echoes a prior item id AND that
--      prior item's product_id equals the payload row's product_id (an id echo
--      cannot attach another line's snapshot to a different product).
--
--      PRODUCT FALLBACK (Codex round 11-13). When the id does NOT resolve, the
--      row falls back to the first unconsumed prior line of the SAME quote and
--      SAME product, consuming each prior row at most once. Every valid echoed
--      id is RESERVED in a pass over the whole payload FIRST, so payload order
--      cannot decide which line keeps its snapshot: without that, changing a
--      line from product A to B on a quote that already holds B let the changed
--      row claim the existing B row's id and cost whenever it happened to be
--      processed first, leaving the real B row with a fresh stamp. This covers a
--      pre-snapshot browser bundle (sends no ids at all) and a current page that
--      cleared the id of a product-swapped line. Two earlier attempts to detect
--      a stale caller instead were both wrong and are recorded here so they are
--      not retried: counting echoed ids refused a legitimate replace-every-line
--      save with no way for the operator to recover, and a caller-declared
--      capability flag was forgeable — a rep could set it, omit every id, and
--      have unchanged lines re-stamped at today's (possibly lower) catalog cost.
--      The fallback is not forgeable: the map is built only inside the
--      owner-checked existing-quote branch and scoped to this quote, so the only
--      cost a caller can inherit is one this quote already recorded for that
--      product. Trade-off accepted: when a payload adds a genuinely new line for
--      a product already on the quote, one of the two lines inherits the prior
--      snapshot rather than getting a fresh stamp. Both are the same product on
--      the same quote, so the value is honest; the alternative designs were a
--      lock-out and a forgery vector. Lines with no prior match still insert
--      NULL and the trigger stamps today's cost.
--      (QuoteBuilder sends each loaded line's database id — see QuoteBuilder.tsx.)
--
--      ID REUSE (Codex P1-A). The reinserted row REUSES the echoed quote_item
--      uuid whenever that id+product match holds, instead of generating a fresh
--      one. QuoteBuilder does NOT refetch after save (handleSaveDraft calls
--      saveQuote and never re-runs fetchQuote), so without reuse the ids held
--      by the still-open page go stale on the FIRST save; the SECOND save from
--      that page would echo dead ids, the id-keyed preservation would miss, and
--      the trigger would re-stamp today's catalog cost — silently breaking the
--      immutable quote-time cost. With reuse, client-held ids stay valid across
--      unlimited saves with no refetch. Rows with no valid echoed id still get
--      gen_random_uuid(). The capture map now includes prior rows whose snapshot
--      is NULL too, so their ids are stable as well (their cost stays NULL and
--      the trigger stamps it).
--
--      CONSUME-ONCE (Codex P1-B). Each prior id may be claimed by at most one
--      payload row. A payload that repeats ANY id within one save raises
--      'QUOTE_ITEM_ID_DUPLICATE' before the INSERT — otherwise one legitimate
--      prior id could copy a single old snapshot onto arbitrarily many new lines
--      of the same product. The explicit check fires FIRST so the caller gets a
--      clear domain error rather than the primary-key violation that id reuse
--      would otherwise produce.
--      The recompute CTE now prices cc from the snapshot:
--        cc = COALESCE(qi.cost_at_quote_cents / 100.0, p.current_cost, 0)
--      and still writes current_cost = f.cc, so current_cost becomes
--      snapshot-valued and every legacy reader (quote totals, quoteCalc,
--      convert_quote_to_order's qi.current_cost -> cost_per_unit copy) now
--      carries quote-time cost with no interface change. profit/net_margin are
--      recomputed from the same cc exactly as before.
--   Signature, guards, row-version contract, idempotency, and grants of
--   save_quote are unchanged.
--
-- convert_quote_to_order (20260702172500 impl) needs NO change: it copies
-- qi.current_cost into order_items.cost_per_unit, which is now the quote-time
-- snapshot — the intended behavior.

ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS cost_at_quote_cents bigint;

COMMENT ON COLUMN public.quote_items.cost_at_quote_cents IS
  'Immutable snapshot of products.current_cost (in cents, rounded) at the moment this line was first quoted. Preserved across save_quote''s delete+reinsert; NULL only when the product''s current_cost is NULL at stamp time. Populated automatically by trg_snapshot_quote_item_cost.';

CREATE OR REPLACE FUNCTION public._snapshot_quote_item_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ANTI-FORGERY: stamp from products UNCONDITIONALLY, discarding any
  -- client-supplied value. The qitems_insert RLS policy lets a rep INSERT
  -- quote_items directly via PostgREST (delete+reinsert a line), so an
  -- IF-NULL-only fill would let them supply cost 0 and inflate margin.
  -- The single trusted exception: save_quote (SECURITY DEFINER) marks its
  -- transaction with the txn-local setting crx.quote_cost_snapshot_passthrough
  -- = '1' (set_config(..., true)) before reinserting lines; PostgREST callers
  -- have no way to set a transaction-local GUC, so only the RPC's preserved
  -- quote-time values pass through. NULL remains only when
  -- products.current_cost is NULL at stamp time.
  IF current_setting('crx.quote_cost_snapshot_passthrough', true) = '1'
     AND NEW.cost_at_quote_cents IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT ROUND(current_cost * 100)::bigint INTO NEW.cost_at_quote_cents
  FROM public.products WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$;

-- Trigger-only helper: default privileges grant new public functions to API
-- roles; strip callable application roles (same pattern as bump_record_row_version).
-- caller-analysis: _snapshot_quote_item_cost :: brand-new trigger-only helper created in this migration; no rpc callsites exist, trigger execution does not require caller EXECUTE.
REVOKE ALL ON FUNCTION public._snapshot_quote_item_cost() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_snapshot_quote_item_cost ON public.quote_items;
CREATE TRIGGER trg_snapshot_quote_item_cost
  BEFORE INSERT ON public.quote_items
  FOR EACH ROW
  EXECUTE FUNCTION public._snapshot_quote_item_cost();

-- Backfill BEFORE the immutability guard exists: existing lines snapshot the
-- cost they actually quoted with (current_cost numeric dollars -> cents).
-- Ground truth for historical margin. (Ordering matters: the guard below
-- rejects any change to cost_at_quote_cents, including this NULL -> value
-- fill, so the backfill must run first.)
UPDATE public.quote_items
   SET cost_at_quote_cents = ROUND(current_cost * 100)::bigint
 WHERE cost_at_quote_cents IS NULL
   AND current_cost IS NOT NULL;

-- Immutability guard: the snapshot is server-trusted (save_quote's recompute
-- reads it), and RLS lets a quote's owning sales_rep UPDATE quote_items rows
-- directly via PostgREST. Without this guard a rep could zero the snapshot on
-- their own quote and inflate stored margin. Only the RPC path (which runs as
-- the function owner via SECURITY DEFINER save_quote) legitimately rewrites
-- rows, and it does so by delete+reinsert — a direct UPDATE changing the
-- snapshot is always illegitimate.
CREATE OR REPLACE FUNCTION public._guard_quote_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.cost_at_quote_cents IS DISTINCT FROM OLD.cost_at_quote_cents THEN
    RAISE EXCEPTION 'QUOTE_ITEM_COST_SNAPSHOT_IMMUTABLE: cost_at_quote_cents cannot be changed after the line is created'
      USING ERRCODE = 'P0001';
  END IF;
  -- Swapping product_id on an existing row would leave the previous product's
  -- cost snapshot attached to a different product — a cheap snapshot on an
  -- expensive product inflates stored margin just as effectively as editing the
  -- snapshot directly, and the immutability check above would not catch it.
  -- save_quote never UPDATEs product_id (a product swap is a delete+reinsert,
  -- and the id-reuse path only reuses an id when product_id matches), so any
  -- direct UPDATE changing it is the RLS-policy path and is always illegitimate.
  IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'QUOTE_ITEM_PRODUCT_IMMUTABLE: product_id cannot be changed on an existing quote line; save the quote to replace the line instead'
      USING ERRCODE = 'P0001';
  END IF;
  -- Re-parenting a line is the same attack as editing the snapshot, one step
  -- removed. A rep who owns an old quote with a cheap snapshot and a newer
  -- quote holding the same product could move the old row across via the
  -- qitems_update RLS policy; save_quote would then see a known id on the
  -- target quote with a matching product and faithfully preserve the stale
  -- cost, inflating quote, order and commission profit. save_quote never
  -- UPDATEs quote_id or section_id -- it delete+reinserts -- so any direct
  -- UPDATE that moves a line is illegitimate.
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    RAISE EXCEPTION 'QUOTE_ITEM_QUOTE_IMMUTABLE: a quote line cannot be moved to a different quote'
      USING ERRCODE = 'P0001';
  END IF;
  -- section_id may move between sections of the SAME quote (a legitimate
  -- reorder), but never into a section belonging to another quote, which would
  -- carry the line across by the back door.
  IF NEW.section_id IS DISTINCT FROM OLD.section_id
     AND NEW.section_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.quote_sections qs
        WHERE qs.id = NEW.section_id
          AND qs.quote_id = NEW.quote_id
     ) THEN
    RAISE EXCEPTION 'QUOTE_ITEM_SECTION_FOREIGN: section_id must belong to the same quote as the line'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- caller-analysis: _guard_quote_item_cost_snapshot :: trigger-only guard created in this migration; no rpc callsites; trigger execution does not require caller EXECUTE.
REVOKE ALL ON FUNCTION public._guard_quote_item_cost_snapshot() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_quote_item_cost_snapshot ON public.quote_items;
CREATE TRIGGER trg_guard_quote_item_cost_snapshot
  BEFORE UPDATE ON public.quote_items
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_quote_item_cost_snapshot();

-- save_quote: verbatim 20260730235031 body except the marked
-- SNAPSHOT<<< ... >>>SNAPSHOT blocks (capture, reinsert column, recompute cc).
CREATE OR REPLACE FUNCTION public.save_quote(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_quote_owner uuid;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
  v_tier int;
  v_server_totals record;
  v_drawn_guard record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  v_cached_quote_id uuid;
  v_cached_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_request_fingerprint text;
  -- SNAPSHOT<<< prior-item cost map (id -> {p: product_id, c: cost}) captured
  -- before the delete+reinsert. Strictly id-keyed; no product_id fallback.
  v_prior_item_costs jsonb := '{}'::jsonb;
  -- Ids already claimed by an earlier payload row in THIS save. Each prior id
  -- may be consumed at most once (P1-B); a repeat is a hard domain error.
  v_consumed_item_ids jsonb := '{}'::jsonb;
  -- Per-row scratch for the reinsert loop.
  v_payload_item_id text;
  v_reuse_item_id uuid;
  v_preserved_cost bigint;
  v_consumed_prior_ids jsonb := '{}'::jsonb;
  v_fallback_prior_id text;
  -- >>>SNAPSHOT
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  v_request_fingerprint := md5(jsonb_build_object(
    'quote_id', p_quote_id,
    'quote_payload', p_quote_payload,
    'sections', p_sections,
    'performed_by', p_performed_by
  )::text);

  -- Quote ownership is checked before the idempotency lookup so a SECURITY
  -- DEFINER replay cannot expose another rep's result. The check is deliberately
  -- non-locking here: every idempotent Quote writer must take the advisory lock
  -- before any Quote row lock. Ownership is checked again under the later row
  -- lock before a replay return or direct mutation.
  IF p_quote_id IS NOT NULL
     AND NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM quotes
       WHERE id = p_quote_id
         AND created_by = v_actor
     ) THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN
      -- A create replay has no p_quote_id to authorize before the lookup, so
      -- bind the cached result to its real target before releasing it. Existing
      -- saves must also reject a key cached for a different quote.
      v_cached_quote_id := NULLIF(v_existing->>'quote_id', '')::uuid;
      IF v_cached_quote_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      IF p_quote_id IS NOT NULL
         AND p_quote_id IS DISTINCT FROM v_cached_quote_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF NOT public.is_admin()
         AND NOT EXISTS (
           SELECT 1 FROM quotes
           WHERE id = v_cached_quote_id
             AND created_by = v_actor
      ) THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF jsonb_typeof(v_existing->'row_version') <> 'number'
         OR (v_existing->>'row_version') !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      v_cached_row_version := (v_existing->>'row_version')::bigint;
      SELECT created_by, row_version
        INTO v_quote_owner, v_old_row_version
      FROM quotes
      WHERE id = v_cached_quote_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_old_row_version IS DISTINCT FROM v_cached_row_version THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- LAYER2-COORD (#5): lock the quote row up front (FOR UPDATE) so the unplan
    -- guard's job_product_draws check below can't be raced by a concurrent job
    -- schedule (_sync_quote_job_reservations locks the same row FOR UPDATE, so
    -- the two serialize). Was: SELECT status ... WHERE id = p_quote_id;
    SELECT created_by, status, commission_split, row_version
      INTO v_quote_owner, v_old_status, v_old_commission_split, v_old_row_version
    FROM quotes WHERE id = p_quote_id FOR UPDATE;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;
    IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'NOT_QUOTE_OWNER';
    END IF;

    -- Lost-update guard (2026-07-22): when the client passes the split it
    -- originally loaded (commission_split_expected), reject a split overwrite
    -- if a different value landed in between (stale-tab last-write-wins).
    -- Callers that omit commission_split_expected behave exactly as before.
    IF p_quote_payload ? 'commission_split_expected'
       AND p_quote_payload->'commission_split' IS NOT NULL
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_quote_payload->'commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_quote_payload->'commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this quote''s commission split was changed elsewhere after you opened it — reload the quote and re-apply your change';
    END IF;

    IF NOT (p_quote_payload ? 'row_version_expected')
       OR jsonb_typeof(p_quote_payload->'row_version_expected') <> 'number'
       OR (p_quote_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;
    v_expected_row_version := (p_quote_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;

    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    -- LAYER2<<< block unplanning a booking a scheduled job is still drawing from
    -- (Codex final push-gate P1 #1): if is_planned would become false while a live
    -- job_product_draws row exists for this quote, the UPDATE below + trailing
    -- _sync_planned_holds release the quote's crop_program holds, and the next job
    -- re-sync drops the draw (quote no longer planned-open) — reopening the full
    -- booking balance while the job still consumes the stock (double-count). Clear the
    -- job reservation via the job lifecycle (cancel/reschedule) before unplanning.
    IF COALESCE((p_quote_payload->>'is_planned')::boolean,
                (SELECT is_planned FROM quotes WHERE id = p_quote_id)) = false
       AND EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = p_quote_id AND quantity_drawn > 0
       ) THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION: cannot unplan this booking — a scheduled job is still reserving product from it; cancel or reschedule the job first';
    END IF;
    -- >>>LAYER2

    v_quote_id := p_quote_id;

    -- SNAPSHOT<<< capture the existing lines' immutable quote-time costs BEFORE
    -- the delete+reinsert wipes them. One map, keyed strictly by quote_item id,
    -- each entry carrying the prior line's product_id so the reinsert can
    -- require id AND product to match (an echoed id cannot attach another
    -- line's snapshot to a different product). Deliberately NO product_id
    -- fallback: a genuinely new line for a product already on the quote must
    -- get today's cost from the trigger, not inherit an old snapshot.
    -- The map also drives ID REUSE (P1-A), so it deliberately includes rows
    -- whose cost_at_quote_cents is NULL: their id must stay stable too (their
    -- 'c' is JSON null, so the reinsert passes NULL and the trigger stamps).
    SELECT COALESCE(
             jsonb_object_agg(
               id::text,
               jsonb_build_object('p', product_id::text, 'c', cost_at_quote_cents)
             ),
             '{}'::jsonb)
      INTO v_prior_item_costs
    FROM quote_items
    WHERE quote_id = v_quote_id;

    -- RESERVATION PASS (Codex round 13). Every valid echoed id must be claimed
    -- BEFORE any id-less row is allowed to take a product fallback, because the
    -- payload order is not controlled by us. Changing a line from product A to
    -- product B on a quote that already contains B clears that line's id; if the
    -- changed row happens to be processed first, a single pass would let it
    -- claim the EXISTING B row's uuid and snapshot, and the real B row -- whose
    -- echoed id is now already consumed -- would fall through to a fresh stamp
    -- at today's catalog cost. With different quantities on the two lines that
    -- silently changes stored cost, profit, the converted order and commissions.
    -- Reserving first makes the outcome independent of payload order.
    FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
    LOOP
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
      LOOP
        v_payload_item_id := NULLIF(v_item->>'id', '');
        IF v_payload_item_id IS NOT NULL
           AND v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id'
           AND NOT (v_consumed_prior_ids ? v_payload_item_id) THEN
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_payload_item_id, true);
        END IF;
      END LOOP;
    END LOOP;
    -- >>>SNAPSHOT

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, header_notes, footer_notes, is_planned, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, current_date + 15),
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- SNAPSHOT<<< arm the trigger passthrough for THIS transaction only, right
  -- before the item reinsert loop. _snapshot_quote_item_cost otherwise stamps
  -- cost_at_quote_cents unconditionally from products (anti-forgery); this
  -- txn-local GUC (is_local => true, dies at COMMIT/ROLLBACK) is the trusted
  -- signal that the non-NULL values inserted below are the preserved
  -- quote-time snapshots. Direct PostgREST inserts cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
      section_header_notes, needed_by_date, field_id
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      NULLIF(v_section->>'needed_by_date', '')::date,
      NULLIF(v_section->>'field_id', '')::uuid
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- SNAPSHOT<<< resolve this payload row's identity BEFORE the INSERT.
      -- (a) consume-once (P1-B): any id repeated within one save is rejected
      --     here, so the caller sees a clear domain error instead of the
      --     primary-key violation that id reuse (below) would raise.
      -- (b) id reuse (P1-A): when the echoed id belongs to a prior line of
      --     THIS quote and that prior line's product matches, the reinserted
      --     row keeps the same uuid, so ids the still-open QuoteBuilder page
      --     holds remain valid across repeated saves without a refetch.
      v_payload_item_id := NULLIF(v_item->>'id', '');
      v_reuse_item_id := NULL;
      v_preserved_cost := NULL;
      IF v_payload_item_id IS NOT NULL THEN
        IF v_consumed_item_ids ? v_payload_item_id THEN
          RAISE EXCEPTION 'QUOTE_ITEM_ID_DUPLICATE: quote item ids must be unique within a save'
            USING ERRCODE = 'P0001';
        END IF;
        v_consumed_item_ids := v_consumed_item_ids || jsonb_build_object(v_payload_item_id, true);
        -- No not-consumed test here: the reservation pass above already claimed
        -- this id for this payload row, and the duplicate check immediately
        -- above guarantees no second row can present the same id.
        IF v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id' THEN
          v_reuse_item_id := v_payload_item_id::uuid;
          v_preserved_cost := (v_prior_item_costs->v_payload_item_id->>'c')::bigint;
        END IF;
      END IF;

      -- SNAPSHOT<<< product fallback when the id did not resolve.
      --
      -- A browser running the pre-snapshot bundle sends no ids at all, and even
      -- a current page clears the id of a line whose product changed. Earlier
      -- attempts to detect that (counting echoed ids, then a caller-declared
      -- capability flag) were both wrong: the count locked users out of a
      -- legitimate replace-every-line save, and the flag was caller-controlled,
      -- so a rep could set it, omit every id, and have unchanged lines
      -- re-stamped at today's catalog cost -- lowering the recorded basis and
      -- inflating profit and commission whenever a product got cheaper.
      --
      -- Match on the line's OWN quote and product instead, consuming each prior
      -- row at most once. This is not forgeable: the map is built only inside
      -- the owner-checked existing-quote branch and scoped to this quote, so the
      -- only cost a caller can inherit is one this very quote already recorded
      -- for that same product. Omitting an id can therefore no longer lower a
      -- cost basis -- at worst it preserves the honest historical value.
      IF v_reuse_item_id IS NULL AND (v_item->>'product_id') IS NOT NULL THEN
        SELECT k INTO v_fallback_prior_id
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k)
        ORDER BY e.k
        LIMIT 1;

        IF v_fallback_prior_id IS NOT NULL THEN
          v_reuse_item_id := v_fallback_prior_id::uuid;
          v_preserved_cost := (v_prior_item_costs->v_fallback_prior_id->>'c')::bigint;
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_fallback_prior_id, true);
          v_fallback_prior_id := NULL;
        END IF;
      END IF;
      -- >>>SNAPSHOT
      -- >>>SNAPSHOT
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, price_override, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT: preserved value or NULL (trigger snapshots)
      ) VALUES (
        -- SNAPSHOT: reuse the echoed id when it matched a prior line of this
        -- quote (same product); otherwise mint a fresh one as before.
        COALESCE(v_reuse_item_id, gen_random_uuid()),
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        (v_item->>'price_override')::numeric,
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        COALESCE((v_item->>'profit')::numeric, 0),
        COALESCE((v_item->>'total_price')::numeric, 0),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit',
        -- SNAPSHOT<<< carry the quote-time cost across the reinsert ONLY when
        -- the payload echoes a prior item id AND that prior line's product_id
        -- equals this row's product_id (id-echo forgery cannot move a snapshot
        -- onto a different product), and only once per prior id. Resolved into
        -- v_preserved_cost above; NULL here means the BEFORE INSERT trigger
        -- stamps today's products.current_cost — correct for genuinely new or
        -- changed-product lines (and for a prior line that never snapshotted).
        v_preserved_cost
        -- >>>SNAPSHOT
      );
    END LOOP;
  END LOOP;


  -- Disarm the passthrough the moment the reinsert loop closes (defense in
  -- depth: txn-local anyway, but nothing after this point may pass a supplied
  -- snapshot through the anti-forgery trigger).
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);

  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      COALESCE(qi.price_override, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      -- SNAPSHOT<<< was: COALESCE(p.current_cost, 0). Price cost from the
      -- immutable quote-time snapshot; live catalog cost only for a row the
      -- trigger could not snapshot (product missing a cost).
      COALESCE(qi.cost_at_quote_cents / 100.0, p.current_cost, 0) AS cc,
      -- >>>SNAPSHOT
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      ROUND((ppu - cc) * total_units, 2) AS profit,
      CASE
        WHEN ppu * total_units > 0
          THEN ROUND(((ppu - cc) * total_units) / (ppu * total_units) * 100, 2)
        ELSE 0
      END AS net_margin
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- LAYER2<<< drawn-product guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1):
  -- a line can't be reduced below what an order OR a scheduled job already drew from it.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;

  SELECT
    COALESCE(SUM(total_price), 0) AS total_price,
    COALESCE(SUM(current_cost * total_units_needed), 0) AS total_cost,
    COALESCE(SUM(profit), 0) AS total_profit
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  -- One logical save must produce exactly one quote UPDATE. The row was
  -- already locked and its expected version checked before any children were
  -- replaced; combining header/status fields with the calculated totals keeps
  -- that lock order while ensuring the row-version trigger advances once.
  UPDATE quotes SET
    customer_id = (p_quote_payload->>'customer_id')::uuid,
    tier = v_tier,
    status = v_status,
    commission_split = CASE
      WHEN p_quote_payload->'commission_split' IS NOT NULL
      THEN p_quote_payload->'commission_split'
      ELSE commission_split
    END,
    valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
    expires_at = COALESCE((p_quote_payload->>'expires_at')::date, expires_at),
    header_notes = p_quote_payload->>'header_notes',
    footer_notes = p_quote_payload->>'footer_notes',
    is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
    sent_at = CASE
      WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
      WHEN v_status = 'sent' THEN sent_at
      ELSE sent_at
    END,
    total_price = v_server_totals.total_price,
    total_cost = v_server_totals.total_cost,
    total_profit = v_server_totals.total_profit,
    total_margin_pct = CASE
      WHEN v_server_totals.total_price > 0
      THEN ROUND(v_server_totals.total_profit / v_server_totals.total_price * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  INSERT INTO activity_feed (id, event_type, description, performed_by, related_entity_type, related_entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  -- LAYER2-COORD (#4): re-sync this quote's ACTIVE jobs to the edited booking,
  -- then resync crop_program holds. _sync_quote_job_reservations rebuilds every
  -- active job's draws+holds (so a grown line re-draws its job, a shrunk line
  -- reallocates siblings) and ends by calling _sync_planned_holds itself, so it
  -- is a strict superset of the prior trailing `_sync_planned_holds(v_quote_id)`
  -- (identical for a quote with no jobs). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(v_quote_id, v_actor);

  v_result := jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    '_request_fingerprint', v_request_fingerprint,
    'commission_split', (SELECT commission_split FROM quotes WHERE id = v_quote_id),
    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id),
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Self-contained ACL restatement for the re-emitted SECDEF mutator
-- (same boundary as 20260730235031: anon/PUBLIC denied, authenticated + service_role allowed).
-- caller-analysis: save_quote :: REVOKE targets only anon/PUBLIC and EXECUTE is immediately re-granted to authenticated + service_role (ACL identical to 20260730235031); both live rpc callers (src/pages/QuoteBuilder.tsx:1478 rpc save_quote, src/components/quotes/BulkQuoteImport.tsx:668) run as authenticated and are unaffected.
REVOKE EXECUTE ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_quote(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- _restore_quote_version_owner_impl: carry the version's own quote-time cost.
--
-- Base: the 4-arg body from 20260703130000, which 20260730235031 RENAMED to
-- _restore_quote_version_owner_impl and wrapped behind a 5-arg
-- restore_quote_version. Replicated verbatim except the marked SNAPSHOT blocks;
-- the public wrapper, its signature, guards, idempotency scoping and grants are
-- untouched.
--
-- The impl reinserts quote_items from the version snapshot with the historical
-- current_cost but no cost_at_quote_cents, so the trigger added by this
-- migration would stamp todays catalog cost. Nothing looks wrong immediately --
-- current_cost, profit and the header totals still read historical -- but the
-- next ordinary save preserves the stamped value and recomputes current_cost
-- from it, silently repricing the restored version at todays cost.
--
-- caller-analysis: _restore_quote_version_owner_impl :: CREATE OR REPLACE of the existing owner impl; no signature or grant change, and its only caller is the public restore_quote_version wrapper, which is unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._restore_quote_version_owner_impl(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
  v_drawn_guard record; -- drawn-version guard (20260611120100)
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = (v_snapshot->'quote'->>'total_price')::numeric,
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = (v_snapshot->'quote'->>'total_profit')::numeric,
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- SNAPSHOT<<< arm the trusted passthrough for this transaction so the rows
  -- reinserted below carry the version's own quote-time cost. Same mechanism
  -- save_quote uses: transaction-local, so a PostgREST caller cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        (v_item->>'profit')::numeric,
        (v_item->>'total_price')::numeric,
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit',
        -- SNAPSHOT: the version stored the cost this quote was priced with.
        -- Without it the BEFORE INSERT trigger stamps todays catalog cost, and
        -- the next ordinary save preserves that stamp and recomputes the line
        -- from it, silently repricing the restored version.
        --
        -- COALESCE to 0: a version whose item carries a missing or JSON-null
        -- current_cost would otherwise insert NULL here, the trigger would fall
        -- through to todays catalog cost, and the restore would reprice after
        -- all. An explicit zero is the honest record for a line the version
        -- itself had no cost for, and unlike NULL it is preserved by later saves.
        COALESCE(ROUND((v_item->>'current_cost')::numeric * 100)::bigint, 0)
      );
    END LOOP;
  END LOOP;

  -- SNAPSHOT<<< disarm immediately once the reinsert loop closes.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);
  -- >>>SNAPSHOT

  -- BEGIN drawn-version guard (20260611120100)
  -- Codex round-2 MED (2026-06-11): a restore must never under-book the drawn
  -- ledger (quote_product_draws deliberately survives the section delete +
  -- re-insert above). Validates the FINAL persisted quote_items — the same
  -- invariant, token, and block shape as save_quote's drawn-product guard
  -- (20260610184230). A violation rolls back the entire restore atomically,
  -- including the section DELETE.
  -- LAYER2<<< drawn guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1).
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- BEGIN planned-hold + job-reservation sync (20260611132115 + Layer2 A3.12)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  -- LAYER2-CHAN (push-gate #C): a restore that changes booked quantity must ALSO
  -- re-sync the quote's ACTIVE jobs (draws + shed holds), exactly as save_quote now
  -- does — else a restored-larger booking leaves stale job draws and reopens balance
  -- the job still needs. _sync_quote_job_reservations rebuilds the jobs THEN calls
  -- _sync_planned_holds itself (strict superset). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(p_quote_id, v_actor);
  -- END planned-hold + job-reservation sync

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$function$;

-- Postflight assertions: partial application is a hard failure.
DO $$
DECLARE
  v_unsnapshotted int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'quote_items' AND column_name = 'cost_at_quote_cents'
  ) THEN RAISE EXCEPTION 'verify failed: quote_items.cost_at_quote_cents missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.quote_items'::regclass AND tgname = 'trg_snapshot_quote_item_cost'
  ) THEN RAISE EXCEPTION 'verify failed: trg_snapshot_quote_item_cost missing'; END IF;

  SELECT count(*) INTO v_unsnapshotted
  FROM public.quote_items
  WHERE cost_at_quote_cents IS NULL AND current_cost IS NOT NULL;
  IF v_unsnapshotted > 0 THEN
    RAISE EXCEPTION 'verify failed: % quote_items rows still NULL after backfill', v_unsnapshotted;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._snapshot_quote_item_cost()'::regprocedure
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE regexp_replace(setting, '\s+', '', 'g') = 'search_path=public,pg_temp'
      )
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
      -- anti-forgery contract: passthrough gate present, no IF-NULL-only fill
      AND position('crx.quote_cost_snapshot_passthrough' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'verify failed: _snapshot_quote_item_cost security posture';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
        WHERE regexp_replace(setting, '\s+', '', 'g') = 'search_path=public,pg_temp'
      )
      AND position('cost_at_quote_cents' in p.prosrc) > 0
      -- id-keyed preservation only (no product_id fallback map) + passthrough armed
      AND position('crx.quote_cost_snapshot_passthrough' in p.prosrc) > 0
      AND position('v_prior_product_costs' in p.prosrc) = 0
      -- P1-A: the reinserted row reuses the echoed quote_item id instead of
      -- always minting a new one (client-held ids survive repeated saves).
      AND position('COALESCE(v_reuse_item_id, gen_random_uuid())' in p.prosrc) > 0
      -- P1-B: each prior id is consumable once, and the duplicate is a clear
      -- domain error raised before the INSERT (not a PK violation).
      AND position('v_consumed_item_ids' in p.prosrc) > 0
      -- Cost preservation must fall back to the line's own quote+product when
      -- the id does not resolve. Neither an echoed-id count nor a caller-declared
      -- capability flag may gate it: the first locked users out of a legitimate
      -- replace-every-line save, the second was forgeable by the caller.
      AND position('v_consumed_prior_ids' in p.prosrc) > 0
      -- Echoed ids must be RESERVED in a pass over the whole payload before any
      -- id-less row takes a product fallback, or payload order decides which
      -- line keeps its snapshot.
      AND position('RESERVATION PASS' in p.prosrc) > 0
      AND position('QUOTE_STALE_CLIENT' in p.prosrc) = 0
      AND position('client_sends_item_ids' in p.prosrc) = 0
      AND position('QUOTE_ITEM_ID_DUPLICATE' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'verify failed: save_quote not snapshot-aware or security posture wrong';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'verify failed: save_quote ACL drift';
  END IF;

  -- restore_quote_version must supply the version's own quote-time cost through
  -- the trusted passthrough; otherwise a restore silently reprices at today.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'::regprocedure
      AND p.prosecdef
      AND position('cost_at_quote_cents' in p.prosrc) > 0
      AND position('crx.quote_cost_snapshot_passthrough' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'verify failed: restore_quote_version owner impl not snapshot-aware';
  END IF;

  IF has_function_privilege('anon', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'verify failed: restore_quote_version owner impl ACL drift';
  END IF;
END$$;
