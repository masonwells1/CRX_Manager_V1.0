# Audit Fix Sprints — Continuation Handoff

**Date:** 2026-04-30
**Status:** Sprints A1, A2 (partial), B, and C shipped today. Sprints A2-tail, A3, A4, D, E, F deferred.

This doc captures everything the next session needs to pick up cleanly. All four codex audits (`2026-04-30-money-inventory-audit-findings.md`, `2026-04-30-security-permissions-audit-findings.md`, `2026-04-30-data-integrity-workflow-locks-audit-findings.md`, `2026-04-30-production-operations-audit-findings.md`) had ~30 findings, ~12 unique P1s. We closed 7 P1s today; 5 P1s plus all P2s remain.

---

## What shipped today (commits `9c498cf` → `eef3807`)

| Sprint | Commit | What it did |
|---|---|---|
| A1 | `9c498cf` | Auth gates on `save_field_app_invoice`, `create_invoice_from_blend_ticket`, `post_invoice_group` (Phase 9 / migration `20260430210000`) |
| A2 partial + B | `2fda04d` | Auth gates + integrity rules on `save_invoice` (rejects standalone) and `create_invoice_from_order` (rejects duplicates); UI cleanup on `Invoices.tsx` (Phase 10 / migration `20260430220000`) |
| C | (this commit) | Field-app RLS lockdown — `field_app_locations`, `field_app_location_shares`, `application_records` (Phase 11 / migration `20260430230000`) |

Migrations applied to live Supabase project `rhyzpcqhnizqbxphqdkr`. Each migration ran its own `DO`-block self-test before returning success.

---

## What's still to fix — priority order

### P1 — `allocate_payment` auth gate (deferred from Sprint A2)

