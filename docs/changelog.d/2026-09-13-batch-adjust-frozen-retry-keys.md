## 2026-09-13 — Batch Adjust keeps each row's retry key until its outcome is known

**Defect (live, found 2026-09-11 by the rls-security-reviewer while reviewing
migration `20260911120000_bind_adjust_inventory_receipt_to_intent`; not caused by
that migration).** `src/components/inventory/BatchAdjustModal.tsx` counted every
per-row error as "failed", including a reply lost after `adjust_inventory` had
already committed. One successful row then cleared every retained key, so
re-running the "failed" row minted a new key and moved the stock a second time.
Keys were also reused for any different selection of the same size, which after
the migration returns `IDEMPOTENCY_INTENT_MISMATCH`; the modal reported that as a
plain failure and never reset the key.

**Fix (frontend only, no database change).**
- The exact batch (rows, delta, reason, actor) is frozen with
  `useUncertainMutationIntent` (operation `adjust_inventory_batch`, surface
  `inventory-batch-adjust`), the same durable pattern PR #624 uses for the
  single-product dialog. A separate operation name keeps an unresolved batch from
  locking that dialog; the server keys never overlap.
- Each row's key is the frozen batch key plus the inventory row id, so a retry
  re-sends every row under its original key and any change to rows, delta or
  reason is a new batch with fresh keys.
- Each row is classified: adjusted; refused (`isDefinitiveRpcRejection` —
  nothing committed); not confirmed (transport or unusable reply — key kept);
  or binding-rejected (`getIdempotencyBindingRejection` — shown as "Check stock
  history", never re-sent under that batch).
- The batch unfreezes only when no row is left unconfirmed, and it unfreezes
  before the row results render. The dialog stays open on a mixed result and
  shows per-row status. A row is skipped only on a retry of the batch it settled
  under. A frozen batch restored after a reload is shown locked with a
  "Retry N Unchanged" button.
- The page's `onSuccess` (which clears the Inventory page selection) now runs
  when the dialog closes, not after a partial success, so per-row results are not
  wiped while the operator still needs them.
- Non-finite quantities (e.g. `1e400`) are treated as zero instead of being
  frozen as `null`.

**Review.** compliance-reviewer: 0 BLOCKER / 2 HIGH / 5 MED / 4 LOW. Fixed: both
HIGH (mid-dialog `onSuccess` emptied the results; tests used a no-op `onSuccess`
that hid it), row results now bound to their batch key, banner no longer promises
safety for products adjusted another way, exact request counts in tests,
non-finite quantity, "Refused — will retry" label inside a frozen batch. Deferred
with reason: a binding-rejected row unfreezes the batch (per the
`getIdempotencyBindingRejection` contract the key can never succeed, and keeping
it frozen would trap the dialog until the 23h window expires); an expired frozen
record has no discard control (hook-wide behaviour shared by every surface); a
replay after reload can log the batch to the activity feed twice (stock
unaffected); two tabs submitting an identical new batch at once share one key
(hook design).

**Proof.**
- `src/components/inventory/BatchAdjustModal.retry.test.tsx` renders the real
  modal and hook (fake-indexeddb) inside a stand-in page whose `onSuccess` clears
  the selection like `InventoryPage`, against a fake `adjust_inventory` that moves
  stock once per new key, replays receipts, refuses a key reused for a different
  payload, and can commit-then-lose a reply. Asserted on the fake's stock-move
  counter and exact request list: lost reply then retry moves stock once; mixed
  result keeps the unconfirmed row's key and keeps results on screen; a reload
  restores the frozen batch and replays every row under its original key;
  changed delta or reason uses a fresh key; binding and definitive refusals are
  surfaced distinctly.
- Real browser (temporary uncommitted harness page rendering the real modal with
  the Supabase client's `rpc` replaced by an in-page fake that persisted across
  reloads): a -3 batch with Bicep's reply lost showed "Adjusted" / "Not confirmed
  — retry" and the locked banner; after a full page reload the frozen batch was
  restored from browser storage; "Retry 2 Unchanged" replayed both receipts under
  the original keys (`…:inv-a`, `…:inv-b` → "replayed receipt"), leaving exactly
  one move per adjustment (stock 100 → 105 → 102). The harness was deleted.

**Not verified.** No real adjustment was submitted in the running app against
Supabase: that would change live stock. After a full page reload a frozen batch
is only visible once an admin selects any row and opens Batch Adjust (surfacing
it without a selection needs an `InventoryPage.tsx` change that would collide
with open PR #624).
