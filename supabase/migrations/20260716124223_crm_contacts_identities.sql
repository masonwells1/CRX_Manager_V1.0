-- ============================================================================
-- crm_contacts_identities — Phase 1 relationship intelligence foundation.
-- ----------------------------------------------------------------------------
-- Adds canonical customer contacts and provider-issued external identities
-- without changing any existing customer columns. The legacy customer contact
-- fields remain synchronized for existing pages, PDFs, and emails. Provider
-- values will include 'woo' and voice providers in later phases; phone/email
-- matching deliberately belongs on contacts, never in external identities.
-- Sales-rep access follows the existing customer-scoped pattern: the customer
-- must be assigned to the current sales rep.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.normalize_phone_e164(
  raw text,
  default_region text DEFAULT 'US'
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
AS $$
DECLARE
  digits text;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;

  digits := regexp_replace(raw, '[^0-9]', '', 'g');

  IF left(btrim(raw), 1) = '+'
     AND ('+' || digits) ~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN '+' || digits;
  END IF;

  IF upper(default_region) = 'US' AND digits ~ '^[0-9]{10}$' THEN
    RETURN '+1' || digits;
  END IF;

  IF digits ~ '^1[0-9]{10}$' THEN
    RETURN '+' || digits;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_phone_e164(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_phone_e164(text, text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  name text,
  role text,
  phone_display text,
  phone_e164 text,
  email text,
  preferred_contact_method text,
  is_primary boolean NOT NULL DEFAULT false,
  can_place_orders boolean NOT NULL DEFAULT false,
  is_decision_maker boolean NOT NULL DEFAULT false,
  is_billing_contact boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_contacts_phone_e164_check
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT customer_contacts_preferred_contact_method_check
    CHECK (preferred_contact_method IS NULL OR preferred_contact_method IN ('phone', 'text', 'email')),
  CONSTRAINT customer_contacts_identity_present_check
    CHECK (
      btrim(coalesce(name, '')) <> ''
      OR btrim(coalesce(phone_display, '')) <> ''
      OR btrim(coalesce(phone_e164, '')) <> ''
      OR btrim(coalesce(email, '')) <> ''
    ),
  CONSTRAINT customer_contacts_primary_active_check CHECK (NOT is_primary OR is_active),
  CONSTRAINT customer_contacts_customer_id_id_key UNIQUE (customer_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_contacts_one_primary_per_customer_idx
  ON public.customer_contacts (customer_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS customer_contacts_customer_id_idx
  ON public.customer_contacts (customer_id);
CREATE INDEX IF NOT EXISTS customer_contacts_phone_e164_idx
  ON public.customer_contacts (phone_e164);
CREATE INDEX IF NOT EXISTS customer_contacts_email_normalized_idx
  ON public.customer_contacts (lower(btrim(email)));

CREATE TABLE IF NOT EXISTS public.external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  contact_id uuid,
  provider text NOT NULL,
  external_id text NOT NULL,
  verified_at timestamptz,
  verified_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_identities_provider_nonblank_check CHECK (btrim(provider) <> ''),
  CONSTRAINT external_identities_external_id_nonblank_check CHECK (btrim(external_id) <> ''),
  CONSTRAINT external_identities_provider_external_id_key UNIQUE (provider, external_id),
  CONSTRAINT external_identities_customer_contact_fk
    FOREIGN KEY (customer_id, contact_id)
    REFERENCES public.customer_contacts(customer_id, id)
);

CREATE INDEX IF NOT EXISTS external_identities_customer_id_idx
  ON public.external_identities (customer_id);

COMMENT ON TABLE public.customer_contacts IS
  'Canonical people and contact methods for a customer; legacy customer contact fields remain synchronized.';
COMMENT ON COLUMN public.customer_contacts.phone_e164 IS
  'Normalized E.164 phone number when unambiguous; NULL when normalization would require guessing.';
COMMENT ON COLUMN public.customer_contacts.phone_display IS
  'Original human-readable phone value retained for display and legacy compatibility.';
COMMENT ON COLUMN public.customer_contacts.is_primary IS
  'At most one active primary contact per customer.';
COMMENT ON TABLE public.external_identities IS
  'Provider-issued identifiers only; phone and email matching remain on customer_contacts.';
COMMENT ON COLUMN public.external_identities.provider IS
  'Identity issuer, including future WooCommerce (woo) and voice providers.';
COMMENT ON COLUMN public.external_identities.external_id IS
  'Stable provider-issued identifier, unique within its provider.';

ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_identities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.customer_contacts FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.external_identities FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.external_identities TO authenticated;

DROP POLICY IF EXISTS customer_contacts_select ON public.customer_contacts;
DROP POLICY IF EXISTS customer_contacts_insert ON public.customer_contacts;
DROP POLICY IF EXISTS customer_contacts_update ON public.customer_contacts;
CREATE POLICY customer_contacts_select ON public.customer_contacts
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_contacts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    ))
  );
CREATE POLICY customer_contacts_insert ON public.customer_contacts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_contacts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    ))
  );
CREATE POLICY customer_contacts_update ON public.customer_contacts
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_contacts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    ))
  )
  WITH CHECK (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_contacts.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    ))
  );

