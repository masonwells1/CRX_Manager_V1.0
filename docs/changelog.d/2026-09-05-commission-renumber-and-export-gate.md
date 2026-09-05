## 2026-09-05 - Commission history: renumber the two unapplied migrations, gate the CSV exports

Round-3 landing fixes for PR #592, from the exact-SHA `gpt-5.6-sol` review of `21360c0c`.

## Renumbered the two unapplied migrations so they can actually run

Both candidates sorted **below** the live applied high-water `name`
(`20260904180000_invoice_season_follows_invoice_date`, read read-only from production on
2026-09-05). Migrations apply in ledger-`name` order, so at their original stamps the runner would
have **silently skipped** both rather than refusing them — the same trap that forced the renumber
recorded for row 911.

- `20260903231000_commission_history_report_replay_guard.sql` -> `20260905020000_…`
- `20260904110000_repair_commission_history_label_snapshots.sql` -> `20260905020100_…`

Relative order is preserved (replay guard still applies before the label repair, which is the order
`prove-commission-history-label-repair.mjs` executes them in). **SQL content is byte-for-byte
unchanged**, so every pin, hash and proof recorded against these files still holds. References were
updated in `.gitattributes`, both smoke provers, `docs/manual/CURRENT_STATE.md`,
`docs/manual/KNOWN_ISSUES.md`, `docs/reference/migration-history.md` (rows 914/915, which now carry
the renumber rationale) and the replay-guard status changelog entry.

Neither migration is applied. Both still require Mason's explicit in-chat approval before any live
apply.

The final CI freshness gate required the two manual status headers to be re-read after those
September 5 filenames were introduced. A fresh read-only production ledger check observed 998 rows,
991 distinct names, `max(version) = 20260904152221`, and the same effective authored-name high-water
`20260904180000_invoice_season_follows_invoice_date`. `CURRENT_STATE.md` and `KNOWN_ISSUES.md` now
record that evidence and identify open PR #599 as the owner of the still-unmerged high-water file.

## Commission CSV exports no longer emit stale figures as current

`Export CSV` and `Export Payment Detail` on the Commission Balance tab stayed enabled while a
refresh was in flight and after a refresh had failed. Because a failed refresh deliberately keeps
the previous rows on screen behind a warning banner, clicking Export then downloaded the *previous*
cutoff's money under a filename stamped with the current local date, followed by a success toast.
The CSV carried neither the banner nor the cutoff it belonged to.

Both exports are now gated on `commissionExportReady` — the load must be finished, error-free, and
for the cutoff currently selected. The handlers also refuse and toast an error if reached by any
other path, so the guard is not presentation-only. Both filenames now carry the as-of date that was
actually loaded (`commission_balance_as_of_<date>`, `commission_payment_detail_as_of_<date>`).

Covered by three new cases in `src/pages/Reports.commissionHistory.test.tsx`. Mutation-verified:
reverting the gate to the pre-fix condition turns two of them red.

## Not addressed here

The remaining findings from that review are tracked, not fixed — notably that the live recorder
still stamps UUID and `[Unknown customer]` labels until the renumbered repair is applied, and that
recipient reassignment after an unposted payment batch can credit the wrong salesperson (that one is
in an already-applied migration and is live today, independent of this PR).
