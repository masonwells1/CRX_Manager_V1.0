-- Per-Line-Item Split Billing — Phase 1: additive schema (FEATURE FLAG OFF)
--
-- Spec: docs/plans/per-line-item-split-billing-spec-2026-07-17.md  (§3 data model, §5 invariants).
-- This migration is ADDITIVE and INERT: it creates new tables + one nullable column + an
-- OFF feature flag. No existing function, policy, or row behavior changes. Nothing reads or
-- writes these tables until Phase 2 (calculator) / Phase 3 (save-post RPC) land behind the flag.
--
-- Build order (spec §6): Phase 1 = this file, reviewed on its own, flag OFF. Do NOT apply live
-- until (a) Codex reviews the PR and (b) the §6.1 baseline field-application billing cycle has run.
--
-- idempotency-body-check: exempt  (pure DDL + one config upsert; no mutating RPC defined here)

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Feature flag (OFF). Mirrors the app_settings boolean-flag convention
--    (src/lib/autoDraftSetting.ts): only the literal string 'true' is ON.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES (
  'feature_per_line_split_billing',
  'false',
  'Per-line-item custom split billing on the field-application invoice path. OFF until the '
  || 'Phase 2/3 calculator + save-post RPC ship and the baseline billing cycle is proven. '
  || 'Server is authoritative; the flag only reveals the UI.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. field_app_billing_sets — one durable parent per billing event.
--    Replaces relying on the nullable invoices.invoice_group_id (spec §3). Covers both
--    grouped (multi-recipient) and single-recipient invoices.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.field_app_billing_sets (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The shared group id stamped on the child invoices (invoices.invoice_group_id). Nullable
  -- while the set is a draft that has not yet produced invoices.
  invoice_group_id        uuid,
  job_id                  uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  primary_customer_id     uuid REFERENCES public.customers(id),
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','posted','voided')),
  -- Versioned rounding policy (spec §4/§8): pins the allocation rules used for this set so a
  -- later policy change never silently re-rounds a posted set.
  rounding_policy_version integer NOT NULL DEFAULT 1,
  created_by              uuid NOT NULL REFERENCES public.profiles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_app_billing_sets_group
  ON public.field_app_billing_sets (invoice_group_id);
CREATE INDEX IF NOT EXISTS idx_field_app_billing_sets_job
  ON public.field_app_billing_sets (job_id);

DROP TRIGGER IF EXISTS trg_field_app_billing_sets_updated_at ON public.field_app_billing_sets;
CREATE TRIGGER trg_field_app_billing_sets_updated_at
  BEFORE UPDATE ON public.field_app_billing_sets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. field_app_billing_lines — one SERVER-created logical source line per
--    chemical / service / flat fee (spec §3). Each child invoice_item and each
--    invoice_line_share references its logical line here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.field_app_billing_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_set_id        uuid NOT NULL
                          REFERENCES public.field_app_billing_sets(id) ON DELETE CASCADE,
  line_kind             text NOT NULL CHECK (line_kind IN ('chemical','service','flat_fee')),
  -- price_basis decides which §4 allocation path applies:
  --   same_price      -> allocate the canonical source cents by largest remainder
  --   per_person_price-> per-person round(price*qty); group total is the sum (no parent figure)
  --   flat_fee        -> fixed bigint cents allocated by percentage, largest remainder
  price_basis           text NOT NULL CHECK (price_basis IN ('same_price','per_person_price','flat_fee')),
  product_id            uuid REFERENCES public.products(id),
  application_service_id uuid REFERENCES public.application_services(id),
  description           text NOT NULL,
  -- Canonical (unsplit) source figures. Full numeric precision; the calculator rounds once.
  source_quantity       numeric(12,4),
  source_acres          numeric(12,4),
  source_unit_price_cents bigint,          -- null on per_person_price (no single price)
  source_amount_cents   bigint,            -- canonical unsplit line total; null on per_person_price
  sort_order            integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_app_billing_lines_set
  ON public.field_app_billing_lines (billing_set_id);

DROP TRIGGER IF EXISTS trg_field_app_billing_lines_updated_at ON public.field_app_billing_lines;
CREATE TRIGGER trg_field_app_billing_lines_updated_at
  BEFORE UPDATE ON public.field_app_billing_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. invoice_line_shares — immutable per-line allocation snapshot (spec §3).
--    APPEND-ONLY: no updated_at by design; frozen once its invoice is posted (trigger below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_line_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_line_id       uuid NOT NULL
                          REFERENCES public.field_app_billing_lines(id) ON DELETE CASCADE,
                          -- draft-only cascade (line -> shares); NOT the immutability mechanism (§5)
  invoice_item_id       uuid NOT NULL
                          REFERENCES public.invoice_items(id) ON DELETE CASCADE,  -- child item, this customer
  customer_id           uuid NOT NULL REFERENCES public.customers(id),

  split_mode            text NOT NULL CHECK (split_mode IN ('field_default','custom')),
  -- 0..100% in micro-percent (100% = 100,000,000) so exact vectors are integer-exact.
  split_micro_pct       integer NOT NULL
                          CHECK (split_micro_pct >= 0 AND split_micro_pct <= 100000000),
  allocated_quantity    numeric(12,4),   -- MATCHES invoice_items.quantity precision
  allocated_acres       numeric(12,4),   -- higher precision than invoice_items.acres(12,2) on purpose

  base_unit_price_cents bigint NOT NULL, -- resolved base (global manual / quote / tier / customer_application_rates)
  base_price_source     text NOT NULL,   -- which source the base came from
  price_mode            text NOT NULL CHECK (price_mode IN ('default','override')),
  unit_price_cents      bigint NOT NULL, -- effective price (= base unless overridden)
  amount_cents          bigint NOT NULL, -- = the child invoice_item's extended_cents

  split_override_reason text,            -- required when split_mode = 'custom'
  price_override_reason text,            -- required when price_mode = 'override'
  calculation_hash      text NOT NULL,   -- SERVER-computed; never a browser value
  vector_hash           text NOT NULL,   -- SERVER-computed
  created_by            uuid NOT NULL REFERENCES public.profiles(id),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_line_shares_item_unique UNIQUE (invoice_item_id),
  CONSTRAINT invoice_line_shares_line_customer_unique UNIQUE (billing_line_id, customer_id),
  -- reason required in the modes that demand an audit trail
  CONSTRAINT invoice_line_shares_split_reason_ck
    CHECK (split_mode <> 'custom' OR split_override_reason IS NOT NULL),
  CONSTRAINT invoice_line_shares_price_reason_ck
    CHECK (price_mode <> 'override' OR price_override_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_line
  ON public.invoice_line_shares (billing_line_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_customer
  ON public.invoice_line_shares (customer_id);

-- ---------------------------------------------------------------------------
-- 4. Per-line vector must sum to exactly 100% (spec §3/§5). Deferrable so the
--    save path can build a whole vector inside one transaction before the check runs.
--    Skips a line that was deleted (line -> shares cascade legitimately zeroes it).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_invoice_line_shares_sum_100()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER            -- fires only inside the SECDEF save path; runs as its owner
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line_id uuid := COALESCE(NEW.billing_line_id, OLD.billing_line_id);
  v_sum bigint;
BEGIN
  -- If the parent logical line is gone (draft line removed), there is nothing to enforce.
  IF NOT EXISTS (SELECT 1 FROM public.field_app_billing_lines WHERE id = v_line_id) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(split_micro_pct), 0)
    INTO v_sum
    FROM public.invoice_line_shares
   WHERE billing_line_id = v_line_id;

  IF v_sum <> 100000000 THEN
    RAISE EXCEPTION
      'invoice_line_shares vector for billing_line % sums to % micro-pct, must equal 100000000',
      v_line_id, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_line_shares_sum_100 ON public.invoice_line_shares;
CREATE CONSTRAINT TRIGGER trg_invoice_line_shares_sum_100
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_line_shares_sum_100();

-- ---------------------------------------------------------------------------
-- 5. Immutability WHILE POSTED (spec §1/§5). Shares are freely editable on a draft
--    invoice; once the child invoice is posted, UPDATE/DELETE is refused. Unpost is the
--    sanctioned reopen (it flips the invoice status back), so this respects unpost/re-post.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_invoice_line_shares_frozen_when_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER            -- fires only inside the SECDEF save/unpost path; runs as its owner
SET search_path = public, pg_temp
AS $$
DECLARE
  v_posted boolean;
BEGIN
  SELECT (i.status = 'posted' OR i.posted_at IS NOT NULL)
    INTO v_posted
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE ii.id = COALESCE(OLD.invoice_item_id, NEW.invoice_item_id);

  IF COALESCE(v_posted, false) THEN
    RAISE EXCEPTION
      'invoice_line_shares row % is frozen: its invoice is posted. Unpost the invoice first.',
      COALESCE(OLD.id, NEW.id)
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Fires on INSERT too (defense-in-depth): a share may never be attached to an already-posted
-- invoice, even by the server save path. On a normal draft save the invoice is not yet posted,
-- so inserts proceed; posting happens afterward. (rls-security-reviewer M1, 2026-07-18.)
DROP TRIGGER IF EXISTS trg_invoice_line_shares_frozen_when_posted ON public.invoice_line_shares;
CREATE TRIGGER trg_invoice_line_shares_frozen_when_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_line_shares_frozen_when_posted();

-- ---------------------------------------------------------------------------
-- 6. RLS. All three tables: scoped SELECT for staff; NO browser INSERT/UPDATE/DELETE.
--    Every write happens inside the locked SECURITY DEFINER save path (Phase 3), which
--    runs as owner and bypasses RLS. We additionally REVOKE direct DML from client roles.
-- ---------------------------------------------------------------------------
ALTER TABLE public.field_app_billing_sets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     ENABLE ROW LEVEL SECURITY;

-- Force RLS so even table owners (defensive) obey; SECURITY DEFINER funcs still bypass via ownership.
ALTER TABLE public.field_app_billing_sets  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     FORCE ROW LEVEL SECURITY;

-- billing_sets: staff read
DROP POLICY IF EXISTS field_app_billing_sets_select ON public.field_app_billing_sets;
CREATE POLICY field_app_billing_sets_select ON public.field_app_billing_sets
  FOR SELECT USING (is_admin() OR is_sales_rep() OR is_applicator());

-- billing_lines: staff read
DROP POLICY IF EXISTS field_app_billing_lines_select ON public.field_app_billing_lines;
CREATE POLICY field_app_billing_lines_select ON public.field_app_billing_lines
  FOR SELECT USING (is_admin() OR is_sales_rep() OR is_applicator());

-- invoice_line_shares: SELECT scoped through invoice_items -> invoices (mirror invoice_items_select)
DROP POLICY IF EXISTS invoice_line_shares_select ON public.invoice_line_shares;
CREATE POLICY invoice_line_shares_select ON public.invoice_line_shares
  FOR SELECT USING (
    is_admin() OR EXISTS (
      SELECT 1
        FROM public.invoice_items ii
        JOIN public.invoices i ON i.id = ii.invoice_id
       WHERE ii.id = invoice_line_shares.invoice_item_id
         AND ( i.created_by = (SELECT auth.uid())
            OR i.salesman_id = (SELECT auth.uid()) )
    )
  );

-- No INSERT/UPDATE/DELETE policies exist -> RLS default-denies client DML. Belt-and-suspenders:
REVOKE INSERT, UPDATE, DELETE ON public.field_app_billing_sets  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.field_app_billing_lines FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.invoice_line_shares     FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Server-controlled email suppression for $0 / not-to-send invoices (spec §5).
--    Additive nullable-with-default column; every existing invoice becomes 'sendable'
--    (unchanged behavior). The browser only DISPLAYS this; the server sets it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS send_disposition text NOT NULL DEFAULT 'sendable';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_send_disposition_ck'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_send_disposition_ck
      CHECK (send_disposition IN ('sendable','suppressed_zero_total'));
  END IF;
END $$;

COMMENT ON COLUMN public.invoices.send_disposition IS
  'Server-controlled email gate. suppressed_zero_total = $0 not-to-send invoice: recorded and '
  || 'visible in the account, contributes zero to AR/aging/finance charge, NOT marked paid, and '
  || 'every email path must refuse it. Default sendable. Never written by the browser.';

COMMIT;
