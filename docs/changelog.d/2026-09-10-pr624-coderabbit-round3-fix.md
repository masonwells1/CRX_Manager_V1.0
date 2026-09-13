## 2026-09-10 — PR #624: CodeRabbit round 3 on `584dbf269` (1 fixed)

CodeRabbit's review of `584dbf269` requested changes with one Major finding. It is fixed.

- **A stale retry after a peer completion and an IndexedDB loss (Major).** This is the same setup
  as round 2. Tab A's reply is lost; tab B completes the same request under the same key. This
  time the browser also loses the IndexedDB coordinator row (eviction or a cleared store) before
  tab A retries. `beginIntent` offered the local mirror as a fallback only while it was pending.
  With the mirror now resolved, `coordinateDurableRecord` fell back to the fresh proposal and a new
  key, and `adjust_inventory` would apply the adjustment twice. The local mirror is now passed
  whatever its status. A resolved mirror follows the same rule as a resolved coordinator row: the
  tab's own identical attempt keeps its committed key, and anything else starts fresh. The
  parameter is renamed from `pendingMirror` to `localMirror`, and two comments now describe the
  resolved case.

Proof:

- New test in `useUncertainMutationIntent.test.ts`: a two-tab peer completion followed by a wiped
  IndexedDB. Before the fix it failed because tab A received a new key.
- Mutation check: filtering the mirror back to pending-only fails that test.
- Real-browser check: two tabs on the dev server ran the actual hook. After tab B completed the
  request, the IndexedDB database was deleted, and the local mirror still read resolved. Tab
  A's retry kept the original key.
- 100/100 tests pass across the eight suites that use the hook; `npm run typecheck` and ESLint are
  clean.

No live database change: migration `20260908130000` is still parked and unapplied.
