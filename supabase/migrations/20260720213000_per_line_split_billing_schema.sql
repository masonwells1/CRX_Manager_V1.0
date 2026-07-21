-- ============================================================================
-- PER-LINE SPLIT BILLING — ADDITIVE SCHEMA (flag-gated, behavior-neutral)
-- CRX Manager V1.0
-- Date: 2026-07-18
-- Spec: docs/plans/per-line-item-split-billing-spec-2026-07-17.md
--
-- WHAT
--   Adds the storage layer for the future per-line split-billing feature:
--   a field-application "billing set" (the group of billable lines produced by
--   one job), its individual billing lines, a per (billing line x customer)
--   allocation snapshot (invoice_line_shares), and an append-only post-time
--   history table (invoice_line_share_snapshots). Also adds three additive
--   marker columns on invoices/invoice_items.
--
-- WHY
--   The per-line model lets a single field application be split across multiple
--   growers line-by-line (each line can carry its own percentage AND its own
--   per-person price), then frozen when the invoice posts — mirroring how
--   order_shares/invoice_shares already work, but at line granularity.
--
-- BEHAVIOR CHANGE: NONE.
--   This migration is purely additive. Nothing reads or writes these tables
--   until the split calculator + the SECURITY DEFINER posting RPC land behind a
--   feature flag in a later migration. Existing invoicing is untouched:
--     * new tables start empty
--     * the new invoice/invoice_items columns are nullable / carry a neutral
--       default ('normal') that matches today's behavior
--   Money is bigint cents throughout. We never touch invoices.balance_cents
--   (a generated column).
--
-- IMMUTABILITY
--   invoice_line_shares are frozen while their parent invoice is posted/paid/
--   overdue via prevent_invoice_line_shares_edit_after_post(), copied from
--   prevent_order_shares_edit_after_post() (2026-05-04). Unposting reopens them.
--
-- SECURITY
--   RLS is enabled on all four new tables with SELECT-only policies scoped
--   through the linked invoice (mirroring invoice_shares_select). There are NO
--   INSERT/UPDATE/DELETE policies for authenticated: all writes flow through a
--   SECURITY DEFINER RPC / service_role. INSERT/UPDATE/DELETE are explicitly
--   revoked from authenticated & anon; SELECT is granted to authenticated.
-- ============================================================================

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- 1a. field_app_billing_sets — one row per field application that is being
--     billed via the per-line engine. Optionally traces back to the source job.
CREATE TABLE IF NOT EXISTS field_app_billing_sets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_group_id  uuid,
  source_job_id     uuid REFERENCES jobs(id),
  created_by        uuid REFERENCES profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 1b. field_app_billing_lines — the individual billable lines within a set
