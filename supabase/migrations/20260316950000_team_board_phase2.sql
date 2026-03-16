-- Team Board Phase 2: Escalation Engine + Workload Visibility
-- F5: last_escalated_at column for dedup, F7: get_team_workload RPC

-- ─── F5: Escalation tracking column ───
ALTER TABLE team_notes ADD COLUMN IF NOT EXISTS last_escalated_at timestamptz;

-- ─── F7: Team Workload RPC ───
-- Returns per-member workload summary: open tasks, overdue tasks, today's deliveries
CREATE OR REPLACE FUNCTION get_team_workload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_today date := current_date;
BEGIN
  SELECT jsonb_agg(row_to_json(t) ORDER BY t.full_name)
  INTO v_result
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.role,
      -- Open tasks: assigned, not completed, not deleted
      (SELECT count(*)
       FROM team_notes tn
       WHERE tn.assigned_to = p.id
         AND tn.is_completed = false
         AND tn.deleted_at IS NULL
      )::int AS open_tasks,
      -- Overdue tasks: open + past due_date
      (SELECT count(*)
       FROM team_notes tn
       WHERE tn.assigned_to = p.id
         AND tn.is_completed = false
         AND tn.deleted_at IS NULL
         AND tn.due_date < v_today
      )::int AS overdue_tasks,
      -- Today's deliveries (drivers only, but returns 0 for non-drivers)
      (SELECT count(*)
       FROM deliveries d
       WHERE d.assigned_driver = p.id
         AND d.scheduled_date = v_today
         AND d.status IN ('scheduled', 'in_progress')
      )::int AS today_deliveries,
      -- This week's deliveries
      (SELECT count(*)
       FROM deliveries d
       WHERE d.assigned_driver = p.id
         AND d.scheduled_date >= date_trunc('week', v_today)
         AND d.scheduled_date < date_trunc('week', v_today) + interval '7 days'
         AND d.status IN ('scheduled', 'in_progress', 'completed')
      )::int AS week_deliveries
    FROM profiles p
    WHERE p.is_active = true
  ) t;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;
