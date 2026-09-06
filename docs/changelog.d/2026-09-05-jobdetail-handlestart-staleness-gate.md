## 2026-09-05 — JobDetail: stop "Job started" and its refetch landing on the job the operator moved to

Final open finding on PR #611. `handleStart` was the one job-action handler on this page carrying
no staleness gate at all. Its three neighbours — `handleComplete`, `handleCancelJob` and
`handleTransferToInvoice` — were each given `captureRouteEpoch()` in round 4; this one was missed,
and the miss survived four review rounds even though the `routeIdRef` comment at the top of the
file names `handleStart` by name as an example of the shape it guards against.

Same defect class as the licence-override finding closed in
`2026-09-05-jobdetail-license-override-and-partial-install.md`: a handler whose siblings were
gated and which was itself skipped. Partial compliance with a finding is the same defect.

### What went wrong

`/jobs/:id` carries no `key`, so changing the id does not remount `JobDetail`. Clicking **Start
Job** and then opening another job while `start_job` was still in flight resumed the handler on a
page now showing a different record, and it ran its whole success block unconditionally:

- `toast('success', 'Job started')` — the confirmation appeared over the job the operator had
  moved to, reading as though *that* job had been started. It had not.
- `await fetchJob()` — a reload of the started job's server state, called from the stale closure.

The other two operands on this page cannot reject that refetch on an A → B → A navigation:
`routeIdRef` is back to A, so `fetchJob`'s entry check passes; and `fetchJob` mints its own
*current* generation ticket with `++`, so the ticket check certifies exactly the call it exists to
reject. Only a count of route **commits** distinguishes A → B → A, because it bumps twice while the
id compares equal to itself.

`start_job` itself commits correctly against the job it was issued for, and the activity-log entry
is written from the handler's own closure, so it names the right job. Nothing about the database
write was wrong — the damage was entirely in what the resumed handler then did to the screen. The
gate is therefore placed after the commit and after `logActivity`, matching `handleComplete`.

### Coverage

One test added to `src/pages/JobDetail.recordBinding.test.tsx` (now five). It holds `start_job`
open, navigates to another job, then lets the RPC land, and requires that no `Job started` toast is
raised. A jobs-read count cannot be used as the witness: navigating issues its own read either way.
The test also asserts `start_job` was actually called, so it cannot pass vacuously if the click is
ever swallowed by the unsaved-changes gate on the button.

**The whole table was re-measured**, not just the new row — twice already on this branch a new
guard has quietly made an older one unprovable, and this round makes it three times.

| # | Mutation | Tests reddened |
|---|---|---|
| M1 | drop the `routeIdRef` clause from `fetchJob`'s post-await predicate | **none** |
| M2 | drop the ticket clause from that same predicate | reopened-same-job; newest-same-route-refetch |
| M3 | remove `fetchJob`'s entry route check | **none — see the retraction below** |
| M4 | remove the loading gate | hides-previous-editable-form |
| M5 | ticket back to a plain read | newest-same-route-refetch |
| M6 | `useLayoutEffect` back to `useEffect` | **none** (known harness limit) |
| M7 | remove the post-await check after the jobs read | four tests |
| M8 | epoch predicate neutered to `true` | four tests, incl. the new start test |
| M9 | remove the unmount epoch cleanup | save-lands-after-leaving-page |
| M10 | remove the licence-prompt close on route commit | closes-prompt-on-job-change |
| M11 | remove the staleness gate on the `LICENSE_EXPIRED` catch | override-not-offered-after-move |
| M12 | install `job_date` before the phase-1 awaits | values-not-stranded-on-blank-form |
| M13 | **remove the staleness gate from `handleStart`** | start-not-announced-over-next-job |

M13 reddens exactly one test and no other, so the new gate does not overlap or mask any guard
except as recorded immediately below. M8 widened from three tests to four because the new test also
depends on the epoch predicate — the row growing, not a guard weakening.

### Retraction: M3 is no longer provable

The row above previously read "remove the entry route check → stale-handler-closure test". **That
claim is now false and is withdrawn.** The test in question (`does not let a post-RPC refetch from a
stale handler closure reload the old job`) drives **`handleStart`**, which is the handler this
entry gates. The new gate stops the refetch before it is ever issued, so `fetchJob`'s entry check
is no longer reached on that path and breaking it changes nothing observable.

The two guards now mask each other for that one scenario, in both directions: remove the
`handleStart` gate and `fetchJob`'s entry check still rejects the refetch; remove the entry check
and the `handleStart` gate still prevents the call. Each is individually sufficient there, so
neither is falsifiable by that test alone. The `handleStart` gate is independently proven by the
new test, which witnesses the toast — something `fetchJob`'s guard can never prevent. The entry
check is left in place: it is the only protection for the fifteen `await`-then-write functions on
this page that carry no epoch gate, and it is the stronger guard for any future caller. It is now
**unproven**, and is recorded as such rather than claimed as covered.

### Not verified

- **M1, M3 and M6 redden nothing.** M1 is belt-and-braces behind the round-3 entry check; M3 is
  masked as described above; M6's window does not exist in jsdom, because `act()` flushes passive
  effects synchronously. All three are deliberate and documented, not defects — but none of them
  should be cited as covered.
- **The error path of `handleStart` is not gated**, and neither is the error path of
  `handleComplete`, `handleCancelJob` or `handleTransferToInvoice`. A failed start still toasts its
  error over whatever job is on screen. That is a misleading message, not a wrong write, and
  gating one of the four without the other three would leave the page inconsistent about which
  pattern is the rule. Left as-is, deliberately, and stated here rather than quietly.
- **No live-browser run.** The page is auth-gated, a fresh worktree has no `.env`, and reproducing
  the race by hand needs two overlapping job loads.
- **The remaining `await`-then-write call sites on this page are still unaudited** — 26 async
  functions, 20 that write after an await, of which 4 now carry the epoch gate and 1 carries its
  own ticket. `loadRecipeById` and `loadProgramById` write `setChemRows`, which drives cost and
  price, and are the first two worth looking at. Out of scope for this finding; recorded so the
  next round starts from a list instead of from whatever a reviewer happens to name.