--     (a chemical, a service, a fuel surcharge, or a flat fee). These hold the
--     un-split "source" quantity/price before any per-customer allocation.
CREATE TABLE IF NOT EXISTS field_app_billing_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_set_id          uuid NOT NULL REFERENCES field_app_billing_sets(id) ON DELETE CASCADE,
  line_kind               text NOT NULL
                            CHECK (line_kind IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee')),
  product_id              uuid REFERENCES products(id),
  application_service_id  uuid REFERENCES application_services(id),
  description             text,
  source_quantity         numeric(12,4),
  source_acres            numeric(12,4),   -- Codex r4 P2 #10: the line's source applied-acre basis (service lines carry acres, not a product quantity) so post-time verification has an acre basis; NULL for pure chemical/flat lines
  source_unit_price_cents bigint,
  source_line_cents       bigint,
  sort_order              integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- 1c. invoice_line_shares — the per (billing line x customer) allocation
--     snapshot. One row per customer share of one billing line, bound 1:1 to
--     the invoice_item it produced. split_micro_pct is stored as micro-percent
--     (100000000 = 100.000000%) so splits stay integer-exact. Every money value
--     is bigint cents. base_* captures the pre-override price, unit_price_cents
--     the effective (possibly overridden) price, amount_cents the final line.
CREATE TABLE IF NOT EXISTS invoice_line_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_line_id       uuid NOT NULL REFERENCES field_app_billing_lines(id) ON DELETE CASCADE,
  invoice_item_id       uuid NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  customer_id           uuid NOT NULL REFERENCES customers(id),
  split_mode            text NOT NULL
                          CHECK (split_mode IN ('field_default', 'custom')),
  split_micro_pct       integer NOT NULL
                          CHECK (split_micro_pct >= 0 AND split_micro_pct <= 100000000),
  allocated_quantity    numeric(12,4),
  allocated_acres       numeric(12,4),   -- (12,4): authoritative allocation store for largest-remainder residual (spec §4 / readiness #2); invoice_items.acres stays 2dp display-only
  base_unit_price_cents bigint NOT NULL,
  base_price_source     text NOT NULL
                          CHECK (base_price_source IN (
                            'manual', 'quoted', 'tier', 'service_rate',
                            'service_default', 'grower_share', 'flat'
                          )),
  price_mode            text NOT NULL DEFAULT 'default'
                          CHECK (price_mode IN ('default', 'override')),
  unit_price_cents      bigint NOT NULL,
  amount_cents          bigint NOT NULL,
  split_override_reason text,
  price_override_reason text,
  calculation_hash      text NOT NULL,
  vector_hash           text NOT NULL,
  created_by            uuid NOT NULL REFERENCES profiles(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_item_id),
  UNIQUE (billing_line_id, customer_id)
);

-- 1d. invoice_line_share_snapshots — append-only history written at post time
--     by a later RPC. Created here (empty) so the schema is ready; nothing
--     populates it yet.
CREATE TABLE IF NOT EXISTS invoice_line_share_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,  -- append-only audit: a hard invoice delete must not silently erase post history
  billing_line_id     uuid,
  customer_id         uuid NOT NULL REFERENCES customers(id),
  posted_at           timestamptz NOT NULL DEFAULT now(),
  split_micro_pct     integer NOT NULL,
  allocated_quantity  numeric(12,4),
  allocated_acres     numeric(12,4),   -- Codex r4 P2: match invoice_line_shares.allocated_acres (12,4); a (,2) column silently rounded 0.3334 -> 0.33 in the post history
  unit_price_cents    bigint NOT NULL,
  amount_cents        bigint NOT NULL,
  -- Codex r4 P1 #8: self-contained line identity. post/unpost/re-save DELETEs the
  -- billing lines + invoice_items, leaving billing_line_id dangling; capture what the
  -- snapshot line WAS (product / service / description / kind) so the post history is
  -- readable without the now-deleted source rows. Nullable: pre-fix rows have none.
  line_kind              text,
  product_id             uuid,
  application_service_id uuid,
  line_description       text,
  -- Codex round-7 P2: full override/pricing provenance so the posted allocation stays auditable AFTER
  -- a post->unpost->re-save deletes the live invoice_line_shares + billing lines (the snapshot is then
  -- the only durable history). Nullable: pre-fix snapshot rows have none.
  base_unit_price_cents  bigint,
  base_price_source      text,
  split_mode             text,
  price_mode             text,
  split_override_reason  text,
  price_override_reason  text,
  calculation_hash       text,
  vector_hash            text,
  snapshot_reason     text NOT NULL DEFAULT 'post',
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. ADDITIVE COLUMNS ON EXISTING TABLES
-- ============================================================================
-- Marker on invoice_items: when set, the item was produced by a split billing
-- line, and the InvoiceDetail editor should lock it (wired later).
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS billing_line_id uuid REFERENCES field_app_billing_lines(id);

-- Invoice-level markers: how a fully-suppressed ($0) split invoice should be
-- treated, and a back-link to the billing set that produced it.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS send_disposition text NOT NULL DEFAULT 'normal'
    CHECK (send_disposition IN ('normal', 'suppressed_zero_total')),
  ADD COLUMN IF NOT EXISTS field_app_billing_set_id uuid REFERENCES field_app_billing_sets(id);

-- ============================================================================
-- 3. INDEXES (FK-supporting)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_fab_lines_set
  ON field_app_billing_lines(billing_set_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_billing_line
  ON invoice_line_shares(billing_line_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_invoice_item
  ON invoice_line_shares(invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_shares_customer
  ON invoice_line_shares(customer_id);
CREATE INDEX IF NOT EXISTS idx_ilss_invoice
  ON invoice_line_share_snapshots(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ilss_customer
  ON invoice_line_share_snapshots(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_field_app_billing_set
  ON invoices(field_app_billing_set_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_billing_line
  ON invoice_items(billing_line_id);

-- ============================================================================
-- 4. ROW LEVEL SECURITY — SELECT-only, scoped through the linked invoice
-- ============================================================================
-- Mirrors invoice_shares_select (2026-02-19): a row is visible when the linked
-- invoice is visible to the caller (admin, or the invoice's creator/salesman).
-- No INSERT/UPDATE/DELETE policies exist for authenticated: all writes go
-- through a SECURITY DEFINER RPC / service_role, which bypasses RLS.

ALTER TABLE field_app_billing_sets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_app_billing_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_shares           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_share_snapshots  ENABLE ROW LEVEL SECURITY;

-- field_app_billing_sets: admin OR a linked invoice (via field_app_billing_set_id)
-- is visible to the caller.
DROP POLICY IF EXISTS field_app_billing_sets_select ON field_app_billing_sets;
CREATE POLICY field_app_billing_sets_select ON field_app_billing_sets
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.field_app_billing_set_id = field_app_billing_sets.id
        AND i.deleted_at IS NULL
        AND (i.created_by = (select auth.uid()) OR i.salesman_id = (select auth.uid()))
    )
  );

-- field_app_billing_lines: admin OR a linked invoice (via the parent set) is
-- visible to the caller.
DROP POLICY IF EXISTS field_app_billing_lines_select ON field_app_billing_lines;
CREATE POLICY field_app_billing_lines_select ON field_app_billing_lines
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.field_app_billing_set_id = field_app_billing_lines.billing_set_id
        AND i.deleted_at IS NULL
        AND (i.created_by = (select auth.uid()) OR i.salesman_id = (select auth.uid()))
    )
  );

-- invoice_line_shares: scope via invoice_item -> invoice, exactly like
-- invoice_shares_select.
DROP POLICY IF EXISTS invoice_line_shares_select ON invoice_line_shares;
CREATE POLICY invoice_line_shares_select ON invoice_line_shares
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.id = invoice_line_shares.invoice_item_id
        AND i.deleted_at IS NULL
        AND (
          public.is_admin()
          OR i.created_by = (select auth.uid())
          OR i.salesman_id = (select auth.uid())
        )
    )
  );

-- invoice_line_share_snapshots: scope via invoice_id directly.
DROP POLICY IF EXISTS invoice_line_share_snapshots_select ON invoice_line_share_snapshots;
CREATE POLICY invoice_line_share_snapshots_select ON invoice_line_share_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_line_share_snapshots.invoice_id
        AND i.deleted_at IS NULL
        AND (
          public.is_admin()
          OR i.created_by = (select auth.uid())
          OR i.salesman_id = (select auth.uid())
        )
    )
  );

