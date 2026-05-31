# Remediation Plan — 2026-05-25 Ultra-Review Findings

> **STATUS: DRAFTS ONLY — NOTHING HAS BEEN APPLIED.**
> No migration files were created, no SQL was executed against the database, nothing was deployed.
> Every block below is a *proposed* migration for your review. When you approve a given migration, it will be
> created as a real timestamped file under `supabase/migrations/` (via the `/create-migration` workflow:
> `date -u +"%Y%m%d%H%M%S"_<desc>.sql`), TS types + reference docs updated, then applied **only on your explicit go-ahead**.

Companion to [2026-05-25-full-codebase-ultra-review.md](2026-05-25-full-codebase-ultra-review.md). All function bodies below were copied from the **live** definitions (read-only `pg_get_functiondef`) on 2026-05-25, so the rewrites are accurate to current production.

## Apply order & risk
| # | Migration | Fixes | Reversible? | Risk of applying |
|---|---|---|---|---|
| **M1** | Revoke `anon` EXECUTE on SECURITY DEFINER functions | RLS-1 (P0) containment | ✅ fully | **Low** — only removes unauthenticated access; authenticated/service_role re-granted in same migration |
| **M2** | Revoke `anon` table DML | RLS-2 (P1) | ✅ fully | **Low** — RLS already blocks anon; this removes the latent grant |
| **M3** | Bind `auth.uid()` actor in mutating RPCs | RLS-1 (P0) depth | ✅ (CREATE OR REPLACE) | **Medium** — changes auth behavior; test logged-in flows |
| **M4** | Commission-split validation | COMM-2 (P1) | ✅ | **Low** — `NOT VALID` constraint skips existing rows |
| **M5** | Commission-split rounding reconciliation | COMM-1 (P1) | ✅ | **Low** — math only; add a regression test |
| **M6** | Consolidate `next_invoice_number` overload | MIG-1 (P1) | ⚠️ drops a function | **Medium** — must repoint 3 dependents first |
| **M7** | P2 cluster (finance-charge UNIQUE, signature guard, idempotency, stranded commissions) | IDEM-2, PIPE-2, IDEM-1, COMM-3 | mixed | **Low–Medium** |

**Not migrations (separate fixes, planned at the end):** EDGE-1/EDGE-2 (redeploy `reset-user-password`), FE-1 (`assertRpcResult`), RPT-1 (CSV escape), DOC-1…4 (doc edits).

---

## M1 — P0 containment: revoke `anon` EXECUTE on all SECURITY DEFINER functions

**Fixes:** RLS-1 (P0). This is the **deploy unblocker** — it closes the unauthenticated vector for *all* ~215 functions at once, immediately, before the per-function work in M3.

**Why this shape:** `SECURITY DEFINER` functions bypass RLS, so a grant to `anon` = an unauthenticated RLS-bypassing endpoint. Functions are currently callable because EXECUTE is granted to `PUBLIC` (which includes `anon`). We revoke from `PUBLIC`+`anon` and re-grant to `authenticated`+`service_role` so logged-in users and the backend keep working. This is dynamic `GRANT`/`REVOKE` — **not** the banned `pg_get_functiondef()`-cloning pattern.

```sql
-- Migration: revoke_anon_execute_on_security_definer_fns
-- Fixes RLS-1 (P0): SECURITY DEFINER functions bypass RLS; anon must not be able to call them.
-- Reversible: re-grant to anon to undo.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef                              -- SECURITY DEFINER only
      AND p.prokind = 'f'
      -- ALLOWLIST: functions that MUST remain callable by anon (unauthenticated).
      -- For an internal ERP this should be empty. Review before applying.
      AND p.proname <> ALL (ARRAY[]::text[])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon;', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', r.sig);
  END LOOP;
END $$;
```

**Pre-flight decision (you must confirm):** is ANY RPC intended to be called without a login? (e.g., a public contact form, a signup helper). If yes, add its name to the `ARRAY[...]` allowlist. Supabase Auth (login/signup) goes through GoTrue, *not* these RPCs, so the expected answer is "none."

