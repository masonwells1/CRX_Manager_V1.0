-- ============================================================================
-- Entity commission recipients — service profile rows for CMCTW LLC and
-- Crop Rx Solutions so existing commission_payment flow works without refactor.
-- ============================================================================
-- Design call 2026-05-16: these entities are real separate entities receiving
-- real money (ACH/check). Picked Option 1 (service profile rows) over
-- alternatives (allow NULL recipient in payments / separate vendor-bill flow).
--
-- Problem solved:
--   - 18 commissions totaling $72,174.90 for CMCTW LLC were unpayable because
--     recipient_user_id stayed NULL (no profile row matched the entity name).
--   - create_commission_payment groups by recipient_user_id and requires non-null.
--
-- Implementation:
--   1. Expand profiles.role CHECK to allow 'entity_recipient' (5th role).
--   2. Create auth.users entries with non-functional email + impossible password
--      so the entities can never log in. raw_user_meta_data sets the role +
--      full_name; the handle_new_user trigger auto-creates the profile row.
--   3. Defensive INSERT INTO profiles ... ON CONFLICT DO UPDATE in case the
--      trigger was disabled/replaced.
--   4. Backfill existing CMCTW LLC commissions to point at the new profile.
--   5. Backfill existing Crop Rx Solutions commissions (none yet, but future-proof).
--   6. Backfill the 1 stale Mason Wells commission that had NULL recipient_user_id
--      from before the recipient_user_id lookup was added.
--
-- Deterministic UUIDs ('00000000-0000-0000-0001-cdcd00000001/2') so the
-- migration is idempotent on replay (avoids creating duplicate entity
-- profiles if rerun).
--
-- After this lands:
--   - CMCTW LLC commissions are immediately payable via /commission-payments.
--   - Future commissions for these entities (created via
--     _insert_commissions_for_order full_name lookup) auto-populate
--     recipient_user_id and are payable from day one.
--   - Entities have role='entity_recipient' which isn't in any user-facing
--     allowlist (EMAIL_TYPES_BY_ROLE, pagePermissions, etc.), so they don't
--     accidentally show up in UI flows meant for human users. The Settings
--     page user list may want to filter on `role != 'entity_recipient'` in
--     a follow-up if needed — deferred since UI impact is cosmetic only.
-- ============================================================================

-- 1. Expand profiles.role CHECK to allow the new role
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'sales_rep'::text, 'driver'::text, 'applicator'::text, 'entity_recipient'::text]));

-- 2. Deterministic UUIDs so the migration is idempotent on replay
DO $$
DECLARE
  v_cmctw_id    uuid := '00000000-0000-0000-0001-cdcd00000001'::uuid;
  v_croprx_id   uuid := '00000000-0000-0000-0001-cdcd00000002'::uuid;
  v_mason_id    uuid;
BEGIN
  -- 3. Insert auth.users entry for CMCTW LLC (idempotent)
  -- raw_user_meta_data populates the auto-created profile via handle_new_user trigger.
  INSERT INTO auth.users (
    id, instance_id, email,
    encrypted_password, email_confirmed_at,
    raw_user_meta_data, raw_app_meta_data,
    aud, role, created_at, updated_at
  ) VALUES (
    v_cmctw_id,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'cmctw-llc@entity.crxinternal.local',
    -- Impossible-to-match bcrypt-like string; entity can never log in.
    '$2a$10$' || encode(gen_random_bytes(40), 'base64'),
    now(),
    jsonb_build_object('full_name', 'CMCTW LLC', 'role', 'entity_recipient'),
    jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
    'authenticated',
    'authenticated',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  -- 4. Insert auth.users entry for Crop Rx Solutions (idempotent)
  INSERT INTO auth.users (
    id, instance_id, email,
    encrypted_password, email_confirmed_at,
    raw_user_meta_data, raw_app_meta_data,
    aud, role, created_at, updated_at
  ) VALUES (
    v_croprx_id,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'crop-rx-solutions@entity.crxinternal.local',
    '$2a$10$' || encode(gen_random_bytes(40), 'base64'),
    now(),
    jsonb_build_object('full_name', 'Crop Rx Solutions', 'role', 'entity_recipient'),
    jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
    'authenticated',
    'authenticated',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  -- 5. Ensure profile rows exist with the correct shape (handle_new_user trigger
  -- created them on the auth.users INSERT, but be defensive in case the trigger
  -- was disabled/replaced).
  INSERT INTO profiles (id, email, full_name, role, is_active)
  VALUES (v_cmctw_id, 'cmctw-llc@entity.crxinternal.local', 'CMCTW LLC', 'entity_recipient', true)
  ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        role      = EXCLUDED.role,
        is_active = true;

  INSERT INTO profiles (id, email, full_name, role, is_active)
  VALUES (v_croprx_id, 'crop-rx-solutions@entity.crxinternal.local', 'Crop Rx Solutions', 'entity_recipient', true)
  ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        role      = EXCLUDED.role,
        is_active = true;

  -- 6. Backfill existing unpayable commissions for CMCTW LLC
  UPDATE commissions
  SET recipient_user_id = v_cmctw_id
  WHERE recipient = 'CMCTW LLC'
    AND recipient_user_id IS NULL;

  -- 7. Backfill existing unpayable commissions for Crop Rx Solutions
  UPDATE commissions
  SET recipient_user_id = v_croprx_id
  WHERE recipient = 'Crop Rx Solutions'
    AND recipient_user_id IS NULL;

  -- 8. Backfill the 1 stale Mason Wells row found in audit
  SELECT id INTO v_mason_id
  FROM profiles
  WHERE lower(trim(full_name)) = 'mason wells'
    AND is_active = true
    AND role != 'entity_recipient'
  LIMIT 1;

  IF v_mason_id IS NOT NULL THEN
    UPDATE commissions
    SET recipient_user_id = v_mason_id
    WHERE recipient = 'Mason Wells'
      AND recipient_user_id IS NULL;
  END IF;
END
$$;

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_cmctw_profile_id uuid;
  v_croprx_profile_id uuid;
  v_unpayable_cmctw int;
  v_total_cmctw_pending numeric;
BEGIN
  SELECT id INTO v_cmctw_profile_id
  FROM profiles
  WHERE full_name = 'CMCTW LLC' AND role = 'entity_recipient' AND is_active = true;
  IF v_cmctw_profile_id IS NULL THEN
    RAISE EXCEPTION 'entity-commission verification: CMCTW LLC profile row not created';
  END IF;

  SELECT id INTO v_croprx_profile_id
  FROM profiles
  WHERE full_name = 'Crop Rx Solutions' AND role = 'entity_recipient' AND is_active = true;
  IF v_croprx_profile_id IS NULL THEN
    RAISE EXCEPTION 'entity-commission verification: Crop Rx Solutions profile row not created';
  END IF;

  SELECT count(*), COALESCE(SUM(commission_amount), 0)
    INTO v_unpayable_cmctw, v_total_cmctw_pending
  FROM commissions
  WHERE recipient = 'CMCTW LLC' AND recipient_user_id IS NULL;

  IF v_unpayable_cmctw > 0 THEN
    RAISE EXCEPTION 'entity-commission verification: % CMCTW LLC commissions still unpayable ($%)',
      v_unpayable_cmctw, v_total_cmctw_pending;
  END IF;

  RAISE NOTICE 'entity-commission: CMCTW LLC profile %, Crop Rx Solutions profile %, all CMCTW commissions backfilled (was unpayable, now payable).',
    v_cmctw_profile_id, v_croprx_profile_id;
END
$$;
