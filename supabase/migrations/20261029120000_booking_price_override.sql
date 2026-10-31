-- Written 2026-10-29. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (placeholder row; the landing session assigns the final row).
-- Re-read the live ledger before applying.
--
-- WHAT: a booked price on a sent quote can change straight away, without re-sending the quote
--   (Mason 2026-10-27: "override straight away; a higher price needs a warning and the rep's
--   confirmation tick; record who, when, the old price and who ticked; below cost still needs an
--   admin"). Before this, #1105 (20261027040000) refused Convert, Partial Order and Schedule Job
--   until a changed price was re-sent.
--   1. New table quote_price_changes: one row per saved line whose price changed on a sent quote
--      (old and new price in whole cents, who changed it and when, and for a raise who ticked
--      "grower agreed" and when). RLS on; admins and sales reps may read it (as quote_items);
--      nobody but save_quote writes it.
--   2. _save_quote_below_cost_impl_20260810 (behind save_quote): on a sent quote, after pricing,
--      each saved line whose price changed is recorded. A higher price needs the line's
--      grower_confirmed flag in the payload, otherwise the save is refused with
--      QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION and nothing is written.
--   3. _assert_quote_prices_as_sent: a line the customer was sent (same line id and product) also
--      passes when its price equals its latest recorded change.
--   Every other line of the two re-emitted functions is their current body, extracted from a
--   replayed database on main 1567b768 plus 20261029100000 (pinned below; the preflight refuses any drift).
--
-- NOT CHANGED: how save_quote prices a line (a sent line still keeps its stored price unless the
--   rep sets a manual price or picks today's price); a new line, a changed customer, a price that
--   changed any other way, or a version written before line ids still needs a re-send; owner-only
--   editing; the below-cost admin approval; grants on both functions. No rows change.
--
-- CONFLICT NOTE: 20261029100000 (season-end expiry, PR #1201) also re-emits _save_quote_below_cost_
--   impl_20260810. It lands first; this file was regenerated on its body (2026-10-31) and re-pinned,
--   so this migration must be applied after 20261029100000.
--
-- ROLLBACK (its own reviewed migration): re-emit both functions from the pinned pre-image, then
--   DROP TABLE public.quote_price_changes (destructive: needs Mason's yes).
--
-- ORDERING: apply after every older pending migration, including 20261029100000 (PR #1201).

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE quote_price_override_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.quote_price_override_tx') IS NULL THEN
    RAISE EXCEPTION 'QUOTE_PRICE_OVERRIDE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.quote_price_override_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'QUOTE_PRICE_OVERRIDE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.quote_price_changes') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: quote_price_changes already exists; re-read live first';
  END IF;

  -- The two re-emitted functions, pinned to their current body, owner, mode, search_path and
  -- EXECUTE grants. Each has exactly one overload.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_save_quote_below_cost_impl_20260810', 'public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)',
          'cef92527a26f50ba4c55ef4a4ed810ab', true, ARRAY['postgres']),
        ('_assert_quote_prices_as_sent', 'public._assert_quote_prices_as_sent(uuid)',
          '5a0391efa6a8141dc8ba9b86c31ae38b', false, ARRAY['postgres'])
      ) AS pin(fn, sig, body_md5, secdef, execs)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef IS DISTINCT FROM pin.secdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_QUOTE_FUNCTION_DRIFT: a re-emitted function differs from its pinned body, owner, mode, search_path or grants';
  END IF;
END
$preflight$;

-- 1. The record of each booked-price change on a sent quote.
CREATE TABLE public.quote_price_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  -- No foreign key: save_quote re-inserts a quote's lines on every save under the same ids.
  quote_item_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  old_price_cents bigint NOT NULL,
  new_price_cents bigint NOT NULL,
  changed_by uuid NOT NULL REFERENCES public.profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  grower_confirmed_by uuid REFERENCES public.profiles(id),
  grower_confirmed_at timestamptz,
  CONSTRAINT quote_price_changes_changed CHECK (new_price_cents <> old_price_cents),
  CONSTRAINT quote_price_changes_confirmation_pair
    CHECK ((grower_confirmed_by IS NULL) = (grower_confirmed_at IS NULL)),
  CONSTRAINT quote_price_changes_raise_confirmed
    CHECK (new_price_cents < old_price_cents OR grower_confirmed_by IS NOT NULL)
);
COMMENT ON TABLE public.quote_price_changes IS
  'Each booked-price change on a sent quote, written only by save_quote (20261029120000). A raise records who ticked "grower agreed".';
CREATE INDEX quote_price_changes_item_idx ON public.quote_price_changes (quote_item_id, id);
CREATE INDEX quote_price_changes_quote_idx ON public.quote_price_changes (quote_id);
ALTER TABLE public.quote_price_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_price_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.quote_price_changes TO authenticated;
CREATE POLICY quote_price_changes_select ON public.quote_price_changes
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()));