**Verification (run after apply — should return 0):**
```sql
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.prokind='f'
  AND has_function_privilege('anon', p.oid, 'EXECUTE');
```
Then smoke-test the live app while logged in (create order, post invoice, allocate payment) to confirm `authenticated` still has access.

**Rollback:** a migration that `GRANT EXECUTE ... TO anon` on the same set (or restore from the allowlist).

**Add a CI guard (follow-up, not a migration):** extend `scripts/validate-sql.sh` to fail any new migration that `GRANT … TO anon`/`PUBLIC` on a SECURITY DEFINER function, and add a live `pg_proc` check to the `/audit` skill.

---

## M2 — RLS-2: revoke blanket `anon` table DML

**Fixes:** RLS-2 (P1). Today RLS blocks anon row access, but the stock `GRANT ALL … TO anon` posture means one future policy slip = anon read/write. Remove the grant; keep `SELECT` only where genuinely needed (appears to be nowhere).

```sql
-- Migration: revoke_anon_table_dml
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon;
-- Optional hardening: also drop anon SELECT if no table is meant to be publicly readable.
-- REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;

-- Ensure FUTURE tables don't silently re-grant to anon:
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
```

**Verification (should return 0 rows):**
```sql
SELECT table_name, privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee='anon' AND privilege_type <> 'SELECT';
```

**Rollback:** re-grant. **Risk:** Low — RLS already denies anon; this removes the latent capability. Verify authenticated app flows still work (authenticated keeps its grants).

---

## M3 — P0 depth: bind `auth.uid()` in mutating RPCs

**Fixes:** RLS-1 (P0), defense beyond M1. Even after M1 blocks anon, these functions trust a **client-supplied** `p_performed_by`/`p_actor_id` with no session check — so any *authenticated low-privilege* user (driver/applicator) could pass another user's UUID. Bind the actor to `auth.uid()`.

**Canonical block (from CLAUDE.md "Strict-actor pattern"):**
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
p_performed_by := v_actor;   -- ensure audit logging uses the real actor
```

### M3a — the 3 confirmed-exploitable functions (do these first)

**`apply_write_off`** — add `v_actor uuid;` to DECLARE and insert immediately after `BEGIN` (before the idempotency guard):
```sql
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  p_performed_by := v_actor;
  -- DECISION: write-offs are admin-grade. If sales_reps must NOT write off, add:
  -- IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
```
(Rest of the live body unchanged — the implementation migration will be a full `CREATE OR REPLACE` with this prepended.)

**`issue_return_credit(p_return_id, p_actor_id, p_idempotency_key)`** — actor param is `p_actor_id`. Add `v_actor uuid;` to DECLARE, insert after `BEGIN`:
```sql
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  p_actor_id := v_actor;
  -- DECISION: returns-credit is admin/sales-grade; add is_admin()/is_sales_rep() gate if required.
```

**`void_order`** — it already gates on admin, but checks the **spoofable** `p_performed_by`. Add `v_actor uuid;` to DECLARE and **replace** the existing block:
```sql
-- REMOVE:
IF NOT EXISTS (SELECT 1 FROM public.profiles
               WHERE id = p_performed_by AND role = 'admin' AND is_active = true)
THEN RAISE EXCEPTION 'Only admins can void orders'; END IF;
-- REPLACE WITH:
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
p_performed_by := v_actor;
IF NOT EXISTS (SELECT 1 FROM public.profiles
               WHERE id = v_actor AND role = 'admin' AND is_active = true)
THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
```
This preserves the admin requirement but ties it to the real session, and `p_performed_by := v_actor` makes the existing audit/activity stamping accurate.

**Frontend impact (check before applying M3a):** the TS callers currently pass `p_performed_by: profile.id` / `p_actor_id: profile.id`, which equals `auth.uid()`, so `ACTOR_MISMATCH` should not fire in normal use. New error tokens (`AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`) should be registered in `RpcErrorCodes` (`src/lib/db.ts`) and handled in `WriteOffModal`, `Returns.tsx`, and the void-order UI.

### M3b — the remaining directly-callable mutators (same block, per function)

These 25 are anon-executable SECURITY DEFINER functions that mutate and take a caller-supplied actor without an `auth.uid()` check (live scan, 2026-05-25). M1 already blocks anon; M3b closes the authenticated-spoofing gap. Apply the canonical block to each (fetch each body, prepend, `CREATE OR REPLACE`):

`apply_remaining_prepayments`, `approve_return`, `batch_approve_blend_tickets`, `batch_reject_blend_tickets`, `cancel_return`, `create_application_record_from_blend_ticket`, `create_job_from_quote_section`, `create_planned_holds`, `create_quote_from_template`, `create_quote_version`, `duplicate_quote`, `generate_finance_charges`, `link_blend_ticket_to_order`, `link_fields_to_parent`, `load_recipe_into_job`, `receive_return`, `restore_quote_version`, `rollover_quote_to_season`, `save_blend_ticket`, `save_blend_ticket_fields`, `save_field`, `save_field_geometry`, `save_field_polygons`, `save_job`, `save_quote_template`, `unlink_blend_ticket_from_order`, `unlink_field_from_parent`.

*(Excluded from this list: trigger functions and maintenance/cron functions — `handle_new_user`, `trg_*`, `mark_overdue_invoices`, `auto_expire_quotes`, `release_expired_quote_holds`, `retry_failed_notifications`, `check_remainder_reminders`, `cleanup_rate_limits`, `check_idempotency`, `save_idempotency`, etc. — which are not user-facing actor-bearing RPCs. M1 already removes anon EXECUTE from them; for the cron ones, consider restricting to `service_role` only as a separate hardening pass.)*

**Verification (should return 0):**
```sql
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.prokind='f'
  AND has_function_privilege('anon', p.oid,'EXECUTE')            -- expect already 0 after M1
  AND pg_get_functiondef(p.oid) NOT ILIKE '%auth.uid()%'
  AND pg_get_functiondef(p.oid) ~* '(insert|update|delete)\s';
```

---

## M4 — COMM-2: server-side commission-split validation

**Fixes:** COMM-2 (P1). The "splits sum to 100%" rule exists only in client JS today. Enforce it at the data layer via an `IMMUTABLE` validator + a `CHECK` constraint, so it holds no matter which path writes `customers.default_commission_split` (confirmed column: `jsonb`).

```sql
-- Migration: commission_split_validation
CREATE OR REPLACE FUNCTION public.is_valid_commission_split(p_split jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p_split IS NULL
    OR (
      (p_split ? 'splits')
      AND jsonb_typeof(p_split->'splits') = 'array'
      -- every element: non-empty recipient, percentage in (0,100]
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_split->'splits') s
        WHERE COALESCE(trim(s->>'recipient'),'') = ''
           OR (s->>'percentage') IS NULL
           OR NOT (s->>'percentage' ~ '^[0-9]+(\.[0-9]+)?$')   -- guard cast
           OR (s->>'percentage')::numeric <= 0
           OR (s->>'percentage')::numeric > 100
      )
      -- percentages sum to 100 (small tolerance)
      AND abs(COALESCE(
            (SELECT sum((s->>'percentage')::numeric)
             FROM jsonb_array_elements(p_split->'splits') s), 0) - 100) < 0.01
      -- no duplicate recipients (case-insensitive)
      AND (SELECT count(*) FROM jsonb_array_elements(p_split->'splits') s)
        = (SELECT count(DISTINCT lower(trim(s->>'recipient')))
             FROM jsonb_array_elements(p_split->'splits') s)
    );
$function$;

