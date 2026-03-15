# Phase 7 — Complete Defect Backlog (Prioritized)

## Plain-English summary (for Mason)

I moved straight to the next phase.

This is your fix backlog in business terms: the list of defects that can cost money, break deliveries, or create compliance/security exposure.

I prioritized using your scoring model and elevated compliance/security blockers first.

---

## DEFECT #1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Blocker**
Area:            Security / RPC Authorization
Business Impact: A user could potentially impersonate another role in privileged operations (inventory, orders, payments), causing unauthorized stock/money changes.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Privileged `SECURITY DEFINER` RPCs trust caller-supplied actor IDs (`p_performed_by`) in authorization checks.
What should happen: RPC must derive actor from `auth.uid()` server-side (or hard-assert equality).
How to trigger:  Call privileged RPC with another user UUID where function only checks the parameter role.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Authorization logic in key RPCs checks `profiles.id = p_performed_by` rather than binding to session identity. (`convert_quote_to_order`, `receive_po_items`, `update_order_items`, `create_direct_order`, etc.)
Fix:             Enforce `p_performed_by = auth.uid()` in every privileged RPC; ideally remove input actor param and use `auth.uid()` directly.
Verify:          Attempt spoofed UUID call as sales rep; confirm denial.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    5
  Ops Blockage:      4
  Compliance Risk:   5
  Frequency:         4
  Fix Effort:        2
  PRIORITY SCORE:    9.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Blocker**
Area:            RLS / Data Isolation
Business Impact: Sales reps may access data outside their territory/accounts; privacy and internal controls fail.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Some SELECT policies are too broad (`USING (true)` or rep-wide access).
What should happen: Access should be scoped by role + ownership/assignment.
How to trigger:  Query quote child tables/order tables as a rep for another rep’s accounts.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Broad policies on quote children/addresses; orders/order items readable by all reps.
Fix:             Rewrite policies to ownership-scoped predicates and role-safe joins.
Verify:          Role test matrix: rep A cannot read rep B customer/order/quote-child rows.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    4
  Ops Blockage:      3
  Compliance Risk:   5
  Frequency:         5
  Fix Effort:        3
  PRIORITY SCORE:    5.7
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Critical**
Area:            Quote Math / Financial Integrity
Business Impact: Wrong quote totals/margins can create underpricing and commission errors.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Quote totals are calculated in React and persisted.
What should happen: DB/RPC should be the single source of truth for financial math.
How to trigger:  Compare outcomes when frontend state/logic drifts or edge rounding differs.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      `QuoteBuilder` computes line/header totals client-side; server conversion trusts stored totals.
Fix:             Add `calculate_quote_totals` RPC and persist only server-computed values.
Verify:          Fixed numeric test suite (simple/multi/tier/commission/discount-tax order).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    5
  Ops Blockage:      3
  Compliance Risk:   2
  Frequency:         5
  Fix Effort:        3
  PRIORITY SCORE:    5.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Critical**
Area:            Inventory Integrity
Business Impact: Potential over-commitment or negative-effective availability during concurrency peaks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Bucket updates are partly protected, but universal non-negative/invariant guarantees are not sealed.
What should happen: Hard DB constraints + reservation invariants should prevent invalid states.
How to trigger:  Concurrent reservation/adjustment/fulfillment on same product.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Heavy reliance on function logic (`GREATEST`) without complete schema-level invariants and universal RPC-only mutation boundary.
Fix:             Add DB CHECK constraints + reservation guards + remove residual direct mutation paths.
Verify:          Concurrency replay tests cannot produce invalid buckets.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    5
  Ops Blockage:      5
  Compliance Risk:   3
  Frequency:         4
  Fix Effort:        4
  PRIORITY SCORE:    4.3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Critical**
