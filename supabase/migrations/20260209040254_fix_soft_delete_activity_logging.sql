-- =========================================================
-- Fix: Update log_note_activity() to detect soft deletes
--
-- Problem: Soft delete sets deleted_at via UPDATE, but the
-- trigger only logged 'deleted' on TG_OP = 'DELETE'.
-- This caused soft deletes to appear as generic 'updated'
-- entries in the activity log.
--
-- Fix: Check if deleted_at transitioned from NULL to NOT NULL
-- during an UPDATE, and log it as 'deleted' instead.
-- =========================================================

CREATE OR REPLACE FUNCTION log_note_activity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (NEW.id, auth.uid(), 'created', jsonb_build_object('note', row_to_json(NEW)));

  ELSIF TG_OP = 'UPDATE' THEN
    -- PRIORITY 1: Detect soft delete (deleted_at was NULL, now is set)
    IF (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (
        NEW.id,
        COALESCE(auth.uid(), NEW.deleted_by),
        'deleted',
        jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW))
      );

    -- PRIORITY 2: Detect completion/reopening
    ELSIF OLD.is_completed != NEW.is_completed THEN
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(),
        CASE WHEN NEW.is_completed THEN 'completed' ELSE 'reopened' END,
        jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)));

    -- PRIORITY 3: Detect assignment changes
    ELSIF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(), 'assigned',
        jsonb_build_object('old_assignee', OLD.assigned_to, 'new_assignee', NEW.assigned_to));

    -- PRIORITY 4: All other updates
    ELSE
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(), 'updated',
        jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)));
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (OLD.id, auth.uid(), 'deleted', jsonb_build_object('note', row_to_json(OLD)));
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql' SECURITY DEFINER;

SELECT 'Soft delete activity logging fix applied ✅' AS result;