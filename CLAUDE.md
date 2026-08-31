@AGENTS.md

# Claude Code Additions

`AGENTS.md` is the canonical shared project contract. This file contains only Claude Code routing and must not duplicate or weaken it.

## Session Routing

- At session start, read `AGENTS.md`, then load `docs/workflows/SAFE_DEVELOPMENT_RULES.md` and only the workflow/reference files relevant to the task.
- For every task covered by `AGENTS.md`'s **Graph-First Navigation** policy, load the `graphify` skill automatically and query Graphify before broad `Read`/`Glob`/`Grep` exploration. Use its result to narrow source reads, never to replace the source/live verification required by the shared policy; when Graphify is unavailable or refresh reports a supported skip, follow the skill's focused-source fallback.
- `docs/manual/` is the synthesis layer: `AGENT_ONBOARDING.md` for a first session, `DECISION_LOG.md` before re-opening a settled decision, `KNOWN_ISSUES.md` before treating a bug as new, `OWNER_PLAYBOOK.md` when Mason asks "how do I…". Whoever changes a command, policy, or ships/parks work updates the affected manual file in the same change.
- Use `docs/reference/gotchas.md` when working around project-specific behavior.
- Use `.claude/schema-registry.json` for current schema-aware hook checks; refresh it after approved schema changes.
- Treat `docs/CHANGELOG.md`, `docs/reference/`, and active loop/ledger files as the location for changing project status and counts.

## Claude Workflows

Mason can ask in plain English; route to these skills/commands without requiring him to remember names:

| Need | Workflow |
|---|---|
| Read-only second-model review | `codex-review` (from a Claude session) / `claude-review` (from a Codex session) |
| Claude + Codex reconciliation | `agent-pair-review` |
| Durable handoff artifact | `codex-to-claude-handoff` |
| Agent/tooling health | `agent-health` |
| PR review comment preview/post | `agent-pr-comment` |
| Adversarial Codex review | `codex-gauntlet` or `codex-review` |
| Pre-ship verification | `preflight` or `ship` |
| Migration review/create/explain | `migration-review`, `create-migration`, `explain-migration` |

Direct reviews are read-only. PR comments default to dry-run. None of these workflows may push, deploy, apply a live migration, mutate/delete live data, or expose secrets without the approval required by `AGENTS.md`.

## Claude Hooks and Agents

- `.claude/settings.json` is the Claude permission and hook manifest.
- `.claude/hooks/` is the single source of truth for shared guard logic. The tracked `.codex/hooks.json` invokes those files through a portable adapter; do not copy hook implementations into `.codex/`.
- Full hook and reviewer-agent behavior is documented in `docs/reference/agent-guardrails.md`.
- Migration work must satisfy the RLS/security and drift-review gates before a live apply can even be considered.
- Unattended mode never loosens the hard deny set for push, production deploy, destructive data operations, or secrets. Live migrations in an armed hands-free run follow the settled 2026-07-13 policy in `AGENTS.md`/`docs/manual/DECISION_LOG.md`: the migration-apply-guard proof + Codex gates apply in full, and destructive migrations are hard-refused while armed.
- Claude/Codex hook asymmetry is deliberate and enforced: `scripts/agent-manifest-parity.mjs` fails on any undeclared one-sided hook. Wire a new guard on both sides, or declare it in `CLAUDE_ONLY_HOOKS`/`CODEX_ONLY_HOOKS` with the reason.

## Model Tuning (Claude 5 Family — Opus 5 / Fable 5)

Calibrated to Anthropic's Opus 5 prompting guidance; rationale in `docs/research/2026-07-25-opus5-harness-review.md` (measured on Opus 5 only). The carry-over to Fable 5 (the Claude 5 tier above Opus) is provisional — declared, not measured — but binding until a newer harness review supersedes it; a Fable 5 session must not treat this section as Opus-only and skip it.

<tone_preference>
Keep responses focused and concise. Lead with the outcome — the first sentence answers "what happened" or "what did you find" — then supporting detail. Keep caveats short, and give a high-level summary unless Mason asks for depth. Before your first tool call, say in one sentence what you're about to do; while working, update only on an important finding or a change of direction.
</tone_preference>

- **Written deliverables.** Match document length to what the task needs. Reports, audits, and handoffs lead with findings, not a restatement of the assignment. Do not pad with filler sections, redundant summaries, or boilerplate.
- **Subagent budget.** Delegate only for large, genuinely independent, parallelizable work. Do not delegate what you can finish in a handful of tool calls, and never spawn a subagent to double-check your own output. The fan-out a workflow script defines is a **hard cap for that run, not a default** — never add ad-hoc agents on top of it. There is no global session budget; the ceiling is per-workflow.
- **Self-verification.** The Claude 5 models self-correct reliably; do not add "double-check your answer" re-checks. This does not relax the `AGENTS.md` Verification Standard — running the changed behavior and observing it is a production-safety rule, not a self-check, and it stands unchanged. The Codex cross-model gate and the adversarial skeptics on money/RLS/migration paths also stand: they are independent or precision-motivated, not self-verification.
- **Review prompts** must request every finding and filter in a later pass. Never instruct a reviewer to "only report high-severity issues" or "be conservative" — these models follow that literally and report less. **Settled exception (Mason, 2026-07-25):** bounded overnight sweeps are exempt. `overnight-bug-hunt.js`, `money-inventory-hunt.js`, and `whole-codebase-audit.js` keep their 8–10 "most significant" caps — the per-run cost of uncapped fan-out outweighs the tail findings. The rule binds everywhere else; do not add a cap to any other review prompt.
- **Effort.** `low` for mechanical read-only work (`status`, `parked`, `fleet`, doc updates); `medium` for routine review and non-money multi-file work; `high` (default) for money, inventory, RLS, migrations, `ship`, `codex-gauntlet`; `xhigh` for `foundation-ultra-review`, `migration-review`, and overnight hunts. This is a starting point pending an effort sweep on real CRX tasks — never lower effort on a money/RLS/migration path to save tokens. `money-inventory-hunt.js` pins `effort: 'high'` at its finder and verifier call sites; Mason settled on 2026-07-25 that it **stays at `high` until an effort sweep measures otherwise**, so the `xhigh` row does not reach those agents by design.

## Maintenance

After changing Claude commands, skills, hooks, permissions, or agent helpers:

```bash
git status --short --branch   # --write mutates tracked files; inspect state first
node scripts/sync-agent-workflows.mjs --write
npm run test:agent-workflows
npm run agent-health
```

Do not regenerate `AGENTS.md` from this file. `scripts/regenerate-agents-md.mjs` is a compatibility validator and will not overwrite the shared contract.