-- 2. save_quote records each change and needs the tick for a raise.
CREATE OR REPLACE FUNCTION public._save_quote_below_cost_impl_20260810(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
  v_fallback_distinct_costs int;
  v_idless_by_product jsonb := '{}'::jsonb;
  v_idless_count int;
  v_fallback_candidates int;
  -- The id actually written for this row, and the client-key -> id map returned
  -- to the caller. save_quote deletes and reinserts every line, so a browser
  -- that added new lines has no way to learn their ids; without this it keeps
  -- sending them id-less forever and the second save trips the ambiguity guard
  -- (two new lines of one product). client_key is an opaque caller-supplied
  -- string used only to address the response -- it is never an id and never
  -- influences which snapshot a row receives. (Codex round 28.)
  v_new_item_id uuid;
  v_client_key text;
  v_item_ids jsonb := '{}'::jsonb;
  -- PRICE OVERRIDE (20261029120000): saved line ids the rep ticked "grower agreed" on.
  v_confirmed_ids jsonb := '{}'::jsonb;
  v_pc record;
  -- >>>SNAPSHOT
  -- PRICE LOCK (20261027040000): a quote that has been sent (it has a quote_versions row) keeps
  -- each existing line's stored price on every save. Only a manual price (price_override) or the
  -- line's use_todays_price flag changes it; a new line takes today's tier price. A draft that was
  -- never sent follows the catalog as before (Mason, 2026-10-14).
  v_price_locked boolean := false;
  v_carry_prices jsonb := '{}'::jsonb;
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
    v_price_locked := EXISTS (SELECT 1 FROM quote_versions WHERE quote_id = p_quote_id);

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
               jsonb_build_object('p', product_id::text, 'c', cost_at_quote_cents, 'pp', price_per_unit)
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
        ELSIF (v_item->>'product_id') IS NOT NULL THEN
          -- Count the rows that will need a fallback, keyed by product. Two or
          -- more competing for the same product is unresolvable (below).
          v_idless_by_product := jsonb_set(
            v_idless_by_product,
            ARRAY[v_item->>'product_id'],
            to_jsonb(COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0) + 1),
            true);
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
      valid_days, expires_at, chosen_expiry_date, header_notes, footer_notes, is_planned, created_at, updated_at
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
      -- SEASON END (20261029100000): the date the rep picked; NULL = season end.
      (p_quote_payload->>'chosen_expiry_date')::date,
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
          -- A legacy NULL is not a monetary basis. Leave it NULL so the trusted
          -- INSERT trigger must establish a fresh, positive catalog basis (or
          -- reject the save) instead of manufacturing zero cost and profit.
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
        -- AMBIGUITY CHECK. Both tests below apply ONLY when at least one
        -- unconsumed prior line of this product actually exists. With zero
        -- candidates there is no history to allocate and nothing to get wrong:
        -- every unresolved row is genuinely new and takes a fresh id and today's
        -- stamp. Gating on that matters -- an earlier revision refused whenever
        -- two id-less rows shared a product, which blocked the ordinary act of
        -- adding two new lines of a product the quote never carried, and no
        -- reload could clear it because new lines have no ids to supply.
        -- (Codex round 20.)
        SELECT COUNT(*), COUNT(DISTINCT COALESCE(val->>'c', '~'))
          INTO v_fallback_candidates, v_fallback_distinct_costs
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k);

        IF v_fallback_candidates > 0 THEN
          -- (a) Several unresolved payload rows competing for the same product's
          -- history: nothing says which is the pre-existing line and which was
          -- just swapped onto it, so iteration order would decide who keeps the
          -- recorded cost.
          v_idless_count := COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0);
          IF v_idless_count > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this save sent more than one line of the same product without identifying which existing line each one is. Reload the quote and re-apply your changes so every line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;

          -- (b) Several prior lines of this product recorded at DIFFERENT costs.
          -- Same costs are interchangeable -- any pick is identical, so refusing
          -- there would be a lock-out for no gain.
          IF v_fallback_distinct_costs > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this quote has more than one line of the same product recorded at different costs, and this save did not identify which line is which. Reload the quote and re-apply your changes so each line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;
        END IF;

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
      -- SNAPSHOT<<< settle this row's id once, so the same value can be both
      -- written and reported back to the caller under its client key.
      v_new_item_id := COALESCE(v_reuse_item_id, gen_random_uuid());
      -- PRICE LOCK: a line the caller names by its saved id (same product) keeps its stored
      -- price unless the caller asks for today's price on it. A line matched only by the
      -- one-per-product fallback keeps its cost but takes today's price, so the screen (which
      -- names every saved line) and the server agree; the sent-price check then asks for a
      -- re-send if that price differs from the one sent.
      IF v_price_locked AND v_reuse_item_id IS NOT NULL
         AND v_reuse_item_id::text = v_payload_item_id
         AND COALESCE((v_item->>'use_todays_price')::boolean, false) = false THEN
        v_carry_prices := v_carry_prices
          || jsonb_build_object(v_new_item_id::text, v_prior_item_costs->(v_reuse_item_id::text)->'pp');
      END IF;
      IF COALESCE((v_item->>'grower_confirmed')::boolean, false) THEN
        v_confirmed_ids := v_confirmed_ids || jsonb_build_object(v_new_item_id::text, true);
      END IF;
      v_client_key := NULLIF(v_item->>'client_key', '');
      IF v_client_key IS NOT NULL THEN
        v_item_ids := v_item_ids || jsonb_build_object(v_client_key, v_new_item_id::text);
      END IF;
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
        v_new_item_id,
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
        -- Preserve 20260810150500 DELTA-B2: normalize transient client money
        -- before the already-live whole-cent constraints inspect the row.
        ROUND(COALESCE((v_item->>'profit')::numeric, 0), 2),
        ROUND(COALESCE((v_item->>'total_price')::numeric, 0), 2),
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
      COALESCE(qi.price_override, (v_carry_prices->>(qi.id::text))::numeric, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      -- SNAPSHOT<<< was: COALESCE(p.current_cost, 0). Price cost from the
      -- immutable quote-time snapshot; live catalog cost only for a row the
      -- trigger could not snapshot (product missing a cost).
      (qi.cost_at_quote_cents / 100.0) AS cc,
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
      -- SNAPSHOT<<< profit is settled revenue MINUS settled extended cost, not
      -- a rounding of the margin per unit. The reports compute it the first
      -- way; rounding (price - cost) * qty as one expression disagrees with
      -- them by a cent on fractional quantities whose extensions land on a
      -- half-cent, and that cent then rides into the converted order and the
      -- commission. One boundary, applied to each side. (Codex round 33.)
      ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2) AS profit,
      CASE
        WHEN ROUND(ppu * total_units, 2) > 0
          THEN ROUND((ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2))
                     / ROUND(ppu * total_units, 2) * 100, 2)
        ELSE 0
      END AS net_margin
      -- >>>SNAPSHOT
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

  -- PRICE OVERRIDE (20261029120000, Mason 2026-10-27): on a sent quote a saved line's price may
  -- change straight away, with no re-send. Each change is recorded (who, when, old and new price);
  -- a higher price needs the rep's "grower agreed" tick on this save, a lower one does not. The
  -- price check (_assert_quote_prices_as_sent) accepts a line whose price is its latest recorded
  -- change. Below-cost approval is unchanged.
  IF v_price_locked THEN
    FOR v_pc IN
      SELECT qi.id, qi.product_id, p.product_name,
             ROUND((v_prior_item_costs->(qi.id::text)->>'pp')::numeric * 100)::bigint AS old_cents,
             ROUND(qi.price_per_unit * 100)::bigint AS new_cents
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
       WHERE qi.quote_id = v_quote_id
         AND v_prior_item_costs ? (qi.id::text)
         AND (v_prior_item_costs->(qi.id::text)->>'p') = qi.product_id::text
         AND ROUND((v_prior_item_costs->(qi.id::text)->>'pp')::numeric * 100)
             IS DISTINCT FROM ROUND(qi.price_per_unit * 100)
       ORDER BY qi.sort_order, qi.id
    LOOP
      IF v_pc.new_cents > v_pc.old_cents AND NOT (v_confirmed_ids ? (v_pc.id::text)) THEN
        RAISE EXCEPTION 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION: % goes up from $% to $%. Tick "Grower agreed" on that line, then save again.',
          v_pc.product_name, to_char(v_pc.old_cents / 100.0, 'FM999999990.00'), to_char(v_pc.new_cents / 100.0, 'FM999999990.00')
          USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO quote_price_changes (quote_id, quote_item_id, product_id, old_price_cents, new_price_cents,
        changed_by, grower_confirmed_by, grower_confirmed_at)
      VALUES (v_quote_id, v_pc.id, v_pc.product_id, v_pc.old_cents, v_pc.new_cents, v_actor,
        CASE WHEN v_pc.new_cents > v_pc.old_cents THEN v_actor END,
        CASE WHEN v_pc.new_cents > v_pc.old_cents THEN now() END);
    END LOOP;
  END IF;

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
    -- Settle each line's extended cost to cents BEFORE summing, matching the
    -- per-line profit boundary above. Summing raw current_cost * quantity let
    -- sub-cent extended costs into quotes.total_cost, so the header identity
    -- (revenue - cost = profit) broke on fractional quantities and the fraction
    -- rode into versions and conversion. (Codex round 41.)
    COALESCE(SUM(ROUND(current_cost * total_units_needed, 2)), 0) AS total_cost,
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
    -- PRICE LOCK: editing a sent quote keeps its expiry; only a send sets a new one.
    expires_at = CASE WHEN v_price_locked THEN expires_at
      ELSE COALESCE((p_quote_payload->>'expires_at')::date, expires_at) END,
    -- SEASON END (20261029100000): a key sent as null clears the pick (back to season end);
    -- a missing key keeps it. It takes effect at the next send.
    chosen_expiry_date = CASE WHEN p_quote_payload ? 'chosen_expiry_date'
      THEN (p_quote_payload->>'chosen_expiry_date')::date ELSE chosen_expiry_date END,
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

  -- PRICE LOCK: a quote becomes accepted only at the prices, lines and customer last sent.
  -- Only the transition is checked, so a quote accepted earlier (whose last version may predate
  -- line ids) can still be saved.
  IF v_status = 'accepted' AND v_old_status IS DISTINCT FROM 'accepted' THEN
    PERFORM public._assert_quote_prices_as_sent(v_quote_id);
  END IF;

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
    -- SNAPSHOT<<< client_key -> quote_items.id for every line written by this
    -- save, so the caller can install real ids without a refetch. Included in
    -- the idempotency-stored result, so a replayed save returns the same map
    -- rather than leaving a retrying client id-less. (Codex round 28.)
    'item_ids', v_item_ids,
    -- >>>SNAPSHOT
    -- PRICE LOCK (20261027040000): client_key -> the price_per_unit this save stored, so the
    -- quote screen keeps each saved line at the price the database holds. Prices only; no cost.
    'item_prices', (
      SELECT COALESCE(jsonb_object_agg(e.key, qi.price_per_unit), '{}'::jsonb)
      FROM jsonb_each_text(v_item_ids) AS e(key, value)
      JOIN quote_items qi ON qi.id = e.value::uuid
    ),
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

