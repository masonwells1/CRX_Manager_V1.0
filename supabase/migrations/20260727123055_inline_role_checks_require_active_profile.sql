-- Require an ACTIVE profile everywhere an RLS policy INLINES a role check.
--
-- Why: public.is_admin(), is_sales_rep(), is_driver() and is_applicator() all
-- already require `profiles.is_active = true`. Policies that call those helpers
-- are therefore safe. But 38 live policies inline the role subquery themselves
-- and check only `profiles.role`, so a DEACTIVATED user (is_active = false)
-- holding a valid JWT keeps access through them. Nothing in Supabase auth
-- blocks a deactivated user from signing in (auth.users.banned_until is NULL
-- for the one currently-deactivated profile), so RLS is the only SERVER-SIDE
-- gate. (src/components/auth/ProtectedRoute.tsx does deny an inactive profile,
-- but that is client-side routing: it shapes the UI, it does not stop a direct
-- PostgREST call with the same JWT. Only RLS does.)
--
-- This is the systemic gap that migration 20260726223520 explicitly deferred:
--   "(The older vendors_select policy ... still omit the check — that systemic
--    gap is tracked separately and is deliberately NOT widened ... here.)"
-- 20260726223520 (vendors_select_inactive_admin) and 20260701213000
-- (product_label_drafts admin-only policies) are the convention this matches.
--
-- Shape of the fix: ALTER POLICY only. Every statement below preserves the
-- policy's existing command, existing role list, existing non-role predicates
-- (deleted_at scoping, ownership branches, bucket_id scoping) and existing
-- expression SHAPE. The ONLY change is `AND profiles.is_active = true` added
-- to the WHERE clause that already selects the profile row. No policy is
-- created, dropped, widened, or re-scoped.
--
-- Blast radius: the only behaviour change is that a user with
-- is_active = false loses access they should not have had. Every active user
-- is unaffected. Live profile counts at authoring time: 4 active admins,
-- 1 active sales_rep, 1 INACTIVE sales_rep, 2 active drivers, 1 active
-- applicator, 2 active entity_recipients. Zero inactive admins/drivers.
--
-- Scope limit: this is NOT full account deactivation. It closes only the
-- policies that inline a role check. A deactivated user still retains any
-- access granted by policies that do not check role at all -- e.g. the
-- authenticated-wide SELECT on application_services (20260511060000), the
-- any-authenticated SELECT on application_record_fields (20260511050000) and
-- the wide team-attachment SELECT (20260315200000). The own-attachment delete
-- branches are also deliberately preserved for inactive users. Revoking
-- sessions / banning login remains the durable follow-up; do not describe this
-- migration as globally disabling an account.
--
-- Locking: ALTER POLICY takes ACCESS EXCLUSIVE on its table and, like all
-- Postgres locks, HOLDS IT UNTIL THE TRANSACTION COMMITS -- not just for the
-- statement. This migration therefore blocks reads and writes on all 18 tables
-- simultaneously until it finishes. It is short, but apply it during genuinely
-- low traffic. lock_timeout below makes a fast failure preferable to a long
-- production stall; if it trips, nothing is applied and it can simply be re-run.
--
-- Read lock_timeout correctly: Postgres applies it PER LOCK ACQUISITION, not as
-- a deadline for the whole migration. With 18 distinct tables, a worst case is
-- 18 separate waits of up to 10s each while the locks already taken stay held,
-- so 10s bounds any SINGLE wait, NOT the total stall. It reduces the tail risk;
-- it does not cap it. The transaction is still all-or-nothing -- a timeout
-- aborts everything, so a partial apply is impossible.

SET LOCAL lock_timeout = '10s';

-- ─── public.accounting_periods ────────────────────────────────────────────

ALTER POLICY accounting_periods_select_admin ON public.accounting_periods
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY accounting_periods_insert_admin ON public.accounting_periods
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY accounting_periods_update_admin ON public.accounting_periods
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── public.application_record_fields ─────────────────────────────────────

ALTER POLICY arf_delete ON public.application_record_fields
  USING (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = 'admin'::text
        AND p.is_active = true)
  );

ALTER POLICY arf_insert ON public.application_record_fields
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND p.is_active = true)
  );

ALTER POLICY arf_update ON public.application_record_fields
  USING (
    EXISTS (SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = 'admin'::text
        AND p.is_active = true)
  );

-- ─── public.application_services ──────────────────────────────────────────