-- NOT VALID: enforce on new/updated rows only; existing rows are not retro-checked
-- (so the migration can't fail on legacy bad data — audit those separately).
ALTER TABLE public.customers
  ADD CONSTRAINT customers_commission_split_valid
  CHECK (public.is_valid_commission_split(default_commission_split)) NOT VALID;
```

**Pre-flight (find existing violators to clean up before `VALIDATE`):**
```sql
SELECT id, name, default_commission_split FROM public.customers
WHERE NOT public.is_valid_commission_split(default_commission_split);
```
Once those are cleaned: `ALTER TABLE public.customers VALIDATE CONSTRAINT customers_commission_split_valid;`

**Also recommended:** add a friendly check inside `save_customer` (raise `INVALID_COMMISSION_SPLIT`) so the UI gets a clear token instead of a raw constraint-violation message. **Rollback:** drop the constraint + function.

---

## M5 — COMM-1: commission-split rounding reconciliation

**Fixes:** COMM-1 (P1). `_insert_commissions_for_order` rounds each split independently with no reconciliation, so the per-recipient amounts can sum to ±1¢ off the order's commission base. Rewrite the set-based INSERT to assign the residual to the **last** split. `commission_amount` is numeric **dollars**, so reconcile in dollars to 2 decimals. Full corrected body:

```sql
-- Migration: fix_commission_split_rounding
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id uuid, p_customer_id uuid, p_order_profit numeric,
  p_commission_split jsonb, p_order_date date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  WITH raw AS (
    SELECT s AS split, idx
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS t(s, idx)
    WHERE (s->>'recipient') IS NOT NULL
      AND (s->>'percentage')::numeric > 0
  ),
  calc AS (
    SELECT
      split, idx,
      row_number() OVER (ORDER BY idx) AS rn,
      count(*)      OVER ()            AS n,
      public.compute_commission_amount(p_order_profit, (split->>'percentage')::numeric) AS amt,
      sum(public.compute_commission_amount(p_order_profit, (split->>'percentage')::numeric)) OVER () AS sum_amt,
      ROUND(COALESCE(p_order_profit,0) * (sum((split->>'percentage')::numeric) OVER ()) / 100, 2) AS target_total
    FROM raw
  )
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  SELECT
    p_order_id,
    p_customer_id,
    c.split->>'recipient',
    (
      SELECT p.id FROM public.profiles p
      WHERE lower(trim(p.full_name)) = lower(trim(c.split->>'recipient'))
        AND p.is_active = true
        AND (SELECT count(*) FROM public.profiles p2
             WHERE lower(trim(p2.full_name)) = lower(trim(c.split->>'recipient'))
               AND p2.is_active = true) = 1
      LIMIT 1
    ),
    (c.split->>'percentage')::numeric,
    -- last recipient absorbs the rounding residual so the set sums to target_total
    CASE WHEN c.rn = c.n THEN c.amt + (c.target_total - c.sum_amt) ELSE c.amt END,
    COALESCE(p_order_profit, 0),
    p_order_date,
    'pending'
  FROM calc c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
```

**Regression test to add** (`src/lib/commissionSplit.test.ts`): two 50% splits on a $99.99 base must sum to exactly `ROUND(99.99,2)` (one recipient $50.00, the other $49.99) — and fix the existing comment that falsely claims the SQL already reconciles. **Rollback:** restore prior body. **Risk:** Low (math only).

---

## M6 — MIG-1: consolidate the `next_invoice_number` overload

**Fixes:** MIG-1 (P1). Two live overloads exist; the no-arg one is redundant (its logic == the text-arg `ELSE` branch). Drop it — but **3 dependents pin it** and must be repointed first (confirmed live 2026-05-25):
1. `invoices.invoice_number` column DEFAULT = `public.next_invoice_number()`
2. function `create_invoice_from_blend_ticket` (calls the no-arg form)
3. function `save_field_app_invoice` (calls the no-arg form)

**Ordered steps in one migration:**
```sql
-- Migration: consolidate_next_invoice_number_overload
-- Step 1: repoint the column default to the surviving overload.
ALTER TABLE public.invoices
  ALTER COLUMN invoice_number SET DEFAULT public.next_invoice_number('field_application');

-- Step 2: repoint the two functions — CREATE OR REPLACE each with the single change
--         next_invoice_number()  ->  next_invoice_number('field_application')
--         (fetch each current body at implementation time; only that call changes).
--   * create_invoice_from_blend_ticket(...)
--   * save_field_app_invoice(...)

-- Step 3: drop the now-unreferenced no-arg overload.
DROP FUNCTION IF EXISTS public.next_invoice_number();

-- Step 4: verify exactly one overload remains.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='next_invoice_number';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected 1 next_invoice_number overload, found %', v_n; END IF;
END $$;
```

**Important:** Step 3 will FAIL until Steps 1 & 2 remove every dependency — that's the intended safety interlock. Do not `DROP ... CASCADE`.

**Optional follow-up (MIG-3, P2):** make `transfer_job_to_invoice` call `next_invoice_number('field_application')` instead of its inline `MAX()`-scan, so all `INV-` numbers come from one sequence. Lower priority — the `invoices.invoice_number UNIQUE` constraint already prevents silent duplicates. **Rollback:** recreate the no-arg overload + restore the column default.

---

## M7 — P2 cluster

**IDEM-2 (duplicate finance charges):** add the backstop the dedup logic assumes. First check for existing dupes, then constrain:
```sql
-- Pre-flight (must return 0 rows before adding the constraint):
SELECT customer_id, period_end, count(*) FROM public.finance_charges
GROUP BY 1,2 HAVING count(*) > 1;

-- Migration: finance_charges_unique_per_period
ALTER TABLE public.finance_charges
  ADD CONSTRAINT finance_charges_customer_period_uniq UNIQUE (customer_id, period_end);
```
Plus wire `p_idempotency_key` into `generate_finance_charges` (it's in the M3b list anyway). The UNIQUE constraint converts a concurrent double-submit from "duplicate AR" into a clean unique-violation.

**PIPE-2 (blank delivery signature):** in `complete_delivery`, after the existing status checks, add:
```sql
IF p_signed_by IS NULL OR trim(p_signed_by) = '' THEN
  RAISE EXCEPTION 'SIGNATURE_REQUIRED';
END IF;
```

**IDEM-1 (declared-but-unused idempotency key):** for the genuinely unguarded creators `duplicate_quote` and `create_followup_delivery`, wire the canonical pattern (`check_idempotency` at top, `save_idempotency` before return) — mirrors the `transfer_job_to_invoice` fix in `20260516010000`. The others in the IDEM-1 list have incidental state guards; lower priority.

**COMM-3 (stranded commissions):** allow `void_commission_payment` (or a new `delete_commission_payment`) to operate on `unposted` payments, and surface the action in the unposted tab of `CommissionPayments.tsx`. Needs a small RPC change + UI change (drafted at implementation).

---

## Non-migration fixes (planned separately)
- **EDGE-2 (P1):** redeploy `reset-user-password` from current source — the deployed v11 is missing the `entity_recipient` block. (Deploy, not migration.)
- **EDGE-1 (P1):** refactor `reset-user-password` CORS to the shared fail-loud `getAllowedOrigin()` pattern, then redeploy.
- **FE-1 (P2):** in `CustomerDetail.tsx:271-282`, give `get_ar_aging` / `get_customer_statement` their own `const { data, error }` + `assertRpcResult`, or null-check `.error` before reading `.data`.
- **RPT-1 (P2):** in `csvExport.ts`, prefix a leading `'` when `String(value)` matches `/^[=+\-@\t\r]/`, in both the `col.format` and plain branches.
- **DOC-1…4 (P3):** apply the doc-drift punch list from the audit report.

## Sequencing recommendation
Apply **M1 + M2 today** (low risk, closes the P0's network vector immediately). Then schedule **M3a → M3b** with app smoke-testing. **M4/M5/M6** are independent and can follow. **M7** as a cleanup batch. Each migration: create the file, update `migration-history.md` (+ `rpc-functions.md` for M3/M5/M6, `database-schema.md` for M4/M7), `npm run typecheck && npm run build && npm run test`, then apply — all on your explicit approval.
