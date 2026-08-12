# Customer 360 Adoption Pack — Morning Handoff

**Status:** Customer 360 merged through protected PR #381 and its non-destructive activity/timestamp follow-up is live as server/disk B7 version `20260812003315` (submitted as `20260811230423`). Both final-path migration charters, the exact committed-SHA Sol gate, disposable PostgreSQL proof, live catalog/grant/body verification, and genuine schema-registry refresh are green. PR #381 merged at the older reviewed head while two final client/proof fixes were still local, so those isolated changes are now in follow-up PR #385 with a separate exact-SHA CLEAN verdict; its GitHub/Vercel/CodeRabbit checks remain the only release gate still in progress at this handoff update.

**Current closeout branch:** `codex/customer-360-post-merge-fixes` (PR #385)

**Original pack starting base:** `adfef797978645506775b5a8f8fc5bfdd9101d96`

**Follow-up base:** `d3429e4f6c0ac6ba0ee0bae977a81e4de326273a` (PR #381 merge commit)

`origin/main` moved repeatedly during the run. The first move was incorporated by rebase before the feature push; later movement was integrated additively to avoid rewriting the published branch. The final pre-commit fetch reports `0 behind / 10 ahead` against current `origin/main` (`f1a5c683`).

## What changed

The original four implementation/test files remain the user-facing surface. The pre-push adversarial fixes also add the smallest database, shared idempotency, smoke, and reference-doc support needed to make customer assignment atomic:

- `src/pages/Customers.tsx`
  - Admin-only bulk assignment of selected active customers to active sales representatives.
  - Explicit confirmation count and target rep.
  - One atomic `assign_customers_sales_rep` RPC that locks and validates the target rep, updates the exact active-customer set, and raises inside the transaction if the set changed, so rep deactivation and partial-update races cannot commit silently.
  - Payload-bound idempotency keyed to the admin, canonical customer-id set, and target rep.
  - Truthful post-mutation handling: a failed refetch shows the confirmed assignment locally, clears the completed selection, and reports that reload is required without a success toast.
  - Missing rep, phone, email, and crop labels, plus a combined profile-needs filter and core-profile-ready state.
- `src/pages/Customers.filters.test.tsx`
  - Coverage for profile-needs labels/filter combinations, admin/rep permissions, active-rep options, confirmation, cancel, success, RPC errors, a two-selected exact-set rollback error, rep deactivation, retry-key reuse/rotation, and truthful failed-refresh handling.
- `src/pages/CallLists.tsx`
  - Kept all five existing RPC-backed lists and role restrictions.
  - Added list-specific "Why now" facts with safe unavailable-data wording.
  - Added a horizontally reachable, touch-sized mobile tab selector with arrow/Home/End keyboard behavior.
  - Added canonical validated URL state for list, applied criteria, rep, tier, crop, and search; refresh and browser Back/Forward restore the view.
  - Preserved synchronous row clearing, stale-response invalidation, admin-only rep filtering, and safe lookup fallbacks.
  - Prevented false-clear UI while tier/crop enrichment is pending.
  - Sanitized failed-list toasts so raw database details remain in Sentry instead of appearing to users.
  - Bounded day lookbacks to 3,650 days so accepted input cannot overflow the RPC's PostgreSQL timestamp arithmetic.
  - Kept admin rep-filter URLs fail-closed while profile-option lookup is unavailable, so a deep-linked rep scope cannot be stripped and broadened to all reps.
- `src/pages/CallLists.test.tsx`
  - New coverage for all five reasons, fallbacks, role-invalid URLs, complete URL restoration/canonicalization, browser history, stale RPC races, draft/applied criteria, enrichment loading, rep-option failure/retry without scope broadening, sanitized backend failures, touch and keyboard semantics, and the 3,650-day boundary.

Additional support files:

- `supabase/migrations/20260811183317_assign_customers_sales_rep.sql` — applied-live admin-only atomic RPC with target-row locking, exact-set rollback, payload-bound replay, and narrow execute grants; submitted as `20260811122851` and B7-renamed content-identically to the server-assigned version.
- `supabase/migrations/20260812003315_log_customer_sales_rep_assignment.sql` — applied-live, content-identical B7 rename of submitted follow-up `20260811230423`; preserves the RPC contract while advancing `customers.updated_at` and adding one customer-scoped activity row per committed assignment, with exact audit-count rollback and replay de-duplication.
- `scripts/smoke/smoke-assign-customers-sales-rep.sql` and `scripts/smoke/smoke-specs.json` — registered rollback-only denial, partial-set, success, and replay proof.
- `scripts/smoke/prove-assign-customers-sales-rep.mjs` — network-isolated PostgreSQL 17 harness for the exact follow-up migration, activity-row count/replay de-duplication, rollback residue, and concurrent rep deactivation.
- `src/hooks/useIdempotencyKey.ts` and test — rotates the retry key when the assignment intent changes without embedding customer data in the key.
- `src/lib/customerAssignmentGuards.test.ts` and `src/lib/db.ts` — migration contract tests and typed RPC error codes.
- `.claude/schema-registry.json` — genuinely regenerated from all six live introspection queries through 962 rows/high-water `20260812003315`. The migration changed only a function body, so generated Supabase types are structurally unchanged; live verification also confirmed the checked-in `pg_proc` fixture remains at 566 distinct public function names and its verification stamp was advanced.
- `docs/reference/rpc-functions.md`, `docs/reference/migration-history.md`, and `docs/CHANGELOG.md` — applied-live RPC/migration record.

## Test-first and architecture evidence

- Autopilot was armed for the authorized 12-hour run.
- Work started in a clean isolated worktree from then-current `origin/main`.
- Graphify was refreshed first and again after remediation; the current graph has 9,161 nodes and 18,675 edges. Its `explain`, `affected`, `query`, and `path` views narrowed the Customers/Call Lists surface before source verification.
- Initial feature tests failed as intended: **20 failed / 7 passed**.
- Initial implementation reached **27/27 focused tests green**.
- Review-mutation tests then reproduced all five Sol findings: **5 failed / 27 passed** before the fixes.
- Original focused proof before the fresh pre-push review: **2 files / 32 tests passed**.
- Remediation proof before rebase: **4 files / 44 tests passed**, plus TypeScript, lint, and strict changed-migration validation.
- Disposable PostgreSQL proof: exact migration apply passed; rollback smoke returned `SMOKE_PASS_ROLLBACK` and left `0 assignments / 0 receipts`; concurrent changed-payload replay was rejected after the first request committed exactly `2 assignments / 1 receipt`.

## Verification

| Gate | Result |
| --- | --- |
| Focused remediation tests | Pass after PR-review fixes — 4 files, 129 tests |
| Broad Vitest suite | Pass after PR-review fixes — 326 files, 4,449 passed, 123 skipped, 0 failed |
| TypeScript | Pass after rebase — `npm run typecheck` |
| Lint | Pass after rebase — `npm run lint -- --quiet` |
| Build | Pass after rebase — 4,253 modules; PWA generated |
| Agent workflow guards | Pass — `npm run test:agent-workflows` |
| Correction guards | Pass after power recovery — every registered safety harness |
| Documentation drift | Pass locally before apply; post-apply canonical docs now record 962 rows/high-water `20260812003315` and the B7 disk filename |
| Strict SQL migration validation | Pass after recovered-Sol fix — one changed migration, 0 violations, 0 warnings |
| Disposable exact migration apply | Pass again after recovered-Sol fix in PostgreSQL 17, including executable-source/security postflight |
| Rollback smoke | Pass — `SMOKE_PASS_ROLLBACK`, post-state `0 assignments / 0 receipts` |
| Concurrent replay | Pass — changed-payload reuse rejected, committed state `2 assignments / 1 receipt` |
| Concurrent rep deactivation | Pass after recovered-Sol fix — assignment blocked behind the profile update, then rejected `ASSIGNMENT_SALES_REP_INACTIVE`; no receipt or customer write |
| Live apply and catalog/grant verification | Pass — server version `20260811183317`; one overload, `SECURITY DEFINER`, pinned search path, no PUBLIC/anon EXECUTE |
| Live schema/type fixture gates | Pass — real six-query registry refresh through 962 rows/high-water `20260812003315`; no schema/signature change and live public function-name count remains 566 |
| Final staged-snapshot Sol re-review | Pass — terminal CLEAN after the live-state documentation corrections |
| Follow-up migration Sol charters | Pass — both final-path, content-bound `gpt-5.6-sol` high charters returned CLEAN for submitted migration `20260811230423` |
| Follow-up disposable proof | Pass — exact migration parsed/applied in PostgreSQL 17; timestamps advanced on success and rolled back on failure, activity delta was `2`, replay de-duplicated, deactivation lock rejected assignment, and post-state was `0 assignments / 0 activity / 0 receipts` |
| Follow-up live apply | Pass — Supabase assigned version `20260812003315`; ledger row 962, catalog/grants/body and registry refresh verified read-only |

The expected `ErrorBoundary.test.tsx` throw traces and jsdom canvas-not-implemented notices appeared during the green full suite; they are intentional test output, not failures.

## Browser proof

Browser verification used localhost-only mocked Supabase REST/RPC responses and a dummy local key. It made **no production connection or write**. The temporary `.env.local`, local Vite server, and Playwright sessions were removed/stopped afterward.

- Customers desktop list: `output/playwright/customer-360-customers-desktop.png`
- Customers desktop assignment confirmation: `output/playwright/customer-360-assign-confirmation.png`
- Customers phone assignment confirmation (390×844): `output/playwright/customer-360-assign-confirmation-phone.png`
- Call Lists desktop: `output/playwright/customer-360-call-lists-desktop.png`
- Call Lists phone: `output/playwright/customer-360-call-lists-phone.png`
- Customers rep-directory failure: `output/playwright/customer-360-rep-directory-retry.png`
- Customers rep-directory recovered after retry: `output/playwright/customer-360-rep-directory-recovered.png`
- Call Lists inactive-rep bookmark: `output/playwright/customer-360-inactive-rep-bookmark.png`

The original browser pass observed the assignment confirmation, URL canonicalization, invalid/forbidden fallback, and browser Back restoration. A fresh 2026-08-11 pass then exercised the atomic mutation path itself: the browser sent `POST /rest/v1/rpc/assign_customers_sales_rep`, received HTTP 200, closed the modal, cleared the selection, and rendered North Creek Acres as owned by Riley Active. It also proved `tier=3` remains visible/selected with zero matching rows, the call-list search input renders `maxLength=100`, and lapsed-product text attributes `$4,200.00` only to Atrazine 4L before separately noting two other lapsed products. The final recovery pass forced the sales-rep directory to fail, observed a disabled picker and submit action plus a visible retry alert, then restored the active Riley option through the retry button. It also opened `/call-lists?list=prepay&rep=rep-inactive`, preserved that URL, rendered `Casey Former (inactive)` as the selected filter, and proved the list RPC received the inactive rep ID instead of silently broadening to all reps. The only console errors were expected localhost realtime WebSocket failures because the isolated mock intentionally provides REST/RPC but no realtime server; the local Vite process, browser session, temporary route scripts, and `.env.local` were removed afterward.

## Independent review record

### Round 1

- Terra found two adoption/accessibility gaps: the Customers needs filter lacked a 44px minimum touch target, and phone-sized Customers assignment proof was missing.
- Sol found five P2 issues: stale active-rep assignment options, false success after a failed refetch, int32 overflow acceptance, a false-clear enrichment window, and stale criterion drafts after list/history restoration.
- All seven were fixed and mutation-tested.

### Round 2

- Terra: **CLEAN** after source/test and 390×844 screenshot verification.
- Sol confirmed the original five fixes, then found one additional P2 boundary: int32-max days fit the RPC parameter but overflow its timestamp arithmetic.
- The day ceiling was reduced to a safe 3,650-day business horizon with boundary tests.

### Round 3

- Sol: **CLEAN**. Verified the 3,650 maximum, 3,651 and int32-max rejection, and rechecked active-rep, refetch, enrichment, history, role, stale-response, and zero/partial-row protections.

### Fresh pre-push review

- Sol: **NEEDS_FIXES**, three P2 findings on the then-current commit: rep-option lookup failure could broaden a deep-linked Call Lists scope; Customers still had a validation/update time-of-check race; and a partial mutation could leave stale ownership while its test gap kept the suite green.
- Fixes now implemented: fail-closed rep validation, atomic database assignment with target-row locking and exact-set rollback, retry-safe UI reconciliation, and dedicated regression/smoke coverage.
- After power recovery, Sol found two further P2 client retry defects and one P2 proof weakness: failed exact-set recovery claimed a refresh that might not have happened; replay-payload mismatch retained a permanently rejected key; and the lock/postflight test could match comments rather than executable `FOR SHARE` SQL. Sol also flagged one P3 handoff wording error.
- Those findings are fixed: truthfully branched recovery messaging, confirmed-no-op key rotation, comment-stripped executable-source guards for active admin and the exact rep lock, pinned SECURITY DEFINER/search-path postflight assertions, corrected handoff wording, focused tests, exact migration reapply, rollback smoke, and concurrent rep-deactivation proof.
- The final staged-snapshot Sol re-review returned CLEAN, and the later exact committed-SHA review also returned CLEAN before the protected push.
- PR review also found that a valid tier restored from the URL could be hidden when no returned row currently had that tier, lapsed-product wording over-attributed aggregate revenue, the search input lacked its intended client bound, and atomic ownership changes no longer appeared in the user-facing activity feed. Fixed tier options, precise wording, and `maxLength=100` are implemented with regression tests. The audit fix was isolated in submitted migration `20260811230423`, applied live as `20260812003315`; both final-path migration charters and the exact committed-SHA review are CLEAN.
- A later thread-aware pass found three more valid P2s: ownership assignment did not advance `customers.updated_at`, a failed assignment-picker directory lookup looked like an empty rep list with no retry, and inactive-rep bookmarks could be canonicalized away and broaden the call-list scope. The timestamp update, fail-closed picker with retry, and inactive-labeled filter options are implemented with mutation-strength regression coverage. Corrected-body charters, runtime proofs, and the exact committed-SHA review are green.
- The post-push PR thread found one further P2 retry trap: a customer deactivated during an exact-set assignment could remain invisibly selected after refresh and make every retry fail. The exact-set recovery now clears the ambiguous selection, closes the modal, and rotates the rejected intent key after either refresh outcome. Regression tests cover the successful-refresh and failed-refresh branches; the proof harness also strips SQL comments before marker checks and inspects Git status before disposable writes.
- The subsequent exact-SHA Sol gate returned CLEAN with no blocker/high finding and one actionable low-severity hardening note: raw Call Lists backend errors could reach user-facing toasts. The toast is now sanitized, the original exception still goes to Sentry, and a regression test proves internal relation details are not displayed. Because this edit changes the commit, the final exact-SHA gate is rerun before push.

## Explicit boundaries

- PR #381 merged and its normal Vercel deployment checks passed. Follow-up PR #385 carries only the two fixes that were still local when #381 merged; it remains unmerged until its own required checks and CodeRabbit review finish.
- Mason approved the non-destructive migration apply in chat. The original RPC migration applied as server/disk version `20260811183317`; the activity/timestamp follow-up applied as server/disk version `20260812003315`. Both catalog/grant shapes were verified read-only, and the exact follow-up passed rollback and concurrency proof in disposable PostgreSQL. No business-row backfill ran. The registered live rollback smoke is still pending because the production-action guard requires Mason's separate literal `REAL-DATA-OK` authorization.
- No secrets were read, changed, or committed.
- Browser screenshots and route fixtures under `output/` are ignored local evidence, not release artifacts.
- The merged frontend deployment is verified at the platform/check level and the affected flows were browser-rendered against isolated mock responses. A real-customer production assignment smoke was not run because it would mutate live business rows and requires separate `REAL-DATA-OK` authorization.

## Parked recommendation — next slice only

Build the Customer Overview interaction slice next: add an explicit **Edit** action, surface license status and restricted-use-product warnings, then redesign **Call Prep / Log Interaction** as one coherent rep workflow. This recommendation is parked; none of it was implemented here.

## Morning next action

Finish PR #385's required checks and CodeRabbit review, merge it through the protected path, and verify the production app shell/affected routes. Run the registered live rollback smoke only after separate `REAL-DATA-OK` authorization.
