# Foundation Audit Prompt — CRX Manager V1.0 (Application-Layer Health)

**For:** A fresh Claude Code session in this repo (full read tools + read-only Supabase MCP).
Also usable by Codex or any reviewer with repo + read-only live-DB access.
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0 (branch `main`).
**Supabase project ref:** `rhyzpcqhnizqbxphqdkr` (**read-only access only**).
**Output:** write the report to `docs/audits/<today>-foundation-audit-report.md` (use today's date, e.g. `2026-05-27-foundation-audit-report.md`).

**Your job:** Produce an honest, evidence-based health assessment of the **application layer** of this codebase — the React frontend, the data/logic layer that talks to Supabase, and cross-cutting consistency — and answer one question for Mason (a non-coder, sole owner of a *live* app with real customer + financial data):

> **Is this foundation solid enough to keep building on, does it need targeted refactoring, or do parts need to be rebuilt?**

This is a **diagnosis, not a treatment.** You produce a report. You change nothing.

---

## Absolute rules (do not violate)

1. **READ-ONLY. This is the #1 rule.**
   - **Allowed:** `Read`, `Grep`, `Glob`, `Agent` (read-only subagents), and read-only Supabase MCP calls (`list_tables`, `list_migrations`, `list_extensions`, `list_edge_functions`, `get_advisors`, `generate_typescript_types`). Read-only SQL only (`SELECT`).
   - **Forbidden:** editing or creating ANY file except the one report (and an optional map file); `apply_migration`; `deploy_edge_function`; any `INSERT`/`UPDATE`/`DELETE`/DDL; any `git` commit/push; any Bash that mutates state. If you are unsure whether an action writes, **don't do it.**
2. **Evidence or it doesn't count.** Every finding MUST cite `file:line` (or a DB object name). No vague claims, no "this could be improved" without showing the specific code. If you can't point to it, don't report it.
3. **Real problems over nitpicks.** The goal is to explain *why Mason keeps reworking the same things* and *whether the base is trustworthy* — not to list every style preference. Clearly separate "this causes breakage/rework" from "minor polish."
4. **Measure against the project's own stated intent.** This repo documents its rules (see *Read first*). Code that **drifts from the documented rules** is itself a finding — note the rule, the violation, and where.
5. **Quantify.** Prefer "23 components over 400 lines; the 5 largest are …" over "some components are large." Counts, not adjectives.
6. **Exclude `node_modules/` and `.claude/worktrees/` from ALL searches** — the worktree is a stale duplicate and will pollute results.

---

## Scope

**In scope (audit these deeply):**
- **Layer A — Frontend structure:** how the ~66 React pages and shared components are built and wired.
- **Layer B — Data + logic layer:** how the frontend talks to Supabase (RPC patterns, `db.ts` usage, type safety, error handling) and where business logic actually lives.
- **Layer C — Cross-cutting consistency:** the "built many different ways" problem — duplication, dead code, inconsistent conventions, doc drift.

**Out of scope (already hardened — do NOT re-audit; only mention if you trip over something genuinely new and severe):**
- Database security / RLS policies (security advisors already at 0 WARN; 50+ RLS fixes landed).
- Supabase performance advisors / index tuning.
- Unit/E2E test *coverage adequacy* (you may USE the tests as evidence of intended behavior, but don't grade coverage).

---

## Read first (to learn the *intended* patterns before judging the actual code)

1. `AGENTS.md`, then the workflow and reference files it routes for this audit — architecture, CRX Hard Rules, schema gotchas, canonical patterns, and code-drift prevention.
2. `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/workflows/UI_PATTERNS.md`.
3. `docs/reference/pages-routes.md`, `docs/reference/code-patterns.md`.
4. The entry points: `src/App.tsx`, `src/lib/db.ts`, `src/types/index.ts`, `src/contexts/AuthContext.tsx`, `src/lib/activityLogger.ts`, `src/lib/sentry.ts`.

---

## Method — three phases

### Phase 1 — Map (orient before judging)
Build a written inventory and save it to `docs/audits/<today>-foundation-map.md`:
- Every page in `src/pages/` and its route, lazy-load status, and rough size (line count).
- The shared building blocks: components in `src/components/`, hooks, and libs in `src/lib/`.
- The data-flow shape: how a typical page reads/writes data (page → `db.ts` → RPC/table). Pick 2–3 representative pages and trace them end to end.

Do NOT make judgments here — this map exists so the deep-dives don't waste context rediscovering the layout.

### Phase 2 — Parallel deep-dives (depth without skimming)
Dispatch **three read-only subagents in a single message** (use `feature-dev:code-explorer` or `general-purpose`), one per layer, each handed the map from Phase 1 and the matching rubric below. Each subagent:
- is **READ-ONLY** (same Absolute Rules apply);
- returns **only a findings list** — each finding as: `[severity][effort][risk] Title — file:line — what's wrong — why it matters — suggested direction`;
- must cite evidence and quantify.

(Running them in parallel gives each a clean, focused context window — this is what makes the audit deep instead of shallow.)

### Phase 3 — Synthesize
Merge the three findings lists + the map into the single report (format below). Resolve overlaps, rank everything, and answer the headline question decisively.

---

## Phase 2 rubrics

### Layer A — Frontend structure
- **God-components / file size:** list every file over ~400 lines; name the 5–10 worst and what each is trying to do. Are they doing one job or many?
- **Duplication:** find UI or logic blocks copy-pasted across 3+ pages that should be a shared component/hook. Show the duplicates.
- **Shared state:** enumerate the contexts and the patterns used to share/fetch state. Is it consistent, or a mix of context / prop-drilling / ad-hoc per-component fetching?
- **Lazy-load + routing consistency:** does every page follow the `lazy()` + `Suspense` + `Route` + nav-link pattern (CLAUDE.md rule #4)? Flag deviations.
- **Dead / half-built:** pages built but never routed, routed but broken, nav links pointing nowhere, components with zero importers.
- **Skeleton consistency:** do pages share one loading / error / empty-state / layout pattern, or does each reinvent it?

### Layer B — Data + logic layer
- **Guard coverage:** find `.update()` / `.delete()` / RPC calls missing `checkMutationResult()` / `assertRpcResult()` (CLAUDE.md rules #3, #11). The ESLint rule should catch these — verify reality and report any gaps or suppressions.
- **Business-logic location:** identify logic that exists in BOTH the frontend and a DB RPC (e.g., tier/price math, totals, status transitions) — single-source-of-truth violations.
- **Type safety / drift:** any `any` or `@ts-ignore` beyond the single sanctioned exception (`reportPdf.ts` columnStyles); any `src/types/index.ts` interface whose fields don't match the live DB columns.
- **Error handling:** consistent use of `RpcErrorCodes` + `hasRpcCode()` vs fragile `message.includes('TOKEN')` substring matching; any swallowed/silent `catch`; any error path that fails without telling the user.
- **Single Supabase client:** any client created outside `src/lib/db.ts` (CLAUDE.md rule #8).
- **Idempotency consistency:** which critical writes use `useIdempotencyKey()` and which comparable ones don't.

### Layer C — Cross-cutting consistency
- **"Many ways to do one thing":** for each of money formatting (cents → display), date formatting, activity logging shape, confirmation dialogs (`ConfirmModal` vs stray `confirm()`), toasts, and loading spinners — count the distinct implementations and point to them.
- **Dead code:** unused exports, orphaned files/utilities, large commented-out blocks, and a TODO/FIXME census (count + the few that look load-bearing).
- **Duplicate utilities:** the same helper implemented in more than one place.
- **Naming:** inconsistent names for the same concept across the codebase.
- **Doc drift:** spot-check the counts/claims in `CLAUDE.md` and `docs/reference/` against reality (page count, etc.).

---

## Report format (`docs/audits/<today>-foundation-audit-report.md`)

Write it **for Mason first** (plain English, no jargon up top), then the detail.

1. **Headline verdict — the rebase question, answered.** One short paragraph, decisive, choosing exactly one:
   - **NO REBASE** — the foundation is solid; build on it. (Refactors are optional polish.)
   - **PARTIAL** — keep most of it; refactor or rebuild *these specific named areas*.
   - **REBASE** — there are systemic problems that warrant rebuilding *X*; here's why the cost is justified.
   Justify the call in 2–3 sentences tied to the evidence below.

2. **Plain-English executive summary.** Overall foundation grade (Strong / Fair / Weak) and the **top 3–5 root causes** of the rework cycle — *causes, not symptoms* — in language a non-coder understands.

3. **Per-area verdict table.** One row per layer (and any notable subsystem). Columns: `Area | Verdict (Solid / Refactor / Rebuild) | Why (1 line) | Rough effort`.

4. **Severity-ranked findings.** Grouped by layer, sorted P0 first. Each finding:
   `[P#][effort S/M/L][risk Low/Med/High] Title` — `file:line` — what's wrong — why it matters (esp. if it's a rework/breakage driver) — suggested direction (NOT a full fix).

5. **Prioritized roadmap — "if you only fix 5 things."** Sequenced so safe, high-leverage fixes come first. For each: what, why it's at this position, effort, risk-to-fix.

6. **Appendix.** The Phase-1 map (inline or linked).

### Scales
- **Severity:** `P0` actively causing breakage/data-risk now · `P1` root cause of recurring rework / will bite soon — address this cycle · `P2` real debt — fix when next touching the area · `P3` minor / polish.
- **Effort:** `S` <1 day · `M` 1–3 days · `L` a week+.
- **Risk-to-fix:** `Low / Med / High` — chance the fix could break live behavior (this app is in production).

---

## Final reminder
You are diagnosing, not treating. The most valuable output is a **decisive, evidence-backed answer to the rebase question** plus a short, safe, prioritized roadmap — not an exhaustive nitpick list. When in doubt, go deeper on the few things that explain the rework cycle, and resist the urge to fix anything.
