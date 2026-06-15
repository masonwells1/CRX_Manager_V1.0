# PR #59 Codex Review — Execution Summary (2026-05-13)

Closes the codex review of `fix/audit-2026-05-09` (PR #59). Codex surfaced 20
findings (9 P1, 11 P2) across multiple review passes. By end of day:

- **P1: 9 closed, 0 outstanding**
- **P2: 11 closed, 2 deferred** (RLS upper bound — intentional; entity commission recipients — design call)
- **1 false positive** (prepay double-decrement — trigger uses absolute recompute, not relative)

## Migrations applied to live (12 today)

| Codex Finding | Severity | Migration | Status |
|---|---|---|---|
| `update_vendor_bill` positive-total | P2 | `20260511030000` | ✅ already applied 2026-05-12 |
| `create_vendor_bill` positive-total | P2 | `20260511030000` | ✅ already applied 2026-05-12 |
| `apply_prepay_to_invoice` overload drop | P1 | `20260511095000` | ✅ defensive — applied as part of MCP order |
| `bulk_import_order` quantity_remaining | P2 | `20260513140000` | ✅ applied 2026-05-13 |
| `_insert_commissions_for_order` exposed | P1 | `20260513070000` | ✅ REVOKE applied — verified |
| `_insert_commissions_for_order` max(uuid) | P1 | `20260513100000` | ✅ applied (superseded broken `20260513090000`) |
| `_insert_commissions_for_order` recipient_user_id | P2 | `20260513100000` | ✅ applied (full_name lookup; entities NULL) |
| `batch_reschedule_deliveries` 4-arg | P2 | `20260513080000` | ✅ applied |
| `audit_log_allow_payment_allocated` | P1 | `20260513060000` | ✅ applied — restored `/payments` |
| `allocate_payment` gate on payment_date | P2 | `20260513110000` | ✅ applied |
| `edit/delete_prepay_credit` trigger-aware | P2 | `20260513130000` | ✅ applied (with correct 7/4-arg sigs) |
| `edit/delete_prepay_credit` actor spoofable | P1 | `20260513150000` | ✅ **hotfix applied** within minutes of #131's regression |
| `rebate_claim_counters` deny-all policy | P1 | `20260513160000` | ✅ applied |

## Edge Functions deployed via MCP (4 today)

| Function | Version | Hardening |
|---|---|---|
| `create-user` | v17 | `captureEdgeException` in catch block |
| `reset-user-password` | v10 | `captureEdgeException` in catch block |
| `seed-admin` | v15 | `captureEdgeException` in catch block |
| `setup-blend-tickets-storage` | v13 | `captureEdgeException` in catch block |

All 4 functions use the updated `_shared/sentry.ts` with the `[SENTRY_MISCONFIG]`
log sentinel for grep-ability when `SENTRY_DSN` is missing/malformed.

## Frontend refactors

`parseDollarsToCents` is now positive-only by default (strips negative signs).
The credit_limit bypass on CustomerDetail is closed — typing `-100` no longer
stores a negative `credit_limit_cents` that would cause `create_quick_delivery`
to skip the credit check.

New `parseDollarsToCentsSigned` exposes the sign-preserving behavior for the
3 vendor-bill adjustment callsites (NewVendorBill ×2, VendorBillDetail ×1).
Test suite: 1913 passing (+5 new parseCents tests).

## False positives

- **P1 prepay double-decrement** (`20260512050000:68`): Codex assumed the
  `AFTER INSERT` trigger uses relative increment. The trigger formula is
  `balance_cents = original_amount_cents - SUM(prepay_applications.applied)`
  (absolute recompute), so the hand-decrement in `apply_prepay_to_invoice`
  is overwritten by the trigger's correct value. Migration `20260512050000`
  explicitly documents this on lines 26-28. No action needed.

## Deferred (follow-up sprint)

- **Customer RLS upper bound** (P2): drivers/applicators can see customers for
  jobs scheduled arbitrarily far in the future. Intentional — farm logistics
  require visibility weeks/months ahead for route/job planning. Lower bound
  prevents the meaningful historical leak.
- **Entity commission recipients** (P2): CMCTW LLC and Crop Rx Solutions are
  in the hardcoded `CommissionSplitEditor.RECIPIENTS` list but have no profile
  row. `recipient_user_id` stays NULL → `create_commission_payment` rejects
  them. Pre-existing limitation. Possible fixes: create service profile rows,
  or refactor frontend to send profile UUIDs, or update payment flow to
  support non-profile recipients. Needs design call.

## Codex usage limit hit

Codex review billing was exhausted at end of day. No more automated reviews
will run on PR #59 until Mason adds credits or upgrades the Codex plan.

## Manual UI cleanup needed

The ~17 codex review threads on PR #59 that have been addressed will need to
be manually marked "Resolve conversation" in the GitHub PR UI — Codex doesn't
auto-resolve after fix-commits land.
