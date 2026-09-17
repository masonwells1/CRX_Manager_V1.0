## 2026-09-10 — PR #624: CodeRabbit round 2 on `5d249778b` (2 fixed)

CodeRabbit's review of `5d249778b` requested changes with two Major findings. Both are fixed.

- **A stale retry after a peer tab finished the request (Major).** Tab A sends an inventory
  adjustment and loses the reply, so its attempt stays uncertain. Tab B retries the same
  adjustment under the same key; it commits and tab B marks it complete. If tab A's operator then
  pressed retry, before or without tab A hearing about tab B's completion, `beginIntent` found a
  completed coordinator record and minted a fresh key. `adjust_inventory` replays only by key, so
  the adjustment would have been applied twice. `coordinateDurableRecord` now receives the tab's
  own outstanding attempt. When the completed record is that same attempt, and the request is
  identical and still inside its retry window, the retry keeps the original key and retry
  deadline, so the server replays the saved receipt. A different request, or a tab with no
  outstanding attempt on that record, still starts fresh. CodeRabbit suggested refusing the retry
  instead; reusing the key is equally duplicate-safe and shows the operator the confirmed result
  rather than a dead-end error.
- **Stale "apply blocker" wording (Major, docs).** `2026-09-07-create-inventory-hold-cutover-race-open.md`
  still called the cutover race an open apply blocker in three places, although the note at its top
  records it as cleared. Those passages now say it was a blocker when written and has since been
  cleared.

Proof:

- Four new tests in `useUncertainMutationIntent.test.ts`: the stale retry with no storage event,
  the same retry after the storage event arrives, a different request after a peer completion, and
  an identical follow-up after the tab completed its own request.
- Before the fix, the first test failed because tab A received a new key.
- Mutation checks: dropping the own-attempt condition fails the follow-up test (a second identical
  adjustment would reuse the first key and be skipped by the server). Forcing every completed
  record to reopen under its old key fails two tests.
- 99/99 tests pass across the eight suites that use the hook; `npm run typecheck`
  and ESLint are clean.

No live database change: migration `20260908130000` is still parked and unapplied.
