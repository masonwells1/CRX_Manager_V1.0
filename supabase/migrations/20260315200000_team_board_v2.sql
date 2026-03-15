-- ============================================================
-- Team Board V2: Entity Linking, Attachments, Delivery RPCs
-- ============================================================

-- 1. Add entity linking columns to team_notes
ALTER TABLE team_notes
  ADD COLUMN IF NOT EXISTS linked_entity_type text,
  ADD COLUMN IF NOT EXISTS linked_entity_id uuid;

CREATE INDEX IF NOT EXISTS idx_team_notes_entity
  ON team_notes (linked_entity_type, linked_entity_id)
  WHERE linked_entity_type IS NOT NULL;

-- 2. Create team_note_attachments table
CREATE TABLE IF NOT EXISTS team_note_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size_bytes bigint NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_note_attachments_note
  ON team_note_attachments(note_id);

-- RLS for team_note_attachments
ALTER TABLE team_note_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view all attachments"
  ON team_note_attachments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert own attachments"
  ON team_note_attachments FOR INSERT
  TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "Users can delete own attachments or admin can delete any"
  ON team_note_attachments FOR DELETE
  TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 3. Storage bucket for team note attachments
INSERT INTO storage.buckets (id, name, public)
VALUES ('team-note-attachments', 'team-note-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Authenticated users can upload team note attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'team-note-attachments');

CREATE POLICY "Anyone can view team note attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'team-note-attachments');

CREATE POLICY "Users can delete own team note attachments"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'team-note-attachments'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    )
  );

-- 4. RPC: get_team_board_deliveries()
-- Returns today's + tomorrow's deliveries, role-aware
CREATE OR REPLACE FUNCTION get_team_board_deliveries()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_today date := CURRENT_DATE;
  v_tomorrow date := CURRENT_DATE + 1;
  v_result jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id;

  SELECT jsonb_build_object(
    'today', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          del.delivery_address,
          del.delivery_notes,
          c.name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver,
          (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id) AS item_count
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_today
          AND del.status IN ('scheduled', 'in_progress')
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'tomorrow', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          del.delivery_address,
          c.name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_tomorrow
          AND del.status = 'scheduled'
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'unassigned_count', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status = 'scheduled'
        AND assigned_driver IS NULL
    ),
    'today_total', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status IN ('scheduled', 'in_progress')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 5. RPC: get_yesterday_delivery_recap()
CREATE OR REPLACE FUNCTION get_yesterday_delivery_recap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_yesterday date := CURRENT_DATE - 1;
  v_result jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id;

  SELECT jsonb_build_object(
    'completed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.name,
        'driver_name', p.full_name,
        'completed_at', del.updated_at,
        'item_count', (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id),
        'has_issues', (del.issue_type IS NOT NULL)
      ) ORDER BY del.updated_at)
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.name,
        'driver_name', p.full_name,
        'issue_type', del.issue_type,
        'issue_description', del.issue_description
      ))
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_completed', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_with_issues', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_cancelled', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status IN ('cancelled', 'voided')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 6. RPC: get_notes_for_entity(p_entity_type, p_entity_id)
CREATE OR REPLACE FUNCTION get_notes_for_entity(
  p_entity_type text,
  p_entity_id uuid
)
RETURNS SETOF team_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT tn.*
    FROM team_notes tn
    WHERE tn.linked_entity_type = p_entity_type
      AND tn.linked_entity_id = p_entity_id
      AND tn.deleted_at IS NULL
    ORDER BY tn.is_pinned DESC, tn.created_at DESC;
END;
$$;
