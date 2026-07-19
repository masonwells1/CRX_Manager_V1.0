-- Per-line-item split billing relational integrity follow-up.
--
-- Phase 1 established the durable tables, exact 100% vectors, RLS, freeze
-- boundary, and append-only post snapshots. This additive migration closes the
-- relationships that cannot be expressed as simple CHECK constraints:
--   * every share must stay inside the billing set's exact child invoice(s);
--   * a share customer must own its child invoice;
--   * each child item must match its source/share identity, quantity, acres,
--     price, pricing unit, per-unit COGS, and extended amount;
--   * every logical line must cover the billing set's exact customer set;
--   * line quantities/acres and same-price/flat-fee cents must reconcile;
--   * every split invoice item must be represented by exactly one share; and
--   * each child invoice header must equal its sales/COGS item totals; and
--   * zero-dollar children must be suppressed while nonzero children are sendable.
-- The checks are deferred so the Phase 3 writer can build an entire graph in one
-- transaction, then are repeated synchronously before a split invoice posts.
--
-- idempotency-body-check: exempt (DDL only; no mutating RPC defined here)

BEGIN;

-- These deferred checks execute after a SECURITY DEFINER writer returns to the
-- caller. FORCE RLS therefore requires the trigger-function owner to BYPASSRLS.
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

-- Phase 1 remains byte-stable. Add the calculator's material source identity,
-- pricing unit, and per-unit COGS to the durable line and immutable post record
-- here, before any writer can persist a plan that would otherwise lose them.
ALTER TABLE public.field_app_billing_lines
  ADD COLUMN source_job_chemical_id uuid
    REFERENCES public.job_chemicals(id) ON DELETE RESTRICT,
  ADD COLUMN source_unit_size text NOT NULL,
  ADD COLUMN source_cost_cents bigint NOT NULL,
  ADD CONSTRAINT field_app_billing_lines_source_unit_ck
    CHECK (source_unit_size ~ '[^[:space:]]'),
  ADD CONSTRAINT field_app_billing_lines_source_cost_ck
    CHECK (source_cost_cents >= 0),
  ADD CONSTRAINT field_app_billing_lines_source_job_chemical_kind_ck
    CHECK (source_job_chemical_id IS NULL OR line_kind = 'chemical'),
  ADD CONSTRAINT field_app_billing_lines_application_service_kind_ck
    CHECK (application_service_id IS NULL OR line_kind = 'service');

CREATE INDEX idx_field_app_billing_lines_source_job_chemical
  ON public.field_app_billing_lines (source_job_chemical_id);
CREATE UNIQUE INDEX uq_field_app_billing_lines_set_source_job_chemical
  ON public.field_app_billing_lines (billing_set_id, source_job_chemical_id)
  WHERE source_job_chemical_id IS NOT NULL;
CREATE UNIQUE INDEX uq_field_app_billing_lines_set_application_service
  ON public.field_app_billing_lines (billing_set_id, application_service_id)
  WHERE application_service_id IS NOT NULL;

ALTER TABLE public.invoice_line_share_post_snapshots
  ADD COLUMN invoice_total_cost_cents bigint NOT NULL,
  ADD COLUMN source_job_chemical_id uuid,
  ADD COLUMN source_unit_size text NOT NULL,
  ADD COLUMN source_cost_cents bigint NOT NULL,
  ADD COLUMN item_unit_size text NOT NULL,
  ADD COLUMN item_cost_cents bigint NOT NULL;

