# CRX Manager Agent Contract

This is the always-loaded, shared contract for Codex, Claude, and future coding agents. Keep it short: durable rules stay here; procedures, examples, volatile facts, and long explanations belong in the linked documents.

**Instruction priority.** When sources disagree, follow the higher one: (1) the CRX Hard Rules and every "never" in Safety and Protected Delivery, which no request overrides (explain why and offer the safe path); (2) the approval gates and the hooks that enforce them, which open only with Mason's explicit approval in the current conversation or a standing exception written in this file; (3) Mason's current message, which sets scope and explicit limits but never loosens (1) or (2); (4) the rest of this file; (5) the selected workflow in `.claude/commands/` or `.claude/skills/` (or its generated `.agents/` adapter); (6) routed reference docs; (7) decision-log history, handoffs, and older prose. A lower source never loosens a higher one. Name a real conflict in one line, follow the higher source, and fix the lower one when it is in scope.

## Project and Owner

- CRX Manager is the production operations app for Crop RX Solutions, an agricultural chemical distributor. Stack: React 18, TypeScript, Vite, Tailwind CSS, Supabase, and Vercel.
- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`; production: `https://croprxsolutions.app`; Supabase project: `rhyzpcqhnizqbxphqdkr`.
- Mason Wells owns the product. He has no formal coding background and cannot safely review code or diffs. Own the technical process and explain outcomes, risk, proof, and decisions in plain English.

## Owner Communication

- Mason should never have to nudge an agent to continue or ask whether it silently stopped. Keep moving through authorized work and post concise updates at meaningful milestones or failures.
- Lead with the answer or current outcome. Define jargon once when it matters and end with one recommended next step, not a vague offer or a menu of technical choices.
- Make routine technical choices yourself. When Mason must decide a business or risk trade-off, recommend one option first, explain at most two alternatives, and give the exact short reply or app action needed.
- When something fails, promptly state what failed, what it means, and what you are trying next. Exhaust safe alternatives before stopping. A genuine stop begins with `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED`.

## Operating Contract

- Interpret requests by outcome. Reviews, diagnoses, audits, status checks, explanations, and plans authorize the relevant read-only investigation only. Requests to build, change, fix, finish, handle, implement, or ship authorize the normal reversible lifecycle through verification and protected delivery.
- Deliver what was asked at the scope intended. Make routine judgment calls yourself; if the request seems mistaken or a better approach exists, explain that briefly and continue with the requested outcome rather than quietly narrowing, widening, or transforming it.
- Codex proceeds after a short plan without a second approval. Claude retains its global pre-code approval checkpoint for multi-file work or work touching data, money, security, or a live system. Once any required approval is given, do not pause again or ask “Should I continue?” while safe, in-scope work remains.
- Outside Claude's one plan checkpoint, ask only when a missing choice would materially change the business outcome and no safe inference exists, or when an exact hard-gated action below has not been requested in the current conversation.
- Treat explicit limits such as `read-only`, `do not write`, `do not push`, `do not merge`, and `do not query production` literally.
- Stop rule: keep going while each fix or review round closes something. Stop and hand over, with both positions and a recommendation, only when the same BLOCKER or HIGH survives two consecutive fix rounds, you and a reviewer still disagree on a BLOCKER after checking the cited code, a required gate or tool cannot run, or the next step is hard-gated. A workflow's round cap is a ceiling: stop at the cap or the first condition above, whichever comes first.

## Start and Route

1. Before presenting findings as current, confirm the checkout is not behind `origin/main`. Before writing, inspect `git status --short --branch`; preserve unrelated work and use a clean current-main worktree when the checkout is dirty, stale, or occupied.
2. Prefer current code, migrations, tests, grants, and live read-only evidence over memory, old handoffs, or prose.
3. Load only the guidance relevant to the task. Large logs and the schema registry are for keyword or date search, never whole-file reads:

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

- Choose the simplest complete implementation that preserves the business rules: existing patterns, shared helpers and types, direct code, and small focused functions over new layers, dependencies, or speculative flexibility. Optimize for clarity, not cleverness: precise names, straightforward control flow, and comments that explain why.
- Keep the diff narrowly tied to the requested outcome. Avoid opportunistic refactors; remove only dead code or duplication introduced or directly exposed by the change.

## CRX Hard Rules

