-- ============================================================================
-- PARKED DRAFT — NOT APPLIED. Structure Wave-2 · AR reminder: due-date basis + configurable
-- threshold. Ships in the SAME batch as 20260702160000 (A8) + 20260702161000 (A8-aging) —
-- apply order 160000 -> 161000 -> 162000. Mason applies with a per-migration OK.
--
-- OWNER (Mason 2026-07-03): keep dunning reminders at >N days past DUE, and make N adjustable
--   from Settings (was hardcoded 30, aged from invoice_date).
--
-- WHAT:
--   (1) Seed app_settings 'ar_reminder_days' = '30' (ON CONFLICT DO NOTHING — never clobbers a
--       value the admin already set). Surfaced in Settings as "AR Reminder Threshold (days)".
--   (2) get_ar_reminder_candidates: (a) age on COALESCE(due_date, invoice_date) instead of
--       invoice_date in all 3 spots (the WHERE threshold, max_days_past_due, per-invoice
--       days_past_due) — so it never emails NOT-YET-DUE invoices and "Days Past Due" is truthful;
--       (b) read the threshold from app_settings.ar_reminder_days (robust parse: strip non-digits,
--       default 30 on blank/garbage, clamp 1..3650) instead of the literal 30. No signature change,
--       so the ARaging.tsx caller (`supabase.rpc('get_ar_reminder_candidates')`) is unchanged and
--       automatically honors the configured value.
--
-- WHY here (not in 161000): this function was a 4th aging producer Codex found; folding it in
--   would double-define it across two parked migrations (clobber risk). One definition, one file.
--
-- SCOPE: 1 idempotent INSERT into app_settings + 1 CREATE OR REPLACE (re-emitted from the live def
--   with the 3 due-date swaps + the threshold read). SECDEF + search_path + admin gate preserved;
--   one overload. Reads app_settings (runs as owner, so allowed regardless of caller grant).
--
-- SMOKE (2026-07-03, live BEGIN;...ROLLBACK; — NOTHING persisted, verified setting_leaked=false
--   & fn_changed_live=false): threshold_parse=PASS incl. the Codex-R1 cases '30.0'->30, '1e2'->1,
--   '45.5'->45 (leading-integer, NOT digit-strip), blank/garbage/NULL->30, '0'->1, '99999'->3650;
--   plpgsql_check_errors=0; wiring+parser=PASS (fn reads app_settings.ar_reminder_days via
--   regexp_match leading-int, uses `> v_threshold`, ages on COALESCE(due_date, invoice_date)).
-- CODEX: R1 — 2 P2: (a) digit-strip parser misread '30.0'->300 / '1e2'->12 -> FIXED to leading-int
--   regexp_match; (b) ARaging hardcoded "30+ day" copy. R2 — P2: SettingsPage saved the raw string
--   (could store 99999 while the RPC clamps 3650) -> FIXED (normalize 1..3650 on save + input max).
--   R3 — P1: if the frontend deploys BEFORE this migration is applied, a specific day-count in the
--   ARaging send flow would mislead (UI "60+" while the old RPC still emails >30) -> FIXED by making
--   the ARaging confirm modal + toast GENERIC (no number; the day-count lives only in the admin
--   Settings control). ** APPLY-ORDER: apply 160000 -> 161000 -> 162000 BEFORE deploying the
--   SettingsPage/ARaging frontend — they ship on the same branch; merge = deploy. **
--   R4 (2026-07-03): CLEAN — "no actionable correctness issues; typecheck + ESLint pass."
-- ============================================================================

INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES (
  'ar_reminder_days', '30',
  'AR dunning-reminder threshold (days). Only customers with an invoice more than this many days '
  || 'past its DUE date are offered a reminder email by get_ar_reminder_candidates. Default 30.'
)
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  _role  text;
  v_setting_raw text;
  v_num numeric;
  v_threshold int;
BEGIN
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- Configurable threshold (Settings > app_settings.ar_reminder_days). Robust: take the LEADING
  -- integer part (so '30', '30.0', ' 45 ' all read as 30/30/45 — NOT digit-stripping, which would
  -- turn '30.0'->300 or '1e2'->12), default 30 on blank/garbage/missing, clamp 1..3650 so a bad
  -- value can never break the report.
  SELECT setting_value INTO v_setting_raw FROM app_settings WHERE setting_key = 'ar_reminder_days';
  v_num := (regexp_match(COALESCE(v_setting_raw, ''), '^\s*(\d+)'))[1]::numeric;
  v_threshold := CASE WHEN v_num IS NULL THEN 30 ELSE LEAST(GREATEST(v_num, 1), 3650)::int END;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      MAX(EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int > v_threshold
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;
