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
6. Claude workflow logic lives under `.claude/`; Codex-facing skills under `.agents/` are generated adapters. Do not maintain two independent workflow implementations.

## Plan and Approval Gates

For multi-file or risky work, present a short plain-English plan, name the files or systems expected to change, and wait for Mason's approval before writing or making the live-changing move. Tiny, obvious, reversible fixes may proceed directly.

Standing push policy (Mason, 2026-06-16): regular, reversible code may be pushed to `main` without a fresh approval once the full pipeline is green — review clean, tests passing, and the pre-push hook's typecheck/build succeeding. A push to `main` deploys production via Vercel; the one-click rollback there is the accepted safety net. This authorization covers ordinary code only and never extends to the gated actions below.

Always get Mason's explicit approval in the current conversation before:

- force-pushing any branch, or pushing work that has not passed the full green pipeline;
- applying a live database migration or changing live data;
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
- `SECURITY DEFINER` functions must use `SET search_path = public, pg_temp` and deliberate grants.
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
