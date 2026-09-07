## 2026-09-05 — Inventory page: a lost reply can no longer double-apply an adjustment or hold

**Problem.** `adjust_inventory`, `create_inventory_hold` and `retire_inventory_item` replay on
the idempotency KEY ALONE: `check_idempotency` matches key + operation and never compares the
actor or payload (adjust: `20260317200000`; holds: `20260507200000`, unchanged by the parked
`20260630173022`). No trigger or constraint behind them rejects a duplicate ledger row or hold
row; the only server-side stop is "stock cannot go below zero". `InventoryPage.tsx` reset its
idempotency key every time the Adjust dialog opened (row button and mobile card), every time
the Hold dialog opened, and every time the Delete confirmation opened. So when the server
committed but the browser never saw the reply, the operator's natural retry — close the
dialog, reopen it, re-enter +50, Apply — minted a fresh key and PostgreSQL applied the
adjustment a second time (two identical `adjusted` ledger rows), or inserted a second hold.

This is the inventory-page half of what PR #535 carries. That PR's version scopes the retained
key to a payload fingerprint, and two Codex P1 findings on it are still open: the dialog stays
editable after a lost reply, so changing the number and re-applying mints a new key and the
double-apply survives. This change takes the form those findings ask for instead.

**Fix.** Adjust and Hold now run through `useUncertainMutationIntent` (the same durable-intent
mechanism `receive_po_items` already uses on this page). A reply that is not a positively
identified server refusal locks the dialog to the exact request: inputs and Cancel are
disabled, Escape and the backdrop do nothing, the button reads "Retry Exact Adjustment" /
"Retry Exact Hold", and the retry re-sends the frozen payload under the original key even if
the form state moved. Opening Adjust on a different row while one is unresolved keeps the
frozen row. A positively rejected request (SQLSTATE refusal such as negative stock or
`INSUFFICIENT_HOLD_INVENTORY`) releases the lock, so the admin force-hold flow still works and
a corrected re-entry is a genuinely new request. The lock persists across a reload through the
hook's IndexedDB record and is recovered into the dialog on mount. Retire has no editable
payload, so it keeps `useIdempotencyKey` with one key per row, retired only on confirmed
success; a different row mints its own key and can never replay another row's receipt.

**Proof observed.**
- `src/pages/InventoryPage.uncertainRetry.test.tsx` (new, 5 tests) renders the REAL page with
  the REAL `useUncertainMutationIntent` and `useIdempotencyKey` hooks over `fake-indexeddb`,
  with only the Supabase client, auth, toasts, Sentry and the activity logger mocked. It
  asserts on what the server receives: same key + same payload on the retry after a lost
  reply (adjust and hold), dialog locked and undismissable meanwhile, a locked adjustment
  cannot be re-aimed at another row, a definitive refusal releases the lock and the next
  attempt carries a new key, and retire uses one key per row.
- `src/pages/InventoryPage.productIdentity.test.tsx` gains a fake IndexedDB per test because
  the hold path now freezes its request before the RPC fires.
- `src/components/products/stageB2ProductPresentationAdoption.test.ts` pinned the hold RPC's
  product id as `p_product_id: holdProductId`; it now pins the id entering the frozen intent
  and the RPC reading it back from that request. Same guarantee, new plumbing.
- Mutation-proven: with `src/pages/InventoryPage.tsx` swapped for the `main` version the new
  file fails on the same-key assertions; restored, it passes.
- `npm run typecheck`, `eslint --max-warnings=0` on the touched files, and the existing
  `idempotency-reset-order`, `gauntletSection3InventoryGuards`, `section9ApIntentBinding` and
  `useUncertainMutationIntent` suites pass.

**Not verified at the time this entry was first written.** The live function bodies were not queried
(Mason asked for no live access without approval); that analysis came from the newest migration files
on disk. Mason later authorized a read-only production check on 2026-09-06, recorded in
`docs/manual/CURRENT_STATE.md` and in the companion changelog entry
`2026-09-05-create-inventory-hold-receipt-binding.md`.

**Server-side binding — partially addressed in this same PR.** The residual risk named by CodeRabbit
on #535 was that the server binds nothing to the key, so a forward migration adding actor + payload
binding is the durable fix. That migration now ships in this PR:
`supabase/migrations/20260905230000_bind_create_inventory_hold_receipt_to_intent.sql` (see its own
changelog entry). It is **written and container-proven but NOT applied live and NOT merged**, and it
covers **only `create_inventory_hold`** — `adjust_inventory` and `retire_inventory_item` still have
no actor/payload binding on the server and keep relying on the frontend freeze described above.
