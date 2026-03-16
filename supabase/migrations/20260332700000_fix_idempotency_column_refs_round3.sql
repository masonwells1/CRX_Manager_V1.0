-- validate-sql: exempt (fix migration must reference wrong patterns to repair them)
-- ============================================================================
-- Fix idempotency_keys column references — Round 3
--
-- The Quote Builder V2 sprints (20260316xxx) introduced 4 NEW RPCs that use
-- wrong column names on the idempotency_keys table. These were never caught
-- by the previous fix migrations (20260315100000, 20260332200000) because
-- those only targeted the original 11 RPCs.
--
-- The idempotency_keys table schema (from 20260210000000):
--   idempotency_key text NOT NULL UNIQUE  (NOT "key")
--   operation       text NOT NULL          (NOT "entity_type")
--   result          jsonb                  (NOT "entity_id" or "result_id")
--
-- RPCs fixed in this migration:
--   1. create_planned_holds      (20260316500000 — latest definition)
--   2. save_quote_template       (20260316600000 — latest definition)
--   3. create_quote_from_template(20260316600000 — latest definition)
--   4. rollover_quote_to_season  (20260316900000 — latest definition)
--
-- All 4 have the same bug pattern:
--   SELECT: WHERE key = p_idempotency_key  →  WHERE idempotency_key = p_idempotency_key
--   INSERT: (key, entity_type, entity_id)  →  (idempotency_key, operation, result)
--   VALUES: 'xxx', p_some_id               →  'xxx', to_jsonb(p_some_id)
--
-- Uses pg_get_functiondef() + replace() to surgically fix only the
-- idempotency blocks while preserving all business logic intact.
-- ============================================================================


-- 1. create_planned_holds
DO $$
DECLARE
  _fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _fn
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'create_planned_holds'
  LIMIT 1;

  IF _fn IS NULL THEN
    RAISE NOTICE 'create_planned_holds not found, skipping';
    RETURN;
  END IF;

  -- Fix WHERE clause
  _fn := replace(_fn,
    'WHERE key = p_idempotency_key',
    'WHERE idempotency_key = p_idempotency_key');

  -- Fix INSERT column names
  _fn := replace(_fn,
    'INTO idempotency_keys (key, entity_type, entity_id)',
    'INTO idempotency_keys (idempotency_key, operation, result)');

  -- Fix VALUES: UUID → jsonb
  _fn := replace(_fn,
    $$'planned_hold', p_quote_id$$,
    $$'create_planned_holds', to_jsonb(p_quote_id)$$);

  EXECUTE _fn;
  RAISE NOTICE 'create_planned_holds: fixed';
END $$;


-- 2. save_quote_template
DO $$
DECLARE
  _fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _fn
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'save_quote_template'
  LIMIT 1;

  IF _fn IS NULL THEN
    RAISE NOTICE 'save_quote_template not found, skipping';
    RETURN;
  END IF;

  -- Fix WHERE clause
  _fn := replace(_fn,
    'WHERE key = p_idempotency_key',
    'WHERE idempotency_key = p_idempotency_key');

  -- Fix INSERT column names
  _fn := replace(_fn,
    'INTO idempotency_keys (key, entity_type, entity_id)',
    'INTO idempotency_keys (idempotency_key, operation, result)');

  -- Fix VALUES: UUID → jsonb
  _fn := replace(_fn,
    $$'quote_template', p_quote_id$$,
    $$'save_quote_template', to_jsonb(p_quote_id)$$);

  EXECUTE _fn;
  RAISE NOTICE 'save_quote_template: fixed';
END $$;


-- 3. create_quote_from_template
DO $$
DECLARE
  _fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _fn
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'create_quote_from_template'
  LIMIT 1;

  IF _fn IS NULL THEN
    RAISE NOTICE 'create_quote_from_template not found, skipping';
    RETURN;
  END IF;

  -- Fix WHERE clause
  _fn := replace(_fn,
    'WHERE key = p_idempotency_key',
    'WHERE idempotency_key = p_idempotency_key');

  -- Fix INSERT column names
  _fn := replace(_fn,
    'INTO idempotency_keys (key, entity_type, entity_id)',
    'INTO idempotency_keys (idempotency_key, operation, result)');

  -- Fix VALUES: UUID → jsonb
  _fn := replace(_fn,
    $$'quote_from_template', p_template_id$$,
    $$'create_quote_from_template', to_jsonb(p_template_id)$$);

  EXECUTE _fn;
  RAISE NOTICE 'create_quote_from_template: fixed';
END $$;


