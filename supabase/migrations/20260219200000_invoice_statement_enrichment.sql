-- ============================================================================
-- INVOICE & STATEMENT PDF ENRICHMENT
-- CRX Manager V1.0
-- Date: 2026-02-19
--
-- Enriches invoices, invoice_items, and customers to support detailed PDF
-- generation matching legacy Chem-Man output:
--   1. Customer structured address + account numbers
--   2. Invoice header enrichment (crop, fields, applicator, vehicle)
--   3. Invoice item enrichment (EPA, rates, GL/LB conversion)
--   4. Invoice shares table (grower split display)
--   5. Type-aware invoice numbering (INV-/CS-/MC-)
-- ============================================================================

-- ============================================================================
-- 1. CUSTOMER ADDRESS STRUCTURE & ACCOUNT NUMBERS
-- ============================================================================
-- The existing customers table has billing_address as a single text field.
-- Add structured fields for reliable PDF formatting. Also add account_number
-- for statement display (e.g., "Acct Nbr: 194358").

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS shipping_address text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS account_number text;

-- Auto-generate account numbers for existing customers that don't have one
CREATE SEQUENCE IF NOT EXISTS customer_account_number_seq START 100001;

-- Backfill existing customers with sequential account numbers
UPDATE customers
SET account_number = nextval('customer_account_number_seq')::text
WHERE account_number IS NULL;

-- Default for new customers
ALTER TABLE customers
  ALTER COLUMN account_number SET DEFAULT nextval('customer_account_number_seq')::text;

CREATE INDEX IF NOT EXISTS idx_customers_account_number ON customers(account_number);

-- ============================================================================
-- 2. INVOICE HEADER ENRICHMENT
-- ============================================================================
-- Snapshot data from jobs for historical accuracy on invoices.
-- Once an invoice is created, these values should never change even if the
-- source job/product/field data is later modified.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS crop_type text,
  ADD COLUMN IF NOT EXISTS field_names text[],
  ADD COLUMN IF NOT EXISTS total_acres numeric(12,2),
  ADD COLUMN IF NOT EXISTS applicator_name text,
  ADD COLUMN IF NOT EXISTS vehicle_name text,
  ADD COLUMN IF NOT EXISTS application_date date,
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id),
  ADD COLUMN IF NOT EXISTS total_cost_cents bigint DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoices_job_id ON invoices(job_id);

-- ============================================================================
-- 3. INVOICE ITEM ENRICHMENT
-- ============================================================================
-- Add product detail snapshots to invoice line items for PDF display.
-- These are captured at invoice creation time from the source product record.

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS rate_unit text,
  ADD COLUMN IF NOT EXISTS total_applied numeric(12,4),
  ADD COLUMN IF NOT EXISTS total_applied_unit text,
  ADD COLUMN IF NOT EXISTS total_applied_gl_lb numeric(12,4),
  ADD COLUMN IF NOT EXISTS gl_lb_unit text,
  ADD COLUMN IF NOT EXISTS epa_registration text,
  ADD COLUMN IF NOT EXISTS product_form text,
  ADD COLUMN IF NOT EXISTS is_application_fee boolean DEFAULT false;

-- ============================================================================
-- 4. INVOICE SHARES TABLE
-- ============================================================================
-- Denormalized per-invoice grower split summary for PDF display.
-- This is simpler to query than aggregating invoice_line_allocations and
-- provides a historical snapshot of who was billed what percentage.

CREATE TABLE IF NOT EXISTS invoice_shares (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id),
  customer_name       text NOT NULL,
  split_percentage    numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
  acres               numeric(12,2),
  amount_cents        bigint NOT NULL,
  is_primary          boolean DEFAULT false,
  sort_order          integer DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_shares_invoice ON invoice_shares(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_shares_customer ON invoice_shares(customer_id);

-- RLS policies for invoice_shares (mirrors invoice_items access)
ALTER TABLE invoice_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_shares_select" ON invoice_shares
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shares.invoice_id
        AND i.deleted_at IS NULL
        AND (
          public.is_admin()
          OR i.created_by = auth.uid()
          OR i.salesman_id = auth.uid()
        )
    )
  );

CREATE POLICY "invoice_shares_insert" ON invoice_shares
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

CREATE POLICY "invoice_shares_update" ON invoice_shares
  FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "invoice_shares_delete" ON invoice_shares
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ============================================================================
-- 5. TYPE-AWARE INVOICE NUMBERING
-- ============================================================================
-- Different prefix per invoice type:
--   field_application → INV-YYYY-NNNN
--   chemical_sale     → CS-YYYY-NNNN
--   misc_charge       → MC-YYYY-NNNN

CREATE SEQUENCE IF NOT EXISTS cs_invoice_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS mc_invoice_number_seq START 1;

-- Replace the existing next_invoice_number() with a type-aware version.
-- The original function (no args) is preserved as a fallback and now
-- delegates to the new version with 'field_application' default.

CREATE OR REPLACE FUNCTION next_invoice_number(p_invoice_type text DEFAULT 'field_application')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text := extract(year FROM now())::text;
  v_seq  int;
  v_prefix text;
BEGIN
  CASE p_invoice_type
    WHEN 'chemical_sale' THEN
      v_prefix := 'CS';
      v_seq := nextval('cs_invoice_number_seq');
    WHEN 'misc_charge' THEN
      v_prefix := 'MC';
      v_seq := nextval('mc_invoice_number_seq');
    ELSE
      -- field_application or any other type
      v_prefix := 'INV';
      v_seq := nextval('invoice_number_seq');
  END CASE;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

-- ============================================================================
-- 6. GL/LB CONVERSION HELPER (Database-side)
-- ============================================================================
-- Pure function to convert total applied quantity to gallons (liquid) or
-- pounds (dry) based on the rate unit and product form.

CREATE OR REPLACE FUNCTION convert_to_gl_lb(
  p_total_applied numeric,
  p_rate_unit text,
  p_product_form text
)
RETURNS TABLE(converted_value numeric, converted_unit text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_total_applied IS NULL OR p_rate_unit IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;

  IF p_product_form = 'dry' THEN
    -- Convert to LB
    converted_unit := 'LB';
    CASE upper(p_rate_unit)
      WHEN 'OZ' THEN converted_value := p_total_applied / 16.0;
      WHEN 'LB' THEN converted_value := p_total_applied;
      ELSE converted_value := p_total_applied;
    END CASE;
  ELSE
    -- Liquid: Convert to GL
    converted_unit := 'GL';
    CASE upper(p_rate_unit)
      WHEN 'OZ' THEN converted_value := p_total_applied / 128.0;
      WHEN 'PT' THEN converted_value := p_total_applied / 8.0;
      WHEN 'QT' THEN converted_value := p_total_applied / 4.0;
      WHEN 'GL' THEN converted_value := p_total_applied;
      ELSE converted_value := p_total_applied / 128.0;
    END CASE;
  END IF;

  RETURN NEXT;
END;
$$;

-- ============================================================================
-- DONE
-- ============================================================================
