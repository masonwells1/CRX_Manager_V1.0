# Claude Code Setup Optimization Plan — CRX Manager

**Date:** 2026-06-15
**Owner:** Mason (beginner; explain in plain English)
**Status:** COMPLETE & LIVE — committed `33c1753`, fast-forwarded + pushed to `main` (`86355bb`→`33c1753`) with Mason's approval; Vercel auto-redeploys (unchanged app — config/docs only). Phases 0, 1, 2 (most), and the CLAUDE.md parts of Phase 3 are applied and verified; items that need Mason or carry tooling-breakage risk are deferred. See **Execution status** below.

## Execution status (2026-06-15)

**Applied & verified (in the worktree, uncommitted):**
- **P0** — Removed the ~85-line Karpathy/"NEVER STOP" appendix from `CLAUDE.md` (preserved in [`docs/reference/coding-guidelines.md`](../reference/coding-guidelines.md)); resolved the NEVER-STOP-vs-Hard-Red-Lines contradiction.
- **P1** — `/ship` now has **Step 0.5** (plain-English plan you approve before code, for substantial changes) and **Step 2.5** ("prove it actually runs" — UI/RPC/data-read behavioral verification); the auto-fix loop has a **hard 3-round cap + convergence check**.
- **P2** — `CLAUDE.md` de-duplicated against the hooks/ESLint (enforced rules → one-line pointers); auto-trigger tables compressed; stale `superpowers:brainstorming` / `feature-dev` / `posthog` rows dropped; **migration-apply guard content-hash-bound** (`migration-apply-guard.mjs` + `/ship` Step 5.1 + `/migration-review`) so a migration edited after review is blocked — **tested across 5 cases** (allow/deny/backward-compat).
- **P3 (CLAUDE.md parts)** — added "How to size the work": model-per-task guidance, session hygiene (`/clear` vs `/compact`), and "done = ran and proven."
- Also fixed a pre-existing doc drift (migration count 455 → 458).
- **Verification:** `npm run test:agent-workflows` PASS · `node scripts/check-doc-drift.mjs` PASS · guard unit-tested · no `src/` touched (app build/lint/tests unaffected).

