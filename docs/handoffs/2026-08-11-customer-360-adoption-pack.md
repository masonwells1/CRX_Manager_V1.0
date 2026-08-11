# Customer 360 Adoption Pack — Morning Handoff

**Status:** Complete locally; intentionally not pushed, opened as a PR, merged, deployed, or applied to live data.

**Branch:** `codex/customer-360-adoption-pack`

**Worktree:** `C:\Users\mason\.codex\worktrees\customer-360-adoption-pack\CRX_Manager`

**Starting base:** `adfef797978645506775b5a8f8fc5bfdd9101d96`

`origin/main` moved once during the run to docs-only commit `93506e92`; the finished local commit is rebased onto that current base before closeout.

## What changed

Only the four approved implementation/test files were changed, plus this required handoff:

- `src/pages/Customers.tsx`
  - Admin-only bulk assignment of selected active customers to active sales representatives.
  - Explicit confirmation count and target rep.
  - Fresh active-sales-rep validation immediately before mutation.
  - `.select('id')`, `checkMutationResult()`, and exact changed-row-count enforcement, so zero/partial-row results cannot report success.
  - Truthful post-mutation handling: a failed refetch shows the confirmed assignment locally, clears the completed selection, and reports that reload is required without a success toast.
  - Missing rep, phone, email, and crop labels, plus a combined profile-needs filter and core-profile-ready state.
- `src/pages/Customers.filters.test.tsx`
  - Coverage for profile-needs labels/filter combinations, admin/rep permissions, active-rep options, confirmation, cancel, success, error, zero/partial rows, rep deactivation, and failed post-mutation refetch.
- `src/pages/CallLists.tsx`
  - Kept all five existing RPC-backed lists and role restrictions.
  - Added list-specific "Why now" facts with safe unavailable-data wording.
  - Added a horizontally reachable, touch-sized mobile tab selector with arrow/Home/End keyboard behavior.
  - Added canonical validated URL state for list, applied criteria, rep, tier, crop, and search; refresh and browser Back/Forward restore the view.
  - Preserved synchronous row clearing, stale-response invalidation, admin-only rep filtering, and safe lookup fallbacks.
  - Prevented false-clear UI while tier/crop enrichment is pending.
  - Bounded day lookbacks to 3,650 days so accepted input cannot overflow the RPC's PostgreSQL timestamp arithmetic.
- `src/pages/CallLists.test.tsx`
  - New coverage for all five reasons, fallbacks, role-invalid URLs, complete URL restoration/canonicalization, browser history, stale RPC races, draft/applied criteria, enrichment loading, failure retries, touch and keyboard semantics, and the 3,650-day boundary.

No fifth source file was needed; the existing modal, auth, database, crop, and UI primitives were sufficient.

## Test-first and architecture evidence

- Autopilot was armed for the authorized 12-hour run.
- Work started in a clean isolated worktree from then-current `origin/main`.
- Graphify was refreshed first: 8,914 nodes and 18,408 edges. Its `explain`, `affected`, `query`, and `path` views narrowed the Customers/Call Lists surface before source verification.
- Initial feature tests failed as intended: **20 failed / 7 passed**.
- Initial implementation reached **27/27 focused tests green**.
- Review-mutation tests then reproduced all five Sol findings: **5 failed / 27 passed** before the fixes.
- Final focused proof: **2 files / 32 tests passed**.

## Verification

| Gate | Result |
| --- | --- |
| TypeScript | Pass — `npm run typecheck` |
| Lint | Pass — `npm run lint` |
| Production build | Pass — `npm run build` (4,253 modules transformed) |
| Full Vitest suite | Pass — 324 files, 4,330 passed, 123 skipped, 0 failed |
| Agent workflow guards | Pass — `npm run test:agent-workflows` |
| Documentation drift | Pass — `npm run check:docs` |
| Whitespace/conflicts | Pass — `git diff --check` |

The expected `ErrorBoundary.test.tsx` throw traces and jsdom canvas-not-implemented notices appeared during the green full suite; they are intentional test output, not failures.

## Browser proof

Browser verification used localhost-only mocked Supabase REST/RPC responses and a dummy local key. It made **no production connection or write**. The temporary `.env.local`, local Vite server, and Playwright sessions were removed/stopped afterward.

- Customers desktop list: `output/playwright/customer-360-customers-desktop.png`
- Customers desktop assignment confirmation: `output/playwright/customer-360-assign-confirmation.png`
- Customers phone assignment confirmation (390×844): `output/playwright/customer-360-assign-confirmation-phone.png`
- Call Lists desktop: `output/playwright/customer-360-call-lists-desktop.png`
- Call Lists phone: `output/playwright/customer-360-call-lists-phone.png`

Observed behavior included a successful mocked assignment PATCH returning the selected customer id, a follow-up customer GET, URL canonicalization, invalid/forbidden fallback, and browser Back restoration. All mocked REST/RPC requests returned 200. Console errors were limited to expected retries against the intentionally absent local Supabase Realtime WebSocket at `127.0.0.1:54321`; no application exception was observed.

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

## Explicit boundaries

- No push, PR, merge, deployment, migration, edge-function change, Supabase write, or other production mutation occurred.
- No secrets were read, changed, or committed.
- Browser screenshots and route fixtures under `output/` are ignored local evidence, not release artifacts.
- Production behavior is not claimed verified because deployment was intentionally outside this run.

## Parked recommendation — next slice only

Build the Customer Overview interaction slice next: add an explicit **Edit** action, surface license status and restricted-use-product warnings, then redesign **Call Prep / Log Interaction** as one coherent rep workflow. This recommendation is parked; none of it was implemented here.

## Morning next action

Review this local branch and screenshots. If Mason wants it shipped, start a fresh publish run from this branch through the normal reviewed PR, CodeRabbit, green Vercel, merge, and production-verification path.
