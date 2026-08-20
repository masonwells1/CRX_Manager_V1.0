# RLS Security Guide

Complete reference for Row Level Security in CRX Manager.

---

## What is RLS?

Row Level Security (RLS) controls which rows each user can see and modify in the database. Every table in CRX Manager has RLS enabled — this is mandatory. Without RLS policies, a table returns zero rows to everyone (which is the safe default).

---

## The 5 Stored Roles

Live `profiles_role_check` is
`CHECK (role = ANY (ARRAY['admin','sales_rep','driver','applicator','entity_recipient']))` — **5**
permitted values, read from live `pg_constraint` on 2026-08-19 UTC.

An earlier revision of this file said "The 3 Roles" and listed four; this PR corrected it to four
and *still* did not read the constraint. Four is what RLS uses: no policy in `public` references
`entity_recipient` (`pg_policies` matching it: **0**), but 2 live profiles carry that value, so a
reader filtering on "the four roles" would silently drop them.

All five, with the four **app roles** — the ones every policy below branches on — first:

| Role | Who | Access level |
|------|-----|-------------|
| `admin` | Mason and other administrators | Full access to everything |
| `sales_rep` | Sales representatives | Access to own customers, quotes, orders. No access to month-end, commissions, settings. |
| `driver` | Delivery drivers | Access to own assigned deliveries. Can confirm, complete, upload photos, report issues. |
| `applicator` | Chemical applicators | Access to own assigned jobs. Can record applied info. |
| `entity_recipient` | 2 live rows | **Permitted by the CHECK constraint but referenced by no policy.** Such a profile is treated as none of the four above: it fails `is_admin()`, `is_sales_rep()`, `is_driver()` and `is_applicator()`, so it sees only what a plain active profile sees. |

(The `applicator` row used to sit outside this table, after a prose line, so it
rendered as loose text rather than a fourth row — and the heading said three.
There are four **app roles**; the fifth stored value is the row added below them.)

---

## Helper Functions

These SQL functions check the current user's role. They are `SECURITY DEFINER` and `STABLE`, meaning they run with elevated privileges and are cached per-query.

```sql
is_admin()       -- Returns TRUE if current user has role = 'admin'
is_sales_rep()   -- Returns TRUE if current user has role = 'sales_rep'
is_driver()      -- Returns TRUE if current user has role = 'driver'
is_applicator()  -- Returns TRUE if current user has role = 'applicator'
```

### How they work
Each function queries the `profiles` table for the current user's role:
```sql
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

---

## Critical Rule: Always Use `(select auth.uid())`

**WRONG (evaluates per row — slow):**
```sql
USING (customer_id = auth.uid())
```

**RIGHT (evaluates once — fast):**
```sql
USING (customer_id = (select auth.uid()))
```

The parentheses and `select` keyword make PostgreSQL evaluate `auth.uid()` once per query instead of once per row. This is a major performance difference on large tables.

**Live does not fully satisfy this rule.** Read from live `pg_policies` on 2026-08-19 UTC, exactly
**three** policies in `public` still use bare `auth.uid()`:

| Policy | Command | Expression |
|--------|---------|-----------|
| `tnotes_insert` | INSERT | `(created_by = auth.uid()) AND is_active_profile()` |
| `below_cost_approvals_admin_read` | SELECT | `... WHERE p.id = auth.uid() AND p.is_active AND p.role = 'admin'` |
| `credit_memo_apps_select` | SELECT | `... WHERE profiles.id = auth.uid() AND profiles.is_active AND profiles.role IN ('admin','sales_rep')` |

All three are **correct on access** — this rule is about per-row evaluation cost, not security —
and all three sit on small tables (`team_notes` 55 rows, `credit_memo_applications` 1,
`below_cost_approvals` 0, read live 2026-08-19 UTC), so no fix ships here. It is recorded because a
reader taking this section as a description of live would be wrong three times, and because the
Safety Checklist at the bottom of this file asserts the same rule as if it held.

Re-check by stripping the *wrapped* form first and seeing what `auth.uid` is left — a plain
`like '%auth.uid()%'` matches every policy, since the correct form contains the same text:

```sql
with p as (
  select policyname, cmd,
         regexp_replace(coalesce(qual,'') || ' ~~ ' || coalesce(with_check,''),
                        '[(] SELECT auth[.]uid[(][)] AS uid[)]', 'OK', 'g') as s
    from pg_policies where schemaname = 'public'
)
select policyname, cmd from p where s ~ 'auth[.]uid' order by policyname;
```

---

## Common RLS Policy Patterns

### Pattern 1: Admin-only access
```sql
CREATE POLICY "table_select" ON public.table_name
  FOR SELECT TO authenticated
  USING (is_admin());
