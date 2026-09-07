## 2026-09-04 - Sol gate round 2: fix what the first fix broke

Second `gpt-5.6-sol` gate (high effort, frozen head `862cd144d`): **0 BLOCKER, 2 HIGH, 4 MEDIUM,
3 LOW, 2 INFO** — down from 4 HIGH on `c127bd535`. Both new HIGHs and one MEDIUM were consequences of
the previous commit's fixes, which is the expected place to look. All three are fixed here.

### HIGH — the session check suppressed RECONCILIATION, not just reporting

The new session token correctly stopped a stale response from closing the current editor or raising
a prompt over it. But the stale branch was a bare `return`, so a **committed** edit also skipped
`fetchBill()`. The replacement editing session then kept showing bill data fetched BEFORE that edit
landed, and submitting it re-sent the stale due date and notes over the committed ones.

The previous comment called everything after the check "reporting". `fetchBill()` is not reporting;
it is state reconciliation. The split is now drawn correctly: `resetKey()` and `fetchBill()` are
facts about the REQUEST and the RECORD and run unconditionally; only the success toast and closing
the editor are session-scoped.

The stale branch also no longer stays silent. It does **not** claim the edit on screen saved — an
EARLIER one did — so it says exactly that, leaves the operator's current figures untouched, and
refreshes the record underneath them. `fetchBill()` re-reads the current route and guards on
`activeBillIdRef`, so calling it from a stale session is safe.

### HIGH — the recovery instruction promised something it could not deliver

The receiving warning told the operator to "submit it again to clear it". Resubmitting runs the same
local cleanup that just failed: a transient IndexedDB rejection clears, a persistently broken store
does not, and once `isRetryExpired` trips, `handleReceive` refuses before it even attempts
reconciliation. The instruction could loop forever.

Reworded to separate what is certain from what is hopeful: the goods ARE recorded and will not be
undone; resubmitting is safe and MAY clear the record; if it keeps reappearing, reload; if it still
persists, this browser cannot clear it — report it and do not attempt other receipts on this device.
No behaviour change, but the operator is no longer following an instruction that cannot succeed.

### MEDIUM — closing the editor did not end the session

The token advanced on open and on route change but not on close, so a late refusal for an edit the
operator had explicitly **cancelled** still matched, and reopened the overage prompt over a closed
editor. Confirming it then failed the entry guard on the now-null `editModalBillId`, surfacing an
error instead of the action the prompt offered.

Both close paths — the Modal's `onClose` and the Cancel button — now route through one
`closeEditModal()` that advances the session and clears the prompt, so they cannot drift apart.

### Verification

`typecheck`, `lint`, `test`, `build` pass. **357 files, 5052 passed, 0 failed.**

Both vendor-bill fixes have **runtime** regression tests that render the page and drive the real
sequence, and both are mutation-proven: removing the session bump from `closeEditModal` fails the
cancel test while the other three route tests still pass. Note that clearing `editOverageMessage` in
the closer is NOT what fixes the cancel case — the late response sets it again — so the mutation
confirms the session bump specifically.

**Not behaviourally verified:** the receiving change is still untested. It is a message-only change
on a path that needs an IndexedDB rejection during post-commit cleanup, which is not staged in this
suite.
