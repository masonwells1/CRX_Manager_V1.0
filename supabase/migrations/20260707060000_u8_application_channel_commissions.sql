-- ============================================================================
-- U8 (#99): Commissions on the application channel
-- Owner rule (mission §0.2, Mason): jobs pay commission like orders do —
-- CHEMICAL-LINE PROFIT ONLY (the per-acre application fee is excluded; grower-
-- supplied $0 lines contribute nothing). Reversal mirrors the order channel on
-- EVERY path a job invoice can die (void, cancel, transfer-back-to-scheduling,
-- soft-delete, payout-batch void), is GENERATION-precise via
-- commissions.invoice_id (Codex R1 P1), zeroes cancelled amounts (Codex R3 P2),
-- and carries the order channel's payout protections: batched-pending
-- commissions BLOCK reversal/editing (JOB_HAS_BATCHED_COMMISSIONS), paid rows
-- survive with an admin review notification (Codex R6 P1/P2). Pending amounts
-- recompute on unposted-invoice edits with per-unit COGS × quantity and the
-- mint's exact last-row penny reconciliation, falling back to per-row math if
-- any sibling of the generation is not pending (Codex R2 P1 + R5 P2 + R6 P2 +
-- drift-review R6 H1). Split attribution locks at job creation for BOTH
-- channels: quote-born jobs snapshot the quote's split, direct jobs snapshot
-- the customer default via a BEFORE INSERT trigger, and a creation-time
-- "no split" locks as the empty sentinel {"splits":[]} so NULL can only mean a
-- pre-U8 job (Codex R3 P1 + R4 P1); pre-U8 fallbacks persist on first use
-- (Codex R2 P2). All DDL is retry-safe (Codex R4 P2).
--
-- Before this migration, a booking fulfilled as a DELIVERY paid the rep's
-- commission while the SAME booking fulfilled by SPRAYING paid zero: the
-- commissions table had no job lineage at all (order_id NOT NULL, no job_id),
-- and no job-lifecycle function contained any commission logic (finding #99,
-- CONFIRMED; report §3.3).
--
-- All seven function re-emits below are based on pg_get_functiondef() text
-- fetched from LIVE on 2026-07-06 and byte-verified by md5 (bases:
-- transfer_job_to_invoice 16bf1ce8…, create_job_from_quote_section 952e1d0b…,
-- void_invoice 71647379…, transfer_invoice_to_job b6216935…,
-- void_commission_payment 82ee4e71…, save_invoice 19c03fff…,
-- delete_invoices fea0c6d5…). Deltas are the U8-marked blocks only.
-- ============================================================================

-- ============================================================================
-- U8 part 1: schema + the job-channel commission helper
-- (assembled into 20260707060000_u8_application_channel_commissions.sql)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. commissions: allow a job lineage alongside the order lineage.
--    Mirrors invoices.order_id / invoices.job_id nullable-sibling pattern.
--    All existing rows have order_id NOT NULL, so the new CHECK is satisfied.
-- ---------------------------------------------------------------------------
-- (Codex R4 P2: every DDL statement below is retry-safe — IF NOT EXISTS / DROP IF
-- EXISTS guards — per the repo's idempotent-migration checklist. DROP NOT NULL and
-- CREATE OR REPLACE are naturally idempotent.)
ALTER TABLE public.commissions ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE public.commissions
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id);

