# Vendor-bill/accounting-period close lock — local candidate closeout

## Scope

Live migration `20260730114102_vendor_bill_period_close_lock.sql` closes the
governed-RPC race between `close_accounting_period` and `create_vendor_bill` /
`update_vendor_bill`. It adds a whole-calendar-month constraint before deriving
month keys, a non-public internal shared/exclusive transaction-lock helper in
namespace `(73492010, year * 12 + month - 1)`, and re-emits the four current
authoritative RPC bodies with the required serialization changes. It was
submitted as `20260729231031_vendor_bill_period_close_lock` and B7-renamed to
the server-assigned ledger version after apply; the executable body was not
changed by that rename.

`create_vendor_bill` locks its vendor and optional purchase order, then takes
its shared month lock before its authoritative period check.
`update_vendor_bill` locks its bill row, then takes the deduplicated ascending
old/new month locks before both checks. The close takes the exclusive lock after
authorization, idempotency replay, and month validation, but before its invoice
completeness scan and upsert. No vendor-bill or PO completeness gate was added.

This is more than an invisible lock-order adjustment: under a same-month close,
create runs its existing vendor, amount, and PO validations before taking the
shared advisory lock and reading closed-period state. Those validation errors may
therefore surface before a closed-period refusal; that precedence is intentional
for the established row-then-month lock order. Once it reaches the month lock,
the request waits for close to finish and then gets the authoritative
closed-period refusal instead of reading an earlier open state and racing into
an insert. The separate existing-vendor-bills residual remains intentional:
`close_accounting_period` still does not reject an already-existing vendor bill
as a completeness condition. A second residual is also unchanged: only the
governed create/update vendor-bill RPCs join this protocol, so a pre-existing
concurrent draft/unposted-invoice writer can still beat close's invoice
completeness scan. This candidate is not a new AP close policy.

`check_period_open` deliberately remains only the authoritative closed-period
reader, but this candidate makes a deliberate configuration hardening: the live
function's `search_path = public, pg_temp` becomes `search_path = ''`. Its body
is otherwise byte-unchanged, all relation references in that body are explicitly
`public`-qualified, and the disposable PostgreSQL 17 proof passes with that
configuration. It does not acquire the new advisory lock, so unrelated callers
do not inherit a new lock protocol or broader function contract. The two
vendor-bill writers acquire their own governed shared locks immediately before
calling it.

Every re-emitted public SECURITY DEFINER routine explicitly reasserts its live
callable-role boundary: `PUBLIC` and `anon` are denied, while `authenticated`
and `service_role` retain EXECUTE. The non-public month-lock helper remains
unexecutable by all four API roles. The apply-time postflight proves both
boundaries instead of relying on `CREATE OR REPLACE` to preserve prior ACLs.

## Live apply and postflight observed

Root's fresh read-only production preflight observed PostgreSQL 17.6,
`accounting_periods` with 9 total rows, zero closed rows, and zero non-whole
month rows. The live Section 9 predicate had zero violations, and the exact
existing fingerprints for `create_vendor_bill`, `update_vendor_bill`, and
`close_accounting_period` matched the source baseline used for this candidate.
The Supabase ledger now records version `20260730114102` with name
`20260729231031_vendor_bill_period_close_lock`. Targeted live catalog, ACL, and
whole-calendar-month-constraint verification passed. The registered Section 9
rollback-only business chain reached expected terminal `ERROR P0001
SMOKE_PASS_ROLLBACK`, proving the closed-period update refusal while leaving no
fixture data committed. All 20 standing invariant predicates have **0
non-allowlisted rows**. The raw output contains seven approved allowlisted rows
across five predicates: actor-forgery (1), anon-exec-secdef (1),
auth-bound-role-ungated (1), status-literals (3), and
ungated-secdef-mutators / `log_failed_notification(...)` (1).

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

## Remaining boundaries

This slice guarantees only `create_vendor_bill` and `update_vendor_bill` date
writes. `record_vendor_payment`, `void_vendor_payment`, `void_vendor_bill`, and
other mutators that only call `check_period_open` retain their pre-existing
close race unless a separate, coherent, and independently proven protocol adds
them. Sol adjudication retained this boundary: those AP-only cases are a MED
residual, while a global protocol is a separate HIGH-risk lane because many
financial mutators retain the same race. Do not widen this migration here.

B7 closeout is complete: the disk migration is named
`20260730114102_vendor_bill_period_close_lock.sql`, its leading status now says
APPLIED LIVE while preserving the first purpose comment, and its history/manual
references record the same server-assigned version. The proof runner and source
regression discover the unique stable suffix rather than embedding a timestamp.

## Follow-up same-key replay — applied live

