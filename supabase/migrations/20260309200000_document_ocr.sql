-- ============================================================================
-- Migration: Document OCR Infrastructure
-- Description: Storage bucket for document uploads + processing log table
-- ============================================================================

-- 1. Create document-uploads storage bucket (temporary file storage for OCR)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'document-uploads',
  'document-uploads',
  false,
  10485760, -- 10MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 2. RLS policies for document-uploads bucket
-- Authenticated users can upload
CREATE POLICY "Authenticated users can upload documents"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'document-uploads');

-- Users can read their own uploads
CREATE POLICY "Users can read own document uploads"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'document-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can delete their own uploads
CREATE POLICY "Users can delete own document uploads"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'document-uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 3. Document processing log table (audit trail)
CREATE TABLE IF NOT EXISTS document_processing_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  document_type text NOT NULL CHECK (document_type IN (
    'invoice', 'purchase_order', 'price_list', 'product_list', 'customer_list', 'quote_list'
  )),
  file_name text NOT NULL,
  file_size_bytes integer,
  page_count integer,
  processing_time_ms integer,
  confidence numeric(5,2),
  items_extracted integer DEFAULT 0,
  success boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for processing log
ALTER TABLE document_processing_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own processing logs"
  ON document_processing_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can view own processing logs"
  ON document_processing_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Admin can view all processing logs
CREATE POLICY "Admins can view all processing logs"
  ON document_processing_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Index for querying processing logs
CREATE INDEX IF NOT EXISTS idx_document_processing_log_user
  ON document_processing_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_processing_log_type
  ON document_processing_log(document_type, created_at DESC);

COMMENT ON TABLE document_processing_log IS 'Audit log for Google Vision OCR document processing';