-- Codex R1 P1: job commissions also record the exact invoice that minted them, so
-- every reversal / payout-liveness test is GENERATION-precise. job_id alone cannot
-- distinguish an old commission set from the fresh one across a void→re-invoice
-- cycle (the job has a live invoice again — but a DIFFERENT one). ON DELETE SET NULL:
-- if the minting invoice row ever vanishes, the commission conservatively reads as
-- not-payable (the liveness tests treat a dead/missing invoice as dead).
ALTER TABLE public.commissions
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE public.commissions DROP CONSTRAINT IF EXISTS chk_commission_source;
ALTER TABLE public.commissions
  ADD CONSTRAINT chk_commission_source CHECK (order_id IS NOT NULL OR job_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_commissions_job ON public.commissions (job_id) WHERE job_id IS NOT NULL;

-- Codex R9 P2: every U8 reversal/edit/payment-void path filters commissions by the
-- minting invoice — index it so those stay index scans as history grows.
CREATE INDEX IF NOT EXISTS idx_commissions_invoice ON public.commissions (invoice_id) WHERE invoice_id IS NOT NULL;

COMMENT ON COLUMN public.commissions.job_id IS
  'Source job for application-channel commissions (U8). Exactly one of order_id / job_id is set in practice; chk_commission_source requires at least one.';

COMMENT ON COLUMN public.commissions.invoice_id IS
  'The field_application invoice that minted this job commission (U8, Codex R1 P1). NULL on order-channel rows. Reversal and payout-void liveness key on THIS invoice, not on job-level liveness.';

-- ---------------------------------------------------------------------------
-- B. jobs: snapshot the commission split at job creation (copied from the
--    quote by create_job_from_quote_section), so later quote/customer edits
--    do not re-attribute pay. Same snapshot rule orders follow.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS commission_split jsonb;

COMMENT ON COLUMN public.jobs.commission_split IS
  'Commission split snapshot {splits:[{recipient,percentage}]} locked at job creation (U8): quote-born jobs copy the quote''s split (create_job_from_quote_section); direct jobs copy the customer default (trg_jobs_snapshot_commission_split). A creation-time "no split" is locked as the empty sentinel {"splits":[]} (Codex R4 P1), so NULL can ONLY mean a pre-U8 job — resolved once at first invoicing and persisted.';

-- Codex R3 P1: DIRECT jobs (no quote) lock their split at CREATION, not at first
-- invoice — otherwise a customer-default edit between scheduling and invoicing
-- re-attributes pay. BEFORE INSERT so every creation path (save_job or any other
-- insert) is covered. Quote-born inserts are left alone: their snapshot is the
-- QUOTE''s split (set by create_job_from_quote_section), and order-channel parity
-- says a NULL quote split pays no commission — never the customer default
-- (convert_quote_to_order passes only v_quote.commission_split).
CREATE OR REPLACE FUNCTION public.jobs_snapshot_commission_split()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.commission_split IS NULL AND NEW.quote_id IS NULL THEN
    SELECT c.default_commission_split INTO NEW.commission_split
    FROM public.customers c WHERE c.id = NEW.customer_id;
    -- Codex R4 P1: lock "no split" too. A customer with no default snapshots the
    -- empty sentinel {"splits":[]} (a valid no-commission split), so a default
    -- added AFTER scheduling can never re-attribute this job — NULL is reserved
    -- for pre-U8 jobs, which alone take the invoice-time fallback.
    NEW.commission_split := COALESCE(NEW.commission_split, '{"splits":[]}'::jsonb);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_jobs_snapshot_commission_split ON public.jobs;
CREATE TRIGGER trg_jobs_snapshot_commission_split
  BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_snapshot_commission_split();

-- ---------------------------------------------------------------------------
-- C. _insert_commissions_for_job: job-channel sibling of
--    _insert_commissions_for_order (live text mirrored verbatim; only the
--    lineage column changes: job_id instead of order_id).
--    order_profit stores the profit basis (job chemical-line profit, dollars);
--    order_date stores the commission date — legacy column names shared with
--    the order channel so every report/payout path works unchanged.
-- ---------------------------------------------------------------------------
-- idempotency-body-check: exempt (internal helper — not client-callable; EXECUTE revoked
-- from PUBLIC/anon/authenticated below; idempotency lives in the calling RPC, exactly
-- like the live order-channel sibling _insert_commissions_for_order)
CREATE OR REPLACE FUNCTION public._insert_commissions_for_job(
  p_job_id uuid,
  p_invoice_id uuid,
  p_customer_id uuid,
  p_profit numeric,
  p_commission_split jsonb,
  p_commission_date date DEFAULT CURRENT_DATE
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  INSERT INTO public.commissions (
    job_id, invoice_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT
      s, ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT sr.*,
      CASE WHEN sr.rn = sr.split_count THEN
          GREATEST(ROUND(COALESCE(p_profit, 0), 2), 0)
          - COALESCE(SUM(public.compute_commission_amount(p_profit, sr.percentage))
              OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        ELSE public.compute_commission_amount(p_profit, sr.percentage)
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT p_job_id, p_invoice_id, p_customer_id, c.recipient,
    (SELECT p.id FROM public.profiles p WHERE lower(trim(p.full_name)) = lower(trim(c.recipient)) AND p.is_active = true
       AND (SELECT count(*) FROM public.profiles p2 WHERE lower(trim(p2.full_name)) = lower(trim(c.recipient)) AND p2.is_active = true) = 1
     LIMIT 1),
    c.percentage, c.reconciled_amount, COALESCE(p_profit, 0), p_commission_date, 'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Grants: mirror the order-channel sibling's live ACL exactly
-- (proacl = {postgres=X/postgres,service_role=X/postgres} — no PUBLIC/anon/
-- authenticated EXECUTE). The helper is internal to SECURITY DEFINER RPCs,
-- which run as the function owner and therefore keep EXECUTE.
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_job(uuid, uuid, uuid, numeric, jsonb, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_job(uuid, uuid, uuid, numeric, jsonb, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_job(uuid, uuid, uuid, numeric, jsonb, date) FROM authenticated;

-- ============================================================================
-- D. create_job_from_quote_section — copy the quote's commission_split snapshot
--    onto the job (live base + U8 block only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
  v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
  v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0; v_sort integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_job_from_quote_section';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- U5 (Codex P2): lock the quote BEFORE the status checks so a concurrent
  -- convert/close (each takes this same row lock first) serializes with job
  -- scheduling — a plain read could pass the guards on a booking another
  -- transaction is mid-way through accepting or closing.
  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  -- U5<<< #103: an 'accepted' booking was converted to a chemical SALE (order +
  -- delivery). Scheduling a job from it would re-reserve/double-count the same
  -- product. Block with a distinct token so the UI can point the user to a
  -- standalone job instead. (finding #103, CONFIRMED 2026-07-05)
  IF v_quote.status = 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_CONVERTED: quote % was accepted and converted to a chemical sale (order) — create a standalone job instead of scheduling from this booking', v_quote.quote_number;
  END IF;
  -- >>>U5

  IF v_quote.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by,
    -- U8 (#99): snapshot the booking's commission split onto the job so pay attribution
    -- is locked at scheduling time (the same snapshot rule orders follow — a later quote
    -- or customer split edit must not re-attribute an already-scheduled job).
    commission_split
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor,
    -- Codex R4 P1: a quote with no split locks the empty sentinel (no commission,
    -- order-channel parity) — NULL is reserved for pre-U8 jobs.
    COALESCE(v_quote.commission_split, '{"splits":[]}'::jsonb)
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  -- F1<<< 42P01 fix (plpgsql_check, 2026-06-10): the logging INSERT targeted
  -- the old log relation (named in the migration header; deliberately NOT
  -- spelled here — this comment lands in prosrc, and the self-verification
  -- block asserts the old relation name appears NOWHERE in the deployed
  -- body), which does not exist — every call aborted here at runtime.
  -- Re-pointed to activity_feed using its live column shape, the exact
  -- pattern draw_down_quote logs with; the old jsonb details payload
  -- (job_number / quote_id / quote_number / section_name) is folded into the
  -- description text. Event token 'job_created_from_quote' kept.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('job_created_from_quote',
    'Job ' || v_job_number || ' scheduled from quote ' || v_quote.quote_number ||
    COALESCE(' — section ' || v_section.section_name, ''),
    v_actor, 'job', v_job_id, v_quote.customer_id);
  -- >>>F1

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$
;

-- ============================================================================
-- E. transfer_job_to_invoice — resolve+persist the split, mint the job's
--    commission rows at invoicing (live base + U8 blocks only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-8 (G1 per-acre fee) locals
  v_fee jsonb;
  v_fee_total bigint := 0;
  v_fee_cost bigint := 0;
  v_fee_c bigint;
  v_cost_c bigint;
  v_fee_acres numeric := 0;
  -- U8 (#99 commissions on the application channel) locals
  v_commission_split jsonb;
  v_chem_profit_cents bigint := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- BEGIN DELTA-7 (G3 strict-actor): the role gate above is on auth.uid(), but
  -- p_performed_by was written verbatim to created_by / the activity log, so the
  -- recorded performer was forgeable. Bind the authenticated user and reject a
  -- mismatch (matches complete_job / start_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- END DELTA-7

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;

  -- U6 #91b: refuse to invoice the job if a blend ticket for the SAME job has already
  -- been billed (payment_status='billed' = a live, non-voided invoice exists for it).
  -- The blend-ticket invoice and this job invoice bill the same application, so
  -- allowing both double-bills the customer. Block, do not warn. (The
  -- trg_sync_blend_ticket_payment trigger resets billed->unbilled when that invoice
  -- is voided, so a genuine re-bill after a void is unaffected.)
  -- Codex R3 P2: test for a LIVE blend-ticket invoice directly (mirror of the
  -- opposite guard's invoices.job_id test) — payment_status can be written
  -- manually via update_blend_ticket_billing_status and drift out of sync.
  IF EXISTS (
    SELECT 1 FROM blend_tickets bt
    JOIN invoices i ON i.blend_ticket_id = bt.id
    WHERE bt.job_id = p_job_id
      AND bt.deleted_at IS NULL  -- Codex R2 P2: a soft-deleted ticket must not block forever
      AND i.status NOT IN ('voided', 'cancelled')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job has already been billed; invoicing the job too would double-bill the customer. Void that blend-ticket invoice first if you meant to re-bill here.';
  END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- OVERNIGHT FIX (Run 2 cycle 6 — invoice-number canonicalization, Codex-confirmed MEDIUM):
  -- use the shared next_invoice_number() — the SAME invoice_number_seq, 'invoice_number:INV:<year>'
  -- advisory lock, and setval self-heal that every other invoice creator AND the
  -- invoices.invoice_number column default use. The previous inline
  -- `pg_advisory_xact_lock(hashtext('invoice_number'))` + MAX(regexp_replace(...))+1 scan took a
  -- DIFFERENT advisory-lock key, so it did not serialize against other INV creators (two callers
  -- could compute the same number -> 23505 on the UNIQUE index invoices_invoice_number_key,
  -- aborting the transfer) and it never advanced invoice_number_seq.
  v_invoice_number := next_invoice_number('field_application');

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id,
    application_service_id
  ) VALUES (
    -- insert as 'draft' (DELTA-1) — trg_invoice_draft_insert rejects non-draft,
    -- non-credit_memo inserts; DELTA-4 flips to 'unposted' once fully built.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.job_date, v_job.notes,
    -- N2-7 #109<<< stamp the JOB's season, not the season-of-now. An invoice cut in a
    -- later season for a prior-season job must file under the job's season (reports/
    -- year-end read invoices.season). invoices.season is NOT NULL and jobs.season is
    -- nullable, so COALESCE back to the ORIGINAL CURRENT_DATE-based expression when the
    -- job has no season — never stamp NULL, and legacy null-season jobs behave exactly
    -- as before this migration.
    COALESCE(
      v_job.season,
      CASE WHEN extract(month FROM CURRENT_DATE) >= 10
           THEN extract(year FROM CURRENT_DATE)::integer + 1
           ELSE extract(year FROM CURRENT_DATE)::integer END
    ),
    -- >>>N2-7 #109
    p_performed_by, p_job_id, v_job.application_service_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           jc.customer_supplied,
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    v_total_cost_cents := v_total_cost_cents + CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END;
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee, price_source
    ) VALUES (
      v_invoice_id, v_chem.product_id,
      -- U4<<< customer-supplied: keep the line (legal/application record) but at $0
      -- with a labeled description; force cost + price to 0. price_source='manual'
      -- pins the $0 (Codex R5 P1: a product-backed $0 line without it would be
      -- re-priced by tier when the unposted invoice is edited + re-saved). (#53/#54)
      CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
      1,
      v_chem.unit_size,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END,
      -- >>>U4
      v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false,
      CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
    );
  END LOOP;

  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          v_amount := ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    -- OVERNIGHT FIX (Run 2 cycle 2, finding #3 — penny-drift): reconcile the header to the share
    -- sum for BOTH the override AND the percentage-split path (was override-only). Independent
    -- per-customer ROUND(total_price_cents * pct/100) can drift ±1c on odd-cent splits, so without
    -- this the percentage-split header stayed at total_price_cents while invoice_shares summed a cent
    -- off — and get_customer_year_end_summary / get_detailed_statement_data read invoice_shares.amount_cents,
    -- so statements wouldn't tie. v_share_total is the exact sum of the shares; DELTA-8 then adds the
    -- per-acre fee to both shares and header, preserving the tie. The single-customer ELSE branch
    -- already inserts header = its one share, so it ties without this.
    UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, COALESCE(v_job.total_price_cents, 0), true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- DELTA-8 (G1 per-acre application fee, PER-CUSTOMER rate): now that invoice_shares exist,
  -- charge each billed customer the per-acre machine fee at that customer's own rate; add each
  -- customer's fee to their share, emit one is_application_fee line, fold into the header.
  IF v_job.application_service_id IS NOT NULL AND v_total_acres > 0 THEN
    FOR v_share IN
      SELECT id, customer_id, COALESCE(acres, 0) AS acres, price_per_acre_cents
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    LOOP
      -- A grower on a price_override (all-inclusive $/acre) does NOT also pay the per-acre
      -- machine fee, or they'd be double-charged (mirrors save_field_app_invoice).
      IF v_share.price_per_acre_cents IS NOT NULL THEN CONTINUE; END IF;
      v_fee := compute_application_service_fee(
                 v_job.application_service_id, v_share.customer_id, v_share.acres, v_job.season);
      v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
      v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
      v_fee_total := v_fee_total + v_fee_c;
      v_fee_cost  := v_fee_cost  + v_cost_c;
      v_fee_acres := v_fee_acres + v_share.acres;
      IF v_fee_c <> 0 THEN
        UPDATE invoice_shares SET amount_cents = amount_cents + v_fee_c WHERE id = v_share.id;
      END IF;
    END LOOP;

    IF v_fee_total > 0 AND v_fee_acres > 0 THEN
      v_item_order := v_item_order + 1;
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, COALESCE(v_fee->>'service_name', 'Application'), v_fee_acres, 'acre',
        ROUND(v_fee_total / v_fee_acres)::bigint, v_fee_total,
        v_fee_cost, v_item_order, v_fee_acres,
        ROUND(v_fee_total / v_fee_acres)::bigint, 'acre',
        true, 'tier'
      );
      UPDATE invoices SET
        total_amount_cents = COALESCE(total_amount_cents, 0) + v_fee_total,
        total_cost_cents   = total_cost_cents + v_fee_cost
      WHERE id = v_invoice_id;
    END IF;
  END IF;
  -- END DELTA-8

  -- U8<<< (#99): resolve the commission split. New jobs carry a creation-time
  -- snapshot (quote-born: the quote's split via create_job_from_quote_section;
  -- direct: the customer default via trg_jobs_snapshot_commission_split), so this
  -- fallback only fires for PRE-U8 jobs. Order-channel parity (Codex R3 P1): a
  -- quote-born job uses the parent quote's split and ONLY that — convert_quote_to_order
  -- passes only v_quote.commission_split, so a NULL quote split pays no commission,
  -- never the customer default. A pre-U8 direct job uses the customer default, like
  -- a direct order. Codex R2 P2: the resolved fallback is PERSISTED onto the job in
  -- the same UPDATE that flips it to 'invoiced', so attribution locks at first use.
  v_commission_split := v_job.commission_split;
  IF v_commission_split IS NULL THEN
    IF v_job.quote_id IS NOT NULL THEN
      SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
    ELSE
      SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
    END IF;
  END IF;
  -- >>>U8

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id,
    -- U8 (Codex R2 P2 + R4 P1): persist the resolution — even a nothing-anywhere
    -- result locks as the empty sentinel so re-invoices never re-read live sources.
    commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
  WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  -- DELTA-4: invoice was inserted as 'draft'; flip to 'unposted' now that items, shares and
  -- totals are final. draft -> unposted is allowed by _enforce_invoice_status_transition.
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;

  -- U8<<< (#99): mint the application-channel commissions — chemical-line profit only.
  -- Mirror of the order channel (convert_quote_to_order → _insert_commissions_for_order).
  -- Profit basis: the chemical lines just written to THIS invoice. The per-acre machine
  -- fee (is_application_fee=true, product_id NULL) is excluded per the owner rule, and
  -- customer-supplied lines carry $0 price AND $0 cost so they contribute exactly 0.
  -- invoice_items money is bigint CENTS; commissions are numeric DOLLARS → /100.0.
  -- The helper no-ops on a NULL/splits-less split and validates a present one
  -- (COMMISSION_SPLIT_INVALID aborts, matching the order-conversion behavior).
  -- Pending amounts stay in sync with later unposted-invoice edits via the
  -- recompute in the item-rewrite path (Codex R2 P1), mirroring update_order_items.
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
    INTO v_chem_profit_cents
  FROM invoice_items ii
  WHERE ii.invoice_id = v_invoice_id
    AND COALESCE(ii.is_application_fee, false) = false
    AND ii.product_id IS NOT NULL;

  PERFORM _insert_commissions_for_job(
    p_job_id, v_invoice_id, v_job.customer_id,
    v_chem_profit_cents::numeric / 100.0,
    v_commission_split,
    CURRENT_DATE
  );
  -- >>>U8

  -- DELTA-5: log to activity_feed (performed_by NOT NULL: COALESCE to auth.uid()).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

  -- OVERNIGHT FIX (finding #3): write the canonical 'invoice_created' financial_audit_log row
  -- the other six invoice creators write, so the append-only money ledger records creation
  -- provenance for job-built invoices too. Read the FINAL header total back (DELTA-8 may have
  -- adjusted it). Shape mirrors save_field_app_invoice's invoice_created row.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id, auth.uid(),
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'job_id', p_job_id,
      'customer_id', v_job.customer_id,
      'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id)
    ),
    (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id),
    'Invoice ' || v_invoice_number || ' created from job ' || v_job.job_number
  );

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;

-- ============================================================================
-- F. void_invoice — payout-protected cancel+zero of the pending commissions THIS
--    invoice minted, in BOTH the draft/unposted→cancelled early path AND the
--    posted→voided path (live base + U8 blocks only; invoice_id-scoped)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record; v_alloc record; v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0; v_prepay_app record; v_actor_role text;
  v_allocation_set_ids uuid[]; v_commissions_cancelled integer := 0; v_existing jsonb;
  v_job record;  -- U6 #65: job-release locals
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  -- U6 (rls-review M1): IS DISTINCT FROM — the live `!= 'admin'` was NULL-unsafe
  -- (a caller with no profile row yields NULL != 'admin' = NULL → gate silently
  -- passed; downstream NOT NULLs caught it, but the gate itself should hold).
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin users can void invoices'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;

  -- draft/unposted invoices were never posted: no allocations/prepay/commissions to reverse,
  -- and the status trigger only allows →voided from posted/overdue. Route to 'cancelled'
  -- (draft→cancelled / unposted→cancelled are allowed transitions) and return.
  IF v_inv.status IN ('draft', 'unposted') THEN
    UPDATE invoices SET status = 'cancelled', void_reason = p_void_reason, updated_at = now()
    WHERE id = p_invoice_id;

    -- U6 #65: release a job that was transferred into THIS (now cancelled) field-app
    -- invoice so it is no longer stranded at terminal 'invoiced'. See header note for
    -- the admin-override-GUC rationale. Only touch the job if it still owns this invoice.
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
      IF FOUND AND v_job.status = 'invoiced' AND v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
        UPDATE application_records SET invoice_id = NULL
          WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
        SET LOCAL app.admin_override = 'true';
        UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
        RESET app.admin_override;
      END IF;
    END IF;

    -- U8<<< (#99): job-invoice commissions are created AT invoicing (unlike the order
    -- channel, whose commissions predate the invoice), so a job invoice cancelled while
    -- still draft/unposted already has live pending commissions — cancel them here.
    -- Codex R1 P1: scope by commissions.invoice_id (the exact generation THIS invoice
    -- minted), not by job-level liveness — job_id alone cannot tell an old generation
    -- from the current one across a void→re-invoice cycle.
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      -- Codex R6 P1: order-channel payout protections, mirrored. (a) Pending rows in
      -- an ACTIVE payout batch block the reversal (void the commission payment first
      -- — its void resets them to pending here, or cancels them if this invoice is
      -- already dead), exactly like ORDER_HAS_BATCHED_COMMISSIONS on cancel_order.
      -- (b) Rows already PAID stay on the ledger, but every admin is notified for
      -- manual review, because the released job can be re-invoiced and re-earn.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice cancelled — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was cancelled but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', p_invoice_id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
    -- >>>U8

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_cancelled', 'invoice', p_invoice_id, v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'cancelled', 'void_reason', p_void_reason, 'commissions_cancelled', v_commissions_cancelled),
      0,
      'Cancelled ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — ' || p_void_reason);

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_cancelled',
      'Cancelled invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
        'success', true, 'invoice_id', p_invoice_id, 'status', 'cancelled',
        'allocations_reversed_cents', 0, 'prepay_restored_cents', 0, 'commissions_cancelled', v_commissions_cancelled));
    END IF;
    RETURN;
  END IF;

  IF v_inv.status = 'posted' THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

  SELECT ARRAY(SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
    WHERE invoice_id = p_invoice_id AND allocation_set_id IS NOT NULL) INTO v_allocation_set_ids;

  FOR v_alloc IN SELECT ila.id, ila.amount_cents, ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET total_allocated_cents = (SELECT COALESCE(SUM(amount_cents), 0)
      FROM invoice_line_allocations WHERE allocation_set_id = allocation_sets.id),
      updated_at = now() WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now() WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now() WHERE id = v_inv.customer_id;
  END IF;

  UPDATE invoices SET status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason, total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- U6 #65: release a job that was transferred into THIS (now voided) field-app
  -- invoice so it is no longer stranded at terminal 'invoiced'. See header note for
  -- the admin-override-GUC rationale. Only touch the job if it still owns this invoice.
  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
    IF FOUND AND v_job.status = 'invoiced' AND v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
      UPDATE application_records SET invoice_id = NULL
        WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
      SET LOCAL app.admin_override = 'true';
      UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
      RESET app.admin_override;
    END IF;
  END IF;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_inv.order_id
        AND id != p_invoice_id AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  -- U8<<< (#99): application-channel mirror of the order-keyed reversal above — a
  -- voided job invoice cancels the pending commissions THIS invoice minted. A
  -- field_application invoice has order_id NULL, so the block above never fires for
  -- it; only one of the two blocks can run for any given invoice. Codex R1 P1:
  -- scoped by commissions.invoice_id (generation-precise), not job-level liveness.
  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    -- Codex R6 P1: same payout protections as the early-cancel path above.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
        AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Job invoice voided — commissions already paid',
        'Invoice ' || v_inv.invoice_number || ' was voided but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
        'commission_review', 'invoice', p_invoice_id
      FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    UPDATE commissions SET status = 'cancelled', commission_amount = 0
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
    GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  END IF;
  -- >>>U8

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true, 'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled));
  END IF;
END;
$function$
;

-- ============================================================================
-- G. transfer_invoice_to_job — the "return to scheduling" un-invoice path also
--    reverses the commissions the forward transfer minted (live base + U8 block)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transfer_invoice_to_job(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_job RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_actor_role text;
  v_commissions_cancelled integer := 0;  -- U8 (#99)
BEGIN
  -- Role gate (active admin/sales_rep) on the authenticated user.
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- Strict actor: the recorded performer must be the authenticated user
  -- (mirrors transfer_job_to_invoice / complete_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_invoice_to_job');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;

  IF v_inv.invoice_type IS DISTINCT FROM 'field_application' THEN
    RAISE EXCEPTION 'Only a field application invoice can be transferred back to a job';
  END IF;
  IF v_inv.job_id IS NULL THEN
    RAISE EXCEPTION 'This invoice was not created from a job, so it cannot be returned to scheduling';
  END IF;
  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Only a draft or unposted invoice can be returned to scheduling (status: %). Void the invoice first.', v_inv.status;
  END IF;

  -- Lock the source job and confirm it still owns this invoice (no race / double reverse).
  SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source job not found: %', v_inv.job_id; END IF;
  IF v_job.status <> 'invoiced' THEN
    RAISE EXCEPTION 'Source job % is no longer invoiced (status: %); cannot return this invoice to scheduling', v_job.job_number, v_job.status;
  END IF;
  IF v_job.invoice_id IS DISTINCT FROM p_invoice_id THEN
    RAISE EXCEPTION 'Source job % no longer points at this invoice; refusing to reverse', v_job.job_number;
  END IF;

  -- Detach the as-applied legal records from this invoice (inverse of the forward
  -- UPDATE application_records SET invoice_id = v_invoice_id ...).
  UPDATE application_records SET invoice_id = NULL
    WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;

  -- Tear down the invoice contents the forward transfer built.
  DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
  DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;

  -- Cancel the invoice (draft|unposted -> cancelled is an allowed transition; no override).
  -- total/paid/prepay are already 0 on a never-posted invoice; zero them defensively.
  -- total_cost_cents (the internal COGS header) is ALSO zeroed here (P3 remediation) so a
  -- cancelled, line-less invoice does not keep a stale forward cost total on its PDF.
  UPDATE invoices SET
    status = 'cancelled',
    void_reason = 'Returned to scheduling (job ' || v_job.job_number || ')',
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    total_cost_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- U8<<< (#99): the forward transfer minted this invoice's pending commissions —
  -- reverse them with it (a re-transfer creates a fresh pending set). Codex R1 P1:
  -- scoped by commissions.invoice_id so only THIS invoice's generation is touched.
  -- Codex R6 P1: order-channel payout protections (batched-pending blocks; paid
  -- rows stay + admins notified).
  IF EXISTS (
    SELECT 1 FROM commissions c
    JOIN commission_payment_items cpi ON cpi.commission_id = c.id
    JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
      AND c.status = 'pending' AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commissions
    WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
  ) THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Job invoice returned to scheduling — commissions already paid',
      'Invoice ' || v_inv.invoice_number || ' was returned to scheduling but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
      'commission_review', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
  UPDATE commissions SET status = 'cancelled', commission_amount = 0
    WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  -- >>>U8

  -- Return the job to 'completed' so it is editable / re-transferable. The reverse
  -- invoiced -> completed transition is only sanctioned via the admin-override GUC
  -- (SET LOCAL = transaction-scoped); RESET immediately after the single UPDATE.
  SET LOCAL app.admin_override = 'true';
  UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
  RESET app.admin_override;

  -- Append-only money ledger: record the cancellation (mirrors void_invoice's
  -- draft/unposted -> cancelled audit row), with the source-job provenance.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_cancelled', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'job_id', v_inv.job_id),
    jsonb_build_object('status', 'cancelled', 'reason', 'transfer_to_scheduling', 'job_id', v_inv.job_id, 'commissions_cancelled', v_commissions_cancelled),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling (job ' || v_job.job_number || ')'
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_transferred_to_scheduling',
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling — job ' || v_job.job_number || ' reopened',
    COALESCE(p_performed_by, auth.uid()), 'job', v_inv.job_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'job_id', v_inv.job_id,
    'job_number', v_job.job_number,
    'invoice_status', 'cancelled',
    'job_status', 'completed',
    'commissions_cancelled', v_commissions_cancelled
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_invoice_to_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;

-- ============================================================================
-- H. save_invoice — the ONLY item-rewrite path for a job-born field_application
--    invoice while draft/unposted: batched-guarded recompute of pending job
--    commissions with COGS×quantity + mint-parity penny reconciliation
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_invoice(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    IF v_order_id IS NULL AND v_blend_id IS NULL THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = (p_invoice->>'due_date')::date,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$
;

-- ============================================================================
-- I. delete_invoices — the Delete button's soft-delete path: payout-protected
--    cancel+zero of the deleted invoice's pending job commissions and release of
--    the stranded job (live base + U8 block; mirrors the void path's #65 fix)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_invoices(p_invoice_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv        record;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  PERFORM require_admin();  -- admin-only: matches invoices_update/invoices_delete RLS (is_admin())
  PERFORM check_rate_limit(auth.uid(), 'delete_invoices', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'deleted_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status, invoice_number, total_amount_cents, blend_ticket_id,
           invoice_type, job_id  -- U8 (Codex R3 P1): job-born invoice cleanup below
    FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Only draft / unposted / voided invoices are soft-deletable (matches the UI gates).
    IF v_inv.status NOT IN ('draft', 'unposted', 'voided') THEN CONTINUE; END IF;

    UPDATE invoices SET deleted_at = now() WHERE id = v_inv.id;

    -- Blend-ticket orphan guard (overnight bug-hunt MED, 20260620): a soft-delete sets
    -- deleted_at only, which does NOT fire the status-change reset trigger, so a deleted
    -- draft blend invoice would strand the ticket at 'billed' forever (un-rebillable).
    -- When this was the last live invoice for the ticket, reset it (same predicate the
    -- over-reset trigger uses; v_inv was just soft-deleted so it is excluded below).
    IF v_inv.blend_ticket_id IS NOT NULL THEN
      UPDATE blend_tickets SET payment_status = 'unbilled', updated_at = now()
      WHERE id = v_inv.blend_ticket_id AND payment_status = 'billed'
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.blend_ticket_id = v_inv.blend_ticket_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND i.deleted_at IS NULL
        );
    END IF;

    -- U8<<< (Codex R3 P1): the same orphan class as the blend-ticket guard above,
    -- for the application channel. A job-born field_application invoice minted
    -- pending commissions at transfer time and owns its job's 'invoiced' status;
    -- a soft-delete fires no trigger, so without this block the commissions stay
    -- payable for a deleted invoice and the job strands at 'invoiced' forever
    -- (the exact #65 shape void_invoice fixes — mirrored here with the same guards:
    -- generation-precise commission cancel, and release the job only if it still
    -- owns THIS invoice). Deleting an already-voided job invoice no-ops both parts
    -- (void_invoice already cancelled the rows and released the job).
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      -- Codex R6 P1: order-channel payout protections (batched-pending blocks the
      -- whole delete batch — transactional, nothing partially deleted; paid rows
      -- stay + admins notified).
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = v_inv.id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: invoice % has pending commissions in an active payout batch — void that commission payment first', v_inv.invoice_number;
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice deleted — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was deleted but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', v_inv.id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'pending';

      DECLARE
        v_job record;
      BEGIN
        SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
        IF FOUND AND v_job.status = 'invoiced' AND v_job.invoice_id IS NOT DISTINCT FROM v_inv.id THEN
          UPDATE application_records SET invoice_id = NULL
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = v_inv.id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      END;
    END IF;
    -- >>>U8

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_deleted', 'invoice', v_inv.id, v_actor_role,
      jsonb_build_object(
        'status', v_inv.status,
        'invoice_number', v_inv.invoice_number,
        'total_amount_cents', v_inv.total_amount_cents
      ),
      jsonb_build_object('deleted_at', now()),
      0,
      'Soft-deleted invoice ' || v_inv.invoice_number || ' (status ' || v_inv.status || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_invoices', jsonb_build_object('deleted_count', v_count));
  END IF;

  RETURN v_count;
END;
$function$
;

-- ============================================================================
-- J. void_commission_payment — a voided payout batch must not resurrect a
--    commission whose own minting invoice is dead, nor any already-cancelled row
--    (live base + U8 clauses; generation-precise per Codex R1 P1)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_commission_payment(p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_payment record;
  v_reset_count integer;
  v_cancelled_count integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.status NOT IN ('posted', 'unposted') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_PAYMENT_STATUS: %', v_payment.status;
  END IF;

  -- PARKED-003 (codex-driven cycle 2, Claude-independent HIGH): a commission-payment
  -- void retroactively changes the commission ledger and writes the append-only
  -- financial_audit_log. By the void_invoice / void_payment / reverse_write_off
  -- precedent (every other reverse-side money RPC) AND by direct parallel to PARKED-001
  -- (unapply_credit_memo), this must respect the ORIGINAL payment's accounting period.
  -- Gate AFTER the existence + status guards so error-message stability is preserved.
  -- Use COALESCE(v_payment.payment_date, CURRENT_DATE) — mirrors post_commission_payment
  -- exactly (the table column is NOT NULL today but COALESCE matches the precedent).
  PERFORM check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  UPDATE commission_payments SET
    status = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  -- OVERNIGHT FIX (finding #15): only return a batch commission to 'pending' (re-payable) if its
  -- ORDER is still live. A commission whose order was voided/cancelled/deleted after the batch was
  -- posted must NOT be resurrected — set it 'cancelled' / amount 0, matching cancel_order/void_order.
  UPDATE commissions c SET
    status = 'pending',
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = c.order_id
      AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
  )
  -- U8 (#99): same liveness rule for the application channel — a job-sourced
  -- commission is only re-payable while ITS OWN minting invoice is still live.
  -- Codex R1 P1: test c.invoice_id (generation-precise), NOT job-level liveness —
  -- after a void→re-invoice cycle the job has a live invoice again, but it belongs
  -- to the NEW commission generation, and the old batch rows must stay dead.
  AND NOT (
    c.job_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = c.invoice_id
        AND i.status NOT IN ('voided', 'cancelled')
        AND i.deleted_at IS NULL
    )
  )
  -- U8 / Codex R1 P1 hardening (both channels): a row already 'cancelled' (by an
  -- invoice void or order cancel that ran while it sat in this batch) must never be
  -- resurrected to payable by voiding the batch.
  AND c.status <> 'cancelled';
  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  UPDATE commissions c SET
    status = 'cancelled',
    commission_amount = 0,
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = c.order_id
        AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
    )
    -- U8 (#99): job-lineage deadness — the commission's own minting invoice is
    -- no longer live (Codex R1 P1: generation-precise via c.invoice_id).
    OR (
      c.job_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id = c.invoice_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
      )
    )
  );
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_payment.status, 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count, 'commissions_cancelled_dead_order', v_cancelled_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', v_reset_count,
    'commissions_cancelled_dead_order', v_cancelled_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