-- ============================================================================
-- 5. EXPLICIT GRANTS — reads only for authenticated; no direct writes
-- ============================================================================
REVOKE INSERT, UPDATE, DELETE ON
  field_app_billing_sets,
  field_app_billing_lines,
  invoice_line_shares,
  invoice_line_share_snapshots
FROM authenticated, anon;

-- Also strip anon's default SELECT so the grant layer matches intent (RLS already
-- default-denies anon since every policy is TO authenticated, but keep it airtight).
REVOKE SELECT ON
  field_app_billing_sets,
  field_app_billing_lines,
  invoice_line_shares,
  invoice_line_share_snapshots
FROM anon;

GRANT SELECT ON
  field_app_billing_sets,
  field_app_billing_lines,
  invoice_line_shares,
  invoice_line_share_snapshots
TO authenticated;

-- ============================================================================
-- 6. IMMUTABILITY TRIGGER — freeze shares while the parent invoice is posted
-- ============================================================================
-- Copied from prevent_order_shares_edit_after_post() (2026-05-04). Resolves the
-- parent invoice via invoice_item_id -> invoice_items.invoice_id -> invoices,
-- and rejects any INSERT/UPDATE/DELETE while that invoice is posted/paid/overdue.
-- Drafts and unposted invoices stay editable; unposting naturally reopens the
-- shares. Defense-in-depth: the UI locks the editor in the same case.
CREATE OR REPLACE FUNCTION public.prevent_invoice_line_shares_edit_after_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_blocking_inv    text;
BEGIN
  -- Check BOTH the pre-image (OLD) and post-image (NEW) item's invoice, so an
  -- UPDATE cannot remap a share off a posted invoice onto a draft one and slip
  -- through. Reference each record ONLY for the operation where it is assigned
  -- (NEW on INSERT/UPDATE, OLD on UPDATE/DELETE) via a TG_OP guard, so the
  -- expression is unambiguous — a NULL for the non-applicable side never matches.
  -- (Codex round-9: the direct IN(NEW.x, OLD.x) form is already NULL-safe in
  -- PL/pgSQL — proven in live PG — but the explicit guard removes the reviewer flag.)
  SELECT i.invoice_number
    INTO v_blocking_inv
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
   WHERE ii.id IN (
           CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_item_id END,
           CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_item_id END)
     AND i.deleted_at IS NULL
     AND i.status IN ('posted', 'paid', 'overdue')
   LIMIT 1;

  IF v_blocking_inv IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot modify line split — invoice % is already posted. Unpost or void the invoice first.',
      v_blocking_inv
      USING ERRCODE = 'check_violation';
  END IF;

  -- INSERT / UPDATE return NEW; DELETE returns OLD
  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_line_shares_lock_when_posted ON public.invoice_line_shares;
