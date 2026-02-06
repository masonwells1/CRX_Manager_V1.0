/*
  # Add Team Board Collaboration Features - Phase 1 MVP

  ## Overview
  This migration adds core collaboration features to the Team Board including comments threading,
  tags, activity tracking, and enhanced notifications for real-time team collaboration.

  ## New Tables

  ### 1. note_tags
  Reusable tags/categories for organizing team notes
  - `id` (uuid, primary key)
  - `name` (text) - tag name (unique)
  - `color` (text) - hex color for display
  - `created_by` (uuid) - user who created the tag
  - `created_at` (timestamptz)

  ### 2. team_note_tags
  Many-to-many relationship between team notes and tags
  - `note_id` (uuid) - references team_notes
  - `tag_id` (uuid) - references note_tags
  - `created_at` (timestamptz)

  ### 3. note_activity_log
  Tracks all changes and activities on team notes
  - `id` (uuid, primary key)
  - `note_id` (uuid) - references team_notes
  - `user_id` (uuid) - user who performed the action
  - `action_type` (text) - type of action (created, updated, completed, etc.)
  - `changes` (jsonb) - detailed change information
  - `created_at` (timestamptz)

  ## Modified Tables

  ### team_note_comments
  Enhanced to support threading and mentions
  - Add `parent_id` for threaded replies
  - Add `mentions` array for @mentions
  - Add `updated_at` timestamp
  - Add `deleted_at` for soft deletes

  ## Security
  - Enable RLS on all new tables
  - Add policies for authenticated users to access team data
  - Ensure proper access control for comments and activity

  ## Triggers
  - Auto-update timestamps on comment edits
  - Log activity when notes are created/updated/deleted
  - Send notifications for mentions and assignments
*/

-- Create note_tags table
CREATE TABLE IF NOT EXISTS note_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#3b82f6',
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_tags_name ON note_tags(name);

-- Create team_note_tags junction table
CREATE TABLE IF NOT EXISTS team_note_tags (
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES note_tags(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_team_note_tags_note_id ON team_note_tags(note_id);
CREATE INDEX IF NOT EXISTS idx_team_note_tags_tag_id ON team_note_tags(tag_id);

-- Create note_activity_log table
CREATE TABLE IF NOT EXISTS note_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid REFERENCES team_notes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  changes jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_activity_log_note_id ON note_activity_log(note_id);
CREATE INDEX IF NOT EXISTS idx_note_activity_log_user_id ON note_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_note_activity_log_created_at ON note_activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_activity_log_action_type ON note_activity_log(action_type);

-- Enhance team_note_comments table with new columns
DO $$
BEGIN
  -- Add parent_id for threading
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_note_comments' AND column_name = 'parent_id'
  ) THEN
    ALTER TABLE team_note_comments ADD COLUMN parent_id uuid REFERENCES team_note_comments(id) ON DELETE CASCADE;
    CREATE INDEX idx_team_note_comments_parent_id ON team_note_comments(parent_id);
  END IF;

  -- Add mentions array
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_note_comments' AND column_name = 'mentions'
  ) THEN
    ALTER TABLE team_note_comments ADD COLUMN mentions text[] DEFAULT '{}';
  END IF;

  -- Add updated_at timestamp
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_note_comments' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE team_note_comments ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;

  -- Add deleted_at for soft deletes
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_note_comments' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE team_note_comments ADD COLUMN deleted_at timestamptz;
  END IF;
END $$;

-- Enable Row Level Security
ALTER TABLE note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_activity_log ENABLE ROW LEVEL SECURITY;

-- Note tags policies
CREATE POLICY "Authenticated users can view note tags"
  ON note_tags FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create note tags"
  ON note_tags FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update tags they created"
  ON note_tags FOR UPDATE
  TO authenticated
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can delete tags they created"
  ON note_tags FOR DELETE
  TO authenticated
  USING (auth.uid() = created_by);