CREATE OR REPLACE FUNCTION public._assert_per_line_split_billing_integrity(
  p_billing_set_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set public.field_app_billing_sets%ROWTYPE;
  v_bad_id uuid;
BEGIN
  IF p_billing_set_id IS NULL THEN
    RETURN;
  END IF;

  -- Every validating writer takes locks in the same order: one global advisory
  -- lock, then the durable billing-set row. This prevents two concurrent graph
  -- edits from each validating a partial view or deadlocking across many lines.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:per-line-split-billing:relational-integrity', 0)
  );

  SELECT *
    INTO v_set
    FROM public.field_app_billing_sets
   WHERE id = p_billing_set_id
   FOR UPDATE;

  -- A deleted draft set has no remaining invariant to validate.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Prove the inverse job relationship before checking the rows that do exist.
  -- Without this direction, a writer could omit an entire chemical or required
  -- application-service charge and still reconcile every remaining cent.
  IF v_set.job_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.job_chemicals jc
     WHERE jc.job_id = v_set.job_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.field_app_billing_lines bl
          WHERE bl.billing_set_id = p_billing_set_id
            AND bl.line_kind = 'chemical'
            AND bl.source_job_chemical_id = jc.id
       )
  ) THEN
    RAISE EXCEPTION
      'PER_LINE_JOB_CHEMICAL_SET_INCOMPLETE: billing set % omitted a job chemical',
      p_billing_set_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_set.job_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.jobs j
     WHERE j.id = v_set.job_id
       AND j.application_service_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.field_app_billing_lines bl
          WHERE bl.billing_set_id = p_billing_set_id
            AND bl.line_kind = 'service'
            AND bl.application_service_id = j.application_service_id
       )
  ) THEN
    RAISE EXCEPTION
      'PER_LINE_JOB_APPLICATION_SERVICE_MISSING: billing set % omitted its job application service',
      p_billing_set_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Job-backed chemical and service lines must retain the exact frozen job rows,
  -- product/service identity, pricing unit, and per-unit cost selected by the
  -- calculator. A duplicate same-product row is a different audit source and
  -- cannot be substituted after the plan is persisted.
  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
   WHERE bl.billing_set_id = p_billing_set_id
     AND (
       (
         bl.line_kind = 'chemical'
         AND v_set.job_id IS NOT NULL
         AND bl.source_job_chemical_id IS NULL
       )
       OR (
         bl.source_job_chemical_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.job_chemicals jc
            WHERE jc.id = bl.source_job_chemical_id
              AND jc.job_id = v_set.job_id
              AND jc.product_id = bl.product_id
              AND jc.unit IS NOT DISTINCT FROM bl.source_unit_size
              AND (
                CASE WHEN jc.customer_supplied
                  THEN 0
                  ELSE jc.cost_per_unit_cents
                END
              ) IS NOT DISTINCT FROM bl.source_cost_cents
         )
       )
     )
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SOURCE_JOB_CHEMICAL_MISMATCH: billing line % lost or changed its frozen job source',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
   WHERE bl.billing_set_id = p_billing_set_id
     AND bl.line_kind = 'service'
     AND v_set.job_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.jobs j
        WHERE j.id = v_set.job_id
          AND j.application_service_id IS NOT NULL
          AND j.application_service_id = bl.application_service_id
     )
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_JOB_APPLICATION_SERVICE_MISMATCH: billing line % differs from its job application service',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A share's declared customer is audit data and must agree with the customer
  -- on the invoice that owns its one-to-one child item.
  SELECT s.id
    INTO v_bad_id
    FROM public.invoice_line_shares s
    JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
    JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE bl.billing_set_id = p_billing_set_id
     AND s.customer_id IS DISTINCT FROM inv.customer_id
   ORDER BY s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SHARE_CUSTOMER_INVOICE_MISMATCH: share % customer differs from its invoice customer',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The stored item extension is authoritative on the invoice. The audit share
  -- must preserve the exact same bigint cents, including zero and negative rows.
  SELECT s.id
    INTO v_bad_id
    FROM public.invoice_line_shares s
    JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
    JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
   WHERE bl.billing_set_id = p_billing_set_id
     AND s.amount_cents IS DISTINCT FROM ii.extended_cents
   ORDER BY s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SHARE_ITEM_AMOUNT_MISMATCH: share % amount differs from its invoice item',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Customer equality alone is insufficient: a share must point inside this
  -- billing set's exact invoice group (or to an ungrouped live invoice for an
  -- ungrouped set). Otherwise same-customer invoices can be cross-wired.
  SELECT s.id
    INTO v_bad_id
    FROM public.invoice_line_shares s
    JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
    JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE bl.billing_set_id = p_billing_set_id
     AND (
       inv.deleted_at IS NOT NULL
       OR (
         v_set.invoice_group_id IS NOT NULL
         AND inv.invoice_group_id IS DISTINCT FROM v_set.invoice_group_id
       )
       OR (
         v_set.invoice_group_id IS NULL
         AND inv.invoice_group_id IS NOT NULL
       )
     )
   ORDER BY s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SHARE_INVOICE_SET_MISMATCH: share % points outside its billing set invoices',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The child item is the invoice-facing projection of its share. Preserve exact
  -- quantity and price, round only the 4dp audit acres to invoice_items.acres(12,2),
  -- and bind chemical/service identity to the logical line.
  SELECT s.id
    INTO v_bad_id
    FROM public.invoice_line_shares s
    JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
    JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE bl.billing_set_id = p_billing_set_id
     AND (
       ii.quantity IS DISTINCT FROM s.allocated_quantity
       OR ii.acres IS DISTINCT FROM round(s.allocated_acres, 2)
       OR ii.unit_price_cents IS DISTINCT FROM s.unit_price_cents
       OR ii.unit_size IS DISTINCT FROM bl.source_unit_size
       OR ii.cost_cents IS DISTINCT FROM bl.source_cost_cents
       OR (
         bl.line_kind = 'chemical'
         AND ii.product_id IS DISTINCT FROM bl.product_id
       )
       OR (
         bl.line_kind = 'service'
         AND (
           bl.application_service_id IS NULL
           OR inv.application_service_id IS DISTINCT FROM bl.application_service_id
           OR ii.product_id IS NOT NULL
         )
       )
       OR (
         bl.line_kind = 'flat_fee'
         AND ii.product_id IS NOT NULL
       )
     )
   ORDER BY s.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SHARE_ITEM_IDENTITY_MISMATCH: share % differs from its invoice item identity or pricing',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_set.invoice_group_id IS NOT NULL THEN
    -- A group is one invoice per customer. Duplicates make the exact line member
    -- vector ambiguous and are rejected before any cents can be posted.
    IF EXISTS (
      SELECT inv.customer_id
        FROM public.invoices inv
       WHERE inv.invoice_group_id = v_set.invoice_group_id
         AND inv.deleted_at IS NULL
       GROUP BY inv.customer_id
      HAVING inv.customer_id IS NULL OR count(*) <> 1
    ) THEN
      RAISE EXCEPTION
        'PER_LINE_BILLING_GROUP_CUSTOMERS_INVALID: group % must have one live invoice per customer',
        v_set.invoice_group_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_set.primary_customer_id IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.invoices inv
       WHERE inv.invoice_group_id = v_set.invoice_group_id
         AND inv.deleted_at IS NULL
         AND inv.customer_id = v_set.primary_customer_id
    ) THEN
      RAISE EXCEPTION
        'PER_LINE_PRIMARY_CUSTOMER_NOT_IN_GROUP: billing set %',
        p_billing_set_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Each logical line must have exactly the same customer set as the billing
    -- group. The UNIQUE(line, customer) constraint supplies the "exactly one".
    IF EXISTS (
      SELECT 1
        FROM public.field_app_billing_lines bl
        CROSS JOIN public.invoices inv
       WHERE bl.billing_set_id = p_billing_set_id
         AND inv.invoice_group_id = v_set.invoice_group_id
         AND inv.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.invoice_line_shares s
            WHERE s.billing_line_id = bl.id
              AND s.customer_id = inv.customer_id
         )
    ) OR EXISTS (
      SELECT 1
        FROM public.invoice_line_shares s
        JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
       WHERE bl.billing_set_id = p_billing_set_id
         AND NOT EXISTS (
           SELECT 1
             FROM public.invoices inv
            WHERE inv.invoice_group_id = v_set.invoice_group_id
              AND inv.deleted_at IS NULL
              AND inv.customer_id = s.customer_id
         )
    ) THEN
      RAISE EXCEPTION
        'PER_LINE_SHARE_CUSTOMER_SET_MISMATCH: billing set % lines must match group customers',
        p_billing_set_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- An ungrouped durable set represents one recipient. Draft sets may be empty,
    -- but once lines exist the primary customer and its one ungrouped invoice are
    -- the complete member set.
    IF EXISTS (
      SELECT 1 FROM public.field_app_billing_lines
       WHERE billing_set_id = p_billing_set_id
    ) AND v_set.primary_customer_id IS NULL THEN
      RAISE EXCEPTION
        'PER_LINE_PRIMARY_CUSTOMER_REQUIRED: ungrouped billing set %',
        p_billing_set_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.invoice_line_shares s
        JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
        JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
        JOIN public.invoices inv ON inv.id = ii.invoice_id
       WHERE bl.billing_set_id = p_billing_set_id
         AND (
           s.customer_id IS DISTINCT FROM v_set.primary_customer_id
           OR inv.customer_id IS DISTINCT FROM v_set.primary_customer_id
           OR inv.invoice_group_id IS NOT NULL
         )
    ) OR EXISTS (
      SELECT 1
        FROM public.field_app_billing_lines bl
       WHERE bl.billing_set_id = p_billing_set_id
         AND NOT EXISTS (
           SELECT 1
             FROM public.invoice_line_shares s
            WHERE s.billing_line_id = bl.id
              AND s.customer_id = v_set.primary_customer_id
         )
    ) THEN
      RAISE EXCEPTION
        'PER_LINE_SHARE_CUSTOMER_SET_MISMATCH: ungrouped billing set % must contain only its primary customer',
        p_billing_set_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF (
      SELECT count(DISTINCT ii.invoice_id)
        FROM public.invoice_line_shares s
        JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
        JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
       WHERE bl.billing_set_id = p_billing_set_id
    ) > 1 THEN
      RAISE EXCEPTION
        'PER_LINE_SHARE_INVOICE_SET_MISMATCH: ungrouped billing set % must use one child invoice',
        p_billing_set_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The set's job identity must flow to every child invoice that participates in
  -- one of its shares. NULL is deliberate for non-job billing sets.
  SELECT inv.id
    INTO v_bad_id
    FROM public.invoice_line_shares s
    JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
    JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE bl.billing_set_id = p_billing_set_id
     AND inv.job_id IS DISTINCT FROM v_set.job_id
   ORDER BY inv.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_INVOICE_JOB_MISMATCH: invoice % job differs from billing set',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Same-price and flat-fee lines preserve a canonical source total. Per-person
  -- pricing deliberately has no parent total and is therefore excluded.
  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
    LEFT JOIN public.invoice_line_shares s ON s.billing_line_id = bl.id
   WHERE bl.billing_set_id = p_billing_set_id
     AND bl.price_basis IN ('same_price', 'flat_fee')
   GROUP BY bl.id, bl.source_amount_cents
  HAVING bl.source_amount_cents IS NULL
      OR sum(s.amount_cents) IS DISTINCT FROM bl.source_amount_cents
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SOURCE_AMOUNT_MISMATCH: billing line % shares do not equal source cents',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
    LEFT JOIN public.invoice_line_shares s ON s.billing_line_id = bl.id
   WHERE bl.billing_set_id = p_billing_set_id
     AND bl.source_quantity IS NOT NULL
     AND bl.line_kind <> 'flat_fee'
   GROUP BY bl.id, bl.source_quantity
  HAVING count(*) FILTER (WHERE s.allocated_quantity IS NULL) > 0
      OR sum(s.allocated_quantity) IS DISTINCT FROM bl.source_quantity
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SOURCE_QUANTITY_MISMATCH: billing line % shares do not equal source quantity',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
    LEFT JOIN public.invoice_line_shares s ON s.billing_line_id = bl.id
   WHERE bl.billing_set_id = p_billing_set_id
     AND bl.line_kind = 'flat_fee'
   GROUP BY bl.id, bl.source_quantity
  HAVING bl.source_quantity IS DISTINCT FROM 1::numeric
      OR count(*) FILTER (WHERE s.allocated_quantity IS DISTINCT FROM 1::numeric) > 0
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_FLAT_FEE_QUANTITY_MISMATCH: billing line % and every child item must use quantity 1',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT bl.id
    INTO v_bad_id
    FROM public.field_app_billing_lines bl
    LEFT JOIN public.invoice_line_shares s ON s.billing_line_id = bl.id
   WHERE bl.billing_set_id = p_billing_set_id
     AND bl.source_acres IS NOT NULL
   GROUP BY bl.id, bl.source_acres
  HAVING count(*) FILTER (WHERE s.allocated_acres IS NULL) > 0
      OR sum(s.allocated_acres) IS DISTINCT FROM bl.source_acres
   ORDER BY bl.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_SOURCE_ACRES_MISMATCH: billing line % shares do not equal source acres',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A split child invoice is an exact projection of its share rows: no unrelated
  -- item can hide in the header total, and no share can disagree with that total.
  SELECT ii.id
    INTO v_bad_id
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE (
       (v_set.invoice_group_id IS NOT NULL
        AND inv.invoice_group_id = v_set.invoice_group_id
        AND inv.deleted_at IS NULL)
       OR (
         v_set.invoice_group_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.invoice_line_shares owning_share
             JOIN public.invoice_items owning_item
               ON owning_item.id = owning_share.invoice_item_id
             JOIN public.field_app_billing_lines owning_line
               ON owning_line.id = owning_share.billing_line_id
            WHERE owning_line.billing_set_id = p_billing_set_id
              AND owning_item.invoice_id = inv.id
         )
       )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.invoice_line_shares s
         JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
        WHERE s.invoice_item_id = ii.id
          AND bl.billing_set_id = p_billing_set_id
     )
   ORDER BY ii.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_UNSHARED_INVOICE_ITEM: invoice item % is outside its billing set graph',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT inv.id
    INTO v_bad_id
    FROM public.invoices inv
   WHERE (
       (v_set.invoice_group_id IS NOT NULL
        AND inv.invoice_group_id = v_set.invoice_group_id
        AND inv.deleted_at IS NULL)
       OR (
         v_set.invoice_group_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.invoice_line_shares s
             JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
             JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
            WHERE bl.billing_set_id = p_billing_set_id
              AND ii.invoice_id = inv.id
         )
       )
     )
     AND (
       EXISTS (
         SELECT 1 FROM public.invoice_items ii
          WHERE ii.invoice_id = inv.id AND ii.extended_cents IS NULL
       )
       OR inv.total_amount_cents IS DISTINCT FROM (
         SELECT COALESCE(sum(ii.extended_cents), 0)::bigint
           FROM public.invoice_items ii
          WHERE ii.invoice_id = inv.id
       )
     )
   ORDER BY inv.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_INVOICE_HEADER_TOTAL_MISMATCH: invoice % header differs from item cents',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Split child COGS is derived from the same frozen per-unit cost and allocated
  -- quantity as its items. Header profit/commission inputs must tie to those
  -- rows before posting just as the sales total does.
  SELECT inv.id
    INTO v_bad_id
    FROM public.invoices inv
   WHERE (
       (v_set.invoice_group_id IS NOT NULL
        AND inv.invoice_group_id = v_set.invoice_group_id
        AND inv.deleted_at IS NULL)
       OR (
         v_set.invoice_group_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.invoice_line_shares s
             JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
             JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
            WHERE bl.billing_set_id = p_billing_set_id
              AND ii.invoice_id = inv.id
         )
       )
     )
     AND inv.total_cost_cents IS DISTINCT FROM (
       SELECT COALESCE(sum(
         CASE
           WHEN bl.line_kind = 'flat_fee' THEN ii.cost_cents
           ELSE round(ii.cost_cents::numeric * ii.quantity)::bigint
         END
       ), 0)::bigint
         FROM public.invoice_items ii
         JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
         JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
        WHERE ii.invoice_id = inv.id
          AND bl.billing_set_id = p_billing_set_id
     )
   ORDER BY inv.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_INVOICE_HEADER_COST_MISMATCH: invoice % header differs from frozen item COGS',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Suppression is exact, not one-way: every $0 split child is posted and
  -- recorded but must be not-to-send; every nonzero child remains sendable.
  SELECT inv.id
    INTO v_bad_id
    FROM public.invoices inv
   WHERE (
       (v_set.invoice_group_id IS NOT NULL
        AND inv.invoice_group_id = v_set.invoice_group_id
        AND inv.deleted_at IS NULL)
       OR (
         v_set.invoice_group_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM public.invoice_line_shares s
             JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
             JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
            WHERE bl.billing_set_id = p_billing_set_id
              AND ii.invoice_id = inv.id
         )
       )
     )
     AND inv.send_disposition IS DISTINCT FROM (
       CASE WHEN inv.total_amount_cents = 0
         THEN 'suppressed_zero_total'
         ELSE 'sendable'
       END
     )
   ORDER BY inv.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'PER_LINE_INVOICE_SEND_DISPOSITION_MISMATCH: invoice % zero/sendable state is inconsistent',
      v_bad_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._assert_per_line_split_billing_integrity(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Extend Phase 1's linked-item freeze to the pricing unit and per-unit COGS.
-- Draft/unposted graphs may still be rewritten atomically; posted rows cannot
-- be relabeled or have their profit basis changed by a privileged table writer.
CREATE OR REPLACE FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_material_fields_changed boolean;
  v_not_editable boolean;
BEGIN
  v_material_fields_changed :=
    NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.acres IS DISTINCT FROM OLD.acres
    OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
    OR NEW.extended_cents IS DISTINCT FROM OLD.extended_cents
    OR NEW.unit_size IS DISTINCT FROM OLD.unit_size
    OR NEW.cost_cents IS DISTINCT FROM OLD.cost_cents;

  IF NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
     AND NOT v_material_fields_changed THEN
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
      'invoice_item % material split fields are frozen unless its split invoice is draft or unposted with no posted timestamp.',
      OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_invoice_items_shared_parent_frozen_when_posted
  ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_shared_parent_frozen_when_posted
  BEFORE UPDATE OF invoice_id, quantity, acres, unit_price_cents,
    extended_cents, unit_size, cost_cents
  ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_items_shared_parent_frozen_when_posted();

-- The logical source row is part of the same posted audit record. Lock the
-- linked items and invoices in the established item -> invoice order so a line
-- rewrite races safely with posting and cannot change source identity afterward.
CREATE OR REPLACE FUNCTION public.trg_field_app_billing_lines_frozen_when_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_not_editable boolean;
BEGIN
  PERFORM 1
    FROM public.invoice_items ii
    JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
   WHERE s.billing_line_id = OLD.id
   ORDER BY ii.id
   FOR UPDATE OF ii;

  PERFORM 1
    FROM public.invoices inv
   WHERE inv.id IN (
     SELECT ii.invoice_id
       FROM public.invoice_items ii
       JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
      WHERE s.billing_line_id = OLD.id
   )
   ORDER BY inv.id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.invoice_line_shares s
      JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
      JOIN public.invoices inv ON inv.id = ii.invoice_id
     WHERE s.billing_line_id = OLD.id
       AND (inv.status NOT IN ('draft', 'unposted') OR inv.posted_at IS NOT NULL)
  ) INTO v_not_editable;

  IF COALESCE(v_not_editable, false) THEN
    RAISE EXCEPTION
      'field_app_billing_line % is frozen while a child split invoice is posted',
      OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_field_app_billing_lines_frozen_when_posted()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_field_app_billing_lines_frozen_when_posted
  ON public.field_app_billing_lines;
