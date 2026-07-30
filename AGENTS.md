# CRX Manager Agent Guide

This is the shared, project-level contract for every coding agent in this repository. Keep it stable and concise. Tool-specific guidance belongs in that tool's file; volatile counts and sprint status belong in `docs/`.

## Project and Owner

- CRX Manager V1.0 is the production operations app for Crop RX Solutions, an agricultural chemical distributor.
- Stack: React 18, TypeScript, Vite, Tailwind CSS, Supabase, and Vercel.
- Repo: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Owner: Mason Wells. Mason has no formal coding background. Lead the process, define jargon once, explain risk in plain English, and give one clear recommended next step.

## Start Here

1. Inspect `git status --short --branch` before doing anything that writes.
2. If this is your first session in this repo, read `docs/manual/AGENT_ONBOARDING.md`; the rest of `docs/manual/` (architecture, decision log, known issues, current state) is the synthesis layer — check `docs/manual/DECISION_LOG.md` before re-opening a settled design question and `docs/manual/KNOWN_ISSUES.md` before claiming a bug is new.
3. Read `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for any multi-file, data, money, security, production, migration, permission, or customer-facing task.
4. Read `docs/reference/gotchas.md` and the relevant file under `docs/workflows/` for the area being changed.
5. Treat executable code, migrations, live read-only evidence, and current grants as stronger evidence than prose or old handoffs.
6. For architecture, multi-file planning, workflow/migration tracing, difficult debugging, structural audits, or PR impact analysis, automatically use the local Graphify workflow (`npm run graph:refresh`, then the smallest useful `graphify explain` / `affected` / `path` / `query`) before broad source reading. Use it to narrow scope and save tokens; verify material edges in current source and live read-only evidence.
7. Claude workflow logic lives under `.claude/`; Codex-facing skills under `.agents/` are generated adapters. Do not maintain two independent workflow implementations.

## Plan and Approval Gates

For multi-file or risky work, present a short plain-English goal, definition of done, and plan, and name the files or systems expected to change. **Codex standing execution authorization (Mason, 2026-07-22):** unless Mason asked only for a plan, review, diagnosis, or status report, Codex begins ordinary reversible in-scope work immediately after stating the plan; Mason's request to Codex to build, fix, finish, audit, or handle the task is approval for the normal local edits, investigation, tests, worktrees, and other reversible work needed to complete that scope. Codex does not stop after planning or ask "Should I continue?" while another safe, in-scope step is available. This Codex-specific authorization does not change Claude's plan-approval workflow. Tiny, obvious, reversible fixes may proceed directly.

Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in a sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it. Stop short of actions clearly beyond what the request implies.

For substantial tasks, maintain a visible progress plan with completed, current, and remaining steps. If one lane is blocked, investigate safe alternatives and continue other unblocked work. Stop only when the task is genuinely complete, one of the explicit gates below is reached, Mason must make a material product or business choice, or no meaningful progress remains after safe alternatives are exhausted. Before stopping at a gate, finish all safe preparation and combine the needed decisions into one question.

Close substantial work with one categorical verdict: `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`. State what was done, what remains, the proof observed, and the single recommended next step. Never call the task complete while required work remains.

Standing push policy (Mason, 2026-06-16; mechanics updated 2026-07-14): regular, reversible code may land on `main` without a fresh approval once the full pipeline is green — review clean, tests passing, and the pre-push hook's typecheck/build succeeding. Since 2026-07-14, `main` is protected by the GitHub `protect-main` ruleset: direct pushes are impossible for everyone, so landing work means **push a branch → open a PR → checks pass (Vercel required) → read and resolve CodeRabbit's automated review → merge**. This applies to Claude, Codex (per the 2026-07-13 harness decision — risky diffs additionally need the cross-model proof its guard enforces), and Mason alike. A merge to `main` deploys production via Vercel; the one-click rollback there is the accepted safety net. This authorization covers ordinary code only and never extends to the gated actions below.

Standing CodeRabbit review policy (Mason, 2026-07-17): every PR on the public `CRX_Manager_V1.0` and `FarmRx` repos is automatically reviewed by CodeRabbit (an AI reviewer, free on public repos; config in each repo's `.coderabbit.yaml`, which overrides the CodeRabbit dashboard settings). Before merging, whoever is landing the work **reads CodeRabbit's review and fixes any real issue it raises**; CodeRabbit is advisory — it comments and does not block, and its nitpicks may be dismissed with a one-line reason. CodeRabbit is the broad every-PR pass; the Codex cross-model proof remains the hard gate for risky money/RLS/migration diffs. Both run — neither replaces the other. A merge-blocking required status check for CodeRabbit is planned (Mason chose "process now, hard-block soon") and will be added to `protect-main` once its exact check name is confirmed on a live PR. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-17 entry).

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

## CRX Hard Rules

- Add database changes only as new files under `supabase/migrations/`; never edit an applied migration.
- New tables must enable Row Level Security (RLS) and include policies in the same migration.
- Mutating RPCs must accept and actually enforce `p_idempotency_key text DEFAULT NULL`.
- `SECURITY DEFINER` functions normally must use `SET search_path = public, pg_temp` and deliberate grants. An empty search path is allowed only as the stronger variant for a deliberately fully schema-qualified body with current source and migration-review proof.
- Money is bigint cents. Never use floating-point math for stored or calculated money.
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

- `AGENTS.md` is the canonical shared contract and is edited intentionally by hand.
- `CLAUDE.md` imports this file and contains Claude-only routing; it must not restate or contradict shared policy.
- After changing `.claude/commands/` or `.claude/skills/`, run `node scripts/sync-agent-workflows.mjs --write`, then `npm run test:agent-workflows`.
- After schema changes, refresh the schema registry from the correct database source and update the relevant `docs/reference/` files.
- Do not put migration/page/function counts in always-loaded agent files; `npm run check:docs` verifies those claims in reference docs.
