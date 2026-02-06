/*
  # Create Blend Tickets OCR System

  ## Overview
  This migration creates a complete blend ticket management system with OCR processing capabilities.
  Field staff can upload photos of blend tickets, which are automatically processed in the background
  to extract product information, quantities, and other data.

  ## New Tables

  ### blend_tickets
  Main table storing blend ticket metadata and extracted data
  - `id` (uuid, primary key)
  - `ticket_number` (text, unique) - Auto-generated ticket number (BT-YYYYMMDD-NNN)
  - `uploaded_by` (uuid) - User who uploaded the ticket
  - `customer_id` (uuid, nullable) - Matched or manually assigned customer
  - `upload_date` (timestamptz) - When images were uploaded
  - `ticket_date` (date, nullable) - Date extracted from ticket or manually entered
  - `status` (text) - pending, processing, completed, failed, needs_review
  - `review_status` (text) - unreviewed, approved, rejected
  - `reviewed_by` (uuid, nullable) - User who reviewed the ticket
  - `reviewed_at` (timestamptz, nullable) - When review was completed
  - `ocr_confidence_score` (numeric) - Overall confidence score (0-100)
  - `raw_ocr_text` (text, nullable) - Complete raw text extracted by OCR
  - `driver_name` (text, nullable) - Driver who delivered the blend
  - `tank_number` (text, nullable) - Tank or equipment number
  - `applicator_name` (text, nullable) - Person who applied the blend
  - `signature_detected` (boolean) - Whether a signature was found
  - `notes` (text, nullable) - Additional notes or comments
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### blend_ticket_products
  Products listed on each blend ticket
  - `id` (uuid, primary key)
  - `blend_ticket_id` (uuid) - Reference to parent ticket
  - `product_id` (uuid, nullable) - Matched product from products table
  - `product_name` (text) - Product name as extracted from OCR
  - `quantity` (numeric) - Amount of product
  - `unit` (text) - Unit of measurement (gallons, pounds, etc)
  - `lot_number` (text, nullable) - Batch/lot number
  - `sequence_order` (int) - Order product appears on ticket
  - `confidence_score` (numeric) - OCR confidence for this product (0-100)
  - `manually_corrected` (boolean) - Whether this was manually edited
  - `created_at` (timestamptz)

  ### blend_ticket_images
  Image files associated with each ticket
  - `id` (uuid, primary key)
  - `blend_ticket_id` (uuid) - Reference to parent ticket
  - `storage_path` (text) - Path in Supabase Storage
  - `image_url` (text) - Public URL to access image
  - `file_size` (bigint) - Size in bytes
  - `mime_type` (text) - Image format (image/jpeg, image/png)
  - `upload_order` (int) - Order image was uploaded
  - `width` (int, nullable) - Image width in pixels
  - `height` (int, nullable) - Image height in pixels
  - `created_at` (timestamptz)

  ### ocr_processing_queue
  Queue for managing background OCR processing
  - `id` (uuid, primary key)
  - `blend_ticket_id` (uuid) - Reference to ticket being processed
  - `status` (text) - pending, processing, completed, failed
  - `priority` (int) - Processing priority (higher = more urgent)
  - `started_at` (timestamptz, nullable) - When processing started
  - `completed_at` (timestamptz, nullable) - When processing finished
  - `error_message` (text, nullable) - Error details if failed
  - `retry_count` (int) - Number of retry attempts
  - `max_retries` (int) - Maximum allowed retries
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ## Security
  - Enable RLS on all tables
  - Allow all authenticated users to insert and view their own tickets
  - Allow all authenticated users to view all tickets (team visibility)
  - Allow admin and sales_rep roles to update and review tickets

  ## Performance
  - Indexes on status fields for efficient queue processing
  - Indexes on dates for reporting queries
  - Indexes on foreign keys for joins
*/

-- Create blend_tickets table
CREATE TABLE IF NOT EXISTS blend_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text UNIQUE NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  customer_id uuid REFERENCES customers(id),
  upload_date timestamptz NOT NULL DEFAULT now(),
  ticket_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_review')),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES profiles(id),
  reviewed_at timestamptz,
  ocr_confidence_score numeric DEFAULT 0 CHECK (ocr_confidence_score >= 0 AND ocr_confidence_score <= 100),
  raw_ocr_text text,
  driver_name text,
  tank_number text,
  applicator_name text,
  signature_detected boolean DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Create blend_ticket_products table
CREATE TABLE IF NOT EXISTS blend_ticket_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL DEFAULT '',
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  lot_number text,
  sequence_order int NOT NULL DEFAULT 0,
  confidence_score numeric DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 100),
  manually_corrected boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create blend_ticket_images table
CREATE TABLE IF NOT EXISTS blend_ticket_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  image_url text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  mime_type text NOT NULL DEFAULT 'image/jpeg',
  upload_order int NOT NULL DEFAULT 0,
  width int,
  height int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create ocr_processing_queue table
