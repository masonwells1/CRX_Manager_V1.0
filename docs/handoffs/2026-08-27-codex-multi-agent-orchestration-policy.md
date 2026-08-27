# Codex Multi-Agent Orchestration Policy Handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\agent-orchestration-policy-20260827\CRX_Manager`
- Branch: `codex/agent-orchestration-policy-20260827`
- Base: `origin/main` at `005f71c8c33bf96082d1fc8678c96c24e2d281b0`
- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- No live service or database change is in scope.

## GOAL

Add a concise CRX-specific policy that lets Codex use native parallel workers without making Mason coordinate them or weakening the repository's review and delivery gates. Done means the policy is concise, non-conflicting, validated from a clean current base, independently reviewed, and delivered through the protected pull-request path.

## PROVEN

- The original `C:\CRX_Manager` checkout had 60 uncommitted files and was 16 commits behind after the first inspection, so it was not used for edits.
- A fresh fetch established current `origin/main`; this isolated worktree started clean and even with that base.
- This workstation has two Codex binaries: the npm shim is `0.147.0`, while the newer desktop-bundled binary found by the repository health check is `0.150.0-alpha.8`. The npm CLI's feature report marks `multi_agent` stable and enabled, and this desktop session exposes native subagent controls.
- The active global Codex configuration already selects Sol High for the coordinator, Terra Medium as the default subagent, and a maximum of three concurrent subagents.
- Current official Codex documentation supports native subagents, per-agent model and reasoning configuration, custom project agents, and parallel read-heavy work. It also warns that parallel write-heavy work increases conflicts and token use.
- The existing CRX global guidance already provides model tiers, one-writer-per-worktree, verified handoffs, exact-commit review, and protected delivery. The project edit therefore adds only CRX-specific orchestration behavior instead of duplicating the whole setup.
- The similarly named `claude/session-orchestration-setup-d73e6c` branch is PR #364's large migration-guard effort and does not modify `AGENTS.md`; it was left untouched.
- `npm run check:docs` passed every local documentation-drift assertion; its live database count was correctly skipped because no live database verification is needed for this policy-only change.
- `npm run test:agent-workflows` passed, including the lean-guidance check at 133 lines, hook parity, generated workflow parity, production guard tests, and 38 synced Codex workflow adapters.
- `npm run agent-health` passed with one pre-existing warning that the schema registry trails one migration on disk; this policy change does not touch migrations or the registry.
- The combined global and project `AGENTS.md` files total 30,165 bytes, below Codex's default 32 KiB project-instruction discovery limit.

## WRITTEN, NOT PROVEN

- `AGENTS.md` now assigns decomposition, worker contracts, isolation, integration, and Mason-facing status to the coordinating agent.
- It preserves Sol High ownership of critical architecture and final review while permitting lower-cost workers for bounded implementation and scans.
- It makes Spark or any other named worker conditional on what the current session actually exposes rather than promising an unverified route.

## NOT STARTED

- No project-specific `.codex/agents/*.toml` roles were added. Native generic workers and the existing global defaults should be tried first.
- No Spark subagent was spawned during this policy edit. A future narrow pilot may test it if the active session exposes Spark directly or through a supported custom-agent configuration.
- This was not a full application, test-coverage, CI, or database audit; the pasted ChatGPT handoff is broader than the requested `AGENTS.md` brainstorming/edit.

## APPROVAL STATE

Mason requested help brainstorming this setup and editing `AGENTS.md`, which authorizes the reversible repository edit and normal protected delivery path. This handoff grants no new permission to force-push, delete data, change permissions or secrets, deploy an edge function, or apply a live migration.

## GATES AND BLOCKERS

- Completed locally: exact-diff inspection, documentation checks, agent-workflow checks, agent health, and instruction-size verification.
- Required before delivery: obtain a separate review of the exact head commit.
- Required before merge: all existing CRX branch-protection, CodeRabbit, exact-SHA review, CI, and Vercel rules remain unchanged.
- Current blocker: none.

## FIRST ACTION

Review the new `AGENTS.md` section for duplication or conflict, then run the focused documentation and agent-workflow verification suite.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