-- 4. rollover_quote_to_season
DO $$
DECLARE
  _fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _fn
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'rollover_quote_to_season'
  LIMIT 1;

  IF _fn IS NULL THEN
    RAISE NOTICE 'rollover_quote_to_season not found, skipping';
    RETURN;
  END IF;

  -- Fix WHERE clause
  _fn := replace(_fn,
    'WHERE key = p_idempotency_key',
    'WHERE idempotency_key = p_idempotency_key');

  -- Fix INSERT column names
  _fn := replace(_fn,
    'INTO idempotency_keys (key, entity_type, entity_id)',
    'INTO idempotency_keys (idempotency_key, operation, result)');

  -- Fix VALUES: UUID → jsonb
  _fn := replace(_fn,
    $$'rollover_quote', p_quote_id$$,
    $$'rollover_quote_to_season', to_jsonb(p_quote_id)$$);

  EXECUTE _fn;
  RAISE NOTICE 'rollover_quote_to_season: fixed';
END $$;


-- ============================================================================
-- SAFETY NET: Generic fix for ANY function that still has wrong patterns
-- This catches anything we might have missed above
-- ============================================================================

DO $$
DECLARE
  _rec record;
  _fn text;
  _fixed boolean;
BEGIN
  FOR _rec IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%idempotency_keys%'
      AND (
        pg_get_functiondef(p.oid) LIKE '%WHERE key = p_idempotency_key%'
        OR pg_get_functiondef(p.oid) LIKE '%INTO idempotency_keys (key,%'
        OR pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (key)%'
      )
  LOOP
    _fn := pg_get_functiondef(_rec.oid);
    _fixed := false;

    -- Fix WHERE clause
    IF _fn LIKE '%WHERE key = p_idempotency_key%' THEN
      _fn := replace(_fn,
        'WHERE key = p_idempotency_key',
        'WHERE idempotency_key = p_idempotency_key');
      _fixed := true;
    END IF;

    -- Fix INSERT with (key, entity_type, entity_id) pattern
    IF _fn LIKE '%INTO idempotency_keys (key, entity_type, entity_id)%' THEN
      _fn := replace(_fn,
        'INTO idempotency_keys (key, entity_type, entity_id)',
        'INTO idempotency_keys (idempotency_key, operation, result)');
      _fixed := true;
    END IF;

    -- Fix INSERT with (key, operation, result_id, expires_at) pattern
    IF _fn LIKE '%INTO idempotency_keys (key, operation, result_id, expires_at)%' THEN
      _fn := replace(_fn,
        'INTO idempotency_keys (key, operation, result_id, expires_at)',
        'INTO idempotency_keys (idempotency_key, operation, result, expires_at)');
      _fixed := true;
    END IF;

    -- Fix INSERT with (key, operation, result) pattern (missing idempotency_ prefix)
    IF _fn LIKE '%INTO idempotency_keys (key, operation, result)%' THEN
      _fn := replace(_fn,
        'INTO idempotency_keys (key, operation, result)',
        'INTO idempotency_keys (idempotency_key, operation, result)');
      _fixed := true;
    END IF;

    -- Fix ON CONFLICT (key)
    IF _fn LIKE '%ON CONFLICT (key)%' THEN
      _fn := replace(_fn,
        'ON CONFLICT (key)',
        'ON CONFLICT (idempotency_key)');
      _fixed := true;
    END IF;

    IF _fixed THEN
      EXECUTE _fn;
      RAISE NOTICE 'Safety net fixed: %', _rec.proname;
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- VERIFICATION: Fail the migration if ANY function still has wrong patterns
-- ============================================================================

DO $$
DECLARE
  _bad_count integer;
  _bad_names text;
BEGIN
  SELECT count(*), string_agg(p.proname, ', ')
  INTO _bad_count, _bad_names
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND pg_get_functiondef(p.oid) LIKE '%idempotency_keys%'
    AND (
      pg_get_functiondef(p.oid) LIKE '%WHERE key = p_idempotency_key%'
      OR pg_get_functiondef(p.oid) LIKE '%INTO idempotency_keys (key,%'
      OR pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (key)%'
      OR pg_get_functiondef(p.oid) LIKE '%idempotency_keys%entity_type, entity_id%'
      OR pg_get_functiondef(p.oid) LIKE '%idempotency_keys%operation, result_id%'
    );

  IF _bad_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION FAILED: % function(s) still have wrong idempotency column references: %', _bad_count, _bad_names;
  END IF;

  RAISE NOTICE 'VERIFIED: All public functions use correct idempotency_keys column names';
END $$;