DROP POLICY IF EXISTS external_identities_select ON public.external_identities;
DROP POLICY IF EXISTS external_identities_insert ON public.external_identities;
DROP POLICY IF EXISTS external_identities_update ON public.external_identities;
CREATE POLICY external_identities_select ON public.external_identities
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = external_identities.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    ))
  );
CREATE POLICY external_identities_insert ON public.external_identities
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = external_identities.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    -- Reps may link identities but never stamp verification (admin-only).
    AND external_identities.verified_at IS NULL
    AND external_identities.verified_by IS NULL)
  );
CREATE POLICY external_identities_update ON public.external_identities
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = external_identities.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    -- Verified rows are frozen for reps: only admins may edit (or un-verify)
    -- an identity once verification has been stamped.
    AND external_identities.verified_at IS NULL
    AND external_identities.verified_by IS NULL)
  )
  WITH CHECK (
    public.is_admin()
    OR (public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = external_identities.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    -- Reps may edit identity rows but never stamp verification (admin-only).
    AND external_identities.verified_at IS NULL
    AND external_identities.verified_by IS NULL)
  );

DROP TRIGGER IF EXISTS customer_contacts_update_updated_at ON public.customer_contacts;
CREATE TRIGGER customer_contacts_update_updated_at
  BEFORE UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS external_identities_update_updated_at ON public.external_identities;
CREATE TRIGGER external_identities_update_updated_at
  BEFORE UPDATE ON public.external_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE FUNCTION public.sync_primary_contact_to_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
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

CREATE OR REPLACE FUNCTION public.sync_customer_to_primary_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF btrim(coalesce(NEW.contact_name, '')) = ''
     AND btrim(coalesce(NEW.phone, '')) = ''
     AND btrim(coalesce(NEW.email, '')) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.customer_contacts (
    customer_id, name, phone_display, phone_e164, email, is_primary
  )
  VALUES (
    NEW.id,
    nullif(btrim(NEW.contact_name), ''),
    nullif(btrim(NEW.phone), ''),
    public.normalize_phone_e164(NEW.phone),
    nullif(btrim(NEW.email), ''),
    true
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

DROP TRIGGER IF EXISTS customer_contacts_sync_primary_to_customer ON public.customer_contacts;
CREATE TRIGGER customer_contacts_sync_primary_to_customer
  AFTER INSERT OR UPDATE ON public.customer_contacts
  FOR EACH ROW
  WHEN (NEW.is_primary AND NEW.is_active)
  EXECUTE FUNCTION public.sync_primary_contact_to_customer();

DROP TRIGGER IF EXISTS customers_sync_to_primary_contact ON public.customers;
CREATE TRIGGER customers_sync_to_primary_contact
  AFTER UPDATE OF contact_name, phone, email ON public.customers
  FOR EACH ROW
  WHEN (
    OLD.contact_name IS DISTINCT FROM NEW.contact_name
    OR OLD.phone IS DISTINCT FROM NEW.phone
    OR OLD.email IS DISTINCT FROM NEW.email
  )
  EXECUTE FUNCTION public.sync_customer_to_primary_contact();

-- New customers (save_customer INSERT branch, bulk import) get their primary
-- contact immediately; the function early-returns when all fields are blank.
DROP TRIGGER IF EXISTS customers_sync_to_primary_contact_ins ON public.customers;
CREATE TRIGGER customers_sync_to_primary_contact_ins
  AFTER INSERT ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_customer_to_primary_contact();

DO $$
DECLARE
  contacts_created integer := 0;
  customers_total integer := 0;
  skipped_blank integer := 0;
  phones_normalized integer := 0;
  phones_left_null integer := 0;
BEGIN
  INSERT INTO public.customer_contacts (
    customer_id, name, phone_display, phone_e164, email, is_primary
  )
  SELECT
    c.id,
    nullif(btrim(c.contact_name), ''),
    nullif(btrim(c.phone), ''),
    public.normalize_phone_e164(c.phone),
    nullif(btrim(c.email), ''),
    true
  FROM public.customers c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.customer_contacts cc WHERE cc.customer_id = c.id
  )
    AND (
      btrim(coalesce(c.contact_name, '')) <> ''
      OR btrim(coalesce(c.phone, '')) <> ''
      OR btrim(coalesce(c.email, '')) <> ''
    );
  GET DIAGNOSTICS contacts_created = ROW_COUNT;

  SELECT count(*) INTO customers_total FROM public.customers;
  SELECT count(*) INTO skipped_blank
  FROM public.customers c
  WHERE btrim(coalesce(c.contact_name, '')) = ''
    AND btrim(coalesce(c.phone, '')) = ''
    AND btrim(coalesce(c.email, '')) = '';
  SELECT count(*) INTO phones_normalized
  FROM public.customers c
  WHERE nullif(btrim(c.phone), '') IS NOT NULL
    AND public.normalize_phone_e164(c.phone) IS NOT NULL;
  SELECT count(*) INTO phones_left_null
  FROM public.customers c
  WHERE nullif(btrim(c.phone), '') IS NOT NULL
    AND public.normalize_phone_e164(c.phone) IS NULL;

  RAISE NOTICE 'crm contacts backfill: customers total=%, contacts created=%, skipped blank=%, phones normalized=%, phones left NULL (ambiguous)=%',
    customers_total, contacts_created, skipped_blank, phones_normalized, phones_left_null;
END;
$$;
