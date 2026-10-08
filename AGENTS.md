# CRX Manager Agent Contract

The always-loaded shared contract for Codex, Claude, and any other coding agent. Durable rules only; procedures and volatile facts live in the routed documents.

**Priority.** The CRX Hard Rules and every "never" below outrank any request; the approval gates (and the hooks that enforce them) open only with Mason's explicit approval in the current conversation or a standing exception written here; Mason's current message sets scope but never loosens either. Then this file, then the selected workflow, then routed docs, then history and handoffs. Name a real conflict in one line and follow the higher source.

## Project and Owner

- CRX Manager is the production operations app for Crop RX Solutions, an agricultural chemical distributor: React 18, TypeScript, Vite, Tailwind CSS, Supabase, and Vercel.
- Repository `https://github.com/masonwells1/CRX_Manager_V1.0`; production `https://croprxsolutions.app`; Supabase project `rhyzpcqhnizqbxphqdkr`.
- Mason Wells owns the product. He has no formal coding background and cannot safely review code or diffs. Own the technical process; explain outcomes, risk, and proof in plain English.

## Owner Communication

- Mason should never have to nudge an agent. Keep moving through authorized work and post short updates at milestones or failures.
- Lead with the outcome, define jargon once, and end with one recommended next step. Make technical choices yourself; for a business or risk trade-off, recommend one option and give the exact short reply needed.
- When something fails, say what failed, what it means, and what you are trying next. Exhaust safe alternatives first. A genuine stop begins with `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED`.

## Operating Contract

- Reviews, audits, diagnoses, status checks, and plans authorize read-only investigation. Requests to build, change, fix, finish, handle, implement, or ship authorize the whole reversible lifecycle through verification and protected delivery.
- Deliver what was asked at the scope intended. If the request seems mistaken or a better approach exists, say so briefly and continue with the requested outcome rather than quietly narrowing, widening, or transforming it.
- Codex and Claude both proceed after a short plan without waiting for approval (Mason, 2026-10-03). Never pause to ask “Should I continue?” while safe, in-scope work remains; ask only when a missing choice would materially change the business outcome or a hard-gated action below has not been approved.
- Treat explicit limits (`read-only`, `do not write`, `do not push`, `do not merge`, `do not query production`) and "stop", "pause", or "hold on" literally.
- Stop and hand over, with both positions and a recommendation, only when the same BLOCKER or HIGH survives two fix rounds, you and a reviewer still disagree on a BLOCKER after checking the code, a required gate cannot run, or the next step is hard-gated. A workflow's round cap is a ceiling: stop at the cap or the first of these, whichever comes first.

## Start and Route

1. Before presenting findings as current, confirm the checkout is not behind `origin/main`. Before writing, check `git status --short --branch`; preserve unrelated work and use a clean current-main worktree when the checkout is dirty, stale, or occupied.
2. Prefer current code, migrations, tests, grants, and live read-only evidence over memory, handoffs, or prose.
3. Load only what the task needs. Search large logs and the schema registry; never read them whole.

| Task | Read or invoke |
|---|---|
| First session or unfamiliar area | `docs/manual/AGENT_ONBOARDING.md`, then `docs/manual/ARCHITECTURE.md` |
| Any code change | `docs/reference/coding-guidelines.md` and the relevant section of `docs/reference/gotchas.md`; add `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for multi-file, data, money, security, permission, production, migration, or customer-facing work |
| Architecture, difficult debugging, workflow/migration tracing, structural audit, or PR impact | `graphify` skill first; use focused source inspection if docs are outside its code-only corpus |
| Database, migration, or RLS | `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, `docs/workflows/RLS_SECURITY_GUIDE.md`, and `.claude/schema-registry.json` |
| Quote-to-cash or inventory | `docs/workflows/QUOTE_TO_DELIVERY.md` or `docs/workflows/INVENTORY_RULES.md` |
| Frontend/UI | `docs/workflows/UI_PATTERNS.md` |
| Delegation, agent collaboration, or agent-surface changes | `docs/workflows/AGENT_COLLABORATION.md` and `docs/reference/agent-guardrails.md` |
| Choosing a Codex model or effort | `docs/reference/codex-model-tuning.md` |
| Push, PR finalization, merge, or release | `.claude/commands/ship.md` |
| Settled decisions, known problems, or current status | `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`, or `docs/manual/CURRENT_STATE.md` |
| Mason asks how the system or agent process works | `docs/manual/OWNER_PLAYBOOK.md` |

## Engineering Principles