ALTER POLICY application_services_admin_delete ON public.application_services
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY application_services_admin_insert ON public.application_services
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY application_services_admin_update ON public.application_services
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.ar_reminder_tracking ──────────────────────────────────────────

ALTER POLICY ar_reminder_admin_select ON public.ar_reminder_tracking
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.customer_application_rates ────────────────────────────────────

ALTER POLICY car_admin_delete ON public.customer_application_rates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY car_admin_insert ON public.customer_application_rates
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY car_admin_update ON public.customer_application_rates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.delivery_photos ───────────────────────────────────────────────
-- Only the inlined driver branch changes; the is_admin()/is_sales_rep()
-- branches and the assigned-driver delivery join are preserved verbatim.

ALTER POLICY del_photos_insert ON public.delivery_photos
  WITH CHECK (
    is_admin() OR is_sales_rep() OR (
      EXISTS (SELECT 1 FROM profiles
        WHERE profiles.id = (SELECT auth.uid())
          AND profiles.role = 'driver'::text
          AND profiles.is_active = true)
      AND EXISTS (SELECT 1 FROM deliveries d
        WHERE d.id = delivery_photos.delivery_id
          AND d.assigned_driver = (SELECT auth.uid()))
    )
  );

-- ─── public.email_log ─────────────────────────────────────────────────────

ALTER POLICY email_log_admin_select ON public.email_log
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY email_log_admin_insert ON public.email_log
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.failed_notifications (FOR ALL: USING + WITH CHECK) ────────────

ALTER POLICY "Admins can manage failed notifications" ON public.failed_notifications
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.finance_charges ───────────────────────────────────────────────

ALTER POLICY finance_charges_select_admin ON public.finance_charges
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY finance_charges_insert_admin ON public.finance_charges
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── public.quote_pdf_templates ───────────────────────────────────────────

ALTER POLICY quote_pdf_templates_admin_delete ON public.quote_pdf_templates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY quote_pdf_templates_admin_insert ON public.quote_pdf_templates
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

ALTER POLICY quote_pdf_templates_admin_update ON public.quote_pdf_templates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.quote_templates ───────────────────────────────────────────────

ALTER POLICY quote_templates_admin_sales_delete ON public.quote_templates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND profiles.is_active = true)
  );

ALTER POLICY quote_templates_admin_sales_insert ON public.quote_templates
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND profiles.is_active = true)
  );

ALTER POLICY quote_templates_admin_sales_update ON public.quote_templates
  USING (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND profiles.is_active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND profiles.is_active = true)
  );

-- ─── public.rup_sales_records ─────────────────────────────────────────────

ALTER POLICY rup_sales_select ON public.rup_sales_records
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true)
      = ANY (ARRAY['admin'::text, 'sales_rep'::text])
  );

ALTER POLICY rup_sales_insert ON public.rup_sales_records
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── public.team_note_attachments ─────────────────────────────────────────
-- The own-attachment branch is preserved verbatim; only the admin branch
-- gains the active check.

ALTER POLICY "Users can delete own attachments or admin can delete any"
  ON public.team_note_attachments
  USING (
    (uploaded_by = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'::text
        AND profiles.is_active = true)
  );

-- ─── public.vendor_bills ──────────────────────────────────────────────────

