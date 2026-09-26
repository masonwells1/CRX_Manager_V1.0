# Cleanup Sprint Progress

> **STOPPED UPDATING after 2026-07-24 (noted 2026-09-26).** The weekly task that wrote these rows no
> longer exists, so the table below is a frozen history, not current numbers. Negative-inventory status
> now lives in `docs/manual/KNOWN_ISSUES.md` §1 (19 rows, re-verified 2026-08-08, reconcile only from
> physical counts), `docs/manual/CURRENT_STATE.md` §2, and `TODO.md` §1 item 1 (re-base deferred by
> Mason 2026-07-16; decision re-confirmed in `docs/manual/DECISION_LOG.md` 2026-08-08).

Tracking resolution of bad data found in the 2026-05-01 production audit.
Baseline: negatives=17, over_received=15, unbilled=60.
Phase 23 (DB CHECK constraints on inventory buckets) unlocks when negatives=0 for two consecutive weeks.

| Date | Negatives | Over-received | Unbilled | Δ notes |
|------|-----------|---------------|----------|---------|
| 2026-05-01 | 17 | 15 | 60 | Baseline (audit day) |
| 2026-05-08 | 17 | 15 | 59 | -1 unbilled resolved |
| 2026-05-15 | 17 | 15 | 59 | No change this week — zero rows resolved |
| 2026-05-22 | 17 | 15 | 59 | No change this week — zero rows resolved |
| 2026-05-29 | 17 | 15 | 59 | No change this week — zero rows resolved |
| 2026-06-05 | 17 | 15 | 59 | No change this week — zero rows resolved |
| 2026-06-12 | — | — | — | Routine did not produce a data row (no entry recorded) |
| 2026-06-19 | 17 | 15 | 59 | No change — zero rows resolved (6 consecutive stalled weeks) |
| 2026-06-26 | 17 | 15 | 59 | No change — zero rows resolved (7 consecutive stalled weeks) |
| 2026-07-03 | 17 | 15 | 59 | No change — zero rows resolved (8 consecutive stalled weeks) |
| 2026-07-10 | 17 | 15 | 59 | No change — zero rows resolved (9 consecutive stalled weeks) |
| 2026-07-17 | 18 | 15 | 59 | +1 negative — likely U9 warn-not-block delivery (expected; check requires_review=true on inventory_transactions). Legacy 17 rows still need /integrity-cleanup. |
| 2026-07-24 | 19 | 15 | 59 | +1 negative again (second consecutive week of increase). New negative-bucket rows are being created despite Phase 21 going-forward fix — the warn-not-block path may still be firing. No cleanup progress on legacy rows. |
