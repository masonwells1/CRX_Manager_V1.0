## 2026-09-05 — JobDetail: remount the page per record, so one job's data cannot survive onto another

The `gpt-5.6-sol` proof at the round-6 head returned BLOCKED with two High findings that no
previous round had reached. Both are **pre-existing on `main`** and neither needs a race — they are
the plain, everyday consequence of the page being REUSED across records.

### 1. A fully loaded job survived onto the blank `/jobs/new` form (Codex CRX-ENTITY-001, High)

`/jobs/:id` carried no `key`, so React kept one `JobDetail` alive and poured the next record into
it. The new-job branch resets six pieces of state — `loading`, `growerShareFieldNames`,
`loaderVesselId`, `tankCapacity`, `jobNumber`, `recipeId`. Customer, dates, notes, fields,
chemicals, billing shares and applied info all survived.

So: open a job, read it, click **New Job**, save. `save_job` is called there with
`p_job_id: null`, so it **INSERTs a brand-new job carrying another customer's data** — which then
drives that customer's `field_billing_defaults` split and their bill.

Round 5 addressed the *race* version of this (it moved `fetchJob`'s installs below every await, so
an abandoned load installs nothing). That fix is correct and is retained, but it could never reach
this one: nothing here is abandoned mid-flight. Job A's install was legitimate and had already
finished. The round-5 regression test navigates while job A is deliberately blocked before its
install phase, so no completed record state exists in it to leak — which is exactly why five rounds
of review did not surface this.

### 2. Every other confirmation dialog survived a job change (Codex CRX-ENTITY-002, High)

Round 5 closed the licence-override prompt on a route commit. It closed only that one.
`showCompleteConfirm`, `showCancelConfirm`, `showTransferConfirm`, `showCompleteModal`,
`showOverrideModal`, `showPreNoticeConfirm` and `showPostNoticeConfirm` all stayed open across a
change of job, and each dialog's `onConfirm` calls the CURRENT render's handler — which reads the
CURRENT `id`:

```tsx
onConfirm={() => { setShowCompleteConfirm(false); handleComplete(); }}
```

A Complete prompt opened on job A and confirmed after moving to job B therefore **completes job
B** — deducting inventory and writing an application record against a job nobody asked to
complete. Cancel and Transfer-to-Invoice are the same shape.

Gating one of the four job-action handlers and not the rest is the partial-compliance failure this
branch has now hit three separate times.

### The fix: remount, rather than enumerate

`jobs/:id` now renders `src/components/JobDetailRoute.tsx`, which keys `JobDetail` by the route id.
React discards the old instance and builds a fresh one, so **no state can cross a record boundary
by default** — form fields, dialogs, refs and all.

The alternative was to hand-list every field to reset and every dialog to close. That is ~30
setters plus 7 dialogs, it was already rejected once on this branch for silent drift, and it fails
open: the thirty-first field added by the next feature is a defect nobody writes down.

`JobDetailRoute` lives under `components/` rather than `pages/` because it is a routing wrapper,
not a page — the same reasoning that puts `ProtectedRoute` in `components/auth`. That keeps it out
of the pages smoke inventory, which is correct rather than convenient: mounting it mounts
`JobDetail`, whose calendar dependency hard-crashes the jsdom worker, so the inventory could only
ever have marked it skipped. It is covered by real tests instead, and the pages skip ratchet is
untouched at 45.

App.tsx lazy-loads `JobDetailRoute`, so `JobDetail` stays in its own chunk exactly as before.

### What the remount makes redundant — stated, not hidden

Inside one mount, `id` can no longer change. That makes parts of the existing machinery
unreachable in production, and a note at the route effect in `JobDetail.tsx` says so in full. In
short:

- **Redundant while the route stays keyed:** every `routeIdRef` comparison; the `setLoading(true)`
  in the route effect (a saved job now MOUNTS with `loading` true, from `useState(!isNew)`); and
  the licence-prompt close in that effect (a fresh instance starts with the prompt shut).
- **Still load-bearing:** the route-epoch counter. Leaving the page — to another job or off
  `JobDetail` entirely — now always unmounts, and the effect's cleanup is what tells an in-flight
  handler its record is gone. It is the guard that survived the remount, not the one it replaced.
- **Still load-bearing:** the load-generation ticket and `fetchJob`'s gather/install split, which
  order two loads of the SAME job inside one mount. A remount cannot help there.

All of it is kept deliberately: it is the fallback if the key is ever removed, and the existing
tests mount `JobDetail` directly — without the route's key — so those paths stay exercised.
Unreachable code that reads like a guarantee is what this file has been punished for before, so it
is labelled rather than left looking load-bearing.

### Coverage

Three tests in `src/components/JobDetailRoute.test.tsx`, run against the component the router
actually renders rather than a key a test file added for itself:

| Mutation | Tests reddened |
|---|---|
| M14 — drop the `key` from `<JobDetail key={id} />` | new-job-form-not-inherited; complete-dialog-not-carried-over |
| M15 — point App.tsx's `jobs/:id` back at `JobDetail` | routes-through-JobDetailRoute |

M14's failure message is the defect itself: job A's `2026-03-01` still sitting in the Job Date
field of the blank New Job form.

M15 exists because the key is now the only thing between these two defects and production, and the
first two tests would keep passing if App.tsx were quietly re-pointed. It reads App.tsx's route
line as source (App.tsx builds its router at module scope, so importing it in jsdom is not
viable).

**The whole 13-row table from earlier rounds was re-measured against this source and is
unchanged** — same rows redden, same rows do not. The remount disarmed nothing. That check is not
ceremony: three times on this branch a new guard has silently made an older one unprovable.

### Harness fix worth recording

The mutation runner assumed the source file was CRLF and rewrote its LF anchors to match. After a
`sed -i` pass normalised `JobDetail.tsx` to LF, 9 of 13 rows silently became `ANCHOR-NOT-FOUND` —
which scans as "nothing regressed" if you only look for reddened rows. It now derives the line
ending from the file. The commit itself was never affected: `.gitattributes` normalises on the way
in, and the diff stayed at the intended size.

### Not verified

- **M1, M3 and M6 redden nothing**, unchanged from round 6 and documented there: M1 is
  belt-and-braces behind the round-3 entry check, M3 is masked by the `handleStart` gate, and M6's
  window does not exist in jsdom because `act()` flushes passive effects synchronously.
- **No live-browser run.** The page is auth-gated and a fresh worktree has no `.env`.
- **The remount's cost is real but unmeasured:** switching jobs now refetches the record-independent
  lookup lists, because a fresh instance re-runs `loadLookups`. No user-visible timing was measured;
  the correctness win was judged to dominate a page that already refetches the job itself.
- **The remaining `await`-then-write call sites are still unaudited** — 26 async functions, 20 that
  write after an await, 4 with the epoch gate, 1 with its own ticket. `loadRecipeById` and
  `loadProgramById` write `setChemRows`, which drives cost and price. The remount removes the
  cross-record half of that risk; it does not address a stale write landing on the SAME record.
