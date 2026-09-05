## 2026-09-05 — JobDetail: stop one job's in-flight load from landing on another job's form

**What was wrong.** The `jobs/:id` route in `src/App.tsx` carries no `key` prop, so changing
only the id does **not** remount `JobDetail`. The previous job's in-flight loads kept running
after the operator clicked into a different job, and their setters landed on the form now
showing that other job. A save afterwards targets the **current** route id while the form holds
the **old** record's values — one job's data written onto another job's row.

Found by the exact-SHA `gpt-5.6-sol` review of PR #603 head `5dad64e2` (2026-09-05), rated
HIGH. Pre-existing on `main`, not introduced by #603. On `main` the mount effect had no
cancellation of any kind; PR #603 adds a narrowly scoped `cancelled` flag on its own branch,
which this change supersedes rather than extends.

Two open paths, both closed here:

1. The mount effect never re-checked after `await loadLookups()`. On `/jobs/new` -> `/jobs/B`
   the abandoned new-job run continued into its `else` branch and cleared the grower-share
   names, loader vessel and tank capacity of the job now on screen, then overwrote its job
   number with a freshly minted `next_job_number`.
2. `fetchJob()` had no cancellation at all. On `/jobs/A` -> `/jobs/B` with A resolving last,
   A's setters overwrote B's loaded form. A's not-found branch could also toast and redirect
   against the job the operator was actually looking at.

**What changed.** `src/pages/JobDetail.tsx` only — no schema, RPC, money or permission surface.
A `loadGenerationRef` ticket is taken by the mount effect before any await and bumped again on
cleanup, so both a route change and an unmount supersede the run in flight. `fetchJob` captures
the ticket at entry and re-checks it after each of its three awaits, installing nothing once
superseded. Post-save / post-start refetches share the mounted run's ticket and are unaffected.
This gates the **call**, not the record id, so two overlapping loads of the same job stay
ordered. The established in-repo pattern is `initialLoadGenerationRef` in
`src/pages/QuoteBuilder.tsx`.

**The ticket alone is not enough, and a ticket-only guard would have been actively wrong.**
`handleStart`, `handleComplete` and the save path each `await` an RPC and then call `fetchJob()`
from the closure of the render they started on. That call is issued **after** any route change,
so it reads the **current** ticket and mints it for the **old** job — a ticket check would
certify precisely the write it exists to reject. Only the route is an independent witness to
which job is on screen, so `fetchJob` also records the id it was **started for** and compares it
against `routeIdRef`, updated by the mount effect on every id change. Two operands with
genuinely independent sources, so the pair cannot collapse into a tautology.

Each half was believed load-bearing on its own. **That claim was true when written and is false
now** — see the corrected mutation table at the end of this entry. Later rounds added an entry
check and a route epoch, and those made the post-await `routeIdRef` clause unprovable: it is
retained as belt-and-braces, not as a tested guard.

Bailing early also had to take ownership of two pieces of state the abandoned run used to
settle on its way out, or the guard would have traded a data bug for a dead page:

- `fetchJob` raises `baselineSettleGuardRef` synchronously at entry and only lowers it on its
  own completion paths. The `/jobs/new` branch never calls `fetchJob`, so on `job -> /jobs/new`
  the guard would have stuck true, the dirty engine would never have adopted a baseline, and
  the unsaved-changes prompt would have silently stopped protecting the new job. The mount
  effect now resets it as it takes its ticket.
- `loading` is seeded once, at mount (`useState(!isNew)`). Arriving at `/jobs/new` from a saved
  job left it true, and the superseded `fetchJob` that used to clear it now bails — the page
  would have sat on its loading skeleton forever. The new-job branch now clears it explicitly.

**Proof observed.** New `src/pages/JobDetail.staleLoad.test.tsx` mounts the real page under a
router whose location the test drives, with deferred-promise gates (not timers, so the ordering
holds on any machine at any speed). Five tests: `A -> B` with A resolving last, `new -> B` with
the new run's lookups resolving last, the reverse `A -> new`, `A -> B -> A` where the SAME job is
reopened so only call ORDER separates the two in-flight loads, and a Start Job click whose
`start_job` RPC is still in flight across a navigation, so the handler's refetch fires from a
stale closure.

That last case is what proves the guard gates the **call** and not the record. The other three
switch between DIFFERENT jobs, so all three stay green against an id-only guard in its strongest
form — the loaded record's id compared to a ref updated synchronously on route change, two
genuinely independent operands. Mutation-checked at the time: that guard reddened **only** the
`A -> B -> A` case. **Superseded** — with the full round-2/3/4 guard stack in place it reddens
**two** cases; see the corrected table below. (The weaker id-only variant, comparing against `id`
from `fetchJob`'s own closure, reddens three of the four — a superseded run closes over the OLD
id, so it compares a stale value against itself and can never fire.)