-- Team note tags policies
CREATE POLICY "Authenticated users can view note tags relationships"
  ON team_note_tags FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can add tags to notes"
  ON team_note_tags FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can remove tags from notes"
  ON team_note_tags FOR DELETE
  TO authenticated
  USING (true);

-- Note activity log policies
CREATE POLICY "Authenticated users can view activity log"
  ON note_activity_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create activity entries"
  ON note_activity_log FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Create function to automatically update updated_at on comments
CREATE OR REPLACE FUNCTION update_note_comment_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Add trigger for team_note_comments
DROP TRIGGER IF EXISTS update_team_note_comments_timestamp ON team_note_comments;
CREATE TRIGGER update_team_note_comments_timestamp
  BEFORE UPDATE ON team_note_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_note_comment_timestamp();

-- Create function to log activity when notes are changed
CREATE OR REPLACE FUNCTION log_note_activity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (NEW.id, auth.uid(), 'created', jsonb_build_object('note', row_to_json(NEW)));
  ELSIF TG_OP = 'UPDATE' THEN
    -- Log different types of updates
    IF OLD.is_completed != NEW.is_completed THEN
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(), 
        CASE WHEN NEW.is_completed THEN 'completed' ELSE 'reopened' END,
        jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)));
    ELSIF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(), 'assigned', jsonb_build_object('old_assignee', OLD.assigned_to, 'new_assignee', NEW.assigned_to));
    ELSE
      INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
      VALUES (NEW.id, auth.uid(), 'updated', jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)));
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (OLD.id, auth.uid(), 'deleted', jsonb_build_object('note', row_to_json(OLD)));
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Add trigger to team_notes to log all changes
DROP TRIGGER IF EXISTS log_team_note_changes ON team_notes;
CREATE TRIGGER log_team_note_changes
  AFTER INSERT OR UPDATE OR DELETE ON team_notes
  FOR EACH ROW
  EXECUTE FUNCTION log_note_activity();

-- Create function to notify mentioned users in comments
CREATE OR REPLACE FUNCTION notify_mentioned_users_in_comment()
RETURNS TRIGGER AS $$
DECLARE
  mentioned_user_id text;
  commenter_name text;
  note_title text;
BEGIN
  -- Get commenter's name
  SELECT full_name INTO commenter_name
  FROM profiles
  WHERE id = NEW.created_by;

  -- Get note title
  SELECT title INTO note_title
  FROM team_notes
  WHERE id = NEW.note_id;

  -- Create notification for each mentioned user
  IF NEW.mentions IS NOT NULL AND array_length(NEW.mentions, 1) > 0 THEN
    FOREACH mentioned_user_id IN ARRAY NEW.mentions
    LOOP
      INSERT INTO notifications (user_id, notification_type, title, message, related_entity_type, related_entity_id)
      VALUES (
        mentioned_user_id::uuid,
        'mention',
        'You were mentioned',
        commenter_name || ' mentioned you in "' || note_title || '"',
        'team_note',
        NEW.note_id
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Add trigger for comment mentions
DROP TRIGGER IF EXISTS notify_on_comment_mention ON team_note_comments;
CREATE TRIGGER notify_on_comment_mention
  AFTER INSERT ON team_note_comments
  FOR EACH ROW
  EXECUTE FUNCTION notify_mentioned_users_in_comment();

-- Create function to log comment activity
CREATE OR REPLACE FUNCTION log_comment_activity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (NEW.note_id, NEW.created_by, 'commented', jsonb_build_object('comment', row_to_json(NEW)));
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (NEW.note_id, NEW.created_by, 'comment_edited', jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW)));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO note_activity_log (note_id, user_id, action_type, changes)
    VALUES (OLD.note_id, OLD.created_by, 'comment_deleted', jsonb_build_object('comment', row_to_json(OLD)));
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Add trigger to team_note_comments to log comment activity
DROP TRIGGER IF EXISTS log_comment_changes ON team_note_comments;
CREATE TRIGGER log_comment_changes
  AFTER INSERT OR UPDATE OR DELETE ON team_note_comments
  FOR EACH ROW
  EXECUTE FUNCTION log_comment_activity();