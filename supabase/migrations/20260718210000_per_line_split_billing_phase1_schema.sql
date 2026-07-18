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

-- Deferred invariant triggers run after the Phase 3 SECURITY DEFINER writer has
-- returned to the caller's role. Because the protected tables use FORCE RLS,
-- their owning definer must have BYPASSRLS; ordinary table ownership is not enough.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = current_user
       AND rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'PER_LINE_SPLIT_BILLING_OWNER_REQUIRES_BYPASSRLS: migration role %',
      current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

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

-- A posted/draft invoice group has exactly one durable billing parent. PostgreSQL
-- permits multiple NULLs, so ungrouped drafts remain valid while retries or races
-- cannot create competing parents for the same real group.
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_app_billing_sets_group
  ON public.field_app_billing_sets (invoice_group_id)
  WHERE invoice_group_id IS NOT NULL;
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
                          REFERENCES public.field_app_billing_lines(id) ON DELETE RESTRICT,
                          -- explicit share cleanup is required before a draft line can be removed
  invoice_item_id       uuid NOT NULL
                          REFERENCES public.invoice_items(id) ON DELETE RESTRICT, -- prevents parent-cascade snapshot erasure
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
  -- A reason in an override mode must contain visible text; blanks are not an audit trail.
  CONSTRAINT invoice_line_shares_split_reason_ck
    CHECK (
      split_mode <> 'custom'
      OR (split_override_reason IS NOT NULL AND split_override_reason ~ '[^[:space:]]')
    ),
  CONSTRAINT invoice_line_shares_price_reason_ck
    CHECK (
      price_mode <> 'override'
      OR (price_override_reason IS NOT NULL AND price_override_reason ~ '[^[:space:]]')
    )
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_line
  ON public.invoice_line_shares (billing_line_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_customer
  ON public.invoice_line_shares (customer_id);

-- ---------------------------------------------------------------------------
-- 4. Per-line vector must sum to exactly 100% (spec §3/§5). Deferrable so the
--    save path can build a whole vector inside one transaction before the check runs.
--    Skips a line explicitly deleted after its draft shares were explicitly removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_invoice_line_shares_sum_100()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line_id uuid;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_checked_line_ids uuid[] := ARRAY[]::uuid[];
  v_sum bigint;
BEGIN
  -- Serialize all vector validations. A single global lock is deliberate: acquiring
  -- multiple per-line locks in different orders can deadlock multi-line saves.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:invoice-line-shares:sum-100', 0)
  );

  -- UPDATE must validate both the source and destination line. INSERT/DELETE only
  -- have one relevant side. A deferred trigger can safely inspect the final vector.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_line_ids := array_append(v_line_ids, OLD.billing_line_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_line_ids := array_append(v_line_ids, NEW.billing_line_id);
  END IF;

  FOREACH v_line_id IN ARRAY v_line_ids LOOP
    IF v_line_id IS NULL OR v_line_id = ANY(v_checked_line_ids) THEN
      CONTINUE;
    END IF;
    v_checked_line_ids := array_append(v_checked_line_ids, v_line_id);

    -- If the parent logical line is gone (draft line removed), there is nothing to enforce.
    IF NOT EXISTS (SELECT 1 FROM public.field_app_billing_lines WHERE id = v_line_id) THEN
      CONTINUE;
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
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoice_line_shares_sum_100()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoice_line_shares_sum_100 ON public.invoice_line_shares;
CREATE CONSTRAINT TRIGGER trg_invoice_line_shares_sum_100
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_line_shares_sum_100();

-- A share-row trigger cannot observe a brand-new logical line that never receives
-- a share. This companion deferred check closes that zero-row hole while still
-- allowing Phase 3 to insert a line and its complete vector in one transaction.
CREATE OR REPLACE FUNCTION public.trg_field_app_billing_line_has_shares()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.field_app_billing_lines WHERE id = NEW.id)
     AND NOT EXISTS (
       SELECT 1
         FROM public.invoice_line_shares
        WHERE billing_line_id = NEW.id
     ) THEN
    RAISE EXCEPTION
      'field_app_billing_line % has no invoice_line_shares vector',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_field_app_billing_line_has_shares()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_field_app_billing_line_has_shares
  ON public.field_app_billing_lines;
CREATE CONSTRAINT TRIGGER trg_field_app_billing_line_has_shares
  AFTER INSERT ON public.field_app_billing_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_field_app_billing_line_has_shares();

-- ---------------------------------------------------------------------------
-- 5. Immutability WHILE POSTED (spec §1/§5). Shares are freely editable on a draft
--    invoice; once the child invoice is posted, UPDATE/DELETE is refused. Unpost is the
--    sanctioned reopen (it flips the invoice status back), so this respects unpost/re-post.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_invoice_line_shares_frozen_when_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_posted boolean;
  v_item_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- UPDATE must protect both sides: otherwise a row can move from a draft item
  -- to an already-posted item while the trigger inspects only OLD.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_item_ids := array_append(v_item_ids, OLD.invoice_item_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_item_ids := array_append(v_item_ids, NEW.invoice_item_id);
  END IF;

  -- Serialize the share mutation with every posting surface. Posting already
  -- takes the invoice row lock; taking the same lock here means either the share
  -- edit commits while the invoice is still draft, or posting wins and the
  -- status recheck below rejects the edit. The stable order also matches group
  -- posting and avoids an OLD/NEW cross-invoice deadlock on reparent.
  PERFORM 1
  FROM public.invoices i
  WHERE i.id IN (
    SELECT ii.invoice_id
    FROM public.invoice_items ii
    WHERE ii.id = ANY(v_item_ids)
  )
  ORDER BY i.id
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE ii.id = ANY(v_item_ids)
      AND (i.status = 'posted' OR i.posted_at IS NOT NULL)
  )
    INTO v_posted
  ;

  IF COALESCE(v_posted, false) THEN
    RAISE EXCEPTION
      'invoice_line_shares row % is frozen: its invoice is posted. Unpost the invoice first.',
      COALESCE(OLD.id, NEW.id)
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoice_line_shares_frozen_when_posted()
  FROM PUBLIC, anon, authenticated;