Confirmed fail-first: against the unguarded source, tests 1 and 2 both fail with the production
symptom — the heading renders the **stale** job's identity (`J-AAAA-1001`, `J-NEWNEW-9999`) in
place of job B's. Each of the two ownership lines was mutation-tested individually and fails
test 3 with a distinct symptom: removing `setLoading(false)` leaves the stuck skeleton
(heading never found); removing the guard reset leaves the dirty engine frozen at false
(`expected false to be true`).

**A defect this fix introduced, caught by review before merge.** The exact-SHA `gpt-5.6-sol`
review of head `170c2d91d` blocked with CRX-SEC-001 (High), and it was real. `fetchJob`'s first
two statements are **synchronous**: it nulls `baselineRef` and raises `baselineSettleGuardRef`
before its own await. The route check sat *after* that await, so a refetch issued from a stale
handler closure would disarm the dirty engine of the job **currently on screen** on its way in,
then bail on the far side and never lower the guard again. The mount-effect reset does not help,
because the effect does not re-run when a handler fires later. Job B kept rendering its own data
correctly while `isDirty` was frozen at false — so the unsaved-changes prompt stopped firing and
the "save before Start/Complete" gates waved edits through. A silent failure, strictly worse than
the loud one, and reachable from the same `handleStart` / `handleComplete` / save paths.

Fixed by rejecting an already-stale call at the top of `fetchJob`, **before** either write. The
ticket cannot serve as the test there — it is read from the ref one line above, so at entry it
always equals itself; only the route is a witness that early. Mutation-checked: removing that
one line reddens **only** the extended stale-handler test, and it fails on the dirty-tracking
assertion while the heading assertion still passes — which is exactly why the original version
of that test, which checked the heading alone, could not see this. Test 5 now edits job B after
the stale refetch returns and requires the page to register the edit.

**Three more defects, found by the next review round.** Two from the exact-SHA review of
`80e1161bc` and one from the Codex GitHub App. All three were real; two were pre-existing
rather than introduced by this branch.

1. **The form stayed editable while the next job loaded (P1, pre-existing).** `loading` is
   seeded once, at mount (`useState(!isNew)`), so on a saved-job -> saved-job navigation it
   stayed `false` for the entire load window. The page kept rendering the **previous** job's
   values in a live form with Save enabled, while `id` — which `handleSave` writes to
   (`id as string`) — had already flipped to the new job. Saving in that window wrote one
   job's data onto another job's row with **no race required at all**, just a fast click.
   This is the same corruption the ticket guard exists to prevent, reached by a completely
   different route. Fixed by marking saved-record route transitions as loading, which swaps
   the form for the existing skeleton until the new job's data lands.

2. **The ticket was not unique per call (Medium, introduced here).** `fetchJob` read the
   generation without claiming one, so every post-save / post-start / post-cancel refetch on
   a single route shared one ticket and none superseded any other — an older response could
   land on top of a newer one. Reachable because each handler guards only **itself** with an
   in-flight flag (`starting`, `cancelling`, `saving`): the same handler cannot double-fire,
   but two **different** handlers can overlap. Fixed by claiming a unique ticket per call.
   Its position matters: the stale-call rejection must run **before** the bump, or a stale
   call would burn a ticket and supersede the legitimate load in flight.

3. **Invalidation ran too late (High, introduced here).** Route invalidation lived in a
   passive `useEffect`. React commits the new route's render and only then runs passive
   effects, so a job-A response settling in that gap would read a `routeIdRef` still naming
   A, pass the guard, and install A's values on B's route. Moved into a **layout** effect,
   which runs synchronously inside the commit, so no promise continuation can interleave
   between the route changing and the ref moving.

Each of the first two was mutation-tested individually and reddens exactly one test: removing
the loading gate reddens only the new "hides the previous job's editable form" case; reverting
the ticket to a plain read reddens only the new "newest same-route refetch wins" case.

**A fourth defect: the guard was in the wrong layer for half the problem (High, pre-existing).**
Everything above polices which **response** may be installed. But the mutation handlers write
UI and form state **before** `fetchJob` is ever called — `setIsDirty(false)`, success toasts,
and `navigate()`. A handler resuming after the operator moved on marks the job **now on
screen** clean; `fetchJob` then correctly rejects the stale reload, but nothing restores the
flag, because the dirty effect only recomputes on `[formSnapshot, loading, baselineSettleTick]`
and none of those changed. The operator's unsaved edits on that job then go silently when they
navigate away, and the save-before-Start/Complete gates are down. Reported against `cb6911285`.