ALTER POLICY vendor_bills_select ON public.vendor_bills
  USING (
    deleted_at IS NULL
    AND (SELECT profiles.role FROM profiles
          WHERE profiles.id = (SELECT auth.uid())
            AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY vendor_bills_insert ON public.vendor_bills
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY vendor_bills_update ON public.vendor_bills
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── public.vendor_payments ───────────────────────────────────────────────

ALTER POLICY vendor_payments_select ON public.vendor_payments
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY vendor_payments_insert ON public.vendor_payments
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── public.vendors ───────────────────────────────────────────────────────
-- Active-row read path. The soft-deleted-row path (vendors_select_inactive_admin)
-- was already tightened by 20260726223520 and is NOT touched here.

ALTER POLICY vendors_select ON public.vendors
  USING (
    deleted_at IS NULL
    AND (SELECT profiles.role FROM profiles
          WHERE profiles.id = (SELECT auth.uid())
            AND profiles.is_active = true)
        = ANY (ARRAY['admin'::text, 'sales_rep'::text])
  );

-- ─── public.write_offs ────────────────────────────────────────────────────

ALTER POLICY write_offs_select_admin ON public.write_offs
  USING (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

ALTER POLICY write_offs_insert_admin ON public.write_offs
  WITH CHECK (
    (SELECT profiles.role FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_active = true) = 'admin'::text
  );

-- ─── storage.objects ──────────────────────────────────────────────────────
-- ALTER POLICY on storage.objects was proven permitted for the migration role
-- on this project (probe re-run 2026-07-27 inside an always-aborting DO block:
-- the ALTER took effect, then rolled back; live predicate re-read unchanged).
-- Note pg_has_role('postgres','supabase_storage_admin',...) reports neither
-- MEMBER nor USAGE, so the catalog check is NOT a reliable predictor here --
-- the empirical probe through the actual apply channel is. If the privilege
-- ever changes, these two ALTERs error and the whole migration aborts
-- atomically, which is the safe failure mode.
--
-- These two previously used bare auth.uid(). They are switched to
-- (SELECT auth.uid()) to satisfy the ALWAYS rule in
-- docs/workflows/SAFE_DEVELOPMENT_RULES.md ("Use (select auth.uid()) in RLS
-- policies, not bare auth.uid()"). Semantically identical -- auth.uid() is
-- STABLE and uncorrelated here, so wrapping it only lets Postgres evaluate it
-- once per query via an InitPlan instead of once per row.

ALTER POLICY delivery_photos_delete ON storage.objects
  USING (
    bucket_id = 'delivery-photos'::text
    AND EXISTS (SELECT 1 FROM profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = ANY (ARRAY['admin'::text, 'sales_rep'::text])
        AND profiles.is_active = true)
  );

ALTER POLICY "Users can delete own team note attachments" ON storage.objects
  USING (
    bucket_id = 'team-note-attachments'::text
    AND (
      (storage.foldername(name))[1] = ((SELECT auth.uid()))::text
      OR EXISTS (SELECT 1 FROM profiles
        WHERE profiles.id = (SELECT auth.uid())
          AND profiles.role = 'admin'::text
          AND profiles.is_active = true)
    )
  );

-- ─── Verification ─────────────────────────────────────────────────────────

-- Each row is: schema, table, policy, expected command, expected clause shape
-- ('q' = USING only, 'w' = WITH CHECK only, 'qw' = both), and a PIPE-separated
-- list of non-role predicate fragments that MUST survive. Commands, shapes and
-- permissiveness were read from live pg_policies at authoring time, so a policy
-- that silently loses its command, its clause shape, its soft-delete scoping,
-- its bucket scoping or its ownership branch fails here instead of passing on a
-- bare substring match.
--
-- The fragments are FULL deparsed expressions, not bare column names, and each
-- was copied from the live pg_policies text (the two storage ones from a
-- rolled-back dry run of the exact ALTER above, since switching to
-- (SELECT auth.uid()) changes how Postgres prints them). Bare identifiers were
-- rejected deliberately: a fragment of 'deleted_at' would still be satisfied by
-- `deleted_at IS NOT NULL`, and 'delivery-photos' by `bucket_id <> 'delivery-
-- photos'` -- i.e. by an INVERTED predicate that certifies as intact while
-- granting the opposite access. Matching the whole comparison closes that.
-- This is still a text assertion and not a semantic proof; it is a regression
-- tripwire on THIS migration's 38 rewrites, not a general policy verifier.

DO $$
DECLARE
  r record;
  v_qual text;
  v_check text;
  v_cmd text;
  v_permissive text;
  v_key text;
  v_seen text[] := '{}';
  v_frag text;
  v_clause text;
  v_helpers int;
  v_checked int := 0;
  targets text[][] := ARRAY[
    ['public','accounting_periods','accounting_periods_select_admin','SELECT','q',''],
    ['public','accounting_periods','accounting_periods_insert_admin','INSERT','w',''],
    ['public','accounting_periods','accounting_periods_update_admin','UPDATE','q',''],
    ['public','application_record_fields','arf_delete','DELETE','q',''],
    ['public','application_record_fields','arf_insert','INSERT','w',''],
    ['public','application_record_fields','arf_update','UPDATE','q',''],
    ['public','application_services','application_services_admin_delete','DELETE','q',''],
    ['public','application_services','application_services_admin_insert','INSERT','w',''],
    ['public','application_services','application_services_admin_update','UPDATE','qw',''],
    ['public','ar_reminder_tracking','ar_reminder_admin_select','SELECT','q',''],
    ['public','customer_application_rates','car_admin_delete','DELETE','q',''],
    ['public','customer_application_rates','car_admin_insert','INSERT','w',''],
    ['public','customer_application_rates','car_admin_update','UPDATE','qw',''],
    ['public','delivery_photos','del_photos_insert','INSERT','w','is_admin()|is_sales_rep()|d.id = delivery_photos.delivery_id|d.assigned_driver = ( SELECT auth.uid() AS uid)'],
    ['public','email_log','email_log_admin_select','SELECT','q',''],
    ['public','email_log','email_log_admin_insert','INSERT','w',''],
    ['public','failed_notifications','Admins can manage failed notifications','ALL','qw',''],
    ['public','finance_charges','finance_charges_select_admin','SELECT','q',''],
    ['public','finance_charges','finance_charges_insert_admin','INSERT','w',''],
    ['public','quote_pdf_templates','quote_pdf_templates_admin_delete','DELETE','q',''],
    ['public','quote_pdf_templates','quote_pdf_templates_admin_insert','INSERT','w',''],
    ['public','quote_pdf_templates','quote_pdf_templates_admin_update','UPDATE','qw',''],
    ['public','quote_templates','quote_templates_admin_sales_delete','DELETE','q',''],
    ['public','quote_templates','quote_templates_admin_sales_insert','INSERT','w',''],
    ['public','quote_templates','quote_templates_admin_sales_update','UPDATE','qw',''],
    ['public','rup_sales_records','rup_sales_select','SELECT','q',''],
    ['public','rup_sales_records','rup_sales_insert','INSERT','w',''],
    ['public','team_note_attachments','Users can delete own attachments or admin can delete any','DELETE','q','uploaded_by = ( SELECT auth.uid() AS uid)'],
    ['public','vendor_bills','vendor_bills_select','SELECT','q','deleted_at IS NULL'],
    ['public','vendor_bills','vendor_bills_insert','INSERT','w',''],
    ['public','vendor_bills','vendor_bills_update','UPDATE','q',''],
    ['public','vendor_payments','vendor_payments_select','SELECT','q',''],
    ['public','vendor_payments','vendor_payments_insert','INSERT','w',''],
    ['public','vendors','vendors_select','SELECT','q','deleted_at IS NULL'],
    ['public','write_offs','write_offs_select_admin','SELECT','q',''],
    ['public','write_offs','write_offs_insert_admin','INSERT','w',''],
    ['storage','objects','delivery_photos_delete','DELETE','q','bucket_id = ''delivery-photos''::text'],
    ['storage','objects','Users can delete own team note attachments','DELETE','q','bucket_id = ''team-note-attachments''::text|(storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text']
  ];
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    -- A duplicated row must not be able to stand in for an omitted policy.
    v_key := targets[i][1] || '.' || targets[i][2] || '.' || targets[i][3];
    IF v_key = ANY (v_seen) THEN
      RAISE EXCEPTION 'require_active verification: duplicate target %', v_key;
    END IF;
    v_seen := v_seen || v_key;

    SELECT qual, with_check, cmd, permissive
      INTO v_qual, v_check, v_cmd, v_permissive
    FROM pg_policies
    WHERE schemaname = targets[i][1]
      AND tablename  = targets[i][2]
      AND policyname = targets[i][3];

    IF NOT FOUND THEN
      RAISE EXCEPTION 'require_active verification: policy % not found', v_key;
    END IF;

    IF v_cmd <> targets[i][4] THEN
      RAISE EXCEPTION 'require_active verification: % changed command: expected %, found %',
        v_key, targets[i][4], v_cmd;
    END IF;

    IF v_permissive <> 'PERMISSIVE' THEN
      RAISE EXCEPTION 'require_active verification: % is no longer PERMISSIVE (found %)',
        v_key, v_permissive;
    END IF;

    -- Clause shape must be unchanged. This is what stops a half-tightened
    -- UPDATE/ALL policy: USING and WITH CHECK are distinct authorisations
    -- (existing-row visibility vs proposed-row acceptance), so they are never
    -- concatenated before inspection.
    IF (v_qual IS NOT NULL) <> (targets[i][5] LIKE '%q%') THEN
      RAISE EXCEPTION 'require_active verification: % USING clause shape changed (expected %)',
        v_key, targets[i][5];
    END IF;
    IF (v_check IS NOT NULL) <> (targets[i][5] LIKE '%w%') THEN
      RAISE EXCEPTION 'require_active verification: % WITH CHECK clause shape changed (expected %)',
        v_key, targets[i][5];
    END IF;

    IF v_qual IS NOT NULL THEN
      IF v_qual NOT LIKE '%is_active%' THEN
        RAISE EXCEPTION 'require_active verification: % USING lacks is_active', v_key;
      END IF;
      -- The role restriction must SURVIVE: never trade a role check for an
      -- active check.
      IF v_qual NOT LIKE '%role%' THEN
        RAISE EXCEPTION 'require_active verification: % USING lost its role check', v_key;
      END IF;
    END IF;

    IF v_check IS NOT NULL THEN
      IF v_check NOT LIKE '%is_active%' THEN
        RAISE EXCEPTION 'require_active verification: % WITH CHECK lacks is_active', v_key;
      END IF;
      IF v_check NOT LIKE '%role%' THEN
        RAISE EXCEPTION 'require_active verification: % WITH CHECK lost its role check', v_key;
      END IF;
    END IF;

    -- Non-role predicates that must not be dropped. Checked against the ONE
    -- clause that actually carries them -- never against USING and WITH CHECK
    -- concatenated, which would let a fragment present in one clause vouch for
    -- the other. All six fragment-bearing targets are single-clause by
    -- construction; a two-clause target here is an authoring error, so fail
    -- rather than guess which clause was meant.
    IF targets[i][6] <> '' THEN
      IF targets[i][5] = 'qw' THEN
        RAISE EXCEPTION 'require_active verification: % declares fragments on a two-clause policy; fragments must name their clause',
          v_key;
      END IF;
      v_clause := coalesce(v_qual, v_check);
      FOREACH v_frag IN ARRAY string_to_array(targets[i][6], '|') LOOP
        IF v_clause NOT LIKE '%' || v_frag || '%' THEN
          RAISE EXCEPTION 'require_active verification: % lost required predicate "%"',
            v_key, v_frag;
        END IF;
      END LOOP;
    END IF;

    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked <> 38 THEN
    RAISE EXCEPTION 'require_active verification: expected 38 policies, checked %', v_checked;
  END IF;

  -- Nothing anywhere may still inline a role check without is_active. Each
  -- clause is judged ON ITS OWN: concatenating USING and WITH CHECK would let a
  -- policy whose USING inlines an unprotected role check slip through just
  -- because its WITH CHECK happens to mention is_active for an unrelated
  -- reason. Repo-wide, not limited to the 38 -- this is what makes the sweep a
  -- completeness claim and not just a restatement of the target list.
  FOR r IN
    SELECT schemaname, tablename, policyname,
           CASE
             WHEN qual ILIKE '%profiles%' AND qual ILIKE '%role%'
                  AND qual NOT ILIKE '%is_active%' THEN 'USING'
             ELSE 'WITH CHECK'
           END AS clause
    FROM pg_policies
    WHERE (qual ILIKE '%profiles%' AND qual ILIKE '%role%'
           AND qual NOT ILIKE '%is_active%')
       OR (with_check ILIKE '%profiles%' AND with_check ILIKE '%role%'
           AND with_check NOT ILIKE '%is_active%')
  LOOP
    RAISE EXCEPTION 'require_active verification: residual inline role check %.%.% (% clause)',
      r.schemaname, r.tablename, r.policyname, r.clause;
  END LOOP;

  -- All four role helpers must still exist AND still gate on is_active.
  -- Counting first matters: a query that only looks for BAD rows passes
  -- vacuously if a helper has been dropped entirely.
  --
  -- Read via prosrc, not pg_get_functiondef — the latter is banned by
  -- scripts/validate-sql-migrations.sh and that guard's exemption list is
  -- deliberately kept at zero headroom. NOTE this is a textual tripwire, not a
  -- semantic proof: it would not catch a helper that delegates its active check
  -- to another function. It is here to detect regression, not to certify.
  SELECT count(*) INTO v_helpers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('is_admin','is_sales_rep','is_driver','is_applicator')
    AND p.pronargs = 0;

  IF v_helpers <> 4 THEN
    RAISE EXCEPTION 'require_active verification: expected 4 role helpers, found %', v_helpers;
  END IF;

  FOR r IN
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('is_admin','is_sales_rep','is_driver','is_applicator')
      AND p.pronargs = 0
      AND (p.prosrc NOT ILIKE '%is_active%' OR p.prosrc ILIKE '%is_active = false%')
  LOOP
    RAISE EXCEPTION 'require_active verification: helper %() lost its is_active check', r.proname;
  END LOOP;

  RAISE NOTICE 'require_active verification passed: % policies now require an active profile.', v_checked;
END;
$$;
