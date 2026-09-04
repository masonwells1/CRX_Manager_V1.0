## 2026-09-04 - F2: the eight next_*_number generators now refuse inactive and out-of-role callers on live

**Migration:** `supabase/migrations/20260903160000_gate_number_generators_active_profile_role.sql`
**Live ledger:** version `20260904023121`, name `20260903160000_gate_number_generators_active_profile_role`
**Code:** merged 2026-09-03 as PR #583, squash `3a6d52fc7`

## What changed on live

All eight `SECURITY DEFINER` number generators previously granted `EXECUTE` to `authenticated` and
checked nothing, so any logged-in session — including two active `entity_recipient` customer-portal
accounts and one deactivated `sales_rep` — could call all of them. `next_invoice_number` is not
read-only: it calls `nextval()` and conditionally `setval()`, so an unauthorized caller could
advance live invoice numbering.

Each body now raises `AUTH_REQUIRED` when `auth.uid()` is NULL and `INSUFFICIENT_ROLE` unless the
caller is an `is_active = true` profile in the allowed role set, **before** its
`pg_advisory_xact_lock`, so a refused caller cannot take the lock either. Direct `authenticated`
EXECUTE was revoked from the six generators the browser never calls directly;
`next_cycle_count_number` and `next_job_number` keep it because `CycleCounts.tsx` and
`JobDetail.tsx` call them from the browser.

## Proof

Structural, read from live `pg_proc` / `has_function_privilege` after the apply:

- 8 of 8 carry the `AUTH_REQUIRED` + `INSUFFICIENT_ROLE` + `is_active` gate (0 of 8 before).
- Exactly ONE overload of each, all `prosecdef = true`.
- `authenticated` direct EXECUTE: `next_cycle_count_number` and `next_job_number` only.
- `anon` EXECUTE: none of the eight.

Behavioral, observed on live via role simulation in a single DO block that ends in an
unconditional `RAISE EXCEPTION` (so it cannot commit), run inside a scoped `REAL-DATA-OK` window
opened and deleted around that one statement:

| Principal | Result |
| --- | --- |
| deactivated `sales_rep` `38cdefbc` | `INSUFFICIENT_ROLE` |
| unauthenticated (no `sub` claim) | `AUTH_REQUIRED` |
| active `admin` `22c1fc50` | `CC-2026-00018` |

Pre-apply gates: offline prover `NUMBER_GENERATOR_GATE_PROOF_PASS` with all 15 mutation tests
firing on a disposable `postgres:17-alpine`; `rls-security-reviewer` and `migration-drift-reviewer`
both CLEAN from `gpt-5.6-sol`/high, each with a genuine `^tokens used` completion marker.

## Disclosed cost

Verification case 3 permanently advanced the cycle-count sequence by one, so one internal
cycle-count number is skipped (sequences are non-transactional). Cycle-count was chosen over
invoice/order/PO precisely because a gap there has no financial or customer-facing impact. Mason
approved both the apply and the verification in-chat, including this cost, before either ran.

## Reviewer charter fix shipped alongside

`.claude/agents/migration-drift-reviewer.md` CHECK 2 gained a mandatory search **method** and a new
step 4. That reviewer had never once returned a verdict — it walked ~900 migration files one at a
time over the network and died after 598 and then 751 `fetch_blob` calls, producing an
UNADJUDICATED capture that resembled a verdict. The whole corpus is already checked out locally, so
the charter now requires a small bounded number of local `Grep`/`Bash` searches and forbids remote
per-file enumeration. On its first run under the fixed charter it completed and returned CLEAN in
93,656 tokens.

Step 4 records that historical migration text shows what was AUTHORED, not what currently EXISTS,
so multiple authored signatures are a signal to confirm against the live catalog rather than a
BLOCKER on their own. **Correction:** this entry originally claimed "no severity was lowered". That
was wrong — the first draft of step 4 let a live overload *count* settle the question, and an
exact-SHA `gpt-5.6-sol` review caught it. See
`2026-09-04-drift-reviewer-check2-identity-signatures.md` for the defect and the fix. No check was
removed, and step 2 — the BLOCKER on a differing-argument overload with no `DROP FUNCTION` — is
untouched.

## Not done here (owned elsewhere)

- `.claude/schema-registry.json` refresh — orchestrator's consolidated pass.
- `src/pages/JobDetail.tsx:1861-1862` discards the RPC error, so a refused user sees a blank
  job-number field instead of a toast — F06 lane.
