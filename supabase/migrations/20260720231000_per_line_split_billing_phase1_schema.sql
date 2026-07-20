-- Per-Line-Item Split Billing — Phase 1: additive schema (FEATURE FLAG OFF)
--
-- Spec: docs/plans/per-line-item-split-billing-spec-2026-07-17.md  (§3 data model, §5 invariants).
-- This migration is ADDITIVE and INERT: it creates new tables + one invoice column + an
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
CREATE INDEX IF NOT EXISTS idx_field_app_billing_sets_primary_customer
  ON public.field_app_billing_sets (primary_customer_id);
CREATE INDEX IF NOT EXISTS idx_field_app_billing_sets_created_by
  ON public.field_app_billing_sets (created_by);

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
CREATE INDEX IF NOT EXISTS idx_field_app_billing_lines_product
  ON public.field_app_billing_lines (product_id);
CREATE INDEX IF NOT EXISTS idx_field_app_billing_lines_application_service
  ON public.field_app_billing_lines (application_service_id);

DROP TRIGGER IF EXISTS trg_field_app_billing_lines_updated_at ON public.field_app_billing_lines;
CREATE TRIGGER trg_field_app_billing_lines_updated_at
  BEFORE UPDATE ON public.field_app_billing_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. invoice_line_shares — editable working per-line allocation (spec §3).
--    No updated_at by design; frozen while its invoice is posted. Section 8 copies
--    every post into an actually append-only table before a later unpost can reopen it.
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
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_created_by
  ON public.invoice_line_shares (created_by);

