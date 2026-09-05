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
holds on any machine at any speed). Three tests: `A -> B` with A resolving last, `new -> B` with
the new run's lookups resolving last, and the reverse `A -> new`.

Confirmed fail-first: against the unguarded source, tests 1 and 2 both fail with the production
symptom — the heading renders the **stale** job's identity (`J-AAAA-1001`, `J-NEWNEW-9999`) in
place of job B's. Each of the two ownership lines was mutation-tested individually and fails
test 3 with a distinct symptom: removing `setLoading(false)` leaves the stuck skeleton
(heading never found); removing the guard reset leaves the dirty engine frozen at false
(`expected false to be true`).

Full gates on the final source: `npm run typecheck` clean, `npm run lint` clean, `npm run test`
exit 0 under `pipefail` with 350 files passed / 4979 passed / 123 skipped and no `Errors` line,
`npm run build` succeeded.

**Not verified.** No live-browser run against production data — the page is auth-gated and the
race needs two overlapping job loads to reproduce by hand; the proof here is the real page
mounted under deterministic gates, not a click-through. The interaction with PR #603's own
`cancelled` flag is untested: whichever lands second will need its overlapping edit resolved by
content, and #603's narrower flag becomes redundant against this ticket.
