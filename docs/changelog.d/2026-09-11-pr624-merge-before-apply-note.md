## 2026-09-11 — PR #624: correct the stale "merge only after the apply" note and record staff recovery

The OPEN 2026-09-05 manual-hold entry in `docs/manual/KNOWN_ISSUES.md` said the inventory-page
frontend fix "must merge only after the apply". That sentence was written on 2026-09-05, before the
frontend commit was pushed. It is stale, and it contradicted the PR, which merges the frontend
source-only with migration `20260908130000` still parked.

Re-checked on 2026-09-11 against the installed (pre-migration) server contract:

- `InventoryPage` sends `create_inventory_hold`, `adjust_inventory` and `retire_inventory_item`
  exactly the argument sets `main` sends, and the migration keeps the same signature.
- A key is re-sent only with its original frozen request, or after another tab confirmed that
  request committed. The installed body replays both by key, so neither can book a second row.
- A racing loser's `IDEMPOTENCY_CONCURRENT_REPLAY_RETRY` now keeps the key instead of releasing it.
- 112 tests across 13 suites that use the hook or `isDefinitiveRpcRejection` (inventory,
  receiving, purchase-order receiving replay, vendor-bill payment recovery) pass locally.

Also recorded in the same entry:

- An owner (the PR #624 lane, reassignable by the coordinator) and a 2026-09-18 exposure-assessment
  date for the two live server defects the parked migration closes.
- A compatibility note for the installed vs parked contract, with the two gaps stated plainly.
- A new OPEN 2026-09-11 entry for a gap that is not new: after the 23-hour retry window, a locked
  dialog cannot be cleared in the app. Receiving and vendor bills already behave this way on `main`;
  #624 extends it to Adjust and Hold. Owner unassigned; the fix is an admin clear control.

`docs/workflows/INVENTORY_RULES.md` gains a plain-English "Staff recovery" section covering the
locked Adjust, Hold and Receive dialog states.

Merged `main` at `791bc3d86` (PR #599). #599 took migration-history rows 924-926, so this
candidate's row moved from 924 to **927** (header now "latest entry 927"), and the
`CURRENT_STATE.md` pointer follows it. Older changelog entries keep the row number they recorded at the
time.

Docs only. No live database change: migration `20260908130000` is still parked and unapplied.
