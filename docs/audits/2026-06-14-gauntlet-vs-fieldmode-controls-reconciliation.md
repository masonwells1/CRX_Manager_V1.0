# Reconciled prevention plan — Codex Review Gauntlet × Field Mode controls (2026-06-14)

> **Companion to:** `2026-06-14-field-mode-error-retrospective-and-prevention-spec.md` (the retrospective + spec, "the report").
> **Status:** Analysis + decided plan. The two config edits I own (P1 husky, P5 ratchet) are **proposed with exact diffs below — not yet applied**, pending Mason's OK (they're in the "reconcile, don't clobber" shared-config set). New-file controls (ESLint rules, render test) are handed to focused build jobs.
> **Live evidence:** `npm run typecheck` is **green (exit 0)** on the current tree — F1 is already remediated (in `main` via PR #80), and the P1 gate is safe to add (it will not block existing commits).

## 0. The one idea this reconciliation turns on

The gauntlet and the report's controls are **two different layers, not competitors:**

- **Codex Review Gauntlet = the REVIEW layer.** An independent model (Codex/gpt-5.5) reads each *Codex-worthy* change and catches **semantic** problems — actor-forgery, money/cents, idempotency scoping, migration drift, lifecycle violations. It is on-demand, probabilistic (depends on the review running *and* the reviewer noticing), and **scoped to DB/security/money/edge** by both its routing trigger and its review prompt.
- **The report's controls = the DETERMINISTIC FLOOR.** typecheck / ESLint rules / render-smoke tests **prevent a class mechanically, on every commit, for free, whether or not anyone reviews.** They catch **mechanical** problems — a type error, a `.select('*')` column typo, a swallowed `{error}`, a page that throws on mount.

**Field Mode is the proof of why you need both.** It went through *four* review layers (internal swarm, red-team, Codex, Codex re-review) — yet the worst bug (F1, a production runtime crash) was a pure **type error**. Review caught it eventually, but only because Codex happened to read the line. The deterministic floor (a typecheck gate) would have caught it **before the first commit, every time, with no reviewer in the loop.** The lesson is not "review harder" — it's "put the cheap mechanical gates *under* the review layer so review can spend its attention on the semantic classes it's actually good at."

## 1. The question the task posed: would the gauntlet have stopped F1 (the type error)?

**No — and this is the crux.** Two independent reasons:

1. **Routing would have skipped Codex entirely.** `/ship` Step 6 ([ship.md:88](../../.claude/commands/ship.md)) only invokes the Codex gate for a change that "touches a migration, RLS/RPC security, a money path, or an Edge Function." Field Mode is an **additive frontend page** — not Codex-worthy by that rule. The gauntlet's own routing would not have fired Codex for it.
2. **Even if fired, the prompt isn't looking for type errors.** The `codex-review` prompt ([codex-review/SKILL.md:68-75](../../.claude/skills/codex-review/SKILL.md)) is laser-focused on the 5 DB/security/money/lifecycle classes. A frontend `TS2349` (calling a `Record` as a function) is exactly the blind spot — and indeed the **internal 4-reviewer swarm missed it too**.

So relying on "the gauntlet will catch type errors" is the trap. **C1 demands the deterministic gate. The report is right.** This is the clearest example in the set where a hard gate beats review.

## 2. Coverage map — gauntlet vs C1–C5

| Class | Gauntlet status | Evidence | Verdict |
|---|---|---|---|
| **C1** Type errors ship | **PARTIALLY (and weak)** | `/ship` Step 2 verify *already* runs `npm run typecheck` ([ship.md:27-32](../../.claude/commands/ship.md), uncommitted edit) — so a change *driven through `/ship`* is caught pre-commit. BUT the deterministic backstop `.husky/pre-commit` runs lint→**build (vite = transpile, no types)**→vitest and **never typecheck** ([pre-commit:36-44](../../.husky/pre-commit)). A manual commit, or `/ship` Step 7's reliance on husky re-running, misses it. Codex layer is frontend-blind + Field Mode wouldn't trigger it. | **Add the hard gate.** Highest value, smallest change. |
| **C2** Untyped DB access (`.select('*')`+`as`) | **NOT COVERED** | The red-team (not the gauntlet) caught ADDR. The codex prompt covers DB *drift/security*, not "you read a column that doesn't exist." `as` casts defeat typecheck. No ESLint rule. | **New ESLint rule + generated types.** |
| **C3** Unchecked Supabase *returned* errors | **PARTIALLY** | Existing `require-assert-rpc-result` ESLint rule + `checkMutationResult` convention cover **RPCs and `.update()/.delete()`** — but NOT storage uploads (F4) or `.select()` with `if(!error){}`-no-else (F6). | **Extend the convention** to storage + selects via a new/extended rule. |
| **C4** New/changed paths lack tests | **NOT COVERED** | The gauntlet *reviews* code; it never mandates a render test. `/new-page` scaffolds a page, not a test. No render-smoke harness exists. Would have caught F1/ADDR/F3/F6. | **New render-smoke test harness.** |
| **C5** Fixes introduce new bugs | **PARTIALLY — this is the gauntlet's lane** | The gauntlet's **re-review loop** ([codex-review/SKILL.md:92-93](../../.claude/skills/codex-review/SKILL.md): "Re-run `/codex-review` after fixes until SHIP") is *how Codex caught F3/F6-fu — both self-inflicted by remediation commits.* The structure works. `stop-wrap.mjs` has a C10 ratchet ([stop-wrap.mjs:104-147](../../.claude/hooks/stop-wrap.mjs)) — but it's a **non-blocking warning**, scoped to `docs/audits/*` closures, not to the remediation commit. | **Keep the re-review loop; give the ratchet teeth** (require a failing-then-passing regression test for each confirmed BLOCKER/HIGH). Gauntlet owns this. |

## 3. Where review is enough vs where a hard gate is warranted

- **C1, C2, C4 → HARD GATE.** Mechanical, deterministic, cheap. Review is demonstrably unreliable here (F1 survived 3 internal passes; ADDR survived the swarm). Don't spend a model's attention on what `tsc` decides in 2 seconds.
- **C3 → HARD GATE (ESLint).** A swallowed `{error}` is a static pattern; a linter sees it 100% of the time, a reviewer sometimes.
- **C5 → HYBRID.** The *re-review* needs a smart independent reader (gauntlet's job, already working). The *durable artifact* — "the fix ships with a test that fails on the old bug" — is the deterministic half. Gauntlet enforces both.
- **The gauntlet's existing 5 classes (RLS/actor-forgery, money, idempotency, drift, lifecycle) → REVIEW.** These are semantic/contextual; they're exactly what an independent model is *for*. No change — the report doesn't touch these and shouldn't.

## 4. Reconciled controls, in order

1. **P1 — typecheck in `.husky/pre-commit`** *(prevents C1; mine; do first).* Add `npm run typecheck` before the build step, same block shape. `/ship` and CI parts: `/ship` already has it; confirm CI runs `npm run typecheck` (not just build). Safe now — typecheck is green.
2. **P3 — `handle-supabase-error` ESLint rule** + **P4 — render-smoke test** *(prevents C3, C4; handed to a build job).* Highest coverage per effort; P4 alone would have caught F1, ADDR, F3, F6.
3. **P2 — `no-select-star` ESLint rule** + generated Supabase types *(prevents C2; handed to a build job; larger lift).*
4. **P5 — ratchet teeth** *(prevents C5; mine; folded into the gauntlet).*

## 5. Ownership

**I own (gauntlet's lane + the shared-config files I was told to reconcile):**
- **P1 husky typecheck gate** — exact diff in §7. One-line-equivalent, highest value, safe now.
- **P5 ratchet teeth** — strengthen `stop-wrap.mjs` + the `codex-gauntlet` prevention-capture step so a confirmed BLOCKER/HIGH closure must carry a *failing-then-passing* regression test (not just any sibling check), and have the gauntlet loop state this explicitly. Diff sketch in §7.
- **This reconciliation doc** + the CLAUDE.md process lessons (§5 of the report) when the gauntlet work is committed.

**I hand back (focused build jobs — ideally each run through `/ship` itself, so they're dogfooded):**
- **P2** `no-select-star` + generated DB types — new ESLint rule (RuleTester cases) + a generated `src/types/supabase.ts` + typed client. Not gauntlet-specific; it's a typing project.
- **P3** `handle-supabase-error` — new ESLint rule with RuleTester cases for the F4/F6 shapes. Must reconcile with the existing `require-assert-rpc-result` rule (see §6).
- **P4** render-smoke harness — new `src/pages/__smoke__/pages-render.test.tsx` mounting every `App.tsx` lazy page with mocked router/auth/supabase. New test infra.

The gauntlet's role for the handed-back items: **route to them** — once they exist, `/ship` Step 2 and the pre-commit gate run them automatically; the gauntlet doesn't re-implement them.

## 6. Conflicts / duplications to avoid (reconcile, don't clobber)

1. **P1 ↔ `/ship`:** the report's P1 says "add typecheck to `ship.md` verify" — **already done** in the uncommitted `ship.md` edit ([Step 2](../../.claude/commands/ship.md)). Don't re-add. Only the **husky + CI** parts of P1 remain.
2. **P3 ↔ existing `require-assert-rpc-result`:** these overlap on the RPC case. Do **not** create a second rule that double-flags RPC calls — `handle-supabase-error` should cover the *gap* (storage `.upload`/`.remove`, `.select` reads) and defer to the existing rule for RPCs.
3. **P5 ↔ stop-wrap ratchet ↔ gauntlet prevention-capture:** three things claim C5 — the `stop-wrap.mjs` C10 ratchet, the gauntlet's "every finding → durable check" mandate ([CODEX_REVIEW_GAUNTLET.md "Prevention Actions"](../../docs/workflows/CODEX_REVIEW_GAUNTLET.md)), and the report's P5. **Consolidate into one mechanism** (gauntlet capture, enforced by a ratchet with teeth). Don't triplicate the rule in three docs with drifting wording.
4. **C2 interim hook ↔ existing schema-aware hooks:** the report's "interim PreToolUse hook validating `.select` columns against `.claude/schema-registry.json`" overlaps the existing `sql-safety`/schema-aware hook family. If built, **extend an existing hook**, don't add a parallel one. And generated Supabase types will make the `typescript-types-drift-reviewer` partly redundant — sequence so they don't fight.

## 7. Exact edits for the two items I own (proposed — apply on Mason's OK)

**P1 — `.husky/pre-commit`**, insert before the build block (line ~35):
```sh
echo "🔎 Running type-check (tsc --noEmit)..."
npm run typecheck 2>&1
TYPECHECK_EXIT=$?
if [ $TYPECHECK_EXIT -ne 0 ]; then
  echo ""
  echo "❌ TYPE-CHECK FAILED — commit blocked. (build = transpile only; this catches TS errors build misses.)"
  exit 1
fi
```
Plus: confirm the CI workflow runs `npm run typecheck`. (Worktree caveat from the report stands: a worktree's husky isn't invoked via `core.hooksPath` — the gate protects the main checkout; worktree sessions still rely on `/ship` Step 2, which already type-checks.)

**P5 — ratchet teeth:** in `codex-gauntlet.md` Step 6 + `CODEX_REVIEW_GAUNTLET.md` "Prevention Actions", make the executable check **mandatory and regression-shaped** for confirmed BLOCKER/HIGH: *"a test that fails on the pre-fix code and passes after — not merely a sibling check."* In `stop-wrap.mjs`, extend the C10 ratchet so a remediation commit (not just an `audit/*` doc) closing a BLOCKER/HIGH that lacks a new/changed `*.test.*` is listed. (Keep it a listed loose-end, consistent with the hook's existing block-by-listing semantics.)

## 8. Implementation log (2026-06-14)

| Control | Commit | Status |
|---|---|---|
| **P1** typecheck in `.husky/pre-commit` (+ `/ship` already had it) | `74ba12a` | ✅ done |
| **P5** prevention-capture requires a failing-then-passing regression test (gauntlet docs) | `74ba12a` | ✅ done (stop-wrap.mjs code-teeth deferred — file held parallel-session WIP) |
| **P4** render-smoke harness, 30 pages allowlisted | `97a8bdf` | ✅ partial (native @fullcalendar pages + detail-page fixtures = expansion backlog) |
| **P3** `handle-supabase-error` ESLint rule + 3 real swallowed-error bugs fixed | `b84e088` | ✅ done |
| **P2** generated DB types foundation | (this commit) | ✅ foundation only — see below |

### P2 — measured blast radius + adoption plan (the "larger lift", confirmed)

The real C2 fix is a **typed Supabase client** (`createClient<Database>`), which makes a wrong column name (the ADDR bug — `customer_addresses.street`, which does not exist) a **compile error**. I generated the live-schema types and committed them to `src/types/supabase.ts` (regenerate via the Supabase MCP `generate_typescript_types`, project `rhyzpcqhnizqbxphqdkr`).

I then flipped the client to `createClient<Database>` and **measured**: `npm run typecheck` surfaced **238 errors across 58 files**, almost all the same class — generated types correctly mark nullable columns `string | null`, while the codebase's hand-written interfaces assume non-null `string`. These are *real latent null-safety gaps* (a column treated as non-null that can be null), not false positives — but fixing 238 across 58 files is a focused multi-pass remediation, not a one-commit change. The client flip was **reverted**; the types file stays as the foundation.

**Why no `no-select-star` rule:** with generated types, `.select('*')` is type-safe (returns the full Row), and there are **101 legitimate uses across 50 files** — a rule would be 101 warnings of noise for little gain. The wrong-column protection comes from the typed client, not from banning `*`.

**Recommended adoption path (the C2 follow-up):** flip the client to `createClient<Database>`, then fix the 238 nullable-safety gaps **file-by-file** (each: confirm the column is genuinely nullable, then null-guard the use or correct the local interface), highest-traffic pages first (DeliveryDetail 21, OrderDetail 19, BlendTicketDetail 17, CustomerDetail 16, offlineSync 12). Keep `src/types/supabase.ts` fresh by regenerating after each migration. Until then, new code can import `Database['public']['Tables'][...]['Row']` for typed shapes voluntarily.
