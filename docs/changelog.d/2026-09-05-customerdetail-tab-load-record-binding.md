## 2026-09-05 — CustomerDetail: a tab refresh can no longer land the previous customer's rows

`CustomerDetail` is not remounted when only `:id` changes, so its tab loader has to
invalidate itself by hand. It did that with a sequence number alone: each load takes a
ticket and installs only while it still holds the newest one. The route-change effect
bumps that ticket, which covers every load the route/tab effect starts.

It does not cover a load started **after** the route moved from a closure that outlived
it. `LogInteractionModal` captures its `onLogged` callback on an earlier render and
invokes it only once its save RPC and activity-log write resolve — so that callback still
names the **previous** customer's `id` while minting the **newest** sequence. A
sequence-only check there does not merely miss the stale write, it **certifies** it: the
previous customer's timeline installs under the customer now on screen.

Same bug class as the QuoteBuilder route-switch fix
(`2026-09-05-quotebuilder-route-switch-save-target.md`) and the sibling work in PR #611
(JobDetail) and PR #604 (receiving). Pre-existing on `main`.

The primary customer record on this page was already guarded, and the comment above
`currentIdRef` said in as many words that the tab loader still needed the same discipline.
This finishes that.

### What changed (`src/pages/CustomerDetail.tsx`)

- `fetchTabData` refuses a call whose route binding is already broken — **before** the
  call takes a sequence number. Refusing at the door rather than after the first await
  matters twice over: burning a sequence invalidates the load that legitimately belongs to
  the customer now on screen (which then returns having installed nothing *and* without
  clearing `tabLoading`), and the refused call would already have flipped the tab into a
  loading state nothing goes on to clear. Either way the open customer is stranded behind
  a permanent spinner. **That stranding is live on `main` today**, not merely a hazard of
  this design — the regression test for it fails against unfixed source.
- The route half is re-checked after each await alongside the sequence. The door check
  cannot cover a route change that happens while a load is in flight, and the sequence bump
  that normally covers it lives in a passive effect, which React schedules after the commit
  — whereas `currentIdRef` is written in a layout effect, at the commit. A reply landing in
  that gap is superseded by a route the sequence does not know about yet.
- Four post-await checks added ahead of error branches that previously ran unconditionally
  (fields, timeline, and both history reads). A superseded load must not toast its failure
  over the customer now on screen, and the fields branch must not reach its
  `assertRpcResult` throw — an unhandled rejection reporting a failure that belongs to
  another record.

Behaviour for the customer actually on screen is unchanged: no toast, error path, or
install was altered for a load that is still current.

### Proof

Three regression tests added to `src/pages/CustomerDetail.test.tsx`. They mount the real
page on a real router and drive the **real `LogInteractionModal`** — not a stand-in — so
the stale closure under test is the one production actually creates. Reads settle only when
awaited, so each one reports which customer it was genuinely started for.

| Test | The one guard that catches it |
|---|---|
| refuses a timeline refresh fired for the customer the operator has already left | the door refusal |
| keeps the newer timeline load for the SAME customer when the older one lands last | the **call-sequence** operand |
| does not let the refused refresh strand the open customer behind a spinner | the door refusal's **position**, ahead of the sequence mint |

- Against unfixed source, tests 1 and 3 **fail**. Test 2 passes there by design: the
  sequence half already exists on `main`, and that test exists to keep it load-bearing —
  every other test in the group changes customers, where the route binding alone suffices,
  so without it the sequence could be deleted against a green suite.
- Each guard was then disabled individually and the suite re-run. Removing the door refusal
  fails tests 1 and 3; removing the sequence operand fails exactly test 2.
- `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `npm run test`: exit code 0, 350 files / 4989 passed / 123 skipped, no failures, no
  `Errors` line.

### Not verified

- **The re-checked route half inside the post-await guard is reasoned, not test-proven.**
  With the door refusal in place, removing that clause leaves all three tests green. It
  closes only the window between React's commit and its passive effects, which
  `@testing-library`'s `act()` flushing makes non-reproducible on demand. It is kept
  because it stops `fetchTabData`'s correctness from depending on a separate effect
  remembering to bump a counter — but no test pins it, and this note is the reason it must
  not be deleted as dead code.
- Not exercised against the live app in a browser: the failure needs two real customers and
  a slow connection, which is not reproducible on demand in this environment. The three
  sequences are proven at the page level with the real component, the real router and the
  real modal.
