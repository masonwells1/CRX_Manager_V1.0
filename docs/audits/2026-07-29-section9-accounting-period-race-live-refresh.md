# Section 9 Accounting-Period Race — Live Refresh

**Date:** 2026-07-29 (America/Chicago)  
**Scope:** read-only production and current-source verification  
**Verdict:** **OPEN P1 / HIGH production-hardening gap**

## Owner summary

The Section 9 Purchase Order / Accounts Payable remediation is applied in
production and its five original invariant findings are cleared. That does not
close a separate concurrency defect identified during its design review:

- `create_vendor_bill` checks that the bill month is open and then writes;
- `update_vendor_bill` checks that the old and new bill months are open and
  then writes; and
- `close_accounting_period` can close the same month concurrently.

These operations do not take a shared transaction lock. A close can therefore
commit after a bill RPC's open-period check but before that bill RPC commits.
The bill can then land in a month that is already closed.

This is a race condition: each operation is correct when run alone, but their
interleaving can violate the closed-period rule. It requires a new forward
migration and deterministic concurrency proof. It does **not** justify editing
the already-applied Section 9 migration.

## Current-state correction

The older 2026-07-25 design packet described this as an apply blocker for a
pending migration. That wording is now stale:

- production migration history contains version `20260726190515`;
- `docs/manual/KNOWN_ISSUES.md` records the Section 9 remediation as applied
  live on 2026-07-26; and
- the live Section 9 invariant predicate returns zero findings.

The accurate current classification is an open hardening gap in the live
functions, separate from the five remediated Section 9 findings.

## Fresh evidence

Read-only production inspection on 2026-07-29 found:

| Function | Checks period open | Shared advisory transaction lock |
| --- | --- | --- |
| `create_vendor_bill` | Yes | No |
| `update_vendor_bill` | Yes, for stored and requested bill dates | No |
| `close_accounting_period` | No — it is the close operation | No |

The corresponding live function-definition fingerprints were:

| Function | MD5 |
| --- | --- |
| `create_vendor_bill` | `226cf5d432eb96099471a16d9bc067fd` |
| `update_vendor_bill` | `c79850cced3b7463909047361cf20c3f` |
| `close_accounting_period` | `f269720a066649f56decf45e770ed625` |

Current source agrees with production. Migration
`20260726190515_section9_po_ap_high_remediation.sql` calls
`check_period_open` from both bill RPCs but does not serialize those checks
with `close_accounting_period`.

A live catalog scan also found 31 public functions containing
`check_period_open` calls, excluding the helper itself; two are trigger
functions. That count is a discovery boundary, not a claim that all 31 are
unsafe. Each mutating caller must be classified before a shared locking
contract is introduced.

## Required corrective design

Use one canonical month-scoped lock contract shared by:

1. `close_accounting_period`;
2. every RPC that can create, move, void, or otherwise mutate a dated
   accounting record; and
3. trigger paths that enforce the same period boundary.

The lock must be:

- transaction-scoped (`pg_advisory_xact_lock`);
- derived deterministically from the accounting month;
- acquired before checking open/closed state;
- acquired in a stable order when one operation touches two months; and
- followed by the period check and protected write in the same transaction.

The corrective migration should be forward-only. Do not modify migration
`20260726190515` or any other applied migration.

## Acceptance proof

Do not apply a corrective migration until all of the following pass:

- every `check_period_open` caller is classified as read-only, mutating, or
  trigger-driven;
- exact-SQL independent review is clean;
- rollback-only migration smoke passes in a disposable database;
- deterministic two-session tests prove that close-versus-create and
  close-versus-update cannot interleave past the period check;
- old-period/new-period update tests prove stable lock ordering and no
  deadlock;
- existing Section 9 and financial invariant sweeps remain clean; and
- a fresh live preflight confirms the production function fingerprints and
  migration high-water have not drifted.

## Boundaries

This refresh changes documentation only. It applies no migration, changes no
live data, and modifies no function, trigger, grant, policy, generated schema,
or application code.

Implementation is intentionally deferred while Phase 3C and other active
migration lanes are in flight. The next safe step is a bounded caller
classification and two-session test design on a fresh branch; the live apply
remains a separate explicit approval gate.
