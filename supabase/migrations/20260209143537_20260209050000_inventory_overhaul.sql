/*
  # Inventory Overhaul - Database Foundation

  1. New Tables
    - `inventory_holds`
      - `id` (uuid, primary key)
      - `product_id` (uuid, references products)
      - `customer_id` (uuid, references customers, optional)
      - `quantity` (numeric)
      - `hold_type` (text: manual or crop_program)
      - `source_id` (uuid, optional - not enforced as FK due to JSON-stored programs)
      - `notes` (text, optional)
      - `created_by` (uuid, references profiles)
      - `expires_at` (date, optional)
      - `is_active` (boolean)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Changes to Existing Tables
    - Add `is_planned` to `quotes` table

  3. Security
    - Enable RLS on `inventory_holds`
    - SELECT: All authenticated users can view holds
    - INSERT: All authenticated users can create holds
    - UPDATE: Only hold creator OR admin can update
    - DELETE: Only hold creator OR admin can delete

  4. Indexes
    - Index on product_id for active holds (query performance)
    - Index on customer_id for active holds
    - Index on created_by for permission checks
*/

-- Create inventory_holds table
CREATE TABLE IF NOT EXISTS inventory_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  hold_type text NOT NULL DEFAULT 'manual' CHECK (hold_type IN ('manual', 'crop_program')),
  source_id uuid,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  expires_at date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE inventory_holds ENABLE ROW LEVEL SECURITY;

-- RLS Policies - SELECT: all authenticated users can view
CREATE POLICY "inventory_holds_select"
  ON inventory_holds
  FOR SELECT
  TO authenticated
  USING (true);

-- RLS Policies - INSERT: all authenticated users can create
CREATE POLICY "inventory_holds_insert"
  ON inventory_holds
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

-- RLS Policies - UPDATE: only creator or admin can update
CREATE POLICY "inventory_holds_update"
  ON inventory_holds
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- RLS Policies - DELETE: only creator or admin can delete
CREATE POLICY "inventory_holds_delete"
  ON inventory_holds
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- Indexes for query performance
CREATE INDEX idx_inventory_holds_product
  ON inventory_holds(product_id)
  WHERE is_active = true;

CREATE INDEX idx_inventory_holds_customer
  ON inventory_holds(customer_id)
  WHERE is_active = true;

CREATE INDEX idx_inventory_holds_creator
  ON inventory_holds(created_by);

CREATE INDEX idx_inventory_holds_expires
  ON inventory_holds(expires_at)
  WHERE is_active = true AND expires_at IS NOT NULL;

-- Add is_planned column to quotes table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quotes'
    AND column_name = 'is_planned'
  ) THEN
    ALTER TABLE quotes ADD COLUMN is_planned boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- Create index on planned quotes for inventory calculation queries
CREATE INDEX IF NOT EXISTS idx_quotes_planned
  ON quotes(is_planned)
  WHERE is_planned = true
  AND status IN ('draft', 'sent', 'revised');