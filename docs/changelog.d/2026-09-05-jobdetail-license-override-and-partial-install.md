## 2026-09-05 — JobDetail: stop a licence override, and a half-loaded job, from landing on the wrong record

Follow-up round on PR #611. The cross-record stale-load ticket shipped in
`2026-09-05-jobdetail-cross-record-stale-load-ticket.md` gated the load path and six of the seven
sites in the save handler. This entry closes the three findings that were still open against
`d867140d5`: two raised by the `gpt-5.6-sol` proof at that SHA, and one carried forward from a
Codex PR thread anchored at `9cee23cc7`. That earlier entry is left untouched; this is its own
record.

All three are the same shape — work that began on one job finishing after the operator is
somewhere else — but each sits outside the load path the previous round protected, which is why
the ticket and route-id guards did not reach them.

### 1. The licence override could be authorised against a different job (Codex CRX-SEC-002, High)

`performSave`'s `catch` handles `LICENSE_EXPIRED` by opening the admin "Assign Anyway" prompt. The
success path immediately above it is gated on `stillOnThisJob()`; this branch was not. The route
had no `key` **then**, so moving between jobs did not remount the page — the prompt therefore followed the
operator onto the next job, and confirming it calls `performSave(true, reason)` from the *current*
render. An admin clicking through it saved the job then on screen through the administrative
licence-override path, and the activity entry read as a deliberate override of that job. The
over-label reason stashed for the first job was carried into the second job's audit as well.

This is the seventh site in a handler whose other six were gated in round 4. Partial compliance
with a finding is the same defect.

Two changes, covering two genuinely different windows:

- **The catch is now gated on `stillOnThisJob()`**, so a rejection that lands after the operator
  has moved cannot raise the prompt at all. The non-admin toast moved inside the same gate.
- **The route effect closes an open prompt and clears the pending reason on every route commit**,
  so a prompt that opened legitimately does not survive onto the next job. The catch's gate cannot
  cover this case: it already ran, correctly, before the operator moved.

A third layer — binding the reason to a job id and re-checking it at confirm time — was written
and then removed. With the two guards above in place, a confirm can only ever be reached on the
job the prompt belongs to, so the check was unreachable: dead code that reads like a guarantee and
can never be shown to hold. The reasoning is recorded in the source so it is not re-added blind.

### 2. Leaving the page entirely never invalidated the route epoch (Codex CRX-SEC-001, High)

`routeEpochRef` — the counter `stillOnThisJob()` reads — was bumped only in the layout effect's
body, which runs on a route *commit*. Nothing bumped it on unmount. The passive effect below it
already had exactly this cleanup for its own ticket, which is why the ticket was covered and the
epoch was not.

So after navigating away from JobDetail altogether, a save or transfer still in flight saw
`stillOnThisJob() === true` and ran its whole success block on behalf of a page that no longer
existed: a success toast over an unrelated screen, the dirty flag cleared, a refetch of the
abandoned job, and — on a new job — a `navigate()` that pulls the operator off whatever page they
had moved to.

Fixed by returning a cleanup from the layout effect that bumps the epoch. Re-running the effect
fires the cleanup too, so a job → job navigation now bumps twice; the counter is only ever compared
for equality, so an extra bump invalidates nothing a single bump would not.

### 3. A half-loaded job could be saved as a brand-new job (Codex PR thread, `9cee23cc7`, P1)

`fetchJob` installed the record onto the form and only *then* awaited two more reads
(`field_billing_defaults`, twice). Inside that window the form already showed the job's customer,
date, notes and field list. Navigating to `/jobs/new` there correctly abandoned the rest of the
load, but the new-job branch resets only four pieces of state — `loading`,
`growerShareFieldNames`, `loaderVesselId`, `tankCapacity`. The customer, date, notes and fields
survived onto the blank form, and `save_job` is called with `p_job_id: null` there, so the next
save **INSERTED a brand-new job carrying another customer's data** — which then drove the
`field_billing_defaults` split. A job billed to a customer who never ordered it.