-- Fires on INSERT too (defense-in-depth): a share may never be attached to an already-posted
-- invoice, even by the server save path. On a normal draft save the invoice is not yet posted,
-- so inserts proceed; posting happens afterward. (rls-security-reviewer M1, 2026-07-18.)
DROP TRIGGER IF EXISTS trg_invoice_line_shares_frozen_when_posted ON public.invoice_line_shares;
CREATE TRIGGER trg_invoice_line_shares_frozen_when_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_line_shares_frozen_when_posted();

-- ---------------------------------------------------------------------------
-- 6. RLS. All three tables: scoped SELECT for staff; NO browser writes or table DDL.
--    Every write happens inside the locked SECURITY DEFINER save path (Phase 3). The
--    invariant triggers run as the migration owner, whose BYPASSRLS posture is required
--    by the preflight above. We revoke every inherited table privilege from browser
--    roles, then grant authenticated SELECT only; this also removes TRUNCATE, which
--    bypasses RLS and row triggers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.field_app_billing_sets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     ENABLE ROW LEVEL SECURITY;

-- Force RLS so ordinary table owners obey; the invariant trigger definer is separately
-- required to hold BYPASSRLS by the fail-closed preflight at the top of this migration.
ALTER TABLE public.field_app_billing_sets  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     FORCE ROW LEVEL SECURITY;

-- billing_sets: billing staff read. Applicators are deliberately excluded because
-- these rows expose unrelated customer/job identifiers to any globally-authenticated
-- applicator unless an assignment boundary is enforced through billing_set.job_id.
DROP POLICY IF EXISTS field_app_billing_sets_select ON public.field_app_billing_sets;
CREATE POLICY field_app_billing_sets_select ON public.field_app_billing_sets
  FOR SELECT USING (is_admin() OR is_sales_rep());

-- billing_lines: billing staff read; includes source quantities and prices.
DROP POLICY IF EXISTS field_app_billing_lines_select ON public.field_app_billing_lines;
CREATE POLICY field_app_billing_lines_select ON public.field_app_billing_lines
  FOR SELECT USING (is_admin() OR is_sales_rep());

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

-- No write policies exist -> RLS default-denies row DML. Remove all inherited table
-- privileges (including TRUNCATE/REFERENCES/TRIGGER/MAINTAIN), then restore SELECT only.
REVOKE ALL PRIVILEGES ON TABLE public.field_app_billing_sets
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.field_app_billing_lines
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.invoice_line_shares
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.field_app_billing_sets,
                      public.field_app_billing_lines,
                      public.invoice_line_shares
  TO authenticated;

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
      CHECK (
        send_disposition IN ('sendable','suppressed_zero_total')
        AND (send_disposition <> 'suppressed_zero_total' OR total_amount_cents = 0)
      );
  END IF;
END $$;

-- The browser may update other invoice fields through existing policies, so the
-- column needs its own database authority boundary. A SECURITY DEFINER save/post
-- RPC runs as its BYPASSRLS owner; direct authenticated/anon writes do not.
CREATE OR REPLACE FUNCTION public.trg_invoices_send_disposition_server_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_server_authority boolean := false;
BEGIN
  SELECT COALESCE(r.rolbypassrls, false)
    INTO v_server_authority
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;

  IF TG_OP = 'INSERT' THEN
    IF NEW.send_disposition <> 'sendable'
       AND NOT COALESCE(v_server_authority, false) THEN
      RAISE EXCEPTION
        'send_disposition is server-controlled'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.send_disposition IS DISTINCT FROM OLD.send_disposition
        AND NOT COALESCE(v_server_authority, false) THEN
    RAISE EXCEPTION
      'send_disposition is server-controlled'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoices_send_disposition_server_only()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoices_send_disposition_insert_server_only
  ON public.invoices;
CREATE TRIGGER trg_invoices_send_disposition_insert_server_only
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoices_send_disposition_server_only();

DROP TRIGGER IF EXISTS trg_invoices_send_disposition_update_server_only
  ON public.invoices;
CREATE TRIGGER trg_invoices_send_disposition_update_server_only
  BEFORE UPDATE OF send_disposition ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoices_send_disposition_server_only();

COMMENT ON COLUMN public.invoices.send_disposition IS
  'Server-controlled email gate. suppressed_zero_total = $0 not-to-send invoice: recorded and visible in the account, contributes zero to AR/aging/finance charge, NOT marked paid, and every email path must refuse it. Default sendable. Never written by the browser.';

COMMIT;
