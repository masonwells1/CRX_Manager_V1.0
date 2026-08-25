-- predicate: credit-memo-cogs-line-gates
-- Live `_issue_return_credit_impl` is header-only today: it writes no
-- invoice_items. The moment any migration makes it write credit-memo cost
-- lines, two live gates it has never touched become load-bearing. Both were
-- missed by six review rounds and by the candidate's own smoke, because a
-- header-only implementation never reaches either one.
--
--   (1) `_enforce_below_cost_line` (trigger zz_crx_below_cost_invoice_items)
--       has an INSERT escape hatch for lines descended from a governed order
--       line, but it requires COALESCE(NEW.quantity, 0) >= 0. A credit line's
--       NEGATIVE quantity defeats it, so the line reaches the below-cost wall,
--       which compares the HISTORICAL unit_price_cents against
--       products.current_cost TODAY and raises COST_BASIS_REQUIRED or
--       BELOW_COST_CONTEXT_REQUIRED -- aborting the whole return-credit RPC.
--       Safe shapes: the call chain declares app.crx_below_cost_operation, or
--       the trigger exempts negative-quantity credit-memo lines.
--
--   (2) `get_customer_year_end_summary` reads invoice_items with NO
--       invoice_type filter and recognizes `status = 'posted'` only. Credit
--       memos are created 'posted', so new negative lines silently change a
--       customer-facing, EPA-registration-bearing document without any
--       definition change to that function. Safe shapes: it excludes
--       invoice_type = 'credit_memo', or it adopts the same recognized-status
--       union used by the COGS reports.
--
-- Both violations are decision-independent: they must be resolved whichever
-- way the return-credit COGS design lands. See
-- docs/audits/2026-08-25-claude-pr361-cogs-adversarial-review.md (BLOCKER-2,
-- HIGH-1). Catalog-only -- emits no business data.
-- Contract: EXPECT ZERO rows.

WITH impl AS (
  SELECT replace(p.prosrc, E'\r\n', E'\n') AS src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._issue_return_credit_impl(uuid,uuid,text)')
), writes_cost_lines AS (
  -- The precise marker: a header-only implementation never names cost_cents.
  SELECT EXISTS (
    SELECT 1 FROM impl
     WHERE strpos(src, 'invoice_items') > 0
       AND strpos(src, 'cost_cents') > 0
  ) AS active
), chain_declares_context AS (
  SELECT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'issue_return_credit',
         '_issue_return_credit_intent_impl_20260812',
         '_issue_return_credit_impl'
       )
       AND strpos(replace(p.prosrc, E'\r\n', E'\n'), 'crx_below_cost_operation') > 0
  ) AS ok
), trigger_exempts_credit_lines AS (
  -- Over-broad by design: any genuine fix must name credit_memo in the guard.
  -- A fix using another shape should be allowlisted with a dated justification.
  SELECT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = '_enforce_below_cost_line'
       AND strpos(replace(p.prosrc, E'\r\n', E'\n'), 'credit_memo') > 0
  ) AS ok
), year_end_guarded AS (
  -- Matched by name, not by pinned argument types: a signature change must not
  -- silently turn this check into a false positive (or a false clean).
  -- Guarded means EVERY overload carries a guard, and at least one exists.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'get_customer_year_end_summary'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'get_customer_year_end_summary'
       AND strpos(replace(p.prosrc, E'\r\n', E'\n'), 'credit_memo') = 0
       AND strpos(
             replace(p.prosrc, E'\r\n', E'\n'),
             '''posted'', ''overdue'', ''paid'''
           ) = 0
  ) AS ok
)
SELECT 'credit-memo-cogs:below-cost-wall-unguarded' AS violation_key,
       'return-credit implementation writes credit-memo cost lines, but neither the call chain declares app.crx_below_cost_operation nor _enforce_below_cost_line exempts negative-quantity credit-memo lines; issue_return_credit will abort once a product current_cost exceeds a historical sale price' AS reason
  FROM writes_cost_lines w, chain_declares_context c, trigger_exempts_credit_lines t
 WHERE w.active
   AND NOT c.ok
   AND NOT t.ok

UNION ALL

SELECT 'credit-memo-cogs:year-end-summary-unfiltered' AS violation_key,
       'return-credit implementation writes credit-memo lines, but get_customer_year_end_summary still reads invoice_items with no credit_memo exclusion and a narrower recognized-status set, so a customer-facing year-end document changes silently' AS reason
  FROM writes_cost_lines w, year_end_guarded y
 WHERE w.active
   AND NOT y.ok;