```
Used on: `cost_history`. Re-read against live on 2026-08-19 UTC: that is the only admin-only
*read* among the tables this line used to name. `cycle_counts`, `cycle_count_items`,
`rebate_programs` and `rebate_claims` all read as `is_admin() OR is_sales_rep()`.

Stated carefully, because an earlier revision of this paragraph claimed the matrix below "has
always said" so and that the section therefore "contradicted its own file". It did not. On
`origin/main` those matrix rows read `| cycle_counts | Admin | Admin | Admin | Admin |` and the
same for `rebate_programs` and `rebate_claims` — the matrix **agreed** with the stale prose, and
both were wrong together. This PR corrects both. `cycle_count_items` is not carried in this file's
matrix at all; its row lives in `docs/reference/database-schema.md`. Their *writes*
are mostly admin-only but not uniformly: `rebate_claims` INSERT is `is_admin() OR
is_sales_rep()`, and the three `cycle_count_items` write policies are `is_admin() AND EXISTS
(… cycle_counts.status = 'in_progress')`, so even an admin cannot edit a closed count.

### Pattern 2: Any active profile can read
```sql
CREATE POLICY "table_select" ON public.table_name
  FOR SELECT TO authenticated
  USING ((select is_active_profile()));
```
Used on: `products`, `app_settings`, `team_notes`, `activity_feed`, `warehouses`.

This block used to read `USING (true)` and to include `blend_recipes`. Both were stale.
`20260727174657_broad_reads_require_active_profile` (history row 828, applied live 2026-07-27)
narrowed the broad reads to `is_active_profile()`, so a deactivated profile is authenticated but
denied — and live `blend_recipes_select` is `is_admin() OR is_sales_rep() OR is_applicator()`,
which is why the matrix below reads `Admin / Sales Rep / Applicator` for it. **"All
authenticated" in the matrix means exactly this `is_active_profile()` predicate, not `true`.**

### Pattern 3: Admin + Sales Rep (with ownership)
```sql
-- Sales reps write their own, admin writes all
CREATE POLICY "quotes_update" ON public.quotes
  FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  );
```
Used on the **write** side of `quotes` (INSERT and UPDATE), and on `quote_sections`
INSERT/UPDATE/DELETE through an `EXISTS` on the parent quote's `created_by`.

**Not on the read side, which is what this block used to show.** Live `quotes_select` is
`is_admin() OR is_sales_rep()` with **no** ownership test; `qitems_select` is the same; and
`qsections_select` is `is_active_profile()`. The old example named `quotes_select` and added
the ownership half, so anyone copying it would have written a policy narrower than the one actually
deployed.

The matrix row below now reads `Admin / Sales Rep` for SELECT, marking only INSERT and UPDATE
`(own)`. An earlier revision of this paragraph said the pattern "contradicted" that row — it did
not. On `origin/main` the row read `| quotes | Admin / Sales Rep (own) | … |` with `(own)` on
the SELECT cell too, agreeing with the stale example. The disagreement is something this PR
created by fixing the row; both halves are corrected here.

### Pattern 4: Admin + Sales Rep + Driver (for deliveries)
```sql
-- Drivers see only their assigned deliveries
CREATE POLICY "del_select" ON public.deliveries
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR assigned_driver = (select auth.uid())
  );
```
Live carries no `is_driver()` conjunct: the ownership test alone decides it, so a driver reaches
a delivery by being assigned to it rather than by holding the role. That is the same distinction
the matrix banner draws for the `Driver` cells. This block used to show the `is_driver() AND`
form, which is narrower than live.

### Pattern 5: Own data only
```sql
-- Users can only see their own notifications
CREATE POLICY "notif_select" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));
```
Used on: `notifications`. Re-read against live 2026-08-19 UTC: the predicate is right, but this
block named the policy `notifications_select` and live is **`notif_select`**. Worth spelling out,
because `notifications` carries *both* prefixes live — `notif_select`, `notif_insert` and
`notif_update` for three commands, `notifications_admin_delete` for DELETE — so the wrong name
does not look wrong.

### Pattern 6: Insert own data
```sql
CREATE POLICY "activity_insert" ON public.activity_feed
  FOR INSERT TO authenticated
  WITH CHECK (performed_by = (select auth.uid()));
