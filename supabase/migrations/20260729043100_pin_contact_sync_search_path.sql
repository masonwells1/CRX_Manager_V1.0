-- These are trigger-only synchronizers. Pin their lookup path so a caller's
-- session setting cannot change which public objects they resolve.
--
-- SECURITY INVOKER is stated explicitly on both, not left to the default.
-- CREATE OR REPLACE FUNCTION keeps only ownership and permissions; every other
-- property is re-derived from this command, so an unstated security context
-- silently becomes INVOKER.  Both functions are already INVOKER on live
-- (prosecdef = false, checked against rhyzpcqhnizqbxphqdkr), so this preserves
-- the current behavior rather than changing it -- promoting them to DEFINER
-- would widen what a trigger may write and is deliberately not done here.
-- Saying it out loud means a future edit cannot flip the context by omission.

CREATE OR REPLACE FUNCTION public.sync_customer_to_primary_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF btrim(coalesce(NEW.contact_name, '')) = ''
     AND btrim(coalesce(NEW.phone, '')) = ''
     AND btrim(coalesce(NEW.email, '')) = '' THEN
    UPDATE public.customer_contacts
    SET is_primary = false,
        is_active = false
    WHERE customer_id = NEW.id
      AND is_primary;
    RETURN NEW;
  END IF;

  INSERT INTO public.customer_contacts (
    customer_id, name, phone_display, phone_e164, email, is_primary
  )
  VALUES (
    NEW.id, nullif(btrim(NEW.contact_name), ''), nullif(btrim(NEW.phone), ''),
    public.normalize_phone_e164(NEW.phone), nullif(btrim(NEW.email), ''), true
  )
  ON CONFLICT (customer_id) WHERE is_primary DO UPDATE
  SET name = EXCLUDED.name,
      phone_display = EXCLUDED.phone_display,
      phone_e164 = EXCLUDED.phone_e164,
      email = EXCLUDED.email
  WHERE customer_contacts.name IS DISTINCT FROM EXCLUDED.name
     OR customer_contacts.phone_display IS DISTINCT FROM EXCLUDED.phone_display
     OR customer_contacts.phone_e164 IS DISTINCT FROM EXCLUDED.phone_e164
     OR customer_contacts.email IS DISTINCT FROM EXCLUDED.email;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_primary_contact_to_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  UPDATE public.customers c
  SET contact_name = NEW.name,
      phone = NEW.phone_display,
      email = NEW.email
  WHERE c.id = NEW.customer_id
    AND (
      c.contact_name IS DISTINCT FROM NEW.name
      OR c.phone IS DISTINCT FROM NEW.phone_display
      OR c.email IS DISTINCT FROM NEW.email
    );
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_unpinned text;
  v_definer text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO v_unpinned
  FROM pg_proc p
  WHERE p.oid IN (
    'public.sync_customer_to_primary_contact()'::regprocedure,
    'public.sync_primary_contact_to_customer()'::regprocedure
  )
  AND NOT ('search_path=public, pg_temp' = ANY(COALESCE(p.proconfig, ARRAY[]::text[])));

  IF v_unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'CONTACT_SYNC_SEARCH_PATH_NOT_PINNED: %', v_unpinned;
  END IF;

  -- Both were SECURITY INVOKER before this migration and must still be after it.
  -- CREATE OR REPLACE re-derives every unstated property, so a future edit that
  -- drops the explicit SECURITY INVOKER above -- or adds SECURITY DEFINER to a
  -- trigger that writes customers and customer_contacts -- fails here instead of
  -- silently changing whose permissions the mirror writes run under.
  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO v_definer
  FROM pg_proc p
  WHERE p.oid IN (
    'public.sync_customer_to_primary_contact()'::regprocedure,
    'public.sync_primary_contact_to_customer()'::regprocedure
  )
  AND p.prosecdef;

  IF v_definer IS NOT NULL THEN
    RAISE EXCEPTION 'CONTACT_SYNC_SECURITY_CONTEXT_CHANGED: %', v_definer;
  END IF;
END;
$$;

-- plpgsql_check remains in public intentionally for now. Its live extension
-- metadata reports extrelocatable=false, so ALTER EXTENSION ... SET SCHEMA
-- would fail rather than safely move the installed functions.
