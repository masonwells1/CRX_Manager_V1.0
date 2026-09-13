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

**Review.** compliance-reviewer round 1: 0 BLOCKER / 2 HIGH / 5 MED / 4 LOW.
Fixed: both HIGH (mid-dialog `onSuccess` emptied the results; tests used a no-op
`onSuccess` that hid it), row results now bound to their batch key, banner no
longer promises safety for products adjusted another way, exact request counts in
tests, non-finite quantity, "Refused — will retry" label inside a frozen batch.
Round 2: 0 BLOCKER / 0 HIGH / 1 MED / 6 LOW. Fixed: the last submitted batch's
rows stay listed until the dialog closes, so a refused or "Check stock history"
row is not hidden when a frozen batch is retried after a reload with a different
selection (MED); closing after a not-confirmed row also refreshes the page; a
failed "batch finished" write shows a warning instead of plain success;
`buildAdjustmentCalls` now requires a key function; tests cover Escape close,
refresh-on-close after retry and refusal, and a refused row re-sent under its
same key inside a frozen batch. Deferred: the frozen "Retry N Unchanged" count can
differ from rows sent when a batch is adopted from another tab (cosmetic; the
send is correct); no test injects a `resolveIntent` storage failure. Deferred
from round 1 with reason: a binding-rejected row unfreezes the batch (per the
`getIdempotencyBindingRejection` contract the key can never succeed, and keeping
it frozen would trap the dialog until the 23h window expires); an expired frozen
record has no discard control (hook-wide behaviour shared by every surface); a
replay after reload can log the batch to the activity feed twice (stock
unaffected); two tabs submitting an identical new batch at once share one key
(hook design).