```
Used on: `activity_feed`. Same correction: predicate right, name wrong — this block said
`activity_feed_insert`, live is **`activity_insert`**. Patterns 5 and 6 are the two an earlier
sweep of this section checked and passed, and they were the two still wrong, because that sweep
compared predicates and never compared names.

### Pattern 7: Append-only (no updates or deletes)
```sql
-- financial_audit_log: insert only, no updates, no deletes
CREATE POLICY "financial_audit_insert" ON public.financial_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR actor_user_id = (select auth.uid()));

-- No UPDATE or DELETE policies = nobody can modify/delete rows
```
Used on: `financial_audit_log` (its SELECT is `is_admin()`). The append-only half is the point
and it holds — live has no UPDATE and no DELETE policy. The `WITH CHECK (true)` this block used
to show was stale: live also pins the actor.

---

## Full RLS Policy Matrix

> ⚠️ **This matrix is a hand-kept, point-in-time snapshot and drifts.** It is NOT
> the source of truth and is not machine-verified. Later migrations have already
> changed several rows below — e.g. as of 2026-07-15 the browser roles' direct
> INSERT on `returns` and INSERT/UPDATE/DELETE on `return_items` were REVOKED
> (mutations are now RPC-owned; migration `20260715203911`), `payments`
> direct writes were removed (`20260714223000`), and as of 2026-08-16 — a date
> **inferred** from the ledger version stamp `20260816174353`, since the ledger has
> no timestamp column, so the apply is observed but its clock time is not — the
> browser roles' direct INSERT on `quote_versions` was REVOKED along with the
> `qversions_insert` policy (**CRX-SEC-1**, migration `20260813080000`, ledger
> version `20260816174353`; **browser-role** writes are now `create_quote_version`
> RPC only, while `service_role` and `postgres` keep direct INSERT/UPDATE/DELETE
> grants and bypass RLS), and `quote_items` now carries **only** `qitems_select`
> (admin or sales rep) with no INSERT/UPDATE/DELETE policy at all — its writes are
> RPC-only too, and there the scope is tighter: `service_role` holds SELECT only on
> `quote_items`, so `postgres` (the table owner) is the sole remaining direct
> writer. Grants for both tables re-read live 2026-08-19.
> **Before trusting any row,
> query the live policies** — `select * from pg_policies where schemaname='public'
> and tablename='<table>'` (read-only) — and if you're debugging a silent RLS
> denial, believe `pg_policies`, not this table. Do NOT "fix" reality to match
> this matrix (re-adding a revoked permissive policy re-opens a closed hole).
> **Last full reconcile: 2026-08-19 UTC** (
> UTC runs one calendar day ahead here). All 37 rows of this matrix were
> machine-compared against live `pg_policies` (read-only), per command. The 12
> rows that disagreed on which commands have a policy were corrected from the
> live policy expressions: `cost_history`, `quote_items`, `quote_versions`,
> `inventory_holds`, `receiving_records`, `delivery_photos`, `commissions`,
> `payments`, `team_note_comments`, `notifications`, `returns`,
> `return_items`. All 37 rows now agree with live on which commands have a
> policy.
>
> A 13th row, `quotes`, was corrected separately and by hand: its SELECT cell
> read "Admin / Sales Rep (own)" where live `quotes_select` is `is_admin() OR
> is_sales_rep()` with no ownership test — a sales rep reads **every** quote,
> and only INSERT and UPDATE are own-scoped. That was a role-wording error,
> not a presence error, so the mechanical pass could not have caught it. See
> the caveat below.
>
> Note what that does and does not prove. Policy *presence* per command is
> what was compared mechanically; the role wording inside each cell was
> transcribed by hand from the policy's `USING`/`WITH CHECK` expression, so a
> cell can still be imprecise even though its `-` vs non-`-` shape is
> verified. The `quotes` correction above is exactly that failure mode, found
> by a later review rather than by the sweep.
>
> Because `quotes` was clearly not going to be the only one, a later
> mechanical pass re-derived every cell's role set from the live
> `USING`/`WITH CHECK` expressions across **both** matrices and corrected
> every cell claiming **"All authenticated"** where live is role-gated —
> `profiles`, `notifications`, `blend_recipes` and `financial_audit_log` in this table.
> (`notifications` INSERT read `All authenticated` on `origin/main`; live `notif_insert` is
> `is_admin() OR is_sales_rep() OR user_id = (select auth.uid())`. An earlier revision of this
> sentence enumerated only three of the four.)
> Of the **89** cells that pass flagged, that class — together with the
> `rate_limit_log` row, which sits only in the `database-schema.md` matrix,
> and the `blend_recipes` write cells, which appear in **both** matrices —
> accounted for 28, taking the count to 61. A later hand-triage of every
> remaining flag against live `pg_policies` took it to **33**, each of which
> was read individually and confirmed correct on 2026-08-19 UTC. The full
> trajectory (162 on `origin/main` → 89 → 61 → 33), the three false-positive
> families that make up the 33, and the definition of **"All authenticated"**
> as live `is_active_profile()` are in the matching banner in
> `docs/reference/database-schema.md`; the per-cell working is in the CLOSED
> entry in `docs/manual/KNOWN_ISSUES.md`.
>
> **The 162 -> 89 -> 61 -> 33 trajectory came from an in-session script that was never
> committed, so no reader can reproduce those four numbers from this repo.** They are narrative
> context, not evidence — and the enumeration in the KNOWN_ISSUES entry does **not** stand in for
> them. That entry's *"What the hand-triage corrected"* list is given by table, not by cell: its
> first bullet names 12 tables with no command at all, and two further entries read "writes"
> instead of naming which commands. It cannot be summed back to 33 either. An earlier revision of
> this note offered it as the auditable equivalent of the count; that was too strong.
>
> The auditable claim, and the only one worth relying on, is the one the rest of this banner makes:
> every cell of both matrices was read against live `pg_policies` and is reproduced here, row by
> row, for anyone to re-check. Take the trajectory as a description of how the work proceeded, not
> as a measurement.
>
> **One** cell in this table newly reads it: `inventory_holds` SELECT, which read
> `Admin / Sales Rep` on `origin/main`. `team_note_comments` SELECT already read
> `All authenticated` there, so that cell is unchanged. (An earlier revision of this banner named
> both and said they "used to render that expression as *Any active profile*" — wrong twice over:
> the wording never appeared in a committed matrix cell in this repo, and the second cell did not
> change. Both claims are withdrawn.) So this matrix
> carries 8
> cells reading **"All authenticated"** and all 8 also appear in the
> `database-schema.md` matrix.

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | Own/Admin | Own/Admin | Own/Admin | - |
| products | All authenticated | Admin | Admin | Admin |
| cost_history | Admin | - (no INSERT policy) | - | - |
| customers | Admin / Sales Rep (assigned) / Driver (recent delivery) / Applicator (recent job) / dispatched to a job location | Admin / Sales Rep (assigned) | Admin / Sales Rep (assigned) | Admin |
| customer_addresses | All authenticated | Admin / Sales Rep (own customer) | Admin / Sales Rep (own customer) | Admin |
| quotes | Admin / Sales Rep | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin |
| quote_sections | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_items | Admin / Sales Rep | - (RPC only, since `20260812115236` dropped `qitems_insert`/`qitems_update`/`qitems_delete`) | - (RPC only) | - (RPC only) |
| quote_versions | Admin / Sales Rep | - for browser roles (`create_quote_version` RPC only, since `20260813080000`, ledger version `20260816174353`; `service_role` and `postgres` retain direct write grants and bypass RLS) | - (same scope) | - (same scope) |
| orders | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| inventory | Admin / Sales Rep / Driver | Admin | Admin | Admin |
| inventory_transactions | Admin / Sales Rep | Admin / Sales Rep | - | - |
| inventory_holds | All authenticated | - (no write policy; SECDEF RPCs only) | - (no write policy) | - (no write policy) |
| purchase_orders | Admin / Sales Rep | Admin | Admin | Admin |
| purchase_order_items | Admin / Sales Rep | Admin | Admin | Admin |
| receiving_records | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin / Sales Rep / Driver (assigned, while in_progress or completed) | Admin |
| delivery_items | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin | Admin / Sales Rep |
| delivery_photos | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep / active Driver (assigned) | Admin | Admin |
| delivery_remainders | Admin / Sales Rep / Driver (assigned to the original delivery) | Admin / Sales Rep | Admin / Sales Rep | Admin |
| commissions | Admin / Sales Rep (own recipient) | Admin | Admin | Admin |
| payments | Admin / Sales Rep | - (RPC only, since `20260714223000`) | - (RPC only) | - (RPC only) |
| team_notes | All authenticated | Own created_by (active profile) | Own created_by / Admin | Admin |
| team_note_comments | All authenticated | Own created_by | Own created_by / Admin | Own created_by / Admin |
| activity_feed | All authenticated | Own performed_by | - | - |
| notifications | Own user_id | Admin / Sales Rep / own user_id | Own user_id | Admin |
| invoices | Admin / Own created_by / Assigned salesman | Admin / Sales Rep | Admin | Admin |
| invoice_items | Any visible invoice (inherits `invoices` RLS) | Admin / Sales Rep | Admin | Admin |
| financial_audit_log | Admin | Admin / own actor_user_id | - | - |
| blend_recipes | Admin / Sales Rep / Applicator | Admin / own created_by | Admin / own created_by | Admin |
| warehouses | All authenticated | Admin | Admin | Admin |
| cycle_counts | Admin / Sales Rep | Admin | Admin | Admin |
| returns | Admin / Sales Rep / requester | - (RPC only, since `20260715203911`) | Admin / requester | Admin |
| return_items | Admin / Sales Rep / return requester | - (RPC only, since `20260715203911`) | - (RPC only) | - (RPC only) |
| rebate_programs | Admin / Sales Rep | Admin | Admin | Admin |
| rebate_claims | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |

---

## Debugging: Why Is My Query Returning Empty?

If a query returns no rows when you expect data:

### Step 1: Check RLS
The most common cause is an RLS policy blocking access. The query succeeds (no error) but returns empty data.

### Step 2: Use `checkMutationResult()`
For writes, always use:
```typescript
const result = await supabase.from('table').update({ ... }).eq('id', id).select();
checkMutationResult(result, 'Update table');
```
This throws an error if zero rows were affected, which catches silent RLS denials.

### Step 3: Test in SQL Editor
Run the query directly in the Supabase SQL Editor as the affected user:
```sql
-- Check what role the user has
SELECT role FROM profiles WHERE id = 'user-uuid-here';

