# Codex Re-Review Findings for Claude

Date: 2026-04-30
Scope: Field Application Workflow Phases 1-6 re-review
Source review: `docs/audits/2026-04-28-field-application-workflow-review.md`

## Request for Claude

Please review the four findings below against the actual SQL and TypeScript. Do not assume the phase summaries are correct. For each item, confirm whether it is a real bug, partially valid, or false positive, then propose the safest fix order.

## Findings

| ID | Priority | File | Lines | Title |
|---|---:|---|---:|---|
| 1 | P1 | `supabase/migrations/20260430150000_field_app_workflow_phase2.sql` | 97-178 | Job RPCs bypass role and ownership checks |
| 2 | P1 | `supabase/migrations/20260430160000_field_app_workflow_phase3.sql` | 223-229 | Linked prebook lookup uses the wrong source id |
| 3 | P2 | `supabase/migrations/20260430160000_field_app_workflow_phase3.sql` | 224-269 | Multiple matching holds can be over-decremented |
| 4 | P2 | `supabase/migrations/20260429140635_field_app_workflow_phase1.sql` | 281-288 | Editing grouped invoices can leave stale child invoices |

## Finding 1: Job RPCs bypass role and ownership checks

Priority: P1

File: `supabase/migrations/20260430150000_field_app_workflow_phase2.sql`

Lines: 97-178

`start_job` and `complete_job` are `SECURITY DEFINER` functions granted to all authenticated users, but the function bodies do not verify that the caller is admin, sales, or the assigned applicator. Tightening table RLS does not protect these RPC paths because `SECURITY DEFINER` bypasses RLS.

Specific concern:

- `start_job(p_job_id, p_performed_by, p_idempotency_key)` selects the job and changes status without checking the authenticated caller.
- `complete_job(...)` has the same pattern in the later rewritten function.
- `p_performed_by` is client-supplied and should not be trusted as authorization by itself.

Expected review:

- Confirm whether Supabase/PostgREST invokes this RPC as any authenticated user.
- Confirm whether either function uses `auth.uid()` or role helper checks internally.
- If confirmed, fix by adding an internal authorization gate that allows admin, sales, or the job's assigned applicator only.

## Finding 2: Linked prebook lookup uses the wrong source id

Priority: P1

File: `supabase/migrations/20260430160000_field_app_workflow_phase3.sql`

Lines: 223-229

Phase 3 matches `inventory_holds.source_id` to `jobs.quote_section_id`, but planned quote holds are created with `source_id = p_quote_id`, not quote section id. Quote-linked jobs will not release their prebooked quantity, so the leak fix is functionally incomplete.

Evidence to compare:

- Phase 3 lookup: `ih.source_id = v_job.quote_section_id`
- Planned hold creation: `supabase/migrations/20260317100000_fix_idempotency_and_searchpath_final.sql:384-405` deletes/inserts holds where `source_id = p_quote_id`
- Older planned-program migration has the same quote-level source id pattern.

Expected review:

- Verify actual hold source-id semantics in the latest live schema/functions.
- If holds are quote-level, change the job completion lookup to use `v_job.quote_id`, while still narrowing by product and active hold.

## Finding 3: Multiple matching holds can be over-decremented

Priority: P2

File: `supabase/migrations/20260430160000_field_app_workflow_phase3.sql`

Lines: 224-269

The code sums all matching holds to calculate `v_decrement_pb`, then subtracts that full amount from only the first hold by `created_at`. If multiple active holds exist for the same product/source, the first hold can go negative or inactive while later holds remain untouched.

Specific concern:

- `SELECT SUM(ih.quantity)` computes the total active hold quantity.
- `UPDATE inventory_holds SET quantity = quantity - v_decrement_pb ... WHERE id = (SELECT id ... ORDER BY created_at LIMIT 1)` updates only one row.
- If the first hold has less quantity than `v_decrement_pb`, it can go below zero despite the table CHECK constraint, or the update fails at runtime.

Expected review:

- Confirm whether multiple active holds can exist for the same source/product.
- If yes, release holds in a loop oldest-first, decrementing only up to each row's available quantity.

## Finding 4: Editing grouped invoices can leave stale child invoices

Priority: P2

File: `supabase/migrations/20260429140635_field_app_workflow_phase1.sql`

Lines: 281-288

The edit path deletes items, shares, and locations for the whole group, then only rebuilds invoices for the customers currently derived from selected fields. A customer removed by the edit can keep an orphaned child invoice in the group with stale header totals and no rebuilt line items.

Specific concern:

- Existing group child invoices are not deleted, cancelled, voided, or detached before rebuild.
- The rebuild loop only touches customers in the newly derived `v_customers` list.
- Any previous group member not in the new list can remain as a stale invoice.

Expected review:

- Confirm what should happen when editing a grouped field-app invoice removes a billed customer.
- If drafts/unposted can be rebuilt destructively, either delete obsolete child invoices or mark them cancelled/detached in the same transaction.
- Ensure posted/voided group members remain protected by the existing edit lock.

## Suggested Fix Order

1. Fix Finding 1 first. It is the broadest authorization risk.
2. Fix Findings 2 and 3 together. They are the same prebook-release path.
3. Fix Finding 4 after confirming the intended business behavior for draft/unposted grouped invoice edits.

## Verification Requested

After fixes, run:

```sql
SELECT proname, count(*)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
GROUP BY proname
HAVING count(*) > 1;
```

Also run the relevant field-app/job tests and at least one realistic quote -> job -> complete job scenario with planned inventory holds.