Fixed by reordering `fetchJob` into two explicit phases: every remaining round trip completes
first, then the record is installed with no `await` anywhere below. The last `isCurrentLoad()`
check is now the real commit point.

The alternative — extending the new-job branch's reset list — was rejected. That list would have to
be kept in step with roughly thirty setters by hand, forever, and the drift is silent. The ordering
cannot drift, because the invariant is just "no await below this line", and it is stated in the
source at the phase boundary.

**Scope, stated honestly:** this defect is pre-existing and *wider* on `main`.
`git show origin/main:src/pages/JobDetail.tsx` contains no `isCurrentLoad`, `loadGenerationRef` or
`routeIdRef` at all — `fetchJob` there has no cancellation whatsoever, and `main`'s new-job branch
resets the same four things. PR #611 narrowed the hole; this change closes it for the load path.

### Coverage

Four tests added in `src/pages/JobDetail.recordBinding.test.tsx`. They live in their own file with
their own mock because they need the **real** `hasRpcCode` / `RpcErrorCodes` from `src/lib/db.ts`
— the existing stale-load harness replaces that module wholesale, and stubbing those helpers would
delete the error path finding 1 exists to exercise. The file also adds a non-JobDetail route so a
test can genuinely UNMOUNT the page rather than only re-route it.

**Whole mutation table re-measured against this source.** Refactoring `fetchJob`'s ordering and the
layout effect touches guards the existing eight rows cover, so every row was re-run rather than
carried forward — a new guard can make an older one unprovable, and on this branch that has already
happened twice.

| # | Mutation | Tests reddened |
|---|---|---|
| M1 | drop the `routeIdRef` clause from `fetchJob`'s post-await predicate | none — retraction still correct |
| M2 | drop the ticket clause from that same predicate | `A -> B -> A`; newest-same-route-refetch |
| M3 | remove the entry route check | stale-handler-closure |
| M4 | remove the loading gate | hides-previous-editable-form |
| M5 | ticket back to a plain read | newest-same-route-refetch |
| M6 | `useLayoutEffect` back to `useEffect` | none (known harness limit — unchanged) |
| M7 | remove the post-await check after the jobs read | four tests |
| M8 | epoch predicate neutered to `true` | dirty-protected-after-move, **plus both new epoch tests** |
| M9 | remove the unmount epoch cleanup | save-lands-after-leaving-page |
| M10 | remove the licence-prompt close on route commit | closes-prompt-on-job-change |
| M11 | remove the staleness gate on the `LICENSE_EXPIRED` catch | override-not-offered-after-move |
| M12 | install `job_date` before the phase-1 awaits | values-not-stranded-on-blank-form |

No previously recorded row went false this round. M1 and M6 remain the two rows that redden
nothing, for the structural reasons documented in the earlier entry — both re-measured here, not
assumed. M8 widened from one test to three because the two new epoch tests also depend on it; that
is the row growing, not a guard weakening. M9–M12 each redden exactly one test and no other, so the
four new guards do not overlap or mask one another.

### Not verified

- **The `useLayoutEffect` route invalidation (M6) still has no regression test.** Unchanged from
  the previous round and unchanged by this one: `act()` flushes passive effects synchronously, so
  the production window does not exist in jsdom. Do not re-add a test for it without a harness that
  can actually create the gap — one was built, measured, passed identically both ways, and deleted
  rather than kept as a false green.
- **The post-await `routeIdRef` clause in `isCurrentLoad` (M1)** remains belt-and-braces and is not
  independently provable. Re-measured this round; the retraction in the earlier entry still stands.
  Do not delete it as dead, and do not cite it as covered.
- **No live-browser run.** The page is auth-gated, a fresh worktree has no `.env`, and the race
  needs two overlapping job loads to reproduce by hand. The proof is the real page mounted under
  deterministic gates, not a click-through.
- **PR #603 overlap is untouched here.** That branch also edits `JobDetail.tsx` and
  `JobDetail.billingHazard.test.tsx` and is currently unowned; whichever lands second resolves the
  overlap by content.