CREATE TRIGGER trg_field_app_billing_lines_frozen_when_posted
  BEFORE UPDATE OR DELETE ON public.field_app_billing_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_field_app_billing_lines_frozen_when_posted();

-- Resolve the affected set from a share row. UPDATE validates both old and new
-- parents so moving a row cannot leave the source graph invalid.
CREATE OR REPLACE FUNCTION public.trg_assert_per_line_share_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_set_id uuid;
  v_new_set_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT billing_set_id INTO v_old_set_id
      FROM public.field_app_billing_lines
     WHERE id = OLD.billing_line_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT billing_set_id INTO v_new_set_id
      FROM public.field_app_billing_lines
     WHERE id = NEW.billing_line_id;
  END IF;
  PERFORM public._assert_per_line_split_billing_integrity(v_old_set_id);
  IF v_new_set_id IS DISTINCT FROM v_old_set_id THEN
    PERFORM public._assert_per_line_split_billing_integrity(v_new_set_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_share_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_invoice_line_shares_relational_integrity
  ON public.invoice_line_shares;
CREATE CONSTRAINT TRIGGER trg_invoice_line_shares_relational_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_share_integrity();

CREATE OR REPLACE FUNCTION public.trg_assert_per_line_billing_line_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public._assert_per_line_split_billing_integrity(OLD.billing_set_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND (TG_OP = 'INSERT' OR NEW.billing_set_id IS DISTINCT FROM OLD.billing_set_id) THEN
    PERFORM public._assert_per_line_split_billing_integrity(NEW.billing_set_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_billing_line_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_field_app_billing_lines_relational_integrity
  ON public.field_app_billing_lines;
CREATE CONSTRAINT TRIGGER trg_field_app_billing_lines_relational_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.field_app_billing_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_billing_line_integrity();

CREATE OR REPLACE FUNCTION public.trg_assert_per_line_item_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item_id uuid;
  v_set_id uuid;
BEGIN
  FOREACH v_item_id IN ARRAY ARRAY[
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.id END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.id END
  ]::uuid[] LOOP
    IF v_item_id IS NULL THEN CONTINUE; END IF;
    FOR v_set_id IN
      SELECT DISTINCT candidate.billing_set_id
        FROM (
          SELECT bl.billing_set_id
            FROM public.invoice_line_shares s
            JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
           WHERE s.invoice_item_id = v_item_id
          UNION
          SELECT bs.id
            FROM public.invoice_items ii
            JOIN public.invoices inv ON inv.id = ii.invoice_id
            JOIN public.field_app_billing_sets bs
              ON bs.invoice_group_id = inv.invoice_group_id
           WHERE ii.id = v_item_id
             AND inv.invoice_group_id IS NOT NULL
          UNION
          SELECT sibling_line.billing_set_id
            FROM public.invoice_items ii
            JOIN public.invoice_items sibling_item
              ON sibling_item.invoice_id = ii.invoice_id
            JOIN public.invoice_line_shares sibling_share
              ON sibling_share.invoice_item_id = sibling_item.id
            JOIN public.field_app_billing_lines sibling_line
              ON sibling_line.id = sibling_share.billing_line_id
           WHERE ii.id = v_item_id
        ) candidate
    LOOP
      PERFORM public._assert_per_line_split_billing_integrity(v_set_id);
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_item_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_invoice_items_per_line_relational_integrity
  ON public.invoice_items;
CREATE CONSTRAINT TRIGGER trg_invoice_items_per_line_relational_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_item_integrity();

CREATE OR REPLACE FUNCTION public.trg_assert_per_line_invoice_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice_id uuid;
  v_group_id uuid;
  v_set_id uuid;
BEGIN
  FOREACH v_invoice_id IN ARRAY ARRAY[
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.id END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.id END
  ]::uuid[] LOOP
    IF v_invoice_id IS NULL THEN CONTINUE; END IF;
    FOR v_set_id IN
      SELECT DISTINCT candidate.billing_set_id
        FROM (
          SELECT bl.billing_set_id
            FROM public.invoice_items ii
            JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
            JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
           WHERE ii.invoice_id = v_invoice_id
          UNION
          SELECT bs.id
            FROM public.field_app_billing_sets bs
            JOIN public.invoices inv ON inv.invoice_group_id = bs.invoice_group_id
           WHERE inv.id = v_invoice_id
             AND bs.invoice_group_id IS NOT NULL
        ) candidate
    LOOP
      PERFORM public._assert_per_line_split_billing_integrity(v_set_id);
    END LOOP;
  END LOOP;

  -- On UPDATE, also validate a set attached to the old group after the invoice
  -- leaves it; the current-row lookup above can no longer discover that group.
  IF TG_OP = 'UPDATE' AND OLD.invoice_group_id IS DISTINCT FROM NEW.invoice_group_id THEN
    FOREACH v_group_id IN ARRAY ARRAY[OLD.invoice_group_id, NEW.invoice_group_id]::uuid[] LOOP
      IF v_group_id IS NULL THEN CONTINUE; END IF;
      FOR v_set_id IN
        SELECT id FROM public.field_app_billing_sets WHERE invoice_group_id = v_group_id
      LOOP
        PERFORM public._assert_per_line_split_billing_integrity(v_set_id);
      END LOOP;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_invoice_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_invoices_per_line_relational_integrity ON public.invoices;
CREATE CONSTRAINT TRIGGER trg_invoices_per_line_relational_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_invoice_integrity();

CREATE OR REPLACE FUNCTION public.trg_assert_per_line_billing_set_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public._assert_per_line_split_billing_integrity(OLD.id);
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public._assert_per_line_split_billing_integrity(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_billing_set_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_field_app_billing_sets_relational_integrity
  ON public.field_app_billing_sets;
CREATE CONSTRAINT TRIGGER trg_field_app_billing_sets_relational_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.field_app_billing_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_billing_set_integrity();

-- Repeat the complete graph validation synchronously before the Phase 1 AFTER
-- trigger captures an immutable post snapshot. Ordinary invoices have no set and
-- return immediately without changing their legacy posting behavior.
CREATE OR REPLACE FUNCTION public.trg_assert_per_line_integrity_before_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set_id uuid;
BEGIN
  IF NEW.status NOT IN ('posted', 'paid', 'overdue', 'voided')
     OR NEW.posted_at IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_set_id IN
    SELECT DISTINCT candidate.billing_set_id
      FROM (
        SELECT bl.billing_set_id
          FROM public.invoice_items ii
          JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
          JOIN public.field_app_billing_lines bl ON bl.id = s.billing_line_id
         WHERE ii.invoice_id = NEW.id
        UNION
        SELECT bs.id
          FROM public.field_app_billing_sets bs
         WHERE bs.invoice_group_id = NEW.invoice_group_id
           AND NEW.invoice_group_id IS NOT NULL
      ) candidate
  LOOP
    PERFORM public._assert_per_line_split_billing_integrity(v_set_id);
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_assert_per_line_integrity_before_post()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_00_assert_per_line_integrity_before_post ON public.invoices;
CREATE TRIGGER trg_00_assert_per_line_integrity_before_post
  BEFORE UPDATE OF status, posted_at ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_per_line_integrity_before_post();

-- Replace Phase 1's capture body so the immutable record includes the material
-- source and item fields added above. The existing AFTER trigger automatically
-- calls this exact body on every new post instance.
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
  IF NOT EXISTS (
    SELECT 1
      FROM public.invoice_line_shares s
      JOIN public.invoice_items ii ON ii.id = s.invoice_item_id
     WHERE ii.invoice_id = NEW.id
  ) THEN
    RETURN NULL;
  END IF;

  v_requires_post_timestamp := NEW.status IN ('posted','paid','overdue','voided');
  v_creates_post_snapshot := NEW.status IN ('posted','paid','overdue');
  IF v_requires_post_timestamp IS DISTINCT FROM (NEW.posted_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'split invoice % requires posted/voided status and posted_at to agree',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_creates_post_snapshot
     OR (OLD.status IN ('posted','paid','overdue') AND OLD.posted_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(MAX(h.post_sequence), 0) + 1
    INTO v_post_sequence
    FROM public.invoice_line_share_post_snapshots h
   WHERE h.invoice_id = NEW.id;

  INSERT INTO public.invoice_line_share_post_snapshots (
    post_instance_id, invoice_id, invoice_group_id, post_sequence,
    posted_at, post_status, invoice_total_amount_cents, invoice_total_cost_cents,
    send_disposition,
    source_share_id, billing_set_id, rounding_policy_version,
    billing_line_id, invoice_item_id, customer_id,
    line_kind, price_basis, product_id, application_service_id,
    source_job_chemical_id, description,
    source_quantity, source_acres, source_unit_price_cents, source_amount_cents,
    source_unit_size, source_cost_cents, sort_order,
    split_mode, split_micro_pct, allocated_quantity, allocated_acres,
    base_unit_price_cents, base_price_source, price_mode, unit_price_cents, amount_cents,
    split_override_reason, price_override_reason, calculation_hash, vector_hash,
    item_quantity, item_acres, item_unit_price_cents, item_extended_cents,
    item_unit_size, item_cost_cents,
    source_share_created_by, source_share_created_at, captured_by
  )
  SELECT
    v_post_instance_id, NEW.id, NEW.invoice_group_id, v_post_sequence,
    NEW.posted_at, NEW.status, NEW.total_amount_cents, NEW.total_cost_cents,
    NEW.send_disposition,
    s.id, bl.billing_set_id, bs.rounding_policy_version,
    s.billing_line_id, s.invoice_item_id, s.customer_id,
    bl.line_kind, bl.price_basis, bl.product_id, bl.application_service_id,
    bl.source_job_chemical_id, bl.description,
    bl.source_quantity, bl.source_acres, bl.source_unit_price_cents, bl.source_amount_cents,
    bl.source_unit_size, bl.source_cost_cents, bl.sort_order,
    s.split_mode, s.split_micro_pct, s.allocated_quantity, s.allocated_acres,
    s.base_unit_price_cents, s.base_price_source, s.price_mode, s.unit_price_cents, s.amount_cents,
    s.split_override_reason, s.price_override_reason, s.calculation_hash, s.vector_hash,
    ii.quantity, ii.acres, ii.unit_price_cents, ii.extended_cents,
    ii.unit_size, ii.cost_cents,
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
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