CREATE TABLE IF NOT EXISTS ocr_processing_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  priority int NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_blend_tickets_status ON blend_tickets(status);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_review_status ON blend_tickets(review_status);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_uploaded_by ON blend_tickets(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_customer_id ON blend_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_blend_tickets_upload_date ON blend_tickets(upload_date);
CREATE INDEX IF NOT EXISTS idx_blend_ticket_products_ticket_id ON blend_ticket_products(blend_ticket_id);
CREATE INDEX IF NOT EXISTS idx_blend_ticket_products_product_id ON blend_ticket_products(product_id);
CREATE INDEX IF NOT EXISTS idx_blend_ticket_images_ticket_id ON blend_ticket_images(blend_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ocr_queue_status ON ocr_processing_queue(status);
CREATE INDEX IF NOT EXISTS idx_ocr_queue_ticket_id ON ocr_processing_queue(blend_ticket_id);

-- Enable Row Level Security
ALTER TABLE blend_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE blend_ticket_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE blend_ticket_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_processing_queue ENABLE ROW LEVEL SECURITY;

-- RLS Policies for blend_tickets
CREATE POLICY "Authenticated users can view all blend tickets"
  ON blend_tickets FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert blend tickets"
  ON blend_tickets FOR INSERT
  TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "Users can update their own tickets or admin can update any"
  ON blend_tickets FOR UPDATE
  TO authenticated
  USING (
    uploaded_by = auth.uid() 
    OR EXISTS (
      SELECT 1 FROM profiles 
      WHERE profiles.id = auth.uid() 
      AND profiles.role IN ('admin', 'sales_rep')
    )
  );

-- RLS Policies for blend_ticket_products
CREATE POLICY "Authenticated users can view all blend ticket products"
  ON blend_ticket_products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert products for their tickets"
  ON blend_ticket_products FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM blend_tickets 
      WHERE blend_tickets.id = blend_ticket_id 
      AND blend_tickets.uploaded_by = auth.uid()
    )
  );

CREATE POLICY "Users can update products for their tickets or admin can update any"
  ON blend_ticket_products FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM blend_tickets 
      WHERE blend_tickets.id = blend_ticket_id 
      AND (
        blend_tickets.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM profiles 
          WHERE profiles.id = auth.uid() 
          AND profiles.role IN ('admin', 'sales_rep')
        )
      )
    )
  );

CREATE POLICY "Users can delete products for their tickets or admin can delete any"
  ON blend_ticket_products FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM blend_tickets 
      WHERE blend_tickets.id = blend_ticket_id 
      AND (
        blend_tickets.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM profiles 
          WHERE profiles.id = auth.uid() 
          AND profiles.role IN ('admin', 'sales_rep')
        )
      )
    )
  );

-- RLS Policies for blend_ticket_images
CREATE POLICY "Authenticated users can view all blend ticket images"
  ON blend_ticket_images FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert images for their tickets"
  ON blend_ticket_images FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM blend_tickets 
      WHERE blend_tickets.id = blend_ticket_id 
      AND blend_tickets.uploaded_by = auth.uid()
    )
  );

CREATE POLICY "Users can delete images for their tickets or admin can delete any"
  ON blend_ticket_images FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM blend_tickets 
      WHERE blend_tickets.id = blend_ticket_id 
      AND (
        blend_tickets.uploaded_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM profiles 
          WHERE profiles.id = auth.uid() 
          AND profiles.role IN ('admin', 'sales_rep')
        )
      )
    )
  );

-- RLS Policies for ocr_processing_queue
CREATE POLICY "Authenticated users can view all queue items"
  ON ocr_processing_queue FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "System can insert queue items"
  ON ocr_processing_queue FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "System can update queue items"
  ON ocr_processing_queue FOR UPDATE
  TO authenticated
  USING (true);

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_blend_ticket_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_blend_tickets_updated_at
  BEFORE UPDATE ON blend_tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_blend_ticket_updated_at();

CREATE TRIGGER update_ocr_queue_updated_at
  BEFORE UPDATE ON ocr_processing_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_blend_ticket_updated_at();

-- Create function to generate ticket numbers
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS text AS $$
DECLARE
  today_date text;
  sequence_num int;
  ticket_num text;
BEGIN
  today_date := to_char(CURRENT_DATE, 'YYYYMMDD');
  
  -- Get the next sequence number for today
  SELECT COALESCE(MAX(
    CAST(substring(ticket_number from 'BT-[0-9]{8}-([0-9]+)') AS int)
  ), 0) + 1
  INTO sequence_num
  FROM blend_tickets
  WHERE ticket_number LIKE 'BT-' || today_date || '-%';
  
  ticket_num := 'BT-' || today_date || '-' || lpad(sequence_num::text, 3, '0');
  RETURN ticket_num;
END;
$$ LANGUAGE plpgsql;