Area:            Audit Trail Integrity
Business Impact: Inventory audit records can lose legal/operational trust if non-authoritative writes are allowed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Audit logs are present but immutability/trust boundary is not strict enough.
What should happen: Append-only trusted log via server-controlled pathways.
How to trigger:  Direct write patterns and broad insert permissions can pollute logs.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Mixed direct page inserts and broad write permissions.
Fix:             Restrict direct table writes; funnel through signed RPC/triggers only.
Verify:          Non-admin direct insert/update/delete attempts fail.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    4
  Ops Blockage:      3
  Compliance Risk:   5
  Frequency:         4
  Fix Effort:        3
  PRIORITY SCORE:    5.3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #6
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Major**
Area:            Notifications Security
Business Impact: Users can potentially create noisy/spoofed notifications, reducing trust in alerting.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Insert policy allows broad notification creation.
What should happen: Server-issued or role-scoped notification creation only.
How to trigger:  Insert cross-user notifications as non-admin.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Over-broad `notif_insert` policy.
Fix:             Tighten policy to role-safe constraints; move cross-user notifications to trusted server functions.
Verify:          Unauthorized cross-user insert blocked; legitimate system notifications still work.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    2
  Ops Blockage:      2
  Compliance Risk:   2
  Frequency:         4
  Fix Effort:        2
  PRIORITY SCORE:    5.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #7
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Major**
Area:            Quote Commercial Model
Business Impact: Missing canonical discount/tax/fee handling leads to manual adjustments and billing inconsistency.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    No first-class quote tax/discount/fee engine in canonical quote path.
What should happen: Explicit schema + deterministic server order-of-operations.
How to trigger:  Attempt to produce taxed/discounted quote with auditable order of operations.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Domain model gap in quote pricing pipeline.
Fix:             Add schema fields/tables + server quote-pricing function.
Verify:          Golden test cases for discount->tax->fee sequence.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    4
  Ops Blockage:      3
  Compliance Risk:   2
  Frequency:         4
  Fix Effort:        4
  PRIORITY SCORE:    3.3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Major**
Area:            Authentication UX / Recovery
Business Impact: Missing reset flow can lock out field users and disrupt operations.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Password reset flow not clearly surfaced in route/page model.
What should happen: User-visible reset request + confirmation flow.
How to trigger:  Lost password scenario.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Incomplete auth UX coverage.
Fix:             Add reset route/page + Supabase reset flow and messaging.
Verify:          End-to-end reset email and login recovery test.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    2
  Ops Blockage:      3
  Compliance Risk:   1
  Frequency:         2
  Fix Effort:        2
  PRIORITY SCORE:    4.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## DEFECT #9
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Severity:        **Major**
Area:            Runtime Validation Coverage
Business Impact: Without full role-based browser verification, dead wires can ship into season.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What happens:    Environment constraints prevented full UI execution matrix.
What should happen: Complete role-by-role click-path and network/console validation.
How to trigger:  Attempt full Playwright/browser run in current container (blocked).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Root cause:      Tooling/runtime constraints (browser binary/install/crash issues).
Fix:             Run full matrix in stable CI/browser environment with seeded fixtures and role accounts.
Verify:          Green end-to-end matrix across Admin/Sales/Driver suites.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score:
  Financial Risk:    3
  Ops Blockage:      3
  Compliance Risk:   2
  Frequency:         5
  Fix Effort:        2
  PRIORITY SCORE:    6.5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

---

## FIX ORDER (sorted)

> Compliance/security blockers elevated first.

1. **Defect #1** — RPC auth identity spoof hardening
2. **Defect #2** — RLS data-isolation hardening
3. **Defect #5** — Audit trail trust/immutability hardening
4. **Defect #9** — Full runtime role-matrix execution in stable browser CI
5. **Defect #3** — Server-side quote totals authority
6. **Defect #4** — Inventory invariant hardening
7. **Defect #6** — Notification policy tightening
8. **Defect #7** — Discount/tax/fee canonical model
9. **Defect #8** — Password reset UX flow

---

## Phase progression

Proceeding to **Phase 8 — Feature Gap Analysis & Roadmap** next.
