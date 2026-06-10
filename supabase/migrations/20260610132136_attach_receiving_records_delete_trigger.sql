-- ============================================================================
-- Found by the 2026-06-10 remediation smoke test (rolled back): the
-- _receiving_records_before_delete trigger FUNCTION exists live, but NO
-- trigger is attached to receiving_records — the disk lineage
-- (20260312200000:157-158) creates trg_receiving_records_before_delete, yet
-- live pg_trigger has zero rows for the table (pre-B7 drift class). A raw
-- DELETE therefore removed the record with NO inventory reversal ("ghost
-- inventory" — the exact bug the trigger was built to stop). The frontend no
-- longer raw-deletes receiving_records (grep-verified); the exposed path is
-- direct PostgREST deletes by whoever RLS allows.
--
-- Fix: attach the trigger exactly as the disk lineage intended. The function
-- body itself was reviewed + replaced this round (20260610100001 stamp:
-- clamp removal).
-- ============================================================================

DROP TRIGGER IF EXISTS trg_receiving_records_before_delete ON public.receiving_records;
CREATE TRIGGER trg_receiving_records_before_delete
  BEFORE DELETE ON public.receiving_records
  FOR EACH ROW
  EXECUTE FUNCTION public._receiving_records_before_delete();

-- Verification
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_trigger
  WHERE tgrelid = 'public.receiving_records'::regclass
    AND tgname = 'trg_receiving_records_before_delete'
    AND NOT tgisinternal;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'trigger not attached (count=%)', v_cnt;
  END IF;
END $$;