**Why deferred:** large function (~250 lines in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:749+`). Couldn't fit in the same migration as `save_invoice`/`create_invoice_from_order` without burning excessive context.

**Pattern to apply:** mirror Phase 7 / Phase 9 / Phase 10 — `auth.uid()` not null, reject `COALESCE(p_performed_by, auth.uid())` style; replace with strict `IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE`. Add admin/sales role check.

**Steps:**
1. `grep -n "CREATE OR REPLACE FUNCTION allocate_payment" supabase/migrations/*.sql | tail -1` to find the latest source
2. Read the full function body
3. Add the auth gate at the top (after DECLARE, before idempotency check)
4. Apply via `apply_migration`
5. Run tests + commit

### P1 — Sprint A3: delivery RPCs (3 functions)

| RPC | Source migration | Notes |
|---|---|---|
| `confirm_delivery` | `20260316300000_confirm_delivery_idempotency.sql` | Has actor mismatch (line 25-58) — use `COALESCE(p_performed_by, auth.uid())` pattern. Drivers should also be allowed (assigned-driver gate) |
| `complete_delivery` | `20260331200000_fix_complete_delivery_precheck.sql` | Same actor-mismatch problem (line 43-48). **Also has Sprint D issues:** doesn't require `status='in_progress'`, drivers blocked despite UI showing them the button |
| `create_quick_delivery` | `20260333600000_quick_delivery_optional_invoice.sql` | Actor mismatch line 52-60 |

**Recommendation:** ship A3 (auth gates only) FIRST as one migration, then handle Sprint D's status-transition + driver-completion business rules in a separate migration after Mason confirms the policy decisions.

### P1 — Sprint A4: ops RPCs (3 functions)

| RPC | Source migration | Notes |
|---|---|---|
| `save_purchase_order` | `20260331200001_fix_po_edit_partially_received.sql` | Currently checks role using `p_performed_by` directly (no `auth.uid()` comparison). Admin-only. |
| `receive_po_items` | `20260332500000_fix_receive_po_and_audit_constraints.sql` | Actor mismatch line 58-63 |
| `void_commission_payment` | `20260332600000_fix_commission_functions_updated_at.sql` | Actor mismatch line 160-164. Admin-only. |

### P1+ — Sprint D: delivery workflow gaps (needs Mason's input)

The data-integrity audit flagged five issues in this surface area. **Three need business decisions before code:**

1. **Should drivers be allowed to complete deliveries?** Currently `confirm_delivery` allows assigned driver, but `complete_delivery` is admin/sales only. The UI shows the completion button to drivers (DeliveryDetail.tsx:1342). Decide:
   - Allow assigned driver (mirror `confirm_delivery`'s pattern), OR
   - Hide completion section for drivers and rewrite driver-flow text
2. **What replaces the broken delivery → draft-invoice auto-create?** UI says "draft invoice auto-created" (DeliveryDetail.tsx:1342-1345), getting-started doc says the same — but the RPC was rewritten and no longer creates the invoice. Decide:
   - Restore server-side auto-invoice creation, OR
   - Add a "completed-but-uninvoiced deliveries" admin queue + remove the UI promise
3. **`cancel_delivery` allows cancelling completed deliveries** — should be `void_delivery` for completed. UI already enforces this; database doesn't. Easy fix once decided.

**Mechanical fixes (no decision needed):**
- `complete_delivery` should require `status='in_progress'` (one-line guard add)

### P2 — Sprint E: inventory transactional integrity

1. **`retire_inventory_item` RPC** — replace the split frontend audit-insert + delete in `InventoryPage.tsx:644-710`. Atomic: lock row, re-check holds/prebooked/pending, insert ledger, delete or soft-retire.
2. **Cycle count clamp/ledger drift** — `complete_cycle_count` and `reverse_completed_cycle_count` clamp inventory at zero with `GREATEST(0, ...)` but record the FULL variance in `inventory_transactions`. Either block the adjustment when exact ledger isn't applicable, or record actual delta + exception row.
3. **Cycle count item edits in locked RPC** — currently editable from React (CycleCounts.tsx:229-252) without parent-status check. Move to RPC that validates `parent.status = 'in_progress'`.

### P2 — Sprint F: operations hardening

The largest scope. Highest-value items first:

1. **`send-email` Edge Function** — accepts arbitrary HTML/recipients/subject from any admin/sales/driver. Lock down to server-side templates keyed by `email_type`, restrict drivers to delivery-specific templates, add attachment limits, add rate limits.
2. **`process-blend-ticket` per-resource auth** — uses service-role client after only checking broad role. Verify caller is allowed to process THAT specific ticket.
3. **pg_cron for Dashboard-triggered jobs** — `check_remainder_reminders()` and `release_expired_quote_holds()` only run when someone opens the Dashboard. Move to real scheduler (Supabase pg_cron or Vercel cron).
4. **Reconciliation → ops dashboard** — `runReconciliationChecks()` exists but is not wired anywhere. Update its payment-source query (currently reads stale `payments` table; should read `invoice_line_allocations`). Then expose as admin-only Integrity Report page or scheduled run.
5. **SQL validators in CI** — `scripts/validate-sql-migrations.sh` and `scripts/validate-sql.sh` run locally via husky but not in `.github/workflows/ci.yml`. Add them.
6. **`docs/operations/production-runbook.md`** — backup policy, restore drill cadence, deploy rollback, Supabase migration rollback, month-end close steps, log locations. Critical for production billing app.
7. **Edge Function alerting** — `send-email`, `process-document`, `process-blend-ticket` log to platform only. Add Sentry reporting (or similar) for high-impact failures.

---

## Process notes for the next session

- **Each sprint = one migration = one commit.** This stays revertable.
- **The bash-safety hook flags any commit message that contains `--no-verify`, `rm -rf src/`, or other dangerous-pattern strings literally.** Even when those strings are inside a `<<EOF` heredoc as documentation. Workaround: rephrase or describe in higher-level terms (e.g., "blocks bypass-hook flags" instead of literally writing the flag name).
- **Pre-commit hook (.husky/pre-commit) takes ~90-120 seconds** because it runs lint + build + test. Plan accordingly.
- **`pg_get_functiondef` is blocked by sql-safety hook.** When you need to read the latest source of a function, read the source migration file via `grep -n "CREATE OR REPLACE FUNCTION <name>" supabase/migrations/*.sql | tail -1` then `Read` that file at the line range.
- **0 invoices, 0 application_records, 1 job, 0 customer_application_rates rows in production today.** Latitude for behavior changes is high; minimal retroactive-break risk.

## Suggested sprint order for next session

1. **Sprint A3 (delivery auth gates)** — same shape as A1/A2, mechanical, closes 3 P1s
2. **Sprint A4 (ops auth gates)** — same shape, closes 3 more P1s. After this all 12 actor-spoofing vectors are closed.
3. **Sprint A2-tail (allocate_payment)** — large function, last money-RPC P1
4. **Sprint D (delivery workflow)** — once Mason picks the policy options
5. **Sprint E (inventory)** — bigger lift; new RPC needed
6. **Sprint F (ops)** — biggest scope; can be split into F1 (Edge Functions), F2 (cron), F3 (CI + runbook)

Estimated remaining work: 2-3 focused sessions to clear all sprints.
