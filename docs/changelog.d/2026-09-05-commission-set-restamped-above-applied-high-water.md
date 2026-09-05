## 2026-09-05 - Parked commission set restamped above the applied ledger high-water

**Why.** PR #606's migration was applied live on 2026-09-05 and the ledger recorded it as version
`20260905185938` under the bare name `refuse_null_job_field_acres`. The ordering guard the governed
apply path runs (`checkMigrationOrdering`, via `.claude/hooks/migration-apply-lib.mjs`) synthesizes
`<version>_<name>` for timestamp-less ledger names, so that row's effective stamp is
`20260905185938` — newer than six of the then-seven parked commission candidates, which were stamped
`20260905020000`..`20260905185619` earlier that day. Each of those six would have been refused as an
out-of-order replay; the guard was working, the filenames were stale. Found by the migration drift
reviewer on the label-repair reorder and verified from the guard's source plus a live read-only
ledger query (999 rows, `max(version)` `20260905185938`).

**Fix: rename only.** All seven files moved with `git mv`, relative order preserved, the label
repair still last:

| was | now |
|---|---|
| `20260905020000_commission_history_report_replay_guard.sql` | `20260905200000_…` |
| `20260905020200_refuse_stale_commission_payment_recipient.sql` | `20260905200200_…` |
| `20260905020300_enforce_commission_payment_business_date.sql` | `20260905200300_…` |
| `20260905020400_commission_dates_follow_chicago_business_day.sql` | `20260905200400_…` |
| `20260905185619_latest_commission_recipient_label.sql` | `20260905200600_…` |
| `20260905190000_repair_commission_history_label_snapshots.sql` | `20260905210000_…` |

No SQL statement changed. The only edits inside migration files are comment lines that named a
sibling by its old stamp (`200200`, `200500`, `210000`); every md5-pinned function body is
byte-identical.

**References swept.** `.gitattributes` (the `eol=lf` pins follow the filenames);
`scripts/smoke/prove-commission-migration-plan-order.mjs`,
`prove-commission-history-label-repair.mjs`, `prove-commission-dates-chicago.mjs`,
`prove-document-dates-chicago.mjs`, `prove-commission-report-snapshot-contract.mjs`;
`src/lib/commissionPaymentBusinessDateGuard.test.ts`, `src/lib/rpcIdempotencyScope.test.ts`;
`docs/reference/migration-history.md` (rows 914, 915 and 917-921, the live-ledger capture at the
top, and row 916, which now records #606 as applied under the bare name with its filename mismatch
left to the #606 lane); `docs/reference/rpc-functions.md`; `docs/manual/CURRENT_STATE.md`;
`docs/manual/KNOWN_ISSUES.md`. `.claude/schema-registry.json` and the `supabase/baselines/`
manifest carried no reference to any of the seven names. Earlier changelog entries keep the stamps
they were written against.

**Proof.** `scripts/smoke/prove-commission-migration-plan-order.mjs` gained a `LEDGER` phase:
it runs the real `checkMigrationOrdering` against the pinned live row (plus the local applied
snapshot when present) and requires the seven renumbered names to clear it without the
intentional-replay escape hatch, after first showing that six of the seven pre-renumber names are
refused by the same guard against the same ledger (negative control). The container phases were
re-run at the new filenames with settled data present: the old order still halts with the payout
guard never installed, the real order installs every file through `20260905200600` with the guard's
recorder and trigger in place and only the repair refused last, the widened pin is still
load-bearing, and the repair still applies after the guard. The emitted order from the shipped
`scripts/list-post-baseline-migrations.mjs` ends `…200000, 200200, 200300, 200400, 200500,
200600, 210000`. The `LEDGER` phase proves the names against the ledger as read on 2026-09-05; it
is not apply-time authorization. The governed apply path re-reads the live ledger itself and
refuses a snapshot older than 24 hours.

**Found by review, fixed here.** `20260905200600` (formerly `20260905185619`) was the one parked
file with no `eol=lf` pin in `.gitattributes`, and it sat on disk with Windows line endings. That
file md5-pins its own installed body, so `prove-commission-report-snapshot-contract.mjs`, which
streams the file's bytes without normalizing them, installed a CRLF body and the migration refused
its own postflight (`COMMISSION_RECIPIENT_LABEL_POSTFLIGHT_DRIFT`). The ordering proof could not
see this because it normalizes line endings before applying. The pin is added and the file
re-checked-out as LF; the snapshot-contract prover passes again.

**Follow-up correction (before any apply):** the former `20260905200500` file was deliberately
folded into `20260905200400` after a concurrency review found that two migration transactions
could admit an old document writer between them. The pending set now contains **six** files;
`20260905200500` is superseded, never applied, and must not be recreated as a separate step.
The unified file drains document and commission writers before all six replacements, with a
disposable PostgreSQL 17 two-session proof and a lock-removal mutation as its acceptance gate.

No migration was applied and no live data changed. Applying the set still requires Mason's
explicit in-chat approval and the governed apply path.
