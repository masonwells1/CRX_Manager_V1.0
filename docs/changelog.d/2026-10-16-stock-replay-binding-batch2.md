## 2026-10-16 — stock retries can no longer report success for the wrong record (replay-binding batch 2)

Batch 2 of the replay-binding fix (`docs/manual/KNOWN_ISSUES.md`, "about 75 live functions replay a
saved result matched on the retry key alone"): the HIGH stock group, the inventory table's row
labelled 3, shipped second.

- **Fixes thirteen stock actions** (migration `20261016140000`, not applied when written):
  `release_inventory_hold`, `retire_inventory_item`, `reconcile_negative_inventory`,
  `manual_inventory_add`, `create_order_from_blend_ticket`, `create_direct_order`,
  `create_rush_order`, `close_quote_as_applied`, `close_quote_as_short`,
  `create_application_record_from_blend_ticket`, `batch_cancel_deliveries`,
  `reverse_completed_cycle_count`, `create_planned_holds`. As in batch 1, each live body is
  renamed unchanged and a same-name wrapper replays a saved answer only for the same person and
  the exact same request; a different record, quantity, item list or person is refused and nothing
  changes. An exact retry still returns the original answer. The thirteen now require a retry key
  (every screen already sends one), with no keyless path in any public entry point:
  `revert_quote_status`, which used to call `create_planned_holds` without one, now rebuilds a
  reopened planned quote's holds through the private `_create_planned_holds_replay_impl_20261015`
  and itself requires a key (see `2026-10-16-stock-replay-binding-batch2-planned-holds-key.md`).
  Batch 1's commit-time guard now covers these
  operations too (the same trigger, recreated with the longer list; no second trigger). The file
  refuses to apply while a recent receipt for them exists, and the private cycle-count reversal
  helper is no longer callable by the server role. It narrows access, so it applies only on
  Mason's owner approval.
- **App:** the screens that call these functions drop a retry key refused as another request's or
  another person's, and keep it when the database cannot confirm an earlier outcome.
- **Proof:** `node scripts/smoke/prove-stock-replay-binding-batch2-real-schema.mjs`
  (`STOCK_REPLAY_BINDING_BATCH2_PROOF_PASS`) and the rollback-only chain
  `scripts/smoke/smoke-stock-replay-binding-batch2.sql` (spec `stock_replay_binding_batch2`,
  container only: two of the thirteen draw an order number a rollback cannot return). The
  postflight also proves the two private order worker bodies stay unreachable by any API role,
  and `smoke-cycle-count-concurrency-guards.sql` now finds its row-lock check in the renamed
  cycle-count body.
- **Rollback:** the migration header lists the order to undo it, narrowing the commit-time guard
  back to batch 1's nine first.
