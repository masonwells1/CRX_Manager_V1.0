## 2026-09-07 - Keep the commission report replay guard valid after its successor

CodeRabbit correctly found that the parked
`20260905200000_commission_history_report_replay_guard.sql` accepted only the currently live
`get_commission_balance_report(date)` body and comment. The later parked
`20260905200600_latest_commission_recipient_label.sql` replaces that same function signature with a
second reviewed body and comment. A filename-ordered first rollout succeeded, but replaying
`20260905200000` afterward refused the valid post-`20260905200600` contract as dependency drift.

The replay guard now accepts exactly those two reviewed balance-report body hashes and exactly those
two reviewed comments in both preflight and postflight. Their array positions are required to match,
so a successor body carrying the predecessor comment (or the reverse) is still rejected instead of
turning the two contracts into four cross-product combinations. The payment-detail child remains
pinned to its one reviewed body/comment pair. Every other signature, ownership, language, security,
search path, ACL, return-shape, admin-gate, and catalog assertion remains unchanged.

`scripts/smoke/prove-commission-migration-plan-order.mjs` now exercises the missing direction in a
network-isolated PostgreSQL 17 container: after the real ordered rollout installs
`20260905200600`, it replays `20260905200000`, observes success, and confirms the successor balance
report body was preserved. Separate mutations remove the successor body pin, remove the successor
comment pin, and mismatch the body/comment pair; each must fail with
`COMMISSION_HISTORY_REPORT_DEPENDENCY_DRIFT` and leave the successor body unchanged. This makes both
new allowances and their pairing load-bearing rather than decorative.

The first proof run also exposed a stale harness assumption after `main` added the unrelated parked
`20260905090000_next_invoice_number_year_chicago.sql`: the plan-order prover classified every
`20260905*` filename as part of the six-file commission cohort and therefore counted seven. It now
selects the six commission filenames explicitly, so a separate parked migration can neither join
the commission rollout nor invalidate its cohort count by timestamp prefix alone. Because the full
plan harness still executes that separate invoice candidate before the commission cohort, it now
names and asserts that file's single-transaction wrappability too; the invoice candidate's dedicated
prover remains responsible for its behavior.

The next proof run reached PostgreSQL and exposed a second time-dependent fixture assumption. The
inherited base prover deliberately seeds `payment_date = CURRENT_DATE` to reproduce the UTC/Chicago
boundary bug; during a Chicago evening that value is tomorrow, so the `20260905200300` business-date
guard correctly refuses it. The plan-order proof now normalizes only its disposable payment fixture
to Chicago-today before walking the cohort and asserts that no future payment remains. The dedicated
business-date prover retains responsibility for the future-date refusal path.

The exact-SHA adversarial review found the same inherited fixture issue in the standalone
label-repair proof. That proof now normalizes its retained disposable payment before the
business-date preflight and gives the later recipient-currentness scenario explicit Chicago
commission and payment dates. A run during the affected Chicago-evening/UTC-next-day window now
passes the full label-repair, stale-recipient, exact-cent settlement, and business-date mutation
suite instead of failing on the fixture clock.

The same review also found a documentation mismatch in row 915 of
`docs/reference/migration-history.md`. Its apply-order narrative now identifies row 917 as the
unrelated `20260905090000_next_invoice_number_year_chicago.sql` candidate and row 918 as
`20260905200200_refuse_stale_commission_payment_recipient.sql`.

The first pushed candidate exposed one metadata-format constraint in CI: a `LOCAL CANDIDATE` row
must contain exactly one backticked `.sql` basename so the parked-migration registry can identify
the row's own file unambiguously. Row 915 still names the row 917 and row 918 filenames in plain
text, but keeps only its own migration basename in code form. The correction guard therefore
returns a known state without losing the neighboring migration identities CodeRabbit requested.

Nothing in this change applies a migration or mutates live data. All commission candidates remain
parked and require a fresh explicit in-chat approval plus the governed apply proof before any live
Supabase change.
