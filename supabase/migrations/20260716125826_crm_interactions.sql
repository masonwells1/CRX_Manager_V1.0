-- CRM relationship-intelligence Phase 1: rep-entered customer interactions
-- and their transcripts. Rows with source = 'ai_receptionist' or 'web_store'
-- arrive in later phases; transcript records hold future AI artifacts.
--
-- Contacts are established by the preceding crm_contacts_identities migration.
-- The composite foreign key below prevents an interaction from linking a
-- contact that belongs to another customer.

CREATE TABLE public.customer_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  contact_id uuid,
  interaction_type text NOT NULL,
  direction text,
  source text NOT NULL DEFAULT 'rep',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer,
  outcome text,
  summary text,
  owner_user_id uuid REFERENCES public.profiles(id),
  created_by uuid REFERENCES public.profiles(id),
  provider text,
  external_call_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_interactions_type_check
    CHECK (interaction_type IN ('call', 'visit', 'meeting', 'text', 'email', 'voicemail')),
  CONSTRAINT customer_interactions_direction_check
    CHECK (direction IN ('inbound', 'outbound') OR direction IS NULL),
  CONSTRAINT customer_interactions_source_check
    CHECK (source IN ('rep', 'ai_receptionist', 'system', 'web_store')),
  CONSTRAINT customer_interactions_duration_seconds_check
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT customer_interactions_outcome_check
    CHECK (outcome IN (
      'connected', 'left_voicemail', 'no_answer', 'busy', 'follow_up_needed',
      'order_placed', 'resolved', 'other'
    ) OR outcome IS NULL),
  CONSTRAINT customer_interactions_provider_external_call_id_check
    CHECK ((provider IS NULL) = (external_call_id IS NULL)),
  CONSTRAINT customer_interactions_customer_contact_fkey
    FOREIGN KEY (customer_id, contact_id)
    REFERENCES public.customer_contacts(customer_id, id)
);

CREATE UNIQUE INDEX customer_interactions_provider_external_call_id_key
  ON public.customer_interactions (provider, external_call_id)
  WHERE external_call_id IS NOT NULL;

CREATE INDEX customer_interactions_customer_occurred_at_idx
  ON public.customer_interactions (customer_id, occurred_at DESC);

CREATE INDEX customer_interactions_owner_occurred_at_idx
  ON public.customer_interactions (owner_user_id, occurred_at DESC);

CREATE TRIGGER update_customer_interactions_updated_at
  BEFORE UPDATE ON public.customer_interactions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Attribution audit integrity: created_by is immutable except for admins.
-- (RLS pins created_by at INSERT; this closes the UPDATE-time gap where a
-- rep could erase their own attribution or claim an unattributed AI row.)
CREATE OR REPLACE FUNCTION public.guard_interaction_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'created_by is immutable on customer_interactions (admin-only change)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_interactions_guard_attribution
  BEFORE UPDATE OF created_by ON public.customer_interactions
  FOR EACH ROW
  WHEN (OLD.created_by IS DISTINCT FROM NEW.created_by)
  EXECUTE FUNCTION public.guard_interaction_attribution();

CREATE TABLE public.interaction_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id uuid NOT NULL UNIQUE REFERENCES public.customer_interactions(id),
  transcript text,
  ai_summary text,
  extraction jsonb,
  recording_path text,
  recording_consent_status text,
  recording_consent_at timestamptz,
  recording_consent_method text,
  recording_disclosed_at timestamptz,
  ai_disclosed_at timestamptz,
  disclosure_version text,
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interaction_transcripts_extraction_check
    CHECK (extraction IS NULL OR jsonb_typeof(extraction) = 'object'),
  CONSTRAINT interaction_transcripts_recording_consent_status_check
    CHECK (recording_consent_status IN (
      'granted', 'announced', 'declined', 'not_applicable'
    ) OR recording_consent_status IS NULL)
);