- Add database changes as new files under `supabase/migrations/`; never edit an applied migration. New tables require Row Level Security and policies in the same migration.
- Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`. `SECURITY DEFINER` functions require deliberate grants and normally `SET search_path = public, pg_temp`; use the documented fully-qualified exception only with its proof.
- Money must resolve to exact whole cents. New storage uses bigint cents; authoritative TypeScript parses decimals into integer cents before arithmetic. Follow the documented legacy exceptions in `docs/workflows/SAFE_DEVELOPMENT_RULES.md`.
- Financial and inventory invariants belong in PostgreSQL RPCs, triggers, or constraints — not only in React.
- Use `src/lib/db.ts` as the only Supabase client. Call `assertRpcResult()` after RPCs and `checkMutationResult()` after updates or deletes. Never write generated columns.
- Match status values to `.claude/schema-registry.json`. Use shared types from `src/types/index.ts`, `ConfirmModal`, toasts, Lucide icons, Tailwind CSS, and Sentry through `src/lib/sentry`.

## Safety and Protected Delivery

- Never expose secrets or `.env` contents; never use `--no-verify`; never bypass, disable, or weaken hooks, CI, review, branch protection, migration proofs, or rollback gates; and never push directly to `main`.
- Get Mason’s explicit approval in the current conversation before force-pushing, applying a live migration or changing live data, deploying an Edge Function or out-of-band production change, deleting data, or changing secrets, authentication, permissions, billing, domains, or ownership. The only migration exception is a hands-free run Mason explicitly pre-authorized with an unexpired autopilot arm flag, a fresh migration-apply-guard proof, and a fresh Codex verdict; it never permits destructive migrations. See the 2026-07-13 entry in `docs/manual/DECISION_LOG.md`.
- Armed, unattended, or automated work never loosens any other hard gate.
- Regular reversible code follows the protected path in `.claude/commands/ship.md`: branch → exact-SHA Sol review when the diff is risky → push and PR → required checks → resolved agent findings → CodeRabbit review of the frozen head → exact-head merge → proportionate production verification.
- Codex review has two tiers (Mason, 2026-09-20). **Luna** iterates: fix and re-run until no BLOCKER or HIGH remains and every MED/LOW is fixed, refuted with evidence, or named as a deferral; that is the whole review for ordinary reversible work. Escalate a round to **Sol** early only for genuinely complex work, and say why. The exact model IDs and efforts for every Codex role live in `docs/reference/codex-model-tuning.md`; use the pinned IDs there, never a newer model the gates do not yet accept.
- Risky money, inventory, auth, RLS, migration, permission, or other business-critical changes also require one fresh independent **Sol** high-effort review of the exact candidate SHA, run **last**, once no BLOCKER or HIGH remains (deliberately deferred MED/LOW do not block it). Its proof binds to the reviewed HEAD, so any later commit voids it. A green status row or a clean Luna round is not that proof, and a Luna round must never be routed through the proof wrapper, which unlinks the existing proof for that HEAD when it starts.

## Verification and Closeout

- Done means the changed behavior ran and was observed. Match proof to risk: focused checks for small reversible work; broader tests and real-path proof for shared logic, money, data, auth, migrations, or production behavior.
- Done by task type: a review, audit, or diagnosis is done when each finding is checked against current code or live read-only evidence and reported with location and severity; a plan is done when it names the files, risks, and proof it will need; a change is done when it is verified and delivered through the protected path, or parked with the reason and owner.
- If real verification cannot run, say exactly what remains unverified and the risk. Tests written alongside a change are supporting evidence, not sole proof.
- Close substantial work with `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`; state what changed, the proof, who owns anything remaining, and one recommended next step.

## Guidance Ownership

- `AGENTS.md` is the hand-maintained shared contract. `CLAUDE.md` imports it and contains Claude-only routing; it must not duplicate or weaken shared policy.
- `.claude/commands/`, `.claude/skills/`, and `.claude/hooks/` are workflow sources. `.agents/` contains generated Codex adapters; run `node scripts/sync-agent-workflows.mjs --write` after changing a source workflow.
- Whoever changes a command or policy, or ships or parks work, updates the affected manual or reference record in the same change.
- Put changing counts and status in `docs/reference/` or `docs/manual/`, and record shipped work in a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md`. Follow `docs/changelog.d/README.md`.