- Choose the simplest complete implementation that preserves the business rules: existing patterns, shared helpers and types, and small focused functions over new layers or dependencies. Optimize for clarity, not cleverness: precise names, straightforward control flow, and comments that explain why.
- Keep the diff tied to the requested outcome; no opportunistic refactors.

## CRX Hard Rules

- Add database changes as new files under `supabase/migrations/`; never edit an applied migration. New tables require Row Level Security and policies in the same migration.
- Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`. `SECURITY DEFINER` functions require deliberate grants and normally `SET search_path = public, pg_temp`; use the documented fully-qualified exception only with its proof.
- Money must resolve to exact whole cents. New storage uses bigint cents; authoritative TypeScript parses decimals into integer cents before arithmetic (legacy exceptions: `docs/workflows/SAFE_DEVELOPMENT_RULES.md`).
- Financial and inventory invariants belong in PostgreSQL RPCs, triggers, or constraints — not only in React.
- Use `src/lib/db.ts` as the only Supabase client. Call `assertRpcResult()` after RPCs and `checkMutationResult()` after updates or deletes. Never write generated columns.
- Match status values to `.claude/schema-registry.json`. Use shared types from `src/types/index.ts`, `ConfirmModal`, toasts, Lucide icons, Tailwind CSS, and Sentry through `src/lib/sentry`.

## Safety and Protected Delivery

- Never expose secrets or `.env` contents; never use `--no-verify`; never bypass, disable, or weaken hooks, CI, review, branch protection, migration proofs, or rollback gates; and never push directly to `main`.
- Every change follows `.claude/commands/ship.md`: PR → Luna rounds → checks green → CodeRabbit APPROVED → Sol **last** → apply its migration, if any, BEFORE the merge → exact-head merge. Use only the pinned model IDs and efforts in `docs/reference/codex-model-tuning.md`, never a newer model the gates do not yet accept.
- **Luna** iterates: fix and re-run until no BLOCKER or HIGH remains and every MED/LOW is fixed, refuted with evidence, or named as a deferral. Escalate to Sol early only for genuinely complex work, and say why.
- Every merge into `main` requires one fresh independent **Sol** high-effort review of the exact candidate SHA, run **last**, except a documentation-only change as defined in `docs/reference/sol-exempt-paths.md` (Mason, 2026-10-07). That exception needs CodeRabbit APPROVED on the exact head and every required check green. Its proof binds to that HEAD and GitHub's real base, so a later commit or moved base voids it. A green status row or clean Luna round is not that proof, and a Luna round must never run through the proof wrapper, which unlinks the existing proof for that HEAD.
- CodeRabbit reviews every push automatically; fixes stay on the same PR. If it skipped or was rate-limited on a head, the agent posts `@coderabbitai review` on the PR once; never ask Mason to comment, label, or click for CodeRabbit.
- **Autonomous landing (Mason, 2026-09-26).** When CodeRabbit has APPROVED the frozen final head, a fresh exact-SHA Sol review of that head is clean, and every required check is green, the agent merges by itself and applies its NON-destructive migration (routine grants only) through the migration-apply-guard proof gate (both reviewer proofs and a fresh content-bound Sol proof, each under 30 minutes), in any session, no ask. The merge and apply gates enforce it.
- Get Mason’s explicit approval in the current conversation before force-pushing, applying a DESTRUCTIVE migration (one that deletes rows or drops data), changing live data outside a reviewed migration, deploying an Edge Function or out-of-band production change, deleting data, or changing secrets, authentication, permissions, billing, domains, or ownership.
- Unattended or automated work never loosens any hard gate.

## Verification and Closeout

- Done means the changed behavior ran and was observed; match proof to risk. Tests written alongside a change are supporting evidence, not sole proof. If real verification cannot run, say exactly what remains unverified.
- A review, audit, or diagnosis is done when each finding is checked against current code or live read-only evidence and reported with location and severity; a plan is done when it names the files, risks, and proof it will need; a change is done when it is verified and delivered through the protected path, or parked with the reason and owner.
- Close substantial work with `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`: what changed, the proof, who owns what remains, and one next step.

## Guidance Ownership

- `AGENTS.md` is hand-maintained; `CLAUDE.md` imports it and adds Claude-only routing. `.claude/commands/`, `.claude/skills/`, and `.claude/hooks/` are workflow sources; `.agents/` holds generated Codex adapters (`node scripts/sync-agent-workflows.mjs --write`).
- Whoever changes a command or policy, or ships or parks work, updates the affected manual or reference doc in the same change and adds `docs/changelog.d/<YYYY-MM-DD>-<slug>.md`. Volatile counts and status belong in `docs/reference/` or `docs/manual/`, never here.
