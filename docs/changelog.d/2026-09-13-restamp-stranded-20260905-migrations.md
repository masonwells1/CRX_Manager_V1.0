## 2026-09-14 - Seven stranded 20260905* migrations restamped above the applied ledger high-water

**Why.** `20260908120000_close_pr535_live_gaps` applied live on 2026-09-08 (ledger version
`20260909023300`). Seven migration files merged on `main` were never applied. They are the
next-invoice-number candidate and the six parked commission candidates, and all were stamped
`20260905*`. They now sorted BELOW that applied row, so the ordering guard the governed apply path
runs (`checkMigrationOrdering`) would refuse every one of them as an out-of-order replay. That
same stale boundary blocked PR #646's Codex push proof. Before the rename, read-only live ledger
reads by name on 2026-09-13 and 2026-09-14 (1001 rows, `max(version)` `20260909023300`) confirmed
that none of the seven names was applied.

**Why these stamps.** A first draft (PR #688/#695) stamped them `20260908120100`..`20260908130900`.
That sorted them BELOW the pending, owner-approved inventory fix `20260908130000` (merged as #691)
and its successor `20260911120000` (#664), so the apply path's pending-set guard would have
demanded these unapproved commission files go live first. It also sorted them below the
field-app candidates (`20260908190000`, `20260912165758`, `20260913040359`). Neither inventory
file depends on any of the seven, so the set now sorts above all of them.

**Fix: rename only, relative order preserved, label repair still last.**

| was | now |
|---|---|
| `20260905090000_next_invoice_number_year_chicago.sql` | `20260914100100_…` |
| `20260905200000_commission_history_report_replay_guard.sql` | `20260914100200_…` |
| `20260905200200_refuse_stale_commission_payment_recipient.sql` | `20260914100300_…` |
| `20260905200300_enforce_commission_payment_business_date.sql` | `20260914100400_…` |
| `20260905200400_commission_dates_follow_chicago_business_day.sql` | `20260914100500_…` |
| `20260905200600_latest_commission_recipient_label.sql` | `20260914100600_…` |
| `20260905210000_repair_commission_history_label_snapshots.sql` | `20260914100900_…` |

No SQL statement changed. The only in-migration edit is the cross-reference comment inside
`20260914100300` that names the label repair's current stamp. The `crx.chicago_date_cutover`
marker value `'20260905200400'` inside `20260914100500` is deliberately unchanged: it is embedded
in md5-pinned function bodies and matched by other files, and it is a marker, not a filename.
Other in-file comments keep the sibling stamps they were written against; the table above maps
them.

**References updated.** `.gitattributes` `eol=lf` pins; `src/lib/commissionPaymentBusinessDateGuard.test.ts`;
`src/lib/rpcIdempotencyScope.test.ts` (comment); `scripts/smoke/prove-commission-migration-plan-order.mjs`
(filenames, plus the LEDGER phase: the pinned live row is now `20260908120000_close_pr535_live_gaps`,
and the negative control is the six previous names, all of which must be refused);
`prove-commission-history-label-repair.mjs`, `prove-commission-dates-chicago.mjs`,
`prove-document-dates-chicago.mjs`, `prove-commission-report-snapshot-contract.mjs`,
`prove-next-invoice-number-year-chicago.mjs`; `docs/reference/migration-history.md` (rows 914,
915, 917-920, 922 and 925 plus the boundary narrative); `docs/reference/rpc-functions.md`;
`docs/manual/CURRENT_STATE.md`; `docs/manual/KNOWN_ISSUES.md`. The applied
`20260906120000_preview_field_app_season_follows_invoice_date.sql` still names `20260905090000` in
a comment and was deliberately not edited, because applied migrations are never modified.

Row 923 and the "current boundary" capture at the top of `migration-history.md` still describe
`20260908120000_close_pr535_live_gaps` as not applied. Both belong to PR #646, which records that
file's live apply, so this change leaves them for #646 to update. The read-only ledger reads cited
above are the evidence that it is applied.

**Lock-upgrade fix (Mason approved 2026-09-14).** CodeRabbit (PR #695) and the Codex push proof
found that `20260914100400` and `20260914100500` took SHARE ROW EXCLUSIVE and later ran
`DROP TRIGGER`/`ALTER TABLE`, which need ACCESS EXCLUSIVE. Upgrading a lock mid-file can deadlock
against a concurrent read-then-write transaction. Both files now take ACCESS EXCLUSIVE up front
on every table they alter (`commission_payments`; `orders`, `invoices`, `commissions`), keeping
the fixed lock order, so they only ever wait, bounded by `lock_timeout = '10s'`. `jobs` keeps
SHARE ROW EXCLUSIVE because the file runs no DDL on it. The trade-off: readers of those tables
wait for the short apply. No function body, md5 pin, or other statement changed. The unit test
and `prove-commission-dates-chicago.mjs` now assert the new lock modes.

No migration was applied and no live data changed. Applying any of the seven still requires Mason's
explicit in-chat approval and the governed apply path. `.claude/schema-registry.json` is refreshed
from live in a separate follow-up PR.
