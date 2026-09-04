# CRX Manager Agent Guide

This is the shared, project-level contract for every coding agent in this repository. Keep it stable and concise. Tool-specific guidance belongs in that tool's file; volatile counts and sprint status belong in `docs/`.

## Project and Owner

- CRX Manager V1.0 is the production operations app for Crop RX Solutions, an agricultural chemical distributor.
- Stack: React 18, TypeScript, Vite, Tailwind CSS, Supabase, and Vercel.
- Repo: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Owner: Mason Wells. Mason has no formal coding background. Lead the process, define jargon once, explain risk in plain English, and give one clear recommended next step.

## Owner Communication

- Mason should never have to nudge an agent to continue or ask whether it silently stopped. Keep moving through authorized work, post concise milestone/failure updates, lead with the current outcome, and give one recommended next step.
- Make routine technical choices yourself. For a real business or risk decision, recommend one option first, explain at most two alternatives in plain English, and give Mason the exact short reply or app-native action required.
- When a tool, command, check, or approach fails, promptly state what failed, what it means, and what the agent is trying next; exhaust safe alternatives before declaring a blocker. Never finish with a vague offer while in-scope work remains: a genuine stop must use `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED` and explain the exact blocker.

## Start Here

1. Inspect `git status --short --branch` before doing anything that writes.
2. If this is your first session in this repo, read `docs/manual/AGENT_ONBOARDING.md`; the rest of `docs/manual/` (architecture, decision log, known issues, current state) is the synthesis layer — check `docs/manual/DECISION_LOG.md` before re-opening a settled design question and `docs/manual/KNOWN_ISSUES.md` before claiming a bug is new.
3. Read `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for any multi-file, data, money, security, production, migration, permission, or customer-facing task.
4. Read `docs/reference/gotchas.md` and the relevant file under `docs/workflows/` for the area being changed.
5. Treat executable code, migrations, live read-only evidence, and current grants as stronger evidence than prose or old handoffs.
6. For architecture, multi-file planning, workflow/migration tracing, difficult debugging, structural audits, or PR impact analysis, automatically follow the Graph-First Navigation policy below before broad source reading.
7. Claude workflow logic lives under `.claude/`; Codex-facing skills under `.agents/` are generated adapters. Do not maintain two independent workflow implementations.

## Graph-First Navigation

For architecture, multi-file planning, workflow or migration tracing, difficult debugging, structural audits, and PR-impact analysis, Graphify is the default first-pass navigator. Load the `graphify` skill automatically and follow its freshness, focused-query, reporting, and result-persistence procedures before broad file exploration; do not require Mason to remember to request it. A simple documentation lookup, obvious single-file edit, or already-known exact file does not need a graph query. If Graphify is unavailable or its supported refresh path skips, continue with focused source inspection and report that limitation instead of blocking the task.

Use the graph to choose the smallest source surface that can answer or implement the task. Raw source reads do not require Mason's explicit request: they are required whenever needed to edit safely, verify a material connection, review behavior, or conduct an audit. Current source, executable tests, migrations, and live read-only database evidence remain authoritative; Graphify identifies where to look and never proves current behavior or the live schema.
## Plan and Approval Gates

For multi-file or risky work, present a short plain-English goal, definition of done, and plan, and name the files or systems expected to change. **Codex standing execution authorization (Mason, 2026-07-22):** unless Mason asked only for a plan, review, diagnosis, or status report, Codex begins ordinary reversible in-scope work immediately after stating the plan; Mason's request to Codex to build, fix, finish, audit, or handle the task is approval for the normal local edits, investigation, tests, worktrees, and other reversible work needed to complete that scope. Codex does not stop after planning or ask "Should I continue?" while another safe, in-scope step is available. This Codex-specific authorization does not change Claude's plan-approval workflow. Tiny, obvious, reversible fixes may proceed directly.

Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it. Stop short of actions clearly beyond what the request implies.
For substantial tasks, maintain a visible progress plan with completed, current, and remaining steps. If one lane is blocked, investigate safe alternatives and continue other unblocked work. Stop only when the task is genuinely complete, one of the explicit gates below is reached, Mason must make a material product or business choice, or no meaningful progress remains after safe alternatives are exhausted. Before stopping at a gate, finish all safe preparation and combine the needed decisions into one question.

Close substantial work with one categorical verdict: `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`. State what was done, what remains, the proof observed, and the single recommended next step. Never call the task complete while required work remains.

## Protected Delivery

The detailed, current delivery procedure lives in `.claude/commands/ship.md`; the decisions behind it live in `docs/manual/DECISION_LOG.md`, and the deterministic enforcement is documented in `docs/reference/agent-guardrails.md`. Read those sources before any push, PR finalization, or merge. Keep volatile mechanics there instead of expanding this always-loaded contract.

- Regular reversible code may land without a fresh in-chat approval only after the full protected pipeline succeeds: branch → PR → required checks → frozen candidate → any required exact-SHA Codex proof → `ready-for-coderabbit` → resolved CodeRabbit and Codex GitHub App findings → exact-head merge → production verification.
- Never push directly to `main`, use an admin override, enable auto-merge during the final-candidate flow, bypass hooks/checks, or trigger CodeRabbit while implementation or review is still moving.
- Required CI remains the merge gate. An approving GitHub review is not generally required, but any `CHANGES_REQUESTED` verdict or unresolved exact-head agent finding blocks the merge.
- Risky money, inventory, auth, RLS, migration, permission, or other business-critical diffs require a fresh separate adversarial review of the exact candidate SHA using `gpt-5.6-sol` at high reasoning effort.
- A CodeRabbit status row or bot acknowledgement alone is not proof of review. Confirm the frozen candidate was actually reviewed; when CodeRabbit approved, its review commit, the gate marker, and the final PR head must match. Any new commit or base update invalidates that candidate, requiring affected checks and review gates to rerun before one fresh label-based review request.
- Keep `.coderabbit.yaml` as the repository review configuration source. Verify real mergeability with the PR merge state rather than the known-stale protection sub-resource, and merge with `--match-head-commit <reviewed-sha>` only after rechecking every reported check, review state, unresolved thread, and rollback path. A merge to `main` deploys through Vercel and requires proportionate production verification.

Standing hands-free migration policy (Mason, 2026-07-13): in a **pre-authorized hands-free run** — Mason explicitly asked for the run AND autopilot is armed (`node .claude/hooks/autopilot-arm.mjs --hours N`; the unexpired flag is the durable record) — a live migration may apply without a per-migration in-chat OK, provided the hard proof gate passes: fresh same-session migration-apply-guard proof plus a real Codex verdict this session for SQL/RLS/money changes. Migrations that DELETE/TRUNCATE business rows or DROP data-bearing tables/columns are **never** autonomous, armed or not. In an ordinary interactive session, a live apply still gets Mason's in-chat OK. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-13 entry).

Always get Mason's explicit approval in the current conversation before:

- force-pushing any branch, or pushing work that has not passed the full green pipeline;
- applying a live database migration or changing live data (subject to the 2026-07-13 hands-free-run exception above);
- deploying an edge function, or any production deploy outside the normal push-to-`main` path;
- deleting data;
- changing secrets, authentication, permissions, billing, or customer-visible production state beyond what a reviewed regular-code push inherently changes.

Never commit `.env` files or reveal keys. Never use `--no-verify`. Never use destructive recovery such as `git reset --hard`, broad discard-all commands, or recursive force-delete unless Mason explicitly requests that exact action after the risk is explained.

## Workspace Hygiene

- Preserve user work. Do not revert unrelated changes.
- Before trusting a long-running or isolated checkout, run `git fetch origin` and `git rev-list --left-right --count origin/main...HEAD`.
- If the active checkout is dirty or stale and the task is multi-file/risky, use a clean worktree based on current `origin/main`.
- Do not claim a finding is current when the checkout is behind `origin/main`.
- Do not push, deploy, migrate, or mutate live data as part of a review, audit, health check, or setup check.

## Multi-Agent Coordination

- Mason describes the business outcome; the coordinating agent owns risk classification, task breakdown, worker selection, file/worktree isolation, integration, and one consolidated owner-facing status. Do not make Mason coordinate agents or Git.
- Use each tool's canonical native orchestration, project instructions, skills, and linked worktrees. Do not add a custom agent server, queue, container layer, or permanent role files until a repeated workflow and a verified native limitation justify them.
- Delegate only significant, independent, bounded work whose saved time or reduced context noise exceeds the coordination cost. Keep tiny fixes and tightly sequential work with the coordinator. Ad-hoc delegation defaults to at most three active workers unless tool-specific guidance or a canonical workflow defines a different tested fan-out.
- Before delegation, give each worker a contract naming the objective, minimum relevant context, allowed and prohibited files or systems, observable acceptance criteria, required checks, and the evidence and unresolved risks it must return. Workers return distilled results, not raw logs or a bare `Done`.
- Follow the active tool's model-routing rules instead of duplicating them here. Architecture and final review of money, inventory, units, auth, RLS, migrations, and other business-critical behavior stay with the strongest reviewer required by the current workflow.
- Designate exactly one writer per checkout. Concurrent writers require separate clean worktrees and disjoint file ownership; dependent database, API, UI, and test work stays sequential until the coordinator has fixed the shared interface. No worker merges, deploys, applies a live migration, mutates live data, or widens scope independently.
- Worker-written tests and successful builds are supporting evidence, not final proof. The coordinator reviews every accepted diff, runs the real-path verification required below, and preserves the existing exact-SHA adversarial-review and delivery gates.

## CRX Hard Rules

- Add database changes only as new files under `supabase/migrations/`; never edit an applied migration.
- New tables must enable Row Level Security (RLS) and include policies in the same migration.
- Mutating RPCs must accept and actually enforce `p_idempotency_key text DEFAULT NULL`.
- `SECURITY DEFINER` functions normally must use `SET search_path = public, pg_temp` and deliberate grants. Per Mason's 2026-07-30 approval recorded in `docs/manual/DECISION_LOG.md`, an empty search path is allowed only as a narrow exception for a deliberately fully schema-qualified body with current source and migration-review proof.
- Money must be exact whole cents. New money storage uses bigint cents. Existing PostgreSQL
  numeric-dollar storage may remain temporarily to avoid a risky unit rewrite, but it is an approved
  compatibility exception only after authoritative database math is verified as exact `numeric`, all
  existing values are finite whole cents, and an active finite whole-cent CHECK is present. Dirty or
  unconstrained columns remain tracked findings and are never widened or rewritten without approval.
  New or changed authoritative TypeScript
  money math must parse decimal operands into integer cents before arithmetic; never introduce
  binary floating-point rounding for money. See the 2026-08-10 decision in
  `docs/manual/DECISION_LOG.md`. Per Mason's 2026-08-19 decision recorded there, the two
  purchase-order "mirror" constraints satisfy this gate as a closed two-column exception; every
  new or changed money column uses the rounding form, named `<table>_<column>_whole_cents_chk`.
- Inventory and financial invariants belong in PostgreSQL RPCs/triggers, not only in React.
- Use `src/lib/db.ts` as the only Supabase client.
- Call `assertRpcResult()` after RPCs and `checkMutationResult()` after `.update()` or `.delete()`.
- Never update generated columns such as `invoices.balance_cents`.
- Status values must match current database constraints in `.claude/schema-registry.json`.
- Use `ConfirmModal`, not `confirm()`/`window.confirm()`. Use toasts, not `alert()`.
- Import Sentry only through `src/lib/sentry`.
- Use shared types from `src/types/index.ts`, Lucide icons, and Tailwind CSS.

## Verification Standard

Done means the changed behavior ran and was observed, not merely that a new test passed.

- Frontend/UI: open or render the affected flow and verify behavior and console state.
- Backend/API/RPC: execute the path or a focused safe check and inspect the result.
- Database/business logic: verify migration shape and relevant read-only live state when appropriate; never mutate live state without approval.
- Match breadth to risk: narrow checks for a low-risk one-file change; typecheck, tests, build, and real-path proof for shared logic, money, data, auth, or multi-file behavior.
- If real-path verification is blocked, state exactly what was not verified and the remaining risk.

Common commands:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:agent-workflows
npm run agent-health
```

## Documentation and Generated Files

- Record a shipped change as a NEW file in `docs/changelog.d/` (`<YYYY-MM-DD>-<slug>.md`), not by appending to `docs/CHANGELOG.md`. That file is over 15,000 lines and every parallel session lands in it, so concurrent work collides there; a per-change file cannot conflict. It satisfies the pre-commit ledger guard. `docs/CHANGELOG.md` remains valid and is still the history for everything written before this convention; `docs/changelog.d/README.md` has the details.
- `AGENTS.md` is the canonical shared contract and is edited intentionally by hand.
- `CLAUDE.md` imports this file and contains Claude-only routing; it must not restate or contradict shared policy.
- After changing `.claude/commands/` or `.claude/skills/`, run `node scripts/sync-agent-workflows.mjs --write`, then `npm run test:agent-workflows`.
- After schema changes, refresh the schema registry from the correct database source and update the relevant `docs/reference/` files.
- Do not put migration/page/function counts in always-loaded agent files; `npm run check:docs` verifies those claims in reference docs.
