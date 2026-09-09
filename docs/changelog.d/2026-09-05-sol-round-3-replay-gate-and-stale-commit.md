## 2026-09-05 — Sol round 3: the replay gate was on the wrong condition, and one fix wedged a page

Third exact-SHA `gpt-5.6-sol` gate, frozen head `2ff8bdafc`, whole files this time (round 2's finding
11 was that a truncated packet forced two CONDITIONAL verdicts). Returned **1 BLOCKER, 3 HIGH,
2 MEDIUM, 1 LOW, 2 INFO**.

**The BLOCKER is not in this PR and is not fixed here.** `fetchPO` can leave one PO's header on
screen above another PO's line items, and receiving from that screen records the goods against the
wrong purchase order. It is byte-identical on `origin/main` and live in production. Mason's call,
2026-09-05: **its own session**. Tracked in `docs/manual/KNOWN_ISSUES.md`.

### HIGH — `completedElsewhere` never fires for the ordinary replay, so the previous fix did nothing there

The receiving-slip gate added in `2ff8bdafc` was conditioned on `completedElsewhere`. Every
assignment of that flag lives in the RPC **error** branch — but an ordinary retry of an identical
request is not an error. `check_idempotency_intent` matches the fingerprint and `receive_po_items`
does `RETURN v_replay -> 'result'` (`20260831233000_bind_section9_replays_to_intent.sql`): a normal
success, no error, no replay marker. So the common replay took the unguarded path, still reprinted a
slip stamped `new Date()` with the CURRENT operator, and still reported "Items received and inventory
updated" as though this attempt performed the receipt.

Worse, the test written for that fix exercised `IDEMPOTENCY_INTENT_MISMATCH` — a *different-payload
rejection*, not a cached-success replay — so it stayed green while the real path was open. **The test
proved the wrong thing.**

Now gated on `wasLockedReplay` (this submission is a retry of a frozen request) as well as
`completedElsewhere`, covering the PDF, the over-receive alert, and the success message. The replay
message no longer credits this attempt with the work: "Receiving reconciled — these goods are
recorded once, and the PO is up to date," which is true whether the receipt committed now or earlier.

### HIGH — the preparation catch told a retrying operator that nothing was received

"Receiving could not be safely prepared. Nothing was received" is only true on a FIRST attempt. The
storage failure that breaks post-commit cleanup is exactly what breaks preparation on the retry, so
the retry-after-a-committed-receipt is the most likely way to reach that catch. It contradicted the
warning the operator had just read and pushed them to receive from another browser or device — where
no local pending intent exists, a fresh key is minted, and the server cannot recognise the duplicate.
That is the one outcome the whole intent mechanism exists to prevent. A retry now gets a message that
says nothing further was sent, that an earlier attempt may already have recorded the goods, and to
check receiving history rather than re-receive elsewhere.

### HIGH — "the bill has been refreshed" pointed the operator at stale figures

`fetchBill()` updates `bill`; it does **not** rewrite `editSubtotal`/`editAdjustment`/dates/notes in
an editor that is already open — those were copied when the editor opened, BEFORE the earlier edit
committed. Telling the operator the bill was refreshed and to "check the figures on screen" aimed
them at the stale values as though they were the new ones; saving reverts what just landed. The
message now names the fields as stale and gives the one action that actually loads current values:
close and reopen the editor.

### MEDIUM — the same fix wedged the bill the operator was actually looking at

`fetchBill()` was called on every stale-commit path. After navigating away, that is the closure from
the render that started the edit, so it queries the bill they LEFT: it sets the shared `loading` flag
and then returns at its own `activeBillIdRef` guard **without clearing it**, leaving the bill on
screen on a permanent spinner. That call site, added in `2ff8bdafc`, was the only way to reach the
leak. The navigated-away path now does neither the fetch nor a toast about "this bill" — the commit
is recorded, the key retired, and the next visit re-reads it.

### Adjudicated, corrected rather than changed

- **MEDIUM — "nothing is lost" was an overstatement.** Receiving history reprints from the stored
  record, but one row at a time (`items: [record]`), so a multi-line receipt cannot be reproduced as
  one grouped slip, and names come from current data rather than an at-receipt snapshot. The trade is
  still right — a correct one-line reprint beats a slip asserting a time and receiver that never
  happened — but the comment now states it as a trade.
- **LOW — vendor-bill edit idempotency does not survive a reload.** Real and pre-existing: the key
  lives only in `keysRef`, so a reload after an uncertain committed response mints a new key and the
  edit can run twice. Unlike receiving and payments, bill editing has no durable intent record.
  Out of scope here; belongs with the durable-intent work.
- **INFO — no runtime test of the abandoned-render defect.** Correct. The `useLayoutEffect` move is
  right, but nothing in this suite suspends and discards a render, so that specific change is
  reasoned and reviewed, **not** behaviourally proven. Stated plainly rather than left implied.

### Verification

`typecheck`, `lint`, `test`, `build` pass. **358 files, 5060 passed, 0 failed** (up from 5057).

The receiving test's durable-intent mock was hard-coding `unresolvedIntent: null` and
`isIntentLocked: false`, which mocked away the very state it claimed to exercise — after a real failed
cleanup the hook stays locked and the button reads "Retry Exact Receiving". It is now stateful, and
the new replay tests drive the page through the real locked-retry flow.

Three new runtime tests, each mutation-proven and each failing **alone**: ungating the PDF on a
locked replay fails only the replay test; removing the retry-aware preparation message fails only the
"nothing was received" test; restoring the unconditional `fetchBill()` fails only the wedge test.