-- Every transition into a posted state copies the complete allocation and its
-- logical source line into this independent history table. Deliberately omit
-- foreign keys: an unposted draft may delete/rebuild its working share, item, or
-- logical line, but that must never erase or block preservation of a prior post.
CREATE TABLE IF NOT EXISTS public.invoice_line_share_post_snapshots (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_instance_id           uuid NOT NULL,
  invoice_id                 uuid NOT NULL,
  invoice_group_id           uuid,
  post_sequence              integer NOT NULL CHECK (post_sequence > 0),
  posted_at                  timestamptz NOT NULL,
  post_status                text NOT NULL CHECK (post_status IN ('posted','paid','overdue')),
  invoice_total_amount_cents bigint NOT NULL,
  send_disposition           text NOT NULL CHECK (send_disposition IN ('sendable','suppressed_zero_total')),

  source_share_id            uuid NOT NULL,
  billing_set_id             uuid NOT NULL,
  rounding_policy_version    integer NOT NULL CHECK (rounding_policy_version > 0),
  billing_line_id            uuid NOT NULL,
  invoice_item_id            uuid NOT NULL,
  customer_id                uuid NOT NULL,

  line_kind                  text NOT NULL CHECK (line_kind IN ('chemical','service','flat_fee')),
  price_basis                text NOT NULL CHECK (price_basis IN ('same_price','per_person_price','flat_fee')),
  product_id                 uuid,
  application_service_id     uuid,
  description                text NOT NULL,
  source_quantity            numeric(12,4),
  source_acres               numeric(12,4),
  source_unit_price_cents    bigint,
  source_amount_cents        bigint,
  sort_order                 integer NOT NULL,

  split_mode                 text NOT NULL CHECK (split_mode IN ('field_default','custom')),
  split_micro_pct            integer NOT NULL CHECK (split_micro_pct BETWEEN 0 AND 100000000),
  allocated_quantity         numeric(12,4),
  allocated_acres            numeric(12,4),
  base_unit_price_cents      bigint NOT NULL,
  base_price_source          text NOT NULL,
  price_mode                 text NOT NULL CHECK (price_mode IN ('default','override')),
  unit_price_cents           bigint NOT NULL,
  amount_cents               bigint NOT NULL,
  split_override_reason      text,
  price_override_reason      text,
  calculation_hash           text NOT NULL,
  vector_hash                text NOT NULL,

  item_quantity              numeric(12,4),
  item_acres                 numeric(12,2),
  item_unit_price_cents      bigint NOT NULL,
  item_extended_cents        bigint NOT NULL,
  source_share_created_by    uuid NOT NULL,
  source_share_created_at    timestamptz NOT NULL,
  captured_by                uuid,
  captured_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_line_share_post_snapshots_post_share_unique
    UNIQUE (invoice_id, post_sequence, source_share_id),
  CONSTRAINT invoice_line_share_post_snapshots_instance_share_unique
    UNIQUE (post_instance_id, source_share_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_share_post_snapshots_invoice
  ON public.invoice_line_share_post_snapshots (invoice_id, post_sequence);
CREATE INDEX IF NOT EXISTS idx_invoice_line_share_post_snapshots_line
  ON public.invoice_line_share_post_snapshots (billing_line_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_share_post_snapshots_customer
  ON public.invoice_line_share_post_snapshots (customer_id);

-- History is append-only even for privileged application writers. The posting
-- trigger below is the only intended INSERT path; no code path ever rewrites or
-- removes a captured post.
CREATE OR REPLACE FUNCTION public.trg_invoice_line_share_post_snapshots_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'invoice_line_share_post_snapshots is append-only; % is forbidden',
    TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoice_line_share_post_snapshots_immutable()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoice_line_share_post_snapshots_no_row_mutation
  ON public.invoice_line_share_post_snapshots;
CREATE TRIGGER trg_invoice_line_share_post_snapshots_no_row_mutation
  BEFORE UPDATE OR DELETE ON public.invoice_line_share_post_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_line_share_post_snapshots_immutable();

DROP TRIGGER IF EXISTS trg_invoice_line_share_post_snapshots_no_truncate
  ON public.invoice_line_share_post_snapshots;
CREATE TRIGGER trg_invoice_line_share_post_snapshots_no_truncate
  BEFORE TRUNCATE ON public.invoice_line_share_post_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_invoice_line_share_post_snapshots_immutable();

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
  v_not_editable boolean;
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

  -- Lock item rows before invoice rows. This serializes share writes with an
  -- invoice_items.invoice_id reparent and gives both triggers the same lock
  -- order. Without this lock, a concurrent share insert could validate the old
  -- draft parent, wait on its FK, then follow the item onto a posted invoice.
  PERFORM 1
  FROM public.invoice_items ii
  WHERE ii.id = ANY(v_item_ids)
  ORDER BY ii.id
  FOR UPDATE;

  -- Serialize the share mutation with every posting surface. Posting already
  -- takes the invoice row lock; taking the same lock here means either the share
  -- edit commits while the invoice is still draft, or posting wins and the
  -- status recheck below rejects the edit. The stable order also avoids an
  -- OLD/NEW cross-invoice deadlock on share reparent.
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
      AND (i.status NOT IN ('draft', 'unposted') OR i.posted_at IS NOT NULL)
  )
    INTO v_not_editable
  ;

  IF COALESCE(v_not_editable, false) THEN
    RAISE EXCEPTION
      'invoice_line_shares row % is frozen: shares are editable only while the invoice is draft or unposted with no posted timestamp.',
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

-- invoice_line_shares follows invoice_items.invoice_id and snapshots the child item's
-- allocated quantity, acres, unit price, and amount. A linked item is therefore
-- parent-immutable until its draft share is deliberately deleted/rebuilt. Once the
-- invoice posts, the four snapshotted material fields are immutable too; otherwise a
-- privileged writer could change the invoice item while its share stayed frozen.
-- Operational metadata such as tote_number remains outside this trigger.
CREATE OR REPLACE FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allocation_fields_changed boolean;
  v_not_editable boolean;
BEGIN
  v_allocation_fields_changed :=
    NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.acres IS DISTINCT FROM OLD.acres
    OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
    OR NEW.extended_cents IS DISTINCT FROM OLD.extended_cents;

  IF NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
     AND NOT v_allocation_fields_changed THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.invoice_line_shares s
    WHERE s.invoice_item_id = OLD.id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION
      'invoice_item % is frozen while linked to a split-billing snapshot; delete and rebuild draft shares before reparenting, and posted shares cannot be moved.',
      OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the same invoice row used by every posting surface. The material update
  -- either commits while the invoice is still draft, or waits for posting and then
  -- fails against the committed status. invoice_items itself is already row-locked
  -- by this BEFORE UPDATE trigger, matching the item -> invoice lock order used by
  -- share writes.
  SELECT (
      i.status NOT IN ('draft', 'unposted')
      OR i.posted_at IS NOT NULL
    )
    INTO v_not_editable
    FROM public.invoices i
   WHERE i.id = OLD.invoice_id
   FOR UPDATE;

  IF COALESCE(v_not_editable, false) THEN
    RAISE EXCEPTION
      'invoice_item % allocation fields are frozen unless its split invoice is draft or unposted with no posted timestamp.',
      OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invoice_items_shared_parent_frozen_when_posted ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_shared_parent_frozen_when_posted
  BEFORE UPDATE OF invoice_id, quantity, acres, unit_price_cents, extended_cents
  ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted();

-- ---------------------------------------------------------------------------
-- 6. RLS. All four tables: scoped SELECT for staff; NO browser writes or table DDL.
--    Every write happens inside the locked SECURITY DEFINER save path (Phase 3). The
--    invariant triggers run as the migration owner, whose BYPASSRLS posture is required
--    by the preflight above. We revoke every inherited table privilege from browser
--    roles, then grant authenticated SELECT only; this also removes TRUNCATE, which
--    bypasses RLS and row triggers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.field_app_billing_sets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_share_post_snapshots ENABLE ROW LEVEL SECURITY;

-- Force RLS so ordinary table owners obey; the invariant trigger definer is separately
-- required to hold BYPASSRLS by the fail-closed preflight at the top of this migration.
ALTER TABLE public.field_app_billing_sets  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.field_app_billing_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_shares     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_share_post_snapshots FORCE ROW LEVEL SECURITY;

-- billing_sets: admins read all; sales reps read only sets they created or a set
-- whose child invoice is assigned to them. A global is_sales_rep() policy would
-- expose every customer's source quantities and prices to every rep.
DROP POLICY IF EXISTS field_app_billing_sets_select ON public.field_app_billing_sets;
CREATE POLICY field_app_billing_sets_select ON public.field_app_billing_sets
  FOR SELECT USING (
    is_admin() OR (
      is_sales_rep() AND (
        created_by = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1
            FROM public.invoices i
           WHERE i.invoice_group_id = field_app_billing_sets.invoice_group_id
             AND ( i.created_by = (SELECT auth.uid())
                OR i.salesman_id = (SELECT auth.uid()) )
        )
      )
    )
  );

-- billing_lines inherit the same owner/assigned-invoice scope through their set.
DROP POLICY IF EXISTS field_app_billing_lines_select ON public.field_app_billing_lines;
CREATE POLICY field_app_billing_lines_select ON public.field_app_billing_lines
  FOR SELECT USING (
    is_admin() OR (
      is_sales_rep() AND EXISTS (
        SELECT 1
          FROM public.field_app_billing_sets bs
         WHERE bs.id = field_app_billing_lines.billing_set_id
           AND (
             bs.created_by = (SELECT auth.uid())
             OR EXISTS (
               SELECT 1
                 FROM public.invoices i
                WHERE i.invoice_group_id = bs.invoice_group_id
                  AND ( i.created_by = (SELECT auth.uid())
                     OR i.salesman_id = (SELECT auth.uid()) )
             )
           )
      )
    )
  );

-- invoice_line_shares: SELECT scoped through invoice_items -> invoices (mirror invoice_items_select)
DROP POLICY IF EXISTS invoice_line_shares_select ON public.invoice_line_shares;
CREATE POLICY invoice_line_shares_select ON public.invoice_line_shares
  FOR SELECT USING (
    is_admin() OR (
      is_sales_rep() AND EXISTS (
        SELECT 1
          FROM public.invoice_items ii
          JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.id = invoice_line_shares.invoice_item_id
           AND ( i.created_by = (SELECT auth.uid())
              OR i.salesman_id = (SELECT auth.uid()) )
      )
    )
  );

-- History remains readable after a draft item/share is rebuilt, so scope through
-- the stored invoice id rather than the current working invoice_item relation.
DROP POLICY IF EXISTS invoice_line_share_post_snapshots_select
  ON public.invoice_line_share_post_snapshots;
CREATE POLICY invoice_line_share_post_snapshots_select
  ON public.invoice_line_share_post_snapshots
  FOR SELECT USING (
    is_admin() OR (
      is_sales_rep() AND EXISTS (
        SELECT 1
          FROM public.invoices i
         WHERE i.id = invoice_line_share_post_snapshots.invoice_id
           AND ( i.created_by = (SELECT auth.uid())
              OR i.salesman_id = (SELECT auth.uid()) )
      )
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
REVOKE ALL PRIVILEGES ON TABLE public.invoice_line_share_post_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.field_app_billing_sets,
                      public.field_app_billing_lines,
                      public.invoice_line_shares,
                      public.invoice_line_share_post_snapshots
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Server-controlled email suppression for $0 / not-to-send invoices (spec §5).
--    Additive nullable-with-default column; every existing invoice becomes 'sendable'
--    (unchanged behavior). The browser only DISPLAYS this; the server sets it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS send_disposition text NOT NULL DEFAULT 'sendable';

-- Constraint names are unique only within a table. Recreate the table-local
-- constraint deliberately so a same-named constraint elsewhere—or a weaker
-- partially applied local definition—cannot silently bypass this money guard.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_send_disposition_ck;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_send_disposition_ck
  CHECK (
    send_disposition IN ('sendable','suppressed_zero_total')
    AND (send_disposition <> 'suppressed_zero_total' OR total_amount_cents = 0)
  );

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

-- ---------------------------------------------------------------------------
-- 8. Append-only post history (spec §1). Capture a complete, self-contained
--    copy whenever a split invoice crosses from draft/unposted into a posted
--    state. An unpost can then freely rebuild the working rows without changing
--    what was actually posted in any earlier cycle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_capture_invoice_line_share_post_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_instance_id uuid := gen_random_uuid();
  v_post_sequence integer;
  v_requires_post_timestamp boolean;
  v_creates_post_snapshot boolean;
BEGIN
  -- Ordinary invoices have no split-share rows and remain untouched.
  IF NOT EXISTS (
    SELECT 1
      FROM public.invoice_line_shares s
      JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
     WHERE ii.invoice_id = NEW.id
  ) THEN
    RETURN NULL;
  END IF;

  -- A split invoice must never reach the freeze boundary without the timestamp
  -- required by its immutable history row. Also reject the inverse mismatch:
  -- posted_at on a draft/unposted split invoice would freeze its working rows
  -- without representing a real post transition.
  -- Voiding preserves posted_at by design: it is a post-derived terminal state,
  -- but it must not create a second post snapshot.
  v_requires_post_timestamp := NEW.status IN ('posted','paid','overdue','voided');
  v_creates_post_snapshot := NEW.status IN ('posted','paid','overdue');
  IF v_requires_post_timestamp IS DISTINCT FROM (NEW.posted_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'split invoice % requires posted/voided status and posted_at to agree',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Updates within the posted lifecycle (posted -> paid/overdue) and sanctioned
  -- unposts do not create another post instance. A later unposted -> posted
  -- transition does, because OLD is no longer a complete posted state.
  IF NOT v_creates_post_snapshot
     OR (OLD.status IN ('posted','paid','overdue') AND OLD.posted_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  -- The invoice row being updated serializes post transitions for this invoice,
  -- so MAX+1 is safe and the unique constraint remains a fail-closed backstop.
  SELECT COALESCE(MAX(h.post_sequence), 0) + 1
    INTO v_post_sequence
    FROM public.invoice_line_share_post_snapshots h
   WHERE h.invoice_id = NEW.id;

  INSERT INTO public.invoice_line_share_post_snapshots (
    post_instance_id, invoice_id, invoice_group_id, post_sequence,
    posted_at, post_status, invoice_total_amount_cents, send_disposition,
    source_share_id, billing_set_id, rounding_policy_version,
    billing_line_id, invoice_item_id, customer_id,
    line_kind, price_basis, product_id, application_service_id, description,
    source_quantity, source_acres, source_unit_price_cents, source_amount_cents, sort_order,
    split_mode, split_micro_pct, allocated_quantity, allocated_acres,
    base_unit_price_cents, base_price_source, price_mode, unit_price_cents, amount_cents,
    split_override_reason, price_override_reason, calculation_hash, vector_hash,
    item_quantity, item_acres, item_unit_price_cents, item_extended_cents,
    source_share_created_by, source_share_created_at, captured_by
  )
  SELECT
    v_post_instance_id, NEW.id, NEW.invoice_group_id, v_post_sequence,
    NEW.posted_at, NEW.status, NEW.total_amount_cents, NEW.send_disposition,
    s.id, bl.billing_set_id, bs.rounding_policy_version,
    s.billing_line_id, s.invoice_item_id, s.customer_id,
    bl.line_kind, bl.price_basis, bl.product_id, bl.application_service_id, bl.description,
    bl.source_quantity, bl.source_acres, bl.source_unit_price_cents, bl.source_amount_cents, bl.sort_order,
    s.split_mode, s.split_micro_pct, s.allocated_quantity, s.allocated_acres,
    s.base_unit_price_cents, s.base_price_source, s.price_mode, s.unit_price_cents, s.amount_cents,
    s.split_override_reason, s.price_override_reason, s.calculation_hash, s.vector_hash,
    ii.quantity, ii.acres, ii.unit_price_cents, ii.extended_cents,
    s.created_by, s.created_at, auth.uid()
  FROM public.invoice_line_shares s
  JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
  JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
  JOIN public.field_app_billing_sets bs ON bs.id = bl.billing_set_id
  WHERE ii.invoice_id = NEW.id
  ORDER BY s.billing_line_id, s.customer_id;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_capture_invoice_line_share_post_snapshot()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_capture_invoice_line_share_post_snapshot ON public.invoices;
CREATE TRIGGER trg_capture_invoice_line_share_post_snapshot
  AFTER UPDATE OF status, posted_at ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_capture_invoice_line_share_post_snapshot();

COMMIT;
