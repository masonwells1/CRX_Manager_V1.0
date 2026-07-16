# Graphify Workflow and Missed-Logic Audit — 2026-07-15

## Scope and evidence

- Graphify build commit: `5070fa1f`
- Graph size: 4,350 nodes, 12,222 edges, 309 communities
- Primary graph entry point: `QuickReceivePanel()` (`src_components_receiving_quickreceivepanel_quickreceivepanel`)
- Verification: current source, current migrations, and read-only live PostgreSQL catalog checks
- Production changes: none

Graphify was used to select connected workflow surfaces before narrow source inspection. Findings are not based on graph edges alone: every workflow claim below was checked against executable source, and database-contract claims were checked against the live function catalog where noted.

## Executive summary

The audit found one confirmed broken workflow, two already-known or recovery-oriented capabilities that remain unwired, and one low-severity structural drift risk.

| Severity | Count | Summary |
| --- | ---: | --- |
| High | 0 | No silent money, inventory, authorization, or lifecycle bypass was confirmed. |
| Medium | 3 | Quick Receive over-receive is impossible; customer remainder retrieval is orphaned; cancelled-record restoration is not exposed consistently. |
| Low | 1 | Receiving-condition presentation logic is duplicated across four surfaces. |

The highest-confidence issue is Quick Receive: the interface lets an operator choose over-receive and adds the unmatched quantity to the request, but the same request explicitly sends `p_allow_over_receive: false` and omits the required reason. The live database correctly rejects that request.

## Findings

### M1 — Quick Receive offers an over-receive action that cannot succeed

Status: **confirmed defect** — `[verified in source] [verified in live catalog]`

Graph evidence:

- Graphify resolved `QuickReceivePanel()` to `src/components/receiving/QuickReceivePanel.tsx` and identified its receiving/authentication/error-handling neighborhood.
- Node: `src_components_receiving_quickreceivepanel_quickreceivepanel`
- Graphify does not currently connect a string-literal RPC name to its PostgreSQL function, so the RPC boundary was verified directly in source and the live catalog.

Source evidence:

- `src/components/receiving/QuickReceivePanel.tsx:88` models `over_receive` as an available unmatched-item action.
- `src/components/receiving/QuickReceivePanel.tsx:287` adds unmatched quantity to the final matched purchase-order allocation when that action is selected.
- `src/components/receiving/QuickReceivePanel.tsx:314` calls `receive_po_items`.
- `src/components/receiving/QuickReceivePanel.tsx:318` always sends `p_allow_over_receive: false`.
- `src/components/receiving/QuickReceivePanel.tsx:802` renders the over-receive choice.
- The constructed item payload contains no `over_receive_reason`.
- `supabase/migrations/20260714230000_gauntlet_core_guards.sql:188` rejects an over-receipt unless `p_allow_over_receive` is true.
- `supabase/migrations/20260714230000_gauntlet_core_guards.sql:192` restricts over-receiving to admins.
- `supabase/migrations/20260714230000_gauntlet_core_guards.sql:195` requires a nonblank `over_receive_reason`.

Live evidence:

- A read-only catalog check confirmed the deployed `receive_po_items` body contains the fail-closed over-receive gate and `OVER_RECEIVE_REASON_REQUIRED` behavior, and is executable by `authenticated` users.

Impact:

- An operator can complete the UI decision but cannot complete the receiving transaction.
- The failure is safe rather than silent: the database prevents inventory from being overstated.

### M2 — Customer delivery remainders remain a secured, live, zero-caller capability

Status: **known unresolved owner decision** — `[verified in source] [verified in live catalog]`

Evidence:

- No application source calls `get_customer_delivery_remainders`; generated types are the only `src/` reference.
- `docs/manual/KNOWN_ISSUES.md:67` already records this as business-workflow review finding #40.
- `docs/loops/owner-decisions-2026-07.md:121` explicitly leaves the choice as wire a per-customer remainder card or retire the RPC.
- A read-only live catalog check confirmed the RPC is deployed and executable by authenticated users.

Impact:

- The database can provide a customer-level remainder view, but no user workflow consumes it.
- This is not a newly introduced regression; it remains an explicit product decision.

### M3 — Cancelled order/delivery restoration exists in the backend but is not a user workflow

Status: **capability gap requiring product/security decision** — `[verified in source] [verified in live catalog]`

Evidence:

- No application source calls `restore_cancelled_order` or `restore_cancelled_delivery`; the `src/` matches are generated types and contract tests.
- Both functions exist in the live database.
- The live catalog reports `restore_cancelled_order` as authenticated-executable.
- The live catalog reports `restore_cancelled_delivery` as not authenticated-executable, consistent with `supabase/migrations/20260714220000_shared_idempotency_and_hold_hardening.sql:146`, which restricts it to `service_role`.

Impact:

- There is no in-app recovery path for either cancelled entity.
- The two restore capabilities also have different callable audiences, so exposing recovery later requires an intentional authorization decision rather than simply adding buttons.

### L1 — Receiving-condition display rules are duplicated across four connected surfaces

Status: **structural drift risk** — `[verified in source]`

Graph/source evidence:

- Equivalent `conditionVariant` logic appears in:
  - `src/components/receiving/QuickReceivePanel.tsx:54`
  - `src/components/receiving/ReceivingLogPanel.tsx:33`
  - `src/components/receiving/ReceivingLogMobileCards.tsx:5`
  - `src/pages/PurchaseOrderDetail.tsx:26`
- Equivalent `conditionLabel` logic is also repeated in three of those surfaces.

Impact:

- The copies currently agree, so no active display defect was confirmed.
- A new condition or presentation rule can drift between quick receiving, desktop history, mobile history, and purchase-order detail.

## Looked suspicious but verified as intentional or covered

- **Dashboard reminder calls:** `check_remainder_reminders` and `release_expired_quote_holds` also have active live cron jobs. Dashboard invocation is a belt-and-suspenders path, not the only scheduler.
- **Delivery completion:** inspected UI paths call `confirm_delivery` before `complete_delivery`; no bypass was confirmed.
- **Returns lifecycle:** create, approve, reject, cancel, receive, and credit actions are wired to their RPC paths.
- **Recipe loading:** the UI intentionally performs a non-destructive client-side load. `src/lib/recipeHelpers.ts:5` and `src/pages/JobDetail.tsx:2547` explain why the older destructive `load_recipe_into_job` RPC is not called.
- **Batch invoice posting:** the UI intentionally loops group-aware posting calls. Current migrations explicitly document `batch_post_invoices` as a zero-caller, defense-in-depth RPC.
- **Job cancellation:** lifecycle triggers release job holds and close dispatch assignments when status becomes terminal; the direct status update is therefore not an orphaned cleanup path.

## Graph limitations observed

- String-literal Supabase RPC calls were not reliably joined to PostgreSQL function nodes, so Graphify is strongest here as a navigation and clustering layer, not final proof of caller coverage.
- Broad natural-language queries returned noisy neighborhoods. Exact symbol queries such as `QuickReceivePanel()` were substantially more useful and token-efficient.
- Superseded files under `scripts/.staging-migrations/` appeared in some results because script exclusions are not yet precise enough. Those nodes were not used as authoritative evidence.

## Audit boundary

This report is read-only analysis. It does not implement fixes, change production, apply migrations, or make the owner decisions described above.
