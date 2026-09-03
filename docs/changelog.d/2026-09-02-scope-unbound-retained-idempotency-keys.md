## 2026-09-02 - Scope the retained idempotency keys whose RPCs replay on the key alone

The gauntlet-s9 branch removed six per-open `resetKey()` calls across Inventory and
Purchase Order Detail and retained the keys instead, on the assumption that a changed
intent would come back as `IDEMPOTENCY_INTENT_MISMATCH`. The exact-SHA `gpt-5.6-sol`
high-effort review of `ef82064a` returned BLOCKERS on that assumption, and the live
catalog confirms it: `create_inventory_hold`, `adjust_inventory`, `retire_inventory_item`,
`save_purchase_order` and `cancel_purchase_order` carry no `request_actor_id` /
`request_fingerprint` binding and no `check_idempotency_intent` call — `save_purchase_order`
checks only that a cached receipt belongs to the same PO id — and none of the six
`20260831` migrations add that binding. One of the removed calls was the 2026-05-16
PR #59 fix that existed precisely to stop two products sharing a hold intent.

Left unfixed, a lost response followed by the same dialog reopened on a different target
would replay the earlier receipt: the UI reports a hold, adjustment, retirement, PO edit
or PO cancellation that PostgreSQL never performed, corrupting the operator's picture of
physical inventory and purchasing.

Each of the five now derives its key from a payload fingerprint
(`fingerprintIntentPayload`, added to `src/lib/idempotency.ts`) via `getKeyFor`/`resetKeyFor`,
so a genuine lost-response retry of unchanged content still replays while any changed
target or value mints a fresh key. This keeps the retry behaviour the branch wanted
without reintroducing the shared-intent hazard the removed calls prevented.

`reverse_receiving_record` keeps its retained key deliberately: migration
`20260831160000` gives it real `check_idempotency_intent` actor+fingerprint binding, so
the server does reject a changed intent there. That is also why the database must be
rolled out before this frontend merges.

Guarded by `src/lib/gauntletFrontendSafetyGuards.test.ts`, which pins the scoped form and
fails if any of the five reverts to a bare `getKey()`.
