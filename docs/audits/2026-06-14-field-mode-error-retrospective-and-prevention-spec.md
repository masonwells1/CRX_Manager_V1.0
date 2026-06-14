# Field Mode — error retrospective + prevention spec (2026-06-14)

> **Status:** Analysis + actionable spec. Code-level controls **DEFERRED pending the parallel Codex-gauntlet framework** (owner decision 2026-06-14: coordinate, let the gauntlet land first, then layer these on). This doc is written but **uncommitted** — commit it on the right branch alongside the gauntlet work.
> **Scope:** the bugs found across the Field Mode (`/my-route`) review chain and the durable controls that would have prevented each. Companion findings docs (now in `main` via PR #80): `2026-06-14-codex-field-mode-findings-review-prompt.md`, `2026-06-14-codex-field-mode-remediation-rereview-prompt.md`.

## 1. What happened

Field Mode (a new additive `/my-route` driver workspace) went through **four independent review layers** before it was clean enough to ship:

1. **Internal 4-reviewer swarm** → CLEAN (0 blocker/high/med). *Missed everything below.*
2. **Live-DB red-team** → found a real wrong-column bug + a self-inflicted offline conflict.
3. **Codex** (independent model) → **STOP**: 3 BLOCKER + 2 HIGH + 1 MED — including a **shipped runtime crash** and **another self-inflicted offline blocker**.
4. **Codex re-review** of the remediation → SAFE TO PUSH WITH FOLLOW-UPS (2 small follow-ups, applied).

It shipped to production only after all confirmed findings were fixed and re-verified. **The point of this doc: the first two internal layers missed the worst bugs. We need deterministic, code-level controls so these classes can't recur — not just more review.**

## 2. Confirmed errors

| ID | Sev | Location | What | Root cause | Found by |
|---|---|---|---|---|---|
| F1 | BLOCKER | `FieldRoute.tsx` badge | Called `statusToBadgeVariant(stop.status)` — it's a `Record`, not a function → `TS2349` + **runtime crash** on the first stop card | The pre-commit gate runs `npm run build` (Vite/esbuild **transpiles**, no type-check), **never `npm run typecheck`** — so any pure type error ships | Codex |
| ADDR | HIGH | `FieldStop.tsx` address read | Read `customer_addresses.street` — column doesn't exist (it's `address_line`); street silently dropped | `.select('*')` returns untyped data + `as { street?... }` cast → the type checker can't see the wrong column name | red-team |
| F3 | BLOCKER | `FieldStop.tsx` offline | Offline complete snapshotted the **stale pre-Arrive `updated_at`** → `offlineSync` flagged the driver's own Arrive as a conflict and dropped the completion | A remediation commit (the offline conflict-guard added in the red-team round) **introduced** this; no test covered the scheduled→Arrive→offline→complete path | Codex (self-inflicted by a prior fix) |
| F4 | HIGH | `FieldStop.tsx` signature upload | Signature upload **returned-error** swallowed (only *thrown* errors toasted) → signature image silently lost after the RPC committed | Supabase Storage **returns** errors (doesn't throw); `if (!uploadError) {…}` with no `else` | Codex |
| F5 | HIGH | `FieldStop.tsx` offline | Offline completion replays only the RPC — receipt, notifications, signature image, photos never replayed; UI wording understated it | Incomplete offline implementation + misleading copy | Codex |
| F6 | MED | `FieldRoute.tsx` / `FieldStop.tsx` | Query failure rendered "No open stops" / "No items" instead of an error state | Query `error` not inspected → empty data masquerades as "nothing here" | Codex |
| F6-fu | LOW | `FieldStop.tsx` items | The F6 fix added a toast but still rendered the empty row → a *fix that was incomplete* | Remediation not fully verified | Codex re-review |

## 3. Bug classes + root causes

- **C1 — Type errors ship.** (F1) The gate type-*transpiles* but never type-*checks*. **The single highest-impact gap; it produced a production runtime crash.**
- **C2 — Untyped DB access hides schema mismatches.** (ADDR) `.select('*')` + `as` casts defeat TypeScript; a wrong column name becomes a silent runtime nothing.
- **C3 — Unchecked Supabase *returned* errors.** (F4, F6, F6-fu) Supabase returns `{ data, error }` rather than throwing; a destructured `error` that isn't handled = a silent failure or a wrong empty-state.
- **C4 — New/changed paths lack tests.** (F1, F2, F3, F6 — all would have been caught) The only Field Mode test was a hook-contract unit test; no test ever *rendered* the page or exercised the offline path.
- **C5 — Fixes introduce new bugs.** (F3, F6-fu) Two of the worst issues were *created by remediation commits* and shipped because the fix wasn't independently re-verified with a test that fails on the original bug.

## 4. Prevention controls (the spec)

Ordered by impact. Each is concrete and ready to implement once coordinated with the gauntlet work.

### P1 — Type-check in the gate *(prevents C1; highest value)*
- **`.husky/pre-commit`:** add a `npm run typecheck` step **before** the build step (typecheck is fast and gives the clearest error). Block the commit on failure, same shape as the lint/build steps.
- **`.claude/commands/ship.md`:** add `npm run typecheck` to the verify step (so `/ship`'s own loop catches it even if a commit is bypassed).
- **CI:** ensure the CI workflow runs `npm run typecheck` (not just build).
- Exact script already exists: `typecheck` = `tsc --noEmit -p tsconfig.app.json`. (Note: plain `npx tsc --noEmit` uses the root tsconfig and **does not** compile the app files — must use the `-p tsconfig.app.json` form.)
- **Worktree caveat (the reason F1 shipped despite a "branch hook"):** the *active* hook is the main checkout's via `core.hooksPath`; a worktree's own `.husky` is never invoked. Until the gate is fixed, run `npm run typecheck` manually before any worktree commit.

### P2 — Stop untyped DB access *(prevents C2)*
- **ESLint local rule `no-select-star`** in `eslint-local-rules/`: warn/error on string-literal `.select('*')` in `src/` (allow an inline `// eslint-disable-next-line` with justification for the rare legitimate case). Add RuleTester cases.
- **Adopt generated DB types:** run Supabase `generate_typescript_types` into a `src/types/supabase.ts` and type the client so `.select('address_line, city')` is checked against real columns — a wrong column name becomes a compile error. (Larger lift; sequence after P1.)
- Interim: a PreToolUse hook that validates column names in `.select('col, col')` strings against `.claude/schema-registry.json` for known tables.

### P3 — Supabase errors must be handled *(prevents C3)*
- **ESLint local rule `handle-supabase-error`:** flag when a `{ error }`/`{ error: x }` destructured from a `supabase.from(...).<op>()` or `supabase.storage.from(...).<op>()` await is never referenced. Pair with the existing `checkMutationResult` convention (extend guidance to selects + storage). Add RuleTester cases for the F4/F6 shapes (`if (!error) {…}` with no else, destructured-but-unused).

### P4 — Pages must render *(prevents C4; would have caught F1, F2, F3, F6)*
- **A render-smoke test** (`src/pages/__smoke__/pages-render.test.tsx` or similar): for each page lazy-imported in `App.tsx`, mount it inside a `MemoryRouter` with mocked `AuthContext` + a mocked `supabase` client (queries resolve `{ data: [], error: null }`), and assert it renders without throwing. This catches "calls a non-function", "reads a missing field", bad hooks, etc.
- **Require a test for offline / money / idempotency paths** touched by any change (the F3 path had none).

### P5 — Fixes must come with a failing-then-passing check *(prevents C5)*
- This already exists in spirit: `.claude/hooks/stop-wrap.mjs` has a "lessons-to-checks ratchet" warning when a HIGH+ finding is closed without a sibling executable check. **Make it teeth, not just a warning, for confirmed BLOCKER/HIGH remediations**, and have the Codex-gauntlet loop enforce "every confirmed finding → a durable check" (which is exactly the gauntlet's stated purpose — coordinate here).

## 5. Process lessons (write into CLAUDE.md when coordinating)
- **`build` ≠ `typecheck`.** A green build proves nothing about types. The gate must run both.
- **A fix is not done until a test fails on the old bug and passes on the new code.** Two of the worst findings here were self-inflicted by remediation.
- **An internal review by the same model that wrote the code is weakest at finding its own blind spots** — the independent model (Codex) caught what three internal passes missed. Keep the independent layer.
- **`select('*')` + `as` casts are a schema-mismatch trap.** Prefer explicit columns + generated types.

## 6. Rollout (deferred — coordinate with the gauntlet)
1. **P1 typecheck gate** — do first; smallest change, kills the worst class.
2. **P3 supabase-error rule** + **P4 page-render smoke test** — high coverage per effort.
3. **P2 no-select-star** + generated DB types.
4. **P5** ratchet teeth (likely folded into the gauntlet).

Config files that overlap the parallel Codex-gauntlet work (reconcile, don't clobber): `.husky/pre-commit`, `.claude/commands/ship.md`, `.claude/settings.json`, `.claude/hooks/stop-wrap.mjs`, `CLAUDE.md`. The new files (ESLint rules, render tests, this doc) are collision-free.
