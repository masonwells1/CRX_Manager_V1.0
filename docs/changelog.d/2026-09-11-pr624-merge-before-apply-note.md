## 2026-09-11 — PR #624: correct the stale "merge only after the apply" note

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

Docs only. No live database change: migration `20260908130000` is still parked and unapplied.