`20260730124308_close_accounting_period_idempotency_recheck.sql` is the B7
renamed disk record of the live server-assigned ledger version `20260730124308`
(submitted as `20260730121951_close_accounting_period_idempotency_recheck`). It adds
a same-key lookup after the exclusive month advisory lock and before the
already-closed refusal as redundant defense in depth. Under the current
`check_idempotency` helper, the first lookup takes the key-only transaction
advisory lock, so a concurrent same-key caller blocks and replays there. The
behavioral proof therefore demonstrates current helper serialization, not the
necessity of the later lookup: Sol mutation testing removed that block and the
current behavioral proof still passed. The source regression retains a separate
structural assertion that the post-month-lock recheck exists. Its postflight asserts the one `jsonb` overload,
`postgres` owner, SECURITY DEFINER mode, `search_path=public, pg_temp`, helper
execute path, and exact callable-role boundary. The disposable PostgreSQL 17
proof now runs two same-key closes and proves identical JSON replay with one
period row and one idempotency row. It observes PostgreSQL lock readiness for
every schedule rather than using a 500 ms child-liveness guess. Live postflight
confirmed exactly one `close_accounting_period(date,uuid,text)` owned by
`postgres`, SECURITY DEFINER with `search_path=public, pg_temp`, with only
postgres/authenticated/service_role in its ACL (`anon=false`,
`authenticated=true`, `service_role=true`) and exactly two idempotency reads,
including the post-month-lock recheck. The registered fixed-date delivery
rollback smoke returned expected `ERROR P0001 SMOKE_PASS_ROLLBACK` after apply.
The independently executed post-follow-up all-20 invariant sweep is CLEAN:
7 raw rows, all 7 approved allowlist rows, and 0 new/non-allowlisted findings
across the same five predicates—actor-forgery (1), anon-exec-secdef (1),
auth-bound-role-ungated (1), status-literals (3), and
ungated-secdef-mutators (1). Ledger version `20260730124308` was independently
confirmed exactly once.

## Final review correction — applied live

Opus' exact-SHA review found that PostgreSQL resolves
`date_trunc(text, date)` through the time-zone-aware overload. The current
expressions are safe for the live UTC configuration and all nine existing rows,
but an accounting constraint should not depend on session time zone.
`20260730140808_accounting_period_immutable_date_math.sql` is the B7-renamed
disk record of the live server-assigned version (submitted as
`20260730140000_accounting_period_immutable_date_math`). It explicitly casts date inputs to
`timestamp without time zone` in the whole-month CHECK and both close-RPC
boundary calculations. It preserves the lock, replay, owner, security, and
grant behavior, changes no business rows, and carries apply-time postflight
checks. The two mandatory content-bound Sol reviewer charters returned CLEAN
before apply. Live readback confirmed one ledger row; one validated constraint
with exactly two immutable casts; 9 period rows with 0 invalid; and one
`close_accounting_period(date,uuid,text)` overload with `postgres` owner,
SECURITY DEFINER, `search_path=public, pg_temp`, two immutable casts, two
idempotency reads, canonical `ACTOR_MISMATCH`, `anon=false`, and
`authenticated/service_role=true`. `check_period_open(date)` retains its
exactly empty path, fully qualified relation reference, and explanatory
catalog comment.

## Disposable PostgreSQL 17 proof

`npm run proof:vendor-bill-period-close` first runs the readiness helper's
success/timeout unit test, then restores the checked-in real schema baseline in
a network-isolated Supabase PostgreSQL 17 container. Before reproducing the old
race, it replays in ledger order all 12 migrations that production had between
the `20260727174805` baseline and this three-migration release. The proof then
applies the three candidates in their exact live order, for 15 post-baseline
migrations total. Markers
`PRE_CANDIDATE_POST_BASELINE_REPLAY_PASS count=12` and
`FULL_POST_BASELINE_REPLAY_PASS count=15` make those schema generations
observable instead of silently testing a stale snapshot.

The runner uses disposable BEFORE INSERT/UPDATE proof barriers only after the
actual RPC period checks, not replacement writer functions. It reproduces the
baseline create-versus-close race, then proves candidate
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

The generated schema registry was refreshed from all six live-introspection
queries after the migrations landed. Its high-water is now
`20260730140808`; it records all three applied migration names and lists
`accounting_periods_whole_calendar_month_check` as a loud, intentionally
unparsed multi-column constraint for future hook and reviewer awareness.
The live schema-integrity suite now also fails if any of
`create_vendor_bill`, `update_vendor_bill`, or `close_accounting_period`
loses its exact shared/exclusive `_lock_accounting_months` call in a future
function re-emission. The adjacent invoker check pins `compute_season` to
SECURITY INVOKER with exactly `search_path=public`.

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
production behavior, permission, or application code change. The delivery
guard uses three fixed, isolation-checked historical calendar months (January,
February, and March 1990), so it no longer searches the trailing 365 days or
branches on `CURRENT_DATE`; it still exercises the real `complete_delivery`,
`enforce_delivery_accounting_period` trigger path, and `void_delivery`, then
terminates with rollback-only cleanup.

The removed catalog-only candidate smoke was not registered because repository
policy correctly forbids treating an isolated shape probe as a business-chain
gate. `npm run proof:vendor-bill-period-close` remains the explicit,
network-isolated two-session lock proof; the registered Section 9 chain supplies
the rollback-only business proof after apply.
