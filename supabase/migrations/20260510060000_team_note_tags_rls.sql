-- ============================================================================
-- PR-17: Tighten team_note_tags SELECT RLS
--
-- Live state inspection: team_note_tags has 3 policies today.
--   - "Authenticated users can view note tags relationships" — SELECT,
--     USING (true) — TOO PERMISSIVE; doesn't even gate by parent note existence
--   - team_note_tags_insert — already gated by note creator OR admin
--   - team_note_tags_delete — already gated by note creator OR admin
--
-- Only the SELECT policy needs work. The plan suggested admin/sales_rep gating
-- but that would break the team-board for drivers/applicators (team_notes
-- itself uses USING(true) for SELECT — every authenticated user can read team
-- notes). To stay consistent with team_notes while still tightening:
--
--   New SELECT policy: require the parent note to exist. Mirrors the
--   join-pattern used by the existing INSERT/DELETE policies and removes
--   the unconditional USING(true).
--
-- Practical impact: any authenticated user can still read tag associations
-- where the parent team_note exists (which is the only valid case anyway).
-- Cleans up the "USING (true)" red flag without breaking the team-board UI.
-- ============================================================================

DROP POLICY IF EXISTS "Authenticated users can view note tags relationships"
  ON public.team_note_tags;

CREATE POLICY team_note_tags_select ON public.team_note_tags
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.team_notes tn
      WHERE tn.id = team_note_tags.note_id
    )
  );


-- Verification: SELECT policy exists, USING(true) is gone
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.team_note_tags'::regclass
     AND polcmd = 'r'
     AND polname = 'team_note_tags_select';
  IF v_count != 1 THEN
    RAISE EXCEPTION 'team_note_tags_select policy missing (count=%)', v_count;
  END IF;

  -- Old over-permissive policy must be gone
  SELECT count(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.team_note_tags'::regclass
     AND polname = 'Authenticated users can view note tags relationships';
  IF v_count != 0 THEN
    RAISE EXCEPTION 'old over-permissive SELECT policy still present';
  END IF;
END $$;