-- 3. The sent-price check accepts a line at its latest recorded change.
CREATE OR REPLACE FUNCTION public._assert_quote_prices_as_sent(p_quote_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_version_number integer;
  v_snapshot jsonb;
  v_trusted_at timestamptz;
  v_customer_id uuid;
  v_sent_items jsonb;
  v_problem text;
  v_resend text;
BEGIN
  -- The price authority is the version last sent to the customer (Mason, 2026-10-13/14): a sent
  -- quote's prices change only through a revision that is sent again. Callers hold the quote row
  -- lock. Not SECURITY DEFINER: it runs inside the definer-rights quote functions, and no API
  -- role may execute it.
  SELECT version_number, snapshot_data, restore_trusted_at
    INTO v_version_number, v_snapshot, v_trusted_at
  FROM quote_versions
  WHERE quote_id = p_quote_id
  ORDER BY version_number DESC
  LIMIT 1;
  -- Never sent: a draft (a planned booking included) keeps its own prices, as before.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_resend := format('Send the quote to the customer again (it becomes V%s), or rewind it to V%s, then try again.',
    v_version_number + 1, v_version_number);

  -- A version from before the protected send workflow (20260826220000) could have been written
  -- by hand, so it cannot vouch for what the customer saw.
  IF v_trusted_at IS NULL THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: V% of this quote was saved before sent versions were protected, so its prices cannot be confirmed. Send the quote to the customer again, then try again.',
      v_version_number
      USING ERRCODE = 'P0001';
  END IF;

  SELECT customer_id INTO v_customer_id FROM quotes WHERE id = p_quote_id;
  IF (v_snapshot->'quote'->>'customer_id') IS DISTINCT FROM v_customer_id::text THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: the customer changed after V% was sent. %', v_version_number, v_resend
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(i.item), '[]'::jsonb)
    INTO v_sent_items
  FROM jsonb_array_elements(COALESCE(v_snapshot->'sections', '[]'::jsonb)) AS s(section)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.section->'items', '[]'::jsonb)) AS i(item);

  IF jsonb_array_length(v_sent_items) > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
       WHERE NULLIF(i.item->>'quote_item_id', '') IS NULL
     ) THEN
    -- Each line must be a line that was sent, for the same product, at the same price. Lines
    -- removed in a revision, and quantity, rate, acre and note changes, need no re-send:
    -- the lock covers prices only (Mason, 2026-10-14).
    SELECT p.product_name INTO v_problem
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
        WHERE i.item->>'quote_item_id' = qi.id::text
          AND i.item->>'product_id' = qi.product_id::text
          AND (
            (i.item->>'price_per_unit')::numeric = qi.price_per_unit
            -- PRICE OVERRIDE (20261029120000, Mason 2026-10-27): a line the customer was sent
            -- may carry a price changed since, when that price is its latest change recorded
            -- by save_quote. Any other difference still needs a re-send.
            OR ROUND(qi.price_per_unit * 100) = (
              SELECT c.new_price_cents FROM quote_price_changes c
               WHERE c.quote_item_id = qi.id AND c.product_id = qi.product_id
               ORDER BY c.id DESC LIMIT 1)
          )
      )
    ORDER BY qi.sort_order, qi.id
    LIMIT 1;
  ELSE
    -- A version saved before versions recorded line ids: lines can be matched only one to one
    -- by product, so any added, removed or repeated product needs a re-send (fails closed).
    IF (SELECT count(*) FROM quote_items WHERE quote_id = p_quote_id) <> jsonb_array_length(v_sent_items)
       OR EXISTS (SELECT 1 FROM quote_items WHERE quote_id = p_quote_id GROUP BY product_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
                  GROUP BY i.item->>'product_id' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: this quote''s lines no longer match V% as sent, and that version cannot tell its lines apart. %',
        v_version_number, v_resend
        USING ERRCODE = 'P0001';
    END IF;
    SELECT p.product_name INTO v_problem
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
        WHERE i.item->>'product_id' = qi.product_id::text
          AND (i.item->>'price_per_unit')::numeric = qi.price_per_unit
      )
    ORDER BY qi.sort_order, qi.id
    LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: % has a price or line the customer was not sent in V%. %',
      v_problem, v_version_number, v_resend
      USING ERRCODE = 'P0001';
  END IF;
END
$function$;

DO $postflight$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_price_changes'::regclass)
     OR has_table_privilege('authenticated', 'public.quote_price_changes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_price_changes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.quote_price_changes', 'DELETE')
     OR has_table_privilege('anon', 'public.quote_price_changes', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT: quote_price_changes must have RLS on and be read-only for signed-in users';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_save_quote_below_cost_impl_20260810', 'public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)',
          true, ARRAY['postgres'], 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION'),
        ('_assert_quote_prices_as_sent', 'public._assert_quote_prices_as_sent(uuid)',
          false, ARRAY['postgres'], 'quote_price_changes')
      ) AS pin(fn, sig, secdef, execs, marker)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR position(pin.marker IN p.prosrc) = 0
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef IS DISTINCT FROM pin.secdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT: a re-emitted function lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