**Codex (gpt-5.6-sol, high) exact-SHA review of `f14672bc1`: BLOCKERS, 1 HIGH.**
Peer-tab completion could double-move stock: tab A's reply is lost and the batch
freezes; tab B retries the shared batch key, gets the receipt, and resolves it;
tab A's storage listener drops its frozen lock while its form still holds the
delta and reason, so its enabled Adjust button would send the same adjustment
under a fresh key. Fixed: when a batch this dialog left unconfirmed is no longer
frozen, the dialog treats every non-adjusted result as stale ("Finished
elsewhere — check stock"), shows a "Finished in another tab" banner, disables the
form and submit (and `handleSubmit` refuses), and refreshes the page on close.
Regression test renders two live page stand-ins on the same browser storage and
delivers the `storage` event to tab A; it fails against the `f14672bc1` modal.
Real-browser proof in two real tabs of the temporary harness (fake database in
shared localStorage): tab A's +5 committed with its reply lost and froze; tab B
opened the same frozen batch and "Retry 1 Unchanged" replayed the receipt under
the same key; tab A then showed "Finished in another tab" and "Finished elsewhere
— check stock", its "Adjust 1 Product" button reported `disabled` and a real click
sent nothing (still 2 requests, 1 stock move, stock 105); Cancel closed it and
refreshed tab A's page once.

**Codex (gpt-5.6-sol, high) exact-SHA review of `e07bf3cda`: BLOCKERS, 1 HIGH, 1
MEDIUM.**
- HIGH — a passive peer tab could still double-move stock: the guard only covered
  the tab whose own submit left the batch unconfirmed. A tab that merely observed
  the shared frozen batch (with its own form holding the same delta and reason)
  re-enabled when another tab resolved it. Fixed: an open dialog that has shown a
  frozen batch — frozen by itself or only observed — is blocked when that batch
  unfreezes without this dialog resolving it, and closing it refreshes the page
  even if it submitted nothing. Regression test adds a passive third tab; it fails
  against the `e07bf3cda` modal. Real-browser proof in two real tabs of the
  temporary harness (live key-only fake contract, shared localStorage): passive
  tab C typed +5 and a reason but never submitted; tab A's +5 committed with its
  reply lost; tab C showed the frozen batch through the real `storage` event; tab
  A's "Retry 1 Unchanged" replayed the receipt under the same key; tab C then
  showed "Finished in another tab", its "Adjust 1 Product" button reported
  `disabled`, and a real click sent nothing (still 2 requests, 1 stock move, stock
  105); Cancel closed it and refreshed tab C's page once.
- MEDIUM — the tests described an intent-bound server contract from the unapplied
  migration `20260911120000`. The fake `adjust_inventory` now models the live
  key-only contract (a reused key silently replays the stored receipt whatever
  the payload); the fresh-key test proves distinct keys through the stock-move
  counter under that contract, and the binding-rejection test is marked as
  injecting the codes the pending migration would add. The fix itself never
  pairs one key with two payloads, so it does not depend on that migration.

**Codex (gpt-5.6-sol, high) exact-SHA review of `493a279f7`: BLOCKERS, 1 HIGH, 1
MEDIUM.** This was the third review round, so per `ship.md` it went to Mason, who
approved a small change to the shared hook.
- HIGH — check-then-act race: the dialog checked "finished elsewhere" at render
  time, then called `beginIntent()`. If another tab resolved the frozen batch in
  between, `beginIntent()` found a resolved record and started a new request with
  a new key, so the retry could move stock twice. Fixed in
  `src/hooks/useUncertainMutationIntent.ts` with an additive, opt-in option:
  `beginIntent(intent, { requireIdempotencyKey })` proceeds only while that exact
  request is still pending under that key — checked before and again inside the
  IndexedDB transaction — and otherwise throws
  `UNCERTAIN_MUTATION_INTENT_CONFLICT` without writing a new record. A new
  `getPendingIdempotencyKey()` reads the frozen key without claiming anything.
  Callers that do not pass the option are unchanged. The dialog passes the key
  whenever it retries a frozen batch, shows "Finished in another tab" on that
  conflict, and also refuses a click whose render still showed a frozen batch
  that is already gone.
- MEDIUM — a batch whose only results were binding rejections closed without
  refreshing the page. Binding rejections now count as "stock may have changed".
- Proof: new modal tests (a retry clicked after another tab resolved the batch
  but before this tab heard about it sends nothing; a binding-rejected-only batch
  refreshes on close) both fail against the `493a279f7` modal and hook. Four new
  hook tests (retry under a still-pending key; fail closed after a peer resolved
  it; fail closed when only the localStorage mirror is stale and IndexedDB says
  resolved; fail closed when a newer request replaced it) fail against the
  `493a279f7` hook, and disabling only the in-transaction check makes the
  stale-mirror test fail. Full suite, typecheck and lint pass. Real browser
  (temporary harness, live key-only fake contract): tab A's +5 committed with its
  reply lost and froze; the stored batch was then marked resolved in IndexedDB and
  localStorage from inside tab A, exactly as a peer's resolve writes it (a tab
  never receives storage events for its own writes, so tab A still showed
  "Unconfirmed batch" and an enabled "Retry 1 Unchanged"); a real click on Retry
  sent nothing (still 1 request, 1 stock move, stock 105) and showed "Finished in
  another tab"; the Adjust button then reported `disabled`, a real click on it
  sent nothing, and Cancel refreshed the page once. The binding-rejected-only
  refresh is covered by the component test only.

**Codex (gpt-5.6-sol, high) exact-SHA review of `d1f348069`: BLOCKERS, 1 HIGH —
open, with Mason.** A tab that is suspended while another tab's batch freezes and
is then resolved handles both storage events only after storage already says
"resolved" (the hook re-reads the current value, not the event's `newValue`), so
it never shows the frozen batch and its own stale form can send a fresh
adjustment. Counter-position recorded for Mason: that is a separate click in
another tab, and the same double adjustment happens with no lost reply at all
(tab A succeeds, tab C then submits the same typed adjustment), which no
idempotency key can distinguish. Compliance-reviewer on the same SHA: 0 BLOCKER /
0 HIGH / 2 MED (no test for the in-transaction key mismatch against a newer
pending request; "Finished in another tab" is also shown for conflicts that are
not a finished batch) / 5 LOW — not yet fixed.

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
Supabase: that would change live stock. The real-browser run exercised the
round-1 code; the round-2 changes (last batch rows kept listed, refresh after a
not-confirmed close, resolve-failure warning, required key function) are covered
by the component tests that render the real modal, not by a second browser run. After a full page reload a frozen batch
is only visible once an admin selects any row and opens Batch Adjust (surfacing
it without a selection needs an `InventoryPage.tsx` change that would collide
with open PR #624).