-- Test the query with that user's context
SET request.jwt.claims = '{"sub": "user-uuid-here"}';
SELECT * FROM table_name;
```

### Step 4: Check the policy
Look at the migration files for the table's RLS policies:
```bash
# Search for policies on a specific table
grep -r "CREATE POLICY.*table_name" supabase/migrations/
```

---

## Debugging: Why Is My Write Silently Failing?

Supabase returns `{ data: null, error: null }` when RLS blocks a write. This is NOT an error — it's a silent denial.

### Use `checkMutationResult()`
```typescript
const result = await supabase
  .from('customers')
  .update({ farm_name: 'New Name' })
  .eq('id', customerId)
  .select();

checkMutationResult(result, 'Update customer');
// Throws: "Update customer failed: no rows were affected. You may not have permission."
```

### Use `assertRpcResult()` for RPCs
```typescript
const { data } = await supabase.rpc('my_function', { params });
const result = assertRpcResult<ReturnType>(data, 'my_function');
```

---

## Safety Checklist for RLS Changes

- [ ] Every new table has `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- [ ] Every table has at least a SELECT policy
- [ ] Use `(select auth.uid())` not bare `auth.uid()` in all policies
- [ ] Use `DROP POLICY IF EXISTS` before `CREATE POLICY` for idempotency
- [ ] Test as all roles: admin, sales_rep, driver
- [ ] Use `checkMutationResult()` after every `.update()` and `.delete()`
- [ ] Use `assertRpcResult()` for SECURITY DEFINER RPCs
- [ ] Never remove existing RLS policies — add new ones or modify in a new migration
