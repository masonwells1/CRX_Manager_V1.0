# Field Mode Reliability Gauntlet

## WHERE

- Repository: `masonwells1/CRX_Manager_V1.0`
- Worktree: `C:\Users\mason\.codex\worktrees\field-mode-reliability-20260812\CRX_Manager`
- Branch: `codex/field-mode-reliability-20260812`
- Base at start: `origin/main` commit `a44fc2f52a95d815e2873536a6ff4204d84851c2`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`

## GOAL

Run a bounded, frontend-only reliability gauntlet over the driver Field Mode route and its offline-work recovery path. Done means confirmed defects have mutation-strength regression tests, minimal fixes, phone browser proof, the deterministic test/build floor, and an independent exact-head Sol review.

## PROVEN

- The 2026-08-12 live fleet report and exact file collision scan found no active worktree or open pull request touching the scoped files below.
- Graphify was refreshed at base commit `a44fc2f5` (9,118 nodes, 18,671 edges, 99% extracted). The focused path/query identified `FieldRoute`, `getQueueSummary`, `offlineSync`, and the office review page; direct source inspection confirmed every material connection.
- The shared `C:\CRX_Manager` checkout contains unrelated returns-gauntlet work and was not used for implementation.
- Baseline before edits: five focused files, 80 tests passed.
- Independent Sol/high finding gates confirmed three medium defects and refuted one suspected cross-user summary defect:
  1. `FieldRoute` allowed an older stop response to replace a newer refresh result.
  2. `OfflineWorkReview` allowed older queue responses to replace newer filter results and retained stale actionable controls after a current load failure.
  3. `offlineSync` skipped a queued different-user or forced replay when the active replay rejected.
  4. The suspected previous-user queue-summary leak was not real because auth loading unmounts the protected route during user changes.
- New tests were observed failing against the old behavior: four failures across the three confirmed defects.
- Focused final proof: five files, 87 tests passed.
- Page lifecycle proof: 12 tests passed, including newest-response-wins, stale error/loading, unmount invalidation, stale row removal, and resolution/confirmation modal clearing.
- Full Vitest proof: 327 files passed; 4,473 tests passed and 123 skipped.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. The build transformed 4,253 modules and generated the PWA assets.
- Chromium phone proof at 390 x 844: `/my-route` authenticated with the repository-designated driver account, rendered meaningful content, refreshed, had no Vite overlay, and reported zero browser errors. Screenshot: `output/playwright/field-route-mobile.png` (gitignored local evidence).
- The office-role browser attempt was blocked by a Windows Playwright CLI named-pipe collision. No production or test data was changed; page behavior is covered by the 12 focused page tests.
- Independent Sol/high fix gates are CLEAN for both subsystems:
  - Page gate: all sequence, stale-error/loading, unmount, stale-data, and modal-clearing guards are mutation-sensitive.
  - Sync gate: cleanup, serialized recursion after fulfillment or rejection, and non-duplicating same-user sharing are correct.

## IMPLEMENTED

- `FieldRoute` now assigns every stop request a sequence and ignores stale or post-unmount results.
- `OfflineWorkReview` now ignores stale or post-unmount queue results and fails closed on a current load error by clearing stale rows, totals, selection, confirmation, note, and idempotency key.
- `offlineSync` now starts queued different-user or forced work after the active replay settles, whether it succeeds or fails.
- Regression tests cover each removed/reversed guard and the fail-closed behavior.

## NOT DONE BY THIS OVERNIGHT CYCLE

- No push, pull request, merge, deployment, migration, live Supabase write, secret change, or permissions change.
- No full authenticated browser pass for `OfflineWorkReview` because of the local Playwright CLI pipe collision described above.

## APPROVAL STATE

- Mason approved continuing this isolated overnight work on 2026-08-12.
- This cycle may make and locally commit reversible frontend/test fixes.
- This cycle does not carry approval to push, deploy, apply migrations, mutate production data, delete data, or change secrets/authentication/permissions.

## GATES AND BLOCKERS

### Owned files

- `src/pages/FieldRoute.tsx`
- `src/pages/FieldRoute.test.tsx`
- `src/pages/OfflineWorkReview.tsx`
- `src/pages/OfflineWorkReview.test.tsx`
- `src/lib/offlineQueue.ts`
- `src/lib/offlineQueue.test.ts`
- `src/lib/offlineSync.ts`
- `src/lib/offlineSync.test.ts`
- `src/lib/offlineReceipts.ts`
- `src/lib/offlineReceipts.test.ts`
- This handoff and a unique Field Mode audit artifact if findings require one.

### Explicit exclusions

- `JobDetail`, orders, invoices, pricing, commissions, returns, and Team Board.
- `src/lib/db.ts`, shared RPC contracts/types, all migrations, all Edge Functions, and live Supabase writes.
- Shared overnight ledgers or generic changelog files currently owned by other sessions.

### Existing unrelated blocker

- The fleet reports parked Wave A migration state as `UNKNOWN`, and the schema registry trails two parked migration filenames. This frontend-only lane will not resolve or rely on that schema state.

## MORNING ACTION

Inspect the exact local commit on this branch. If the scoped files are still collision-free and `origin/main` has not introduced a conflicting change, move this branch through the normal protected pull-request review pipeline in a daytime ship session. Do not include Claude's parked Wave A migration work in this branch.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
