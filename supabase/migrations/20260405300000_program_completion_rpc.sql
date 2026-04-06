-- Migration: Program Completion RPC
-- Returns program completion data for the Program Tracker dashboard.
-- Joins planned quotes -> sections -> jobs -> blend tickets to calculate
-- planned vs actual acres and completion status.

CREATE OR REPLACE FUNCTION get_program_completion(
  p_season integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer;
  v_result jsonb;
BEGIN
  -- Default to current season (Oct 1 - Sep 30)
  IF p_season IS NULL THEN
    v_season := current_season();
  ELSE
    v_season := p_season;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.customer_name, t.program_name), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      q.customer_id,
      c.farm_name AS customer_name,
      q.id AS quote_id,
      q.quote_number,
      qs.id AS section_id,
      qs.section_name AS program_name,
      qs.needed_by_date,
      COALESCE(MAX(qi.acres), 0) AS planned_acres,
      COALESCE(
        (SELECT SUM(btf.actual_acres)
         FROM jobs j2
         JOIN blend_tickets bt ON bt.job_id = j2.id
         JOIN blend_ticket_fields btf ON btf.blend_ticket_id = bt.id
         WHERE j2.quote_section_id = qs.id
           AND j2.deleted_at IS NULL),
        0
      ) AS completed_acres,
      CASE
        WHEN MAX(qi.acres) IS NULL OR MAX(qi.acres) = 0 THEN 0
        ELSE ROUND(
          COALESCE(
            (SELECT SUM(btf.actual_acres)
             FROM jobs j2
             JOIN blend_tickets bt ON bt.job_id = j2.id
             JOIN blend_ticket_fields btf ON btf.blend_ticket_id = bt.id
             WHERE j2.quote_section_id = qs.id
               AND j2.deleted_at IS NULL),
            0
          ) / MAX(qi.acres) * 100, 1
        )
      END AS completion_pct,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM jobs j3
          WHERE j3.quote_section_id = qs.id AND j3.deleted_at IS NULL
        ) THEN 'not_started'
        WHEN COALESCE(
          (SELECT SUM(btf2.actual_acres)
           FROM jobs j4
           JOIN blend_tickets bt2 ON bt2.job_id = j4.id
           JOIN blend_ticket_fields btf2 ON btf2.blend_ticket_id = bt2.id
           WHERE j4.quote_section_id = qs.id AND j4.deleted_at IS NULL),
          0
        ) >= COALESCE(MAX(qi.acres), 0) AND MAX(qi.acres) > 0
        THEN 'completed'
        ELSE 'in_progress'
      END AS status,
      (SELECT COUNT(*) FROM jobs j5
       WHERE j5.quote_section_id = qs.id AND j5.deleted_at IS NULL
      )::integer AS job_count,
      (SELECT COUNT(*) FROM jobs j6
       JOIN blend_tickets bt3 ON bt3.job_id = j6.id
       WHERE j6.quote_section_id = qs.id AND j6.deleted_at IS NULL
      )::integer AS blend_ticket_count,
      COALESCE(
        (SELECT SUM(inv.total_amount_cents)
         FROM jobs j7
         JOIN blend_tickets bt4 ON bt4.job_id = j7.id
         JOIN invoices inv ON inv.blend_ticket_id = bt4.id
         WHERE j7.quote_section_id = qs.id
           AND j7.deleted_at IS NULL
           AND inv.status NOT IN ('voided', 'cancelled')),
        0
      )::bigint AS invoiced_amount_cents
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    JOIN quote_sections qs ON qs.quote_id = q.id
    LEFT JOIN quote_items qi ON qi.section_id = qs.id
    WHERE q.is_planned = true
      AND q.season = v_season
      AND q.status NOT IN ('declined', 'expired', 'cancelled')
    GROUP BY q.customer_id, c.farm_name, q.id, q.quote_number, qs.id, qs.section_name, qs.needed_by_date
  ) t;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_program_completion(integer) TO authenticated;