**Deferred — need Mason or carry breakage risk (do NOT silently skip; these are real follow-ups):**
- **2.3 Prune plugins/MCP + run `/doctor`** — `/doctor` is interactive (can't run headless) and the irrelevant plugins (legal/marketing/finance/etc.) are enabled at the **user/marketplace level**, not this repo's `settings.json` (which only enables `vercel`). Mason action required.
- **2.4 full command consolidation + Phase-3 reminder-hook merge** — the reminder hooks (`codex-gauntlet-reminder`, `agent-pair-review-reminder`, `codex-to-claude-handoff-reminder`) are wired into `settings.json` AND covered by `test:agent-workflows`; deleting/renaming would break tested tooling. Did the safe part (compressed the CLAUDE.md routing table); the rename/merge is a deliberate follow-up.
- **Permission deny-rules** — redundant with the existing `env-guard`/`bash-safety` hooks; low value, deferred.
- **Reviewer `memory: project`** — unverified that this frontmatter field is supported by the installed Claude Code version; reviewer tools are already scoped read-only. Deferred pending verification.
- **Money-MCP trust note · split large reference docs · memory pruning ritual · doc-drift alarm-vocabulary calibration** — P3 polish, deferred.
**Basis:** Two independent investigations that reached the same conclusion —
1. A bug-history dig (what actually breaks when Claude works on CRX), and
2. A best-practice audit (10 areas of Anthropic's documented Claude Code guidance vs. what CRX does), with the load-bearing claims adversarially verified against the real sources.

---

## TL;DR (read this if nothing else)

**The diagnosis:** Your guardrails *check the recipe but never taste the dish.* They read the code and the migration text and ask "is this shaped right?" — but **nothing actually runs the code against the real database to confirm it does the right thing.** That's why your #1 bug is "it just doesn't work right": a function can reference a column that doesn't exist and *every gate still passes.* Meanwhile your CLAUDE.md and skill/plugin surface have grown so large that they dilute the rules that matter (Anthropic's documented "bloated CLAUDE.md → Claude ignores instructions" effect, which your own file quotes).

**The fix is mostly subtraction + switching on tools you already built.** You don't need more rules. You need: (a) turn on the "run it for real" verification you already have, (b) cut ~1,500 tokens of generic boilerplate that loads every turn, and (c) stop running the heavy 15×-cost review pipeline on tiny changes.

**The plan, in four phases:**
- **Phase 0 — Free wins** (minutes, zero risk): delete the generic boilerplate block; fix one self-contradiction.
- **Phase 1 — Kill the #1 bug**: turn on the live-DB verification gate; add a plain-English plan-you-approve step; cap the auto-fix loop.
- **Phase 2 — Right-size the machine**: only run the heavy pipeline on risky changes; de-duplicate CLAUDE.md vs. the hooks; prune the irrelevant skill/plugin/MCP surface; consolidate the 17+ overlapping review commands.
- **Phase 3 — Polish** (later): reviewer memory, session-hygiene note, hook consolidation, model guidance, etc.

**What we are NOT touching:** your genuinely excellent deterministic layer — the 8 PreToolUse safety hooks, the migration-apply guard, the schema-registry/caller-graph just-in-time pattern, the Codex independent review, and the human gates on push/deploy/migrate. That fortress stays. We're adding the one wall it's missing and clearing the clutter around it.

---

## How we got here (the evidence)

- **The treadmill, measured:** in a recent 3-week stretch, of ~121 commits only ~2 were forward product progress — the rest were remediating bugs Claude introduced (≈94% remediation among substantive commits). That *is* the "everything has bugs" feeling. Source: `docs/audits/2026-06-10-error-prevention-review.md`.
- **The root cause, named in your own docs:** *"no deterministic gate ever looks at the LIVE database."* All the write-time hooks validate migration **text** and code **shape**; none execute the code. One tool that *does* (`plpgsql_check`), when finally run by hand, found **30 errors across 11 functions in a single sweep.**
- **Mason's reported bug mix:** mostly **#1 "it just doesn't work right"** (does the wrong thing / errors / wrong number), some **#2 regressions**, a little **#3 "looks done but isn't."**
- **The mapping:** #1 = behavioral bugs (latent SQL breaks, wrong-column reads, swallowed errors, money errors). Your scaffolding is strongest on the *rare catastrophic* classes (data loss, RLS holes, money-as-float) and weakest on the *common behavioral* class — you built a fortress against the rare disaster and left the front door open to the common nuisance.

### The mental model: two kinds of scaffolding
- **Hard scaffolding** = code that runs and *blocks* bad output (hooks, tests, type-checker, typed DB client, CI, review subagents). More of this = fewer bugs. **Keep and grow.**
- **Soft scaffolding** = prose rules in CLAUDE.md that *hope* Claude reads and obeys (dozens of "NEVER do X" lines). Past a point, more of this = *more* bugs, because it dilutes attention (verified Anthropic guidance). **Trim, and convert to hard where it matters.**

The whole plan is: **grow the hard layer where your #1 bug lives; shrink the soft layer that's quietly backfiring.**

---

## The Plan

> Effort = trivial / small / medium. Risk = how reversible/safe. Each item is applied only with Mason's OK and shown in plain English first.

### Phase 0 — Free wins (do first; minutes; zero risk)

**0.1 — Cut the Karpathy + "NEVER STOP" appendix from CLAUDE.md** *(P0, trivial)*
- *What:* Delete the ~85-line block at the end of CLAUDE.md (the verbatim "Karpathy CLAUDE.md" + "NEVER STOP" text). Optionally move it to your personal `~/.claude/CLAUDE.md` if you want to keep it around for yourself.
- *Why (plain English):* It's ~1,500 tokens of **generic, non-CRX** advice that loads on **every single turn**, sitting in the highest-attention spot in the file, where it crowds out *your* actual rules. It's the single clearest case of the exact bloat Anthropic warns makes Claude follow real instructions *less*.
- *Anthropic basis:* memory/CLAUDE.md docs — "bloated CLAUDE.md causes Claude to ignore your actual instructions" (verbatim-confirmed); instructions near the end of the file get the best recall.

**0.2 — Resolve the "NEVER STOP" contradiction** *(P0, trivial)*
- *What:* Keep exactly one momentum rule — "drive tasks to completion; never push/deploy/migrate/delete/commit-unrelated without Mason's OK" — and delete the verbatim "work indefinitely / don't pause" text that fights it.
- *Why:* Right now the file says "never stop" *and* "stop for these production actions." Contradictory instructions force Claude to pick arbitrarily and waste effort reconciling them. The Hard Red Line already says everything needed.

---

### Phase 1 — Kill the #1 bug ("it just doesn't work right")

**1.1 — Turn on the live-DB verification gate (the big one)** *(P0/P1, small–medium)*
- *What:* Wire the tools you **already built but run by hand** — `scripts/smoke/` (runs functions against the real DB inside a safe, rolled-back transaction), `plpgsql_check` (finds bad columns/casts/CHECK violations), and `scripts/db-invariant-sweeps/` (money + security invariants on live data) — into `/ship` as a **non-skippable step before anything is called "done."** For UI changes, the equivalent is: open the app, click the actual flow, screenshot it.
- *Why (plain English):* This is the missing wall. It's the only check that *runs* the code instead of just reading it — so it catches "wrong column," "wrong number," "button errors," and most regressions, which is exactly your #1 and #2. The cure is already written; it's just switched off.
- *Anthropic basis:* "Verification-Driven Development is the #1 lever — give the agent a check it can run so it closes the loop itself" (Claude Code best practices). Your own review named the absence of a live-DB gate (RC1) as the root cause.
- *Riskiest assumption (we validate this first):* that it can run fast/safe enough to fire every time. We prove it on the first change before committing to it everywhere.

**1.2 — Plain-English plan you approve, before I code** *(P1, small)*
- *What:* For real changes (multiple files, or anything touching SQL / money / RLS / a lifecycle), `/ship` starts by reading the live schema and writing a short plan in plain English — "here's what I'll build, here are the 2–4 files I'll touch, here's what I'm assuming" — and you eyeball it before any code is written. One-line tweaks skip this.
- *Why:* Half of "it does the wrong thing" is **I misunderstood what you wanted** — I built the wrong thing correctly. You can't read code to catch that, but you *can* read English. Catching it at the plan stage is where you, as a non-coder, have the most power. Right now `/ship` jumps straight from job → branch → coding.
- *Anthropic basis:* Explore-Plan-Code-Commit — the documented antidote to multi-file changes that "solve the wrong problem," which is the exact migration-drift class CRX has been burned by.

**1.3 — Put a stop-condition on the auto-fix loop** *(P1, small)*
- *What:* Add a hard max-rounds cap (e.g. 3) and a "same findings two passes in a row → stop and hand to Mason" check to `/ship`'s review→fix loop.
- *Why:* Prevents Claude from thrashing in circles (and burning tokens) on a finding it can't resolve, and prevents a "fix" that just re-introduces a different bug.
- *Anthropic basis:* unattended/iterative loops need an explicit abort condition (verified).

---

### Phase 2 — Right-size the machine (cut waste, sharpen signal)

**2.1 — Only run the heavy pipeline on risky changes** *(P0, small)*
- *What:* Codify a complexity rule in `/ship`: trivial single-file change with no SQL/money/RLS → just lint + build + test (no multi-agent fan-out); touches SQL / money / RLS / lifecycle, or multiple files → full reviewer fan-out + Codex on the migration/money subset.
- *Why:* The multi-agent swarm costs ~15× the tokens of a normal change. That's worth it for risky work and pure waste on a one-line tweak. The current "route EVERYTHING through /ship" mandate applies the expensive path to changes that don't need it.
- *Anthropic basis:* "most coding is single-agent work"; multi-agent (~15× tokens) is justified only for high-value, breadth-first, parallelizable tasks (verified).

**2.2 — De-duplicate CLAUDE.md against the hooks/ESLint** *(P1, small)*
- *What:* For every rule already enforced automatically (idempotency column names, money-as-cents/`parseFloat`, generated-column writes, `confirm()`/`alert()`, `@sentry/react` import, RLS-on-new-tables), replace the prose paragraph with a single one-line pointer to `docs/reference/agent-guardrails.md`.
- *Why:* The hook *is* the real boundary — it blocks the bad write regardless of whether Claude read the rule. Keeping the prose too is advisory noise that dilutes the rules that *aren't* enforced. Anthropic explicitly says don't double-encode what a linter/hook enforces.

**2.3 — Prune the skill / plugin / MCP surface to CRX-relevant** *(P0, medium)*
- *What:* Run `/doctor`. Disable or collapse the large inherited plugin catalogs that have nothing to do with CRX (small-business, legal, marketing, finance, operations, brand-voice, PDF, calendar, computer-use, etc.) via `skillOverrides` or by not loading those plugins. Keep Supabase / GitHub / Vercel / Sentry.
- *Why:* Hundreds of irrelevant skill descriptions compete for the limited "skill listing" budget and bias Claude's auto-delegation *away* from your real CRX skills — and each connected server is extra trust surface on a live-money app.
- *Anthropic basis:* tool/skill surface consumes context and degrades recall; keep the surface lean.

**2.4 — Consolidate the 17+ overlapping review/audit commands** *(P1, medium)*
- *What:* Collapse the review/handoff/audit family (`/ship`, `/preflight`, `/quick-fix`, `/codex-gauntlet`, `/codex-review`, `/codex-cross-review`, `/codex-to-claude-handoff`, `/claude-review`, `/agent-pair-review`, `/migration-review`, `/review-workflow`, `/foundation-ultra-review`, `/architecture-weakness-audit`, `/map-drift-audit`, `/audit`, `/deploy-check`, `/whole-codebase-audit`, `/spot-check-prod`) into a small named set with crisp boundaries — e.g. `/ship` (do + gate), `/preflight` (pre-commit), one `/codex` (independent review), one `/foundation-audit` (deep read-only health). Alias/demote the rest.
- *Why:* The distinctions are real but subtle and hidden in comments, not names. For a solo beginner that's paradox-of-choice with no upside — you shouldn't have to remember which of 17 commands to reach for.

**2.5 — Tighten the migration-apply guard** *(P1, small)*
- *What:* Bind the apply-guard "proof file" to the migration's **content hash**, not just "a proof exists and is < 30 min old," and have it expire if the migration text changes after review.
- *Why:* Closes a reuse hole on your most dangerous operation (applying a live migration) — so a stale or unrelated proof can't wave through an edited migration.

---

### Phase 3 — Polish (later; P2/P3)

- **Reviewer memory + tool locks:** add `memory: project` and explicit read-only `tools:` allowlists to the 5 review subagents so they accumulate CRX patterns across sessions and can never mutate state.
- **Session-hygiene note for Mason:** 3 bullets — `/clear` when switching tasks, `/compact` when one task's session gets long, let subagents do the heavy reading. (Anthropic's #1 listed common mistake is "kitchen-sink sessions.")
- **Consolidate the 4 UserPromptSubmit reminder hooks** (codex-gauntlet ~191 regex patterns, agent-pair-review, codex-to-claude-handoff, dangerous-phrase) into one or two; they overlap and run on every prompt.
- **Money-MCP trust note** (Stripe/PayPal/Square): one written line confirming read-only intent and that no autonomous flow can move money. Optionally promote the truly catastrophic rules (deny writes to `.env*`, deny force-push/`DROP` Bash patterns) to permission **deny** rules so they're harness-enforced, not just hook+prose.
- **Model guidance** (3 lines in CLAUDE.md): Opus + high effort for migration/RLS/money/architecture; a faster model is fine for known-pattern pages/fixes; switching needs `/clear`.
- **Split the big reference docs** (`rpc-functions.md`, `migration-history.md` ~234KB) by subsystem so just-in-time reads pull a narrower slice.
- **Memory pruning ritual** (the `consolidate-memory` skill): archive resolved "NOT pushed / shelved / pending" entries so the knowledge base doesn't become a journal.
- **Calibrate alarm vocabulary:** the doc-drift checker frames a cosmetic count mismatch as a near-incident; reserve dramatic language for genuinely dangerous states so a beginner can tell a real BLOCKER from noise.

---

## What we are deliberately NOT changing (your fortress stays)

These are genuinely excellent and above most setups — leave them alone:
- The **8 PreToolUse safety hooks** (idempotency columns, `updated_at`/generated-column writes, status-enum supersets, `.env`/`service_role` leaks, RLS-on-new-tables, `parseFloat` on `*_cents`).
- The **migration-apply guard** + the **5 parallel review subagents** (RLS, migration-drift, types-drift, pdf-output, compliance).
- The **schema-registry.json + caller-graph.json** just-in-time pattern — a textbook example of Anthropic's "lightweight identifiers, load detail on demand" guidance.
- The **Codex independent cross-review** on high-stakes changes — the only genuinely independent reviewer; exactly the right place to spend tokens.
- The **human gates** on push / deploy / migrate / delete.

---

## Appendix A — Per-area research (Anthropic says → CRX does → gap)

1. **Best-practice workflows** — Anthropic: Explore-Plan-Code-Commit for non-trivial work; Verification-Driven Development is the #1 lever; skip planning for trivial fixes. CRX: `/ship` bakes verification in (strong) but jumps straight to implement (no plan step) and mandates the heavy path for *everything*. → Add a plan step + a trivial carve-out (1.2, 2.1).
2. **CLAUDE.md / Memory / Docs** — Anthropic: target ~200 lines; cut anything a hook already enforces; bloat → ignored instructions. CRX: 444 lines / ~8,200 tokens (already trimmed 74% — right direction) but still ~2.2× target, with ~1,500 tokens of generic boilerplate at the high-recall end. → Phase 0 + 2.2.
3. **Hooks** — Anthropic: use deterministic hooks for what MUST happen; CLAUDE.md is advisory. CRX: 20 hooks across 6 events; the 8 PreToolUse safety hooks are excellent. → Keep; only consolidate the 4 redundant reminder hooks (Phase 3).
4. **Subagents** — Anthropic: context isolation, tool restriction, `memory: project` for reviewers, sharp "use proactively" descriptions. CRX: 5 well-scoped read-only reviewers. → Add reviewer memory + explicit tool locks (Phase 3). (Note: "subagents for verification" is *not* Anthropic doctrine — it's a fine vehicle, don't over-claim it.)
5. **Slash commands / Skills** — Anthropic: skills load on demand; keep SKILL.md < 500 lines; pre-approve safe tools; run `/doctor` if you have 40+. CRX: 18 skills + 15 commands + 5 agents + a huge inherited plugin catalog; review family overlaps heavily. → 2.3, 2.4.
6. **MCP** — Anthropic: Tool Search defers definitions so server *count* is cheap, but trust each server (prompt-injection), especially money servers. CRX: many irrelevant servers connected. → 2.3 + money-MCP trust note.
7. **Headless / Loops / Automation** — Anthropic: `--bare` + scoped `--allowedTools` + `--max-turns`/budget caps; avoid `--dangerously-skip-permissions` ("unsafe in most situations," verified); scheduled cloud routines start with zero MCP. CRX: no standing automation (interactive with human gates — fine); workflows use harness-only globals (can't run in CI). → Decide explicitly yes/no on automation; if no, stop maintaining loop affordances.
8. **Settings / Permissions / Models** — Anthropic: permission rules are the real enforced boundary; match model to task; sandbox cuts prompts ~84%. CRX: hooks in project settings (correct), Bash allowlist in local settings (correct), no model guidance, no OS sandbox (Windows-limited). → Phase 3 (model note; optional deny rules; sandbox is P3/when-supported).
9. **Context engineering** — Anthropic: smallest set of high-signal tokens; context rot is real (verified); just-in-time loading; `/clear`/`/compact` discipline. CRX: registry/graph pattern is exemplary; every-turn fixed cost is too high (CLAUDE.md + skill listings). → Phase 0 + 2.2 + 2.3 are the win; add session-hygiene note.
10. **Multi-agent orchestration** — Anthropic: ~15× token cost (verified); justified only for breadth-first parallelizable work; most coding is single-agent; adversarial review in fresh context is good but flag only correctness/requirement gaps. CRX: audit fan-outs are a correct fit; Codex is the real independent gate; but the blanket `/ship` mandate over-applies the swarm. → 2.1.

---

## Appendix B — Bug taxonomy & coverage (what actually breaks, what catches it)

Ranked most frequent/damaging first. **Bold = still caught only by prose / a manual script / nothing → where Mason still catches things by hand.**

1. **Actor-forgery / ungated SECURITY DEFINER mutators** — recurred on 6 separate dates. *Caught by:* Codex review + the **manual** `db-invariant-sweeps` runner. **Gap: no standing automated gate** → fold into 1.1.
2. **Idempotency defects** (declared-but-ignored / unscoped lookup / TOCTOU placement) — mostly caught by a hook + contract tests; **TOCTOU ordering is not statically caught** → 1.1 (concurrent smoke).
3. Type errors that ship — **FIXED** (typecheck now in pre-commit + CI).
4. **Untyped DB access / column drift** (`.select('*')` + casts) — typed client exists but partial; **`no-select-star` lint rule was never built** → 1.1 + finish typed-client adoption / build the rule.
5. Unchecked Supabase returned errors — **FIXED** for the static shapes (`handle-supabase-error` ESLint rule).
6. **Latent runtime SQL breaks** (wrong column / bad cast / CHECK) — `plpgsql_check` + smoke runner exist but **run manually, not gated** → 1.1. *This is the core of Mason's #1 bug.*
7. Migration drift (CHECK/overload/`updated_at`/generated col) — **well covered** by hooks + drift reviewer.
8. **Fixes that introduce new bugs / one-axis-at-a-time** — ratchet is a non-blocking warning; real catcher is the probabilistic Codex loop → 1.3 + 2.1.
9. **Money / AR semantics** — `parseFloat` caught; AR identities are manual predicates, under-sampled (≈0 posted invoices live) → 1.1 + re-run after first billing cycle.
10. **Lifecycle consumers unaware of a new feature** — review-only, no deterministic catch.
11. **False "done" / unverified claims** — mostly prose + 2 weak hooks; the meta-class under 1/2/6 → 1.1 makes "done" mean "ran and proven."

**Net:** the mechanical/frontend classes that used to bleed (type errors, swallowed errors, migration drift) are now genuinely gated. The classes that **remain manual** are the **live-database** ones — actor-forgery, idempotency ordering, latent SQL breaks, AR identities — i.e. exactly the "no gate looks at the live DB" gap. **Phase 1.1 is the direct fix.**

---

## Appendix C — Over-engineering risks & contrarian takes (verbatim from the synthesis)

**Over-engineering risks (where CRX has TOO MUCH and should cut):**
- CLAUDE.md ~2.2× the 200-line target; ~19% generic Karpathy/NEVER-STOP boilerplate at the high-recall end. **Cut.**
- Hundreds of irrelevant inherited plugin/skills competing for the description budget. **Cut to CRX-relevant.**
- 17+ overlapping review/handoff/audit commands — paradox of choice. **Consolidate.**
- Blanket "route ALL work through the 15×-token /ship swarm." **Add a trivial carve-out.**
- 4 overlapping UserPromptSubmit regex reminder hooks on every prompt. **Consolidate.**
- Rules duplicated as both CLAUDE.md prose AND hooks/ESLint. **Replace prose with pointers.**
- memory/ trending toward a journal (stale "NOT pushed" entries). **Prune.**
- Hardcoded convention text in PreCompact/SessionStart hooks duplicating the registry. **Lean on the registry.**

**Contrarian takes:**
- The "NEVER STOP / work indefinitely" directive is *negative-value context* for a live-production app run by a beginner — don't caveat it (the file already does, twice), **delete it.**
- The real risk isn't too few guardrails — it's that the **advisory** layer has crossed into self-parody and now competes with the actual instructions. The **deterministic** layer is world-class; leave it. Highest-leverage work is **subtraction.**
- "Route everything through /ship" is expensive theater on trivial changes; reserve the swarm + Codex for SQL/money/RLS/lifecycle/multi-file.
- Don't chase OS sandboxing now (Windows-limited; you already have human gates + write-time hooks). Cut context bloat first.
- Same-model adversarial skeptics are good at dropping false positives but are **not** independent — Codex is. Spend tokens on the Codex gate, not on more in-family skeptic rounds.
- The doc-drift checker over-dramatizes a cosmetic mismatch — calibrate the alarm vocabulary so a beginner can tell a real BLOCKER from noise.

---

## Appendix D — Primary sources

Anthropic Claude Code documentation and engineering posts (the load-bearing claims — 15× multi-agent token cost, context rot, "bloated CLAUDE.md → ignored instructions," `--dangerously-skip-permissions` unsafe — were adversarially verified against these):
- Claude Code best practices for agentic coding — `anthropic.com/engineering/claude-code-best-practices`
- Memory & CLAUDE.md — `docs.anthropic.com/en/docs/claude-code/memory`
- Hooks — `docs.anthropic.com/en/docs/claude-code/hooks`
- Subagents — `docs.anthropic.com/en/docs/claude-code/sub-agents`
- Slash commands — `docs.anthropic.com/en/docs/claude-code/slash-commands`
- MCP — `docs.anthropic.com/en/docs/claude-code/mcp`
- Settings / permissions / model config — `docs.anthropic.com/en/docs/claude-code/settings`
- Effective context engineering for AI agents — `anthropic.com/engineering` (context-engineering post)
- How we built our multi-agent research system — `anthropic.com/engineering` (multi-agent research post)

CRX internal evidence: `docs/audits/2026-06-10-error-prevention-review.md`, `docs/audits/2026-06-14-field-mode-error-retrospective-and-prevention-spec.md`, `.claude/hooks/`, `.claude/agents/`, `eslint-local-rules/`, `.husky/pre-commit`, `.github/workflows/ci.yml`, `CLAUDE.md`.
