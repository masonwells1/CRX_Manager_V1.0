-- Sprint 5: PDF column presets for quote PDFs
CREATE TABLE IF NOT EXISTS quote_pdf_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quote_pdf_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pdf templates"
  ON quote_pdf_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage pdf templates"
  ON quote_pdf_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Seed 3 default presets
INSERT INTO quote_pdf_templates (template_name, columns, is_default, is_system) VALUES
  ('Program Detail', '["product", "notes", "sug_rate", "actual_rate", "acres", "qty", "price_unit", "price_per_acre"]', true, true),
  ('Simple Pricing', '["product", "notes", "price_unit", "price_per_acre"]', false, true),
  ('Summary', '["product", "qty", "total_price"]', false, true);

-- Add PDF template reference to quotes
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_template_id uuid REFERENCES quote_pdf_templates(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_columns_override jsonb;
