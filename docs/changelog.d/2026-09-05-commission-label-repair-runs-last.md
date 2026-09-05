## 2026-09-05 - Commission label repair runs last so a settled-data refusal cannot block the payout guard

**Defect.** `20260905020100_repair_commission_history_label_snapshots.sql` correctly refuses to run
once any commission payment has been posted (`COMMISSION_HISTORY_LABEL_REPAIR_SETTLED`). The apply
plan is filename-ordered (`scripts/list-post-baseline-migrations.mjs`) and halts at the first failing
file, so at that position one posted payment before rollout would have stopped
`20260905020200_refuse_stale_commission_payment_recipient.sql` — the row lock plus latest-recipient
check that blocks a payout to a stale recipient — and the September 30 date fixes behind it from ever
installing. Both files were individually correct; the defect was purely the sequence. Live read-only
on 2026-09-05: 0 settlement events, 8 payments, 0 posted — it applied cleanly that day by luck.

**Fix: reorder, not skip.**

- Renamed the repair to `20260905190000_repair_commission_history_label_snapshots.sql` (`git mv`,
  above the live applied high-water name `20260904180000_invoice_season_follows_invoice_date`) so it
  is the last of the seven parked commission files. A refusal there stops nothing else.
- Widened its settlement-recorder pin from the single pre-`020200` body to the two-value
  `IN ('feb0f260…', '9054ce6c…')` shape `020200` already uses for the earned recorder, because the
  guard now runs first and replaces that recorder. No other statement changed.
- Added the scoped `-- sql-safety: exempt-registry` marker with the same evidence `020200` carries
  (both ledger sequences exist live, `pg_class.relkind = 'S'`; the registry predates them).
- Swept every reference to the old stamp: `.gitattributes` (the `eol=lf` pin follows the filename),
  `scripts/smoke/prove-commission-history-label-repair.mjs`, `docs/reference/migration-history.md`
  row 915, `docs/manual/CURRENT_STATE.md`, `docs/manual/KNOWN_ISSUES.md`, and the comment block in
  `20260905020200` that still described the old order in the present tense (comment only, no SQL
  changed there; the drift reviewer confirmed every executable reference already names the new stamp).

Skipping rather than aborting was rejected: it would record the repair as applied while the 34
mislabelled snapshots stayed wrong, and it would rewrite reviewed ledger logic instead of one pin.

**Proof.** New `scripts/smoke/prove-commission-migration-plan-order.mjs` (network-isolated
PostgreSQL 17, delegating to the commission-history base prover): with settled data present it walks
the real filename-ordered plan file by file exactly as the runner does, observes every file through
`20260905185619` installed, the recipient guard's recorder body at `9054ce6c…` with its trigger
attached, and only the repair refused with `COMMISSION_HISTORY_LABEL_REPAIR_SETTLED` as the final
file. A negative control replays the OLD order and shows the guard never installs. It then proves the
widened pin is load-bearing (narrowing it back makes the repair fail with `..._DRIFT` after the
guard) and that the repair still applies after the guard once settled data is gone.
`prove-commission-history-label-repair.mjs` was re-run unchanged in behaviour.

No migration was applied and no live data changed. Applying the set still requires Mason's explicit
in-chat approval and the governed apply path.
