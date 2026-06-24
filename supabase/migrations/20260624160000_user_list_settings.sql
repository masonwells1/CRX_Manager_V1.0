-- ============================================================================
-- FIELD-APP PARITY #8: Customizable list columns (List Settings)
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's LIST SETTINGS gear opens a per-user panel of column on/off toggles
-- for the Manage Job Scheduling list (and shares a common subset with the
-- field-application invoice list). Each user picks which columns they want to
-- see; the choice persists across sessions and is PRIVATE to that user.
--
-- This adds a single generic per-user preferences table: user_list_settings.
-- It is keyed by (user_id, list_key) so the SAME store can later back any
-- list in the app (job list = 'jobs', field invoice list = 'field_invoices',
-- etc.). The chosen config rides in a jsonb `settings` blob (visible-column
-- ids, show-completed flag, etc.) so the schema never has to change when a
-- new toggle is added.
--
-- ALL changes here are ADDITIVE: one new table with RLS scoped to the owner.
-- No existing table, column, RLS policy, or RPC is removed or weakened. There
-- is no money, lifecycle, or actor-sensitive write here, so the strict-actor /
-- idempotency RPC machinery does not apply (these are plain owner-scoped
-- upserts straight from the client, mirroring other per-user preference rows).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- user_list_settings: per-user, per-list saved view configuration.
--   * one row per (user_id, list_key) — UNIQUE so a client UPSERT is clean.
--   * settings jsonb: e.g. { "visibleColumns": ["job_number","status",...],
--                            "showCompleted": true }. Opaque to the DB; the
--                            frontend owns its shape + merges in new defaults.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_list_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The owner. Deleting the user removes their saved layouts.
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Which list this row configures (e.g. 'jobs', 'field_invoices'). A short
  -- non-empty key so one table serves many lists.
  list_key    text NOT NULL CHECK (length(list_key) BETWEEN 1 AND 64),
  -- The saved view config. Defaults to an empty object; the app fills it.
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- One saved layout per user per list — the natural key for an UPSERT.
  UNIQUE (user_id, list_key)
);

-- Lookups are always "my row for this list" — covered by the UNIQUE index.

CREATE TRIGGER set_user_list_settings_updated_at
  BEFORE UPDATE ON user_list_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE user_list_settings ENABLE ROW LEVEL SECURITY;

-- RLS: a user can read / write ONLY their own rows. Every policy is scoped to
-- auth.uid() = user_id, so no user can see or change another user's layout and
-- a user with NO saved row simply gets none (the frontend then applies the
-- defaults). There is no admin override — list layout is personal, not
-- administrative data.
DROP POLICY IF EXISTS user_list_settings_select ON user_list_settings;
CREATE POLICY user_list_settings_select ON user_list_settings
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_list_settings_insert ON user_list_settings;
CREATE POLICY user_list_settings_insert ON user_list_settings
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_list_settings_update ON user_list_settings;
CREATE POLICY user_list_settings_update ON user_list_settings
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_list_settings_delete ON user_list_settings;
CREATE POLICY user_list_settings_delete ON user_list_settings
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE user_list_settings IS
  'Per-user, per-list saved view configuration (visible columns, show-completed, etc.). RLS-scoped to the owner (auth.uid() = user_id). Keyed by (user_id, list_key) so one table serves many lists (jobs, field_invoices, ...). settings jsonb is opaque to the DB; the frontend owns its shape.';
