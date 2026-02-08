/*
  # Add Soft Delete Support to Team Notes

  ## Changes Made
  1. Add `deleted_at` column to `team_notes` table
     - Nullable timestamp column to track when a note was soft-deleted
  
  2. Add `deleted_by` column to `team_notes` table
     - Nullable UUID column to track who deleted the note
     - Foreign key to `profiles` table for audit trail

  ## Security
  - No RLS changes needed; existing policies apply
  - Soft-deleted notes remain in the database for audit purposes
  - Applications should filter by `deleted_at IS NULL` to exclude deleted notes

  ## Notes
  - This enables proper audit trail for deleted notes
  - Supports data recovery if needed
  - Maintains referential integrity for activity logs
*/

-- Add soft delete columns to team_notes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_notes' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE team_notes ADD COLUMN deleted_at timestamptz NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_notes' AND column_name = 'deleted_by'
  ) THEN
    ALTER TABLE team_notes ADD COLUMN deleted_by uuid NULL;
    ALTER TABLE team_notes ADD CONSTRAINT team_notes_deleted_by_fkey 
      FOREIGN KEY (deleted_by) REFERENCES profiles(id);
  END IF;
END $$;

-- Create an index to optimize queries that filter out deleted notes
CREATE INDEX IF NOT EXISTS idx_team_notes_deleted_at ON team_notes(deleted_at) 
  WHERE deleted_at IS NULL;