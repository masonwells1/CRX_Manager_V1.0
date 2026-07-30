# Vendor-bill/accounting-period close lock — local candidate closeout

## Scope

Forward migration `20260729231031_vendor_bill_period_close_lock.sql` closes the
governed-RPC race between `close_accounting_period` and `create_vendor_bill` /
`update_vendor_bill`. It adds a whole-calendar-month constraint before deriving
month keys, a non-public internal shared/exclusive transaction-lock helper in
namespace `(73492010, year * 12 + month - 1)`, and re-emits the four current
authoritative RPC bodies with the required serialization changes.

`create_vendor_bill` locks its vendor and optional purchase order, then takes
its shared month lock before its authoritative period check.
`update_vendor_bill` locks its bill row, then takes the deduplicated ascending
old/new month locks before both checks. The close takes the exclusive lock after
authorization, idempotency replay, and month validation, but before its invoice
completeness scan and upsert. No vendor-bill or PO completeness gate was added.

This is more than an invisible lock-order adjustment: under a same-month close,
create now waits at the shared advisory lock before it can read closed-period
state. Consequently the observable error precedence changes under contention:
the request waits for close to finish and then reports the authoritative
closed-period refusal, instead of reading an earlier open state and racing into
an insert. Its pre-lock authorization, vendor/PO, and amount validations retain
their existing precedence. The separate existing-vendor-bills residual remains
intentional: `close_accounting_period` still does not reject an already-existing
vendor bill as a completeness condition; this candidate serializes governed
create/update activity, not a new AP close policy.

`check_period_open` deliberately remains only the authoritative closed-period
reader, with its established tighter `search_path = ''`. It does not acquire
the new advisory lock, so the many unrelated callers do not inherit a new lock
protocol or broader function contract. The two vendor-bill writers acquire their
own governed shared locks immediately before calling it.

## Read-only live preflight already observed

Root's fresh read-only production preflight observed PostgreSQL 17.6,
`accounting_periods` with 9 total rows, zero closed rows, and zero non-whole
month rows. The live Section 9 predicate had zero violations, and the exact
existing fingerprints for `create_vendor_bill`, `update_vendor_bill`, and
`close_accounting_period` matched the source baseline used for this candidate.
This evidence does not authorize an apply; the migration remains parked pending
fresh exact-SHA review and Mason's explicit approval.

## Caller and direct-reader classification

The raw source token scan has 31 `check_period_open` hits. Two are comments
only: `_save_invoice_scoped_impl` and `enforce_invoice_draft_on_insert`. The 29
executable calls classify as 26 active/delegating mutators, one read-only
`preview_finance_charges`, trigger `enforce_delivery_accounting_period`, and
hard-disabled `apply_remaining_prepayments` (unreachable call). They retain
their existing reader-only protocol. Only the two governed vendor-bill writers
need the new pre-lock because an update can touch both its old and new months.

Direct `accounting_periods` participants include `close_accounting_period`,
`reopen_accounting_period`, `check_period_open`, dashboards,
`_complete_delivery_authorized_impl` (wrapper `complete_delivery` prechecks;
internal warning path), and `void_delivery` (intentional soft-warning business
exception). Direct authenticated-admin table INSERT/UPDATE/DELETE/TRUNCATE is
an existing, UI-unreachable residual boundary. It is deliberately unchanged:
a BEFORE row trigger would acquire its row lock before its month lock and can
deadlock with close's month-lock then upsert-row order. Reopen only relaxes a
closed state and remains unchanged.

## Boundary

This is local-only. It does not apply a migration, change live data, alter
direct table permissions, deploy, push, or open a PR. Any live apply requires
fresh exact-SHA review and the normal migration gate.

## Disposable PostgreSQL 17 proof

`node scripts/smoke/prove-vendor-bill-period-close-concurrency.mjs` restores
the checked-in real schema baseline in a network-isolated Supabase PostgreSQL
17 container. It uses disposable BEFORE INSERT/UPDATE proof barriers only after
the actual RPC period checks, not replacement writer functions. The runner
reproduces the baseline create-versus-close race, then proves candidate
create-writer-first and close-first schedules, update-writer-first and
close-first schedules (including no idempotency/audit/activity side effects on
the rejected update), and simultaneous opposite `Jan→Feb` / `Feb→Jan` updates
on distinct bills with shared-lock compatibility. That completion test alone
does not prove acquisition order, so the runner additionally holds Jan
exclusive for an actual reverse-input `Feb→Jan` update and asserts a waiting
Jan request with no granted Feb request; it also holds Feb for `Jan→Feb` and
asserts granted Jan then waiting Feb. The live schedules observe the candidate's
canonical acquisition order; the source regression separately requires the
helper's ascending `ORDER BY` clause. Terminal markers include
`CANDIDATE_UPDATE_CANONICAL_JAN_FIRST_PASS`,
`CANDIDATE_UPDATE_CANONICAL_FORWARD_ORDER_PASS`, and
`VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS`.

After applying the candidate in that disposable database, the runner also
executes the existing Section 9 PO/AP, finance-charge month-dedup, and delivery
accounting-period guard rollback chains. The Section 9 chain is the registered
business-chain proof for all four touched RPCs: it creates a real vendor bill,
closes its historical month through `close_accounting_period`, and proves
`check_period_open` rejects the subsequent `update_vendor_bill` before a
rewrite. Its closed-period error assertion is the stable authoritative
`Date ... falls in closed accounting period` message. The remaining two chains
prove the new whole-month constraint did not invalidate their registered
fixture paths.

The fixture-only delivery edits are intentional compatibility repairs for that
new constraint and the disposable auth harness: every synthetic closed period
now spans the complete calendar month; the product fixture avoids the unrelated
governed price column; and each switched simulated actor updates both JWT claim
representations used by the restored baseline. They add no pricing flag,
production behavior, permission, or application code change.

The removed catalog-only candidate smoke was not registered because repository
policy correctly forbids treating an isolated shape probe as a business-chain
gate. `npm run proof:vendor-bill-period-close` remains the explicit,
network-isolated two-session lock proof; the registered Section 9 chain supplies
the rollback-only business proof after apply.