Fixed with a route epoch: a ref that counts **route commits only**, captured at the start of
each mutation and re-checked before any UI/form write. Deliberately not `loadGenerationRef` —
that one is also bumped by `fetchJob`'s per-call ticket, so a legitimate concurrent refetch
would falsely mark a live handler stale. A route-commit count also distinguishes `A -> B -> A`,
which an id comparison cannot: it bumps twice while the id compares equal to itself.

The review named three sites; there were **six**, and the two it did not name are worse than
the ones it did. `performSave`'s two error-recovery paths and `handleTransferToInvoice` each
call `navigate()` after their await, so a stale completion would not merely clear a flag — it
would move the operator off the job they were editing. All are now gated. The database write
and its activity-log entry are deliberately left ungated in every case: those record something
that really happened, and only the on-screen consequences belong to the current route.

Mutation-checked: neutering the epoch predicate to a constant `true` reddens **only** the new
"keeps job B dirty-protected when job A's cancel completes after the move" test. That test
edits job B and then lets A's cancel land, which is the sequence the review prescribed; the
earlier stale-handler test could not catch it because it drives Start Job, the one lifecycle
handler that does not clear `isDirty`.

**Corrected mutation table — the whole table re-run after the epoch change.** Each round of this
branch added a guard, and a new guard can make an older one unprovable, so every row was measured
again against the final source rather than carried forward. Two rows recorded earlier had become
false claims and are corrected here; the code comments that repeated them were rewritten.

| # | Mutation | Tests reddened |
|---|---|---|
| M1 | drop the `routeIdRef` clause from `fetchJob`'s post-await predicate | **none — claim retracted** |
| M2 | drop the ticket clause from that same predicate | `A -> B -> A`; newest-same-route-refetch (**two, not one**) |
| M3 | remove the entry route check | stale-handler-closure |
| M4 | remove the loading gate | hides-previous-editable-form |
| M5 | ticket back to a plain read | newest-same-route-refetch |
| M6 | `useLayoutEffect` back to `useEffect` | none (known harness limit, below) |
| M7 | remove the post-await check entirely | four of eight |
| M8 | epoch predicate neutered to `true` | dirty-protected-after-move |

M1 is the row that had gone false. The post-await `routeIdRef` clause was genuinely load-bearing
when it was the only route binding; the round-3 entry check now rejects a stale-closure call
before that predicate is reached, so nothing gets far enough to exercise it. Two further
mutations were run to confirm this is structural rather than a gap in the tests: removing the
clause **and** the entry check together reddens exactly the same single test as removing the entry
check alone, and stopping the layout effect from bumping the ticket does not make the clause
provable either. The layout effect writes `loadGenerationRef` and `routeIdRef` in one commit, so
a route change cannot move one without the other. The clause is kept as belt-and-braces against a
future edit that separates those writes, and is now documented in the source as untested.

Full gates on the final source: `npm run typecheck` clean, `npm run lint` clean, `npm run test`
exit 0 under `pipefail` with 351 files passed / 4994 passed / 123 skipped and no `Errors` line,
`npm run build` succeeded.

**Not verified — the layout-effect change is reasoned, not proven.** Downgrading
`useLayoutEffect` back to `useEffect` reddens **nothing** in the suite, so defect 3 above has
no regression test. The reason is a real limit of the harness, not an oversight: `act` flushes
passive effects synchronously, so inside `act` the invalidation has always already run by the
time an awaited promise resumes — the production window does not exist in jsdom. A test built
specifically to force the ordering (releasing the held response from a sibling's layout effect
during the new route's own commit, so it resolves as a microtask) was written and measured, and
it passed **identically** with the layout effect and with a `useEffect` downgraded from it. It
could not fail for the reason its title claimed, so it was deleted rather than kept as a false
green. The change is retained because it is strictly earlier than what it replaces and cannot
widen the window, but it should be treated as unproven.

**Not verified.** No live-browser run against production data — the page is auth-gated and the
race needs two overlapping job loads to reproduce by hand; the proof here is the real page
mounted under deterministic gates, not a click-through. The interaction with PR #603's own
`cancelled` flag is untested: whichever lands second will need its overlapping edit resolved by
content, and #603's narrower flag becomes redundant against this ticket.