CREATE TRIGGER trg_invoice_line_shares_lock_when_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_line_shares
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_invoice_line_shares_edit_after_post();

COMMENT ON FUNCTION public.prevent_invoice_line_shares_edit_after_post() IS
  'Blocks INSERT/UPDATE/DELETE on invoice_line_shares when the parent invoice (via invoice_item_id) is posted/paid/overdue. Freezes the per-line split snapshot while posted; unposting reopens it. Copied from prevent_order_shares_edit_after_post().';

-- Deliberate grants (CRX hard rule): this SECURITY DEFINER function is a trigger
-- body only — never invoked directly — so no role needs EXECUTE. Revoke the
-- default PUBLIC EXECUTE as defense-in-depth (B7/B8/B9 anon-SECDEF class).
REVOKE EXECUTE ON FUNCTION public.prevent_invoice_line_shares_edit_after_post() FROM anon, PUBLIC;

-- ============================================================================
-- 7. TABLE COMMENTS
-- ============================================================================
COMMENT ON TABLE field_app_billing_sets IS
  'Per-line split billing: one row per field application billed via the per-line engine (optionally traced to source job). Additive/flag-gated — unused until the split RPC lands.';
COMMENT ON TABLE field_app_billing_lines IS
  'Per-line split billing: individual billable lines (chemical/service/fuel_surcharge/flat_fee) within a billing set, holding the un-split source quantity and price. Money is bigint cents.';
COMMENT ON TABLE invoice_line_shares IS
  'Per-line split billing: per (billing line x customer) allocation snapshot, bound 1:1 to the invoice_item it produced. split_micro_pct is integer micro-percent (100000000 = 100%). Frozen while the parent invoice is posted. Money is bigint cents.';
COMMENT ON TABLE invoice_line_share_snapshots IS
  'Per-line split billing: append-only post-time history of line shares. Created empty here; populated by the posting RPC in a later migration. Money is bigint cents.';

-- ============================================================================
-- DONE — additive, flag-gated, no behavior change until the calculator + RPC land.
-- ============================================================================
