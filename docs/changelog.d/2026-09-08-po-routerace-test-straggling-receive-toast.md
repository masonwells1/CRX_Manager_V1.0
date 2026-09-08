## 2026-09-08 — Make the PO route-currency race suite deterministic (straggling receive toast)

### What was wrong

`src/pages/PurchaseOrderDetail.routeRace.test.tsx` was flaky in CI. On PR #605
(commit `df8f2442a`, which touches only `.claude/hooks` and docs, no `src/` files), run
34199500247 attempt 1 failed and attempt 2 passed, with:

```text
keeps PO B loadable when an action finishes while PO B is still in flight
AssertionError: expected undefined to be defined
  src/pages/PurchaseOrderDetail.routeRace.test.tsx:802  expect(await submitReceive('3')).toBeDefined()
```

The harness, not the page, was racing itself:

- A receive does not end when the RPC answers. The handler then resolves the durable
  intent in IndexedDB (fake-indexeddb, which schedules on `setImmediate`), dynamically
  imports the PDF module, refetches, and only then raises the `success` toast.
- On this machine that tail lands inside the same `act()` that released the RPC. On a
  loaded runner it lands **after the test has returned**. The toast mock is shared by
  every test in the file, so the straggling toast is recorded in the **next** test.
- `submitReceive` sampled "did the RPC fire **or has any toast been raised**" to decide
  the receive had reached an outcome. A toast that was already on the books before its
  click therefore stopped the sampling loop on the first pass, before the RPC had fired,
  and the helper returned `undefined`. The three tests that end with a completed receive
  run back to back, which is why the last one is the one that fails.

Reproduced locally by running the full suite as CPU load in the background and looping
the file: in 7 of 8 loaded runs the first test's success toast landed after that test's
body had returned. Unloaded, 0 of 3 runs straggled.

### What changed

Only the test file. No production code was touched, and the flake does not expose a bug
in `PurchaseOrderDetail.tsx`.

1. `submitReceive` counts only toasts raised **after its own click** as an outcome. A
   toast recorded before the click can no longer end the sampling loop.
2. A new `awaitReceiveSettled()` helper waits for the receive's own success toast. Every
   test that lets a receive complete (four of them) now calls it before ending, so the
   receive's whole tail — IndexedDB resolve, PDF import, refused refetches, toast — has
   run inside the test that started it. In the mid-flight test this also means PO A's
   tail has fully played out before PO B's header is allowed to answer, which is the
   collision the test exists to stage.
3. An `afterEach` **hard guard**: if `receive_po_items` was called in a test and its
   success toast was not observed before the test returned, the test fails with a message
   naming `awaitReceiveSettled()`. The guard unmounts the page first, because a throwing
   hook stops Testing Library's own cleanup hook and turns one clear failure into a
   cascade of "found multiple elements" in the tests that follow.

Nothing the suite proves was weakened: no assertion was removed or loosened, no timeout
was raised, and no retry was added.

### Proof observed

- Fixed file: 11/11 green, 6 consecutive runs **under full-suite load** and 3 unloaded,
  0 guard hits. Full suite green with the fixed file in place.
- Guard proven backwards: with the `awaitReceiveSettled()` call removed from the first
  test and the same background load, the guard failed that test in 3 of 3 runs with the
  message above, and only that test.
- `eslint` and `tsc --noEmit` clean on the file.
- **Every mutation in the 2026-09-04 ledger table was re-run** against the fixed
  harness, because a harness change can expire a neighbour's proof just as a guard
  change can. 10 of 11 still go red, on the same tests the ledger names:

| Guard disabled (alone) | Result |
|---|---|
| `fetchPO` token check after the line-items await | red |
| `fetchPO` token check after the header await | red |
| `fetchReceivingHistory` after the records await | red |
| `fetchReceivingHistory` after the receiver-name await | red |
| `useLayoutEffect` route-change clear | red |
| `handleReceive` foreign-line refusal | red |
| `fetchPO` ticket check (route kept) | red |
| `fetchReceivingHistory` ticket check (route kept) | red |
| `fetchReceivingHistory` **route** check (ticket kept) | **green — see below** |
| `fetchReceivingHistory` route screen at the door | red |
| `fetchPO` route screen at the door | red |

**The green row is not new.** Run against the *unchanged* test file three times, the same
mutation is green every time, so this harness change did not expire it. The 2026-09-04
entry says that row went red on "keeps PO B loadable mid-flight" and that only
`fetchPO`'s post-await route check is kept without a test. The second half is now true
of `fetchReceivingHistory`'s post-await route check as well, and for the same reason
that entry gives: once the door screen refuses a route-stale call before it takes a
ticket, no test path reaches the post-await route check while the ticket is still
current. The check is kept because it defends the same unreproducible window (route ref
updated by the layout effect, next ticket not yet minted by the passive effect). That
entry's own warning — the unprovable guard **moves** every time a guard is added — is
what happened here: the door screen for `fetchReceivingHistory` was the last guard
added, and it carried this one. Treat both post-await route checks as deliberately kept
and untested; do not delete either because "all tests stay green".

### Codex review finding (PR #636, P2) — fixed

Codex pointed out that the guard keyed off "the receive RPC was **called**", so a test
that deliberately parks `receive_po_items` and never answers it (the case the guard's own
message said was allowed) would always be failed by the guard. Correct: the Vitest mock
records the call at invocation, and a parked receive can never raise the success toast.

Fix, still test-file only: the harness `rpc` wrapper — the one place every mocked RPC
passes through, including one a test re-mocks to hold open — now records when the
receive RPC **answers**, and the guard keys off that. A parked receive has no tail to
leak; only an answered one does. The guard message now says so.

Proof:

- Backwards: a temporary test that parks the receive for the whole test passes under
  the new guard (12/12) and fails under the old condition (1 failed / 11 passed, the
  probe only).
- Forwards: with test 1's `awaitReceiveSettled()` removed under full-suite load, the
  guard still fails that test 3 of 3 times, and only that test.
- File 3/3 green unloaded; `eslint` and `tsc --noEmit` clean.
- Mutation table re-run against this version of the harness: identical result, 10 of
  11 red on the same tests, the same single green row.

### Not verified

- The flake was reproduced through the mechanism (toast landing after the test body) and
  the guard, not by catching the exact `expected undefined` assertion locally: on this
  machine the straggler always landed in a test that does not receive, so it was
  harmless here. The CI failure needs it to land in a test that does, and the settle
  helper now makes that impossible regardless of which test it would have hit.
- No browser run. Nothing in the page changed.