CREATE INDEX interaction_transcripts_retention_expires_at_idx
  ON public.interaction_transcripts (retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;

CREATE TRIGGER update_interaction_transcripts_updated_at
  BEFORE UPDATE ON public.interaction_transcripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.customer_interactions IS
  'Customer communication and visit history. Future AI receptionist and web-store intake uses the source field.';
COMMENT ON COLUMN public.customer_interactions.id IS 'Stable interaction identifier.';
COMMENT ON COLUMN public.customer_interactions.customer_id IS 'Customer discussed in the interaction.';
COMMENT ON COLUMN public.customer_interactions.contact_id IS 'Optional customer contact, constrained to the same customer.';
COMMENT ON COLUMN public.customer_interactions.interaction_type IS 'Kind of interaction.';
COMMENT ON COLUMN public.customer_interactions.direction IS 'Inbound or outbound when applicable.';
COMMENT ON COLUMN public.customer_interactions.source IS 'Originating channel: rep now; AI receptionist and web store later.';
COMMENT ON COLUMN public.customer_interactions.occurred_at IS 'When the interaction occurred.';
COMMENT ON COLUMN public.customer_interactions.duration_seconds IS 'Duration in whole seconds when known.';
COMMENT ON COLUMN public.customer_interactions.outcome IS 'Disposition of the interaction.';
COMMENT ON COLUMN public.customer_interactions.summary IS 'Human-readable interaction summary.';
COMMENT ON COLUMN public.customer_interactions.owner_user_id IS 'User responsible for the relationship follow-up.';
COMMENT ON COLUMN public.customer_interactions.created_by IS 'User who recorded the interaction.';
COMMENT ON COLUMN public.customer_interactions.provider IS 'External call provider for webhook-originated rows.';
COMMENT ON COLUMN public.customer_interactions.external_call_id IS 'Provider call identifier used for webhook idempotency.';
COMMENT ON COLUMN public.customer_interactions.created_at IS 'When this record was created.';
COMMENT ON COLUMN public.customer_interactions.updated_at IS 'When this record was last updated.';

COMMENT ON TABLE public.interaction_transcripts IS
  'One transcript and future AI-derived artifacts for each customer interaction.';
COMMENT ON COLUMN public.interaction_transcripts.id IS 'Stable transcript record identifier.';
COMMENT ON COLUMN public.interaction_transcripts.interaction_id IS 'Owning interaction; one transcript record per interaction.';
COMMENT ON COLUMN public.interaction_transcripts.transcript IS 'Transcript text when available.';
COMMENT ON COLUMN public.interaction_transcripts.ai_summary IS 'Future AI-generated summary.';
COMMENT ON COLUMN public.interaction_transcripts.extraction IS 'Future structured AI extraction object.';
COMMENT ON COLUMN public.interaction_transcripts.recording_path IS 'Private recording storage path.';
COMMENT ON COLUMN public.interaction_transcripts.recording_consent_status IS 'Recording consent or disclosure status.';
COMMENT ON COLUMN public.interaction_transcripts.recording_consent_at IS 'When recording consent was captured.';
COMMENT ON COLUMN public.interaction_transcripts.recording_consent_method IS 'How recording consent was captured.';
COMMENT ON COLUMN public.interaction_transcripts.recording_disclosed_at IS 'When recording disclosure was made.';
COMMENT ON COLUMN public.interaction_transcripts.ai_disclosed_at IS 'When AI disclosure was made.';
COMMENT ON COLUMN public.interaction_transcripts.disclosure_version IS 'Version of the disclosure script or policy.';
COMMENT ON COLUMN public.interaction_transcripts.retention_expires_at IS 'When a future purge job may remove retained media or text.';
COMMENT ON COLUMN public.interaction_transcripts.created_at IS 'When this record was created.';
COMMENT ON COLUMN public.interaction_transcripts.updated_at IS 'When this record was last updated.';

ALTER TABLE public.customer_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interaction_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_interactions_admin_select ON public.customer_interactions
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY customer_interactions_rep_select ON public.customer_interactions
  FOR SELECT TO authenticated USING (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_interactions.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );
CREATE POLICY customer_interactions_admin_insert ON public.customer_interactions
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY customer_interactions_rep_insert ON public.customer_interactions
  FOR INSERT TO authenticated WITH CHECK (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_interactions.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    -- Reps must attribute their own entries (audit integrity).
    AND customer_interactions.created_by = (SELECT auth.uid())
  );
CREATE POLICY customer_interactions_admin_update ON public.customer_interactions
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY customer_interactions_rep_update ON public.customer_interactions
  FOR UPDATE TO authenticated
  USING (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_interactions.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_sales_rep() AND EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_interactions.customer_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
    -- Reps cannot reattribute an entry to another person (NULL = unattributed
    -- system/AI rows, which reps may edit without claiming authorship).
    AND (
      customer_interactions.created_by = (SELECT auth.uid())
      OR customer_interactions.created_by IS NULL
    )
  );

CREATE POLICY interaction_transcripts_admin_select ON public.interaction_transcripts
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY interaction_transcripts_rep_select ON public.interaction_transcripts
  FOR SELECT TO authenticated USING (
    public.is_sales_rep() AND EXISTS (
      SELECT 1
      FROM public.customer_interactions ci
      JOIN public.customers c ON c.id = ci.customer_id
      WHERE ci.id = interaction_transcripts.interaction_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );
CREATE POLICY interaction_transcripts_admin_insert ON public.interaction_transcripts
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY interaction_transcripts_rep_insert ON public.interaction_transcripts
  FOR INSERT TO authenticated WITH CHECK (
    public.is_sales_rep() AND EXISTS (
      SELECT 1
      FROM public.customer_interactions ci
      JOIN public.customers c ON c.id = ci.customer_id
      WHERE ci.id = interaction_transcripts.interaction_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );
CREATE POLICY interaction_transcripts_admin_update ON public.interaction_transcripts
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY interaction_transcripts_rep_update ON public.interaction_transcripts
  FOR UPDATE TO authenticated
  USING (
    public.is_sales_rep() AND EXISTS (
      SELECT 1
      FROM public.customer_interactions ci
      JOIN public.customers c ON c.id = ci.customer_id
      WHERE ci.id = interaction_transcripts.interaction_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_sales_rep() AND EXISTS (
      SELECT 1
      FROM public.customer_interactions ci
      JOIN public.customers c ON c.id = ci.customer_id
      WHERE ci.id = interaction_transcripts.interaction_id
        AND c.assigned_sales_rep = (SELECT auth.uid())
    )
  );

REVOKE ALL ON TABLE public.customer_interactions FROM anon, PUBLIC;
REVOKE ALL ON TABLE public.interaction_transcripts FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_interactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.interaction_transcripts TO authenticated;
