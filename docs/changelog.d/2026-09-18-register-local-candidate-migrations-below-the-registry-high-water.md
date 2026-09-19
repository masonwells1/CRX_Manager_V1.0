## 2026-09-18 — register every pending migration the registry high-water moved past, and fix four review findings on the adjust_inventory delivery

CodeRabbit's review of PR #714 (commit `965089215`) found five problems. All five are fixed here in one commit.

- **Seven migrations were quietly outside the mutator inventory.** Refreshing the schema registry moved
  its high-water mark above seven migrations whose history rows said "not applied". They are the five
  other commission restamps (`20260914100100`, `100200`, `100400`, `100500`, `100600`), `20260908120000`,
  and this PR's own `20260911120000`. (`20260908120000` had actually applied live on 2026-09-08; the
  merge of current main corrects its row. It stays registered because the generated types still predate
  it.) The safety check meant to catch that only recognised rows worded
  "PENDING APPLY", but these rows say "LOCAL CANDIDATE ... not applied". The check now recognises
  both wordings, and all seven are registered in `MIGRATIONS_AWAITING_TYPE_REGENERATION`.
  The registration check also judged a migration by its first history row. `20260914100100` has a
  preserved historical duplicate row above its real one, so the check now accepts a migration when any
  of its rows states a recognised status.
  Mutation proof on throwaway copies: removing the `20260914100500` registration fails and names exactly
  that migration. Reverting to the old wording as well leaves the same gap green, which confirms the old
  check was blind to it.
- **A prover could hide its own error.** In the adjust_inventory container prover, a failure to delete a
  staged temp file now gets logged. It no longer throws, so it can't replace the error that actually
  stopped the run.
- **Two documents dated a finished check in the future.** The hold-receipt exposure look-back was due by
  2026-09-18 but ran on 2026-09-15, right after that apply. The changelog and `CURRENT_STATE.md` now say
  that.
- **The adjust_inventory smoke spec omitted two functions it exercises.** `save_idempotency` and
  `_refuse_unbound_adjust_inventory_receipt_20260911` are now listed in its `covers`, so selecting either
  by name reaches this chain.

**2026-09-19 update.** Merging main after PR #721 added `20260914100800_bind_transfer_invoice_intent.sql`,
another local candidate below the high-water. The widened check failed on it by name. It is now
registered too. Our migration-history row for `20260911120000` moved from 928 to 929, because #721's
row for `20260914100800` already uses 928.

After PR #722 merged, the contract test reads its boundary as the newest authored stamp among applied
migrations (`20260908130000`), not the apply-time ledger version. The `2026091*` entries now sort above
that boundary and are discovered on their own. They stay registered as a backstop, and the widened
reverse check still names any pending migration that falls below a future boundary.

Nothing was applied to the live database. `20260911120000` remains a local candidate awaiting Mason's
explicit approval.
