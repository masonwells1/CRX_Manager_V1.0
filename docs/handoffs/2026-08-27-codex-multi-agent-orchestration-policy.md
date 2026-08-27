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
- The combined global and project `AGENTS.md` files total 30,290 bytes, below Codex's default 32 KiB project-instruction discovery limit.
- The first exact-head `gpt-5.6-sol` High review returned clean for commit `8083d4c56fdc0e2a11149822000bcf2c0d04e068`. GitHub review then found two follow-up documentation issues: scope the three-worker cap to ad-hoc Codex delegation, and state the exact-head review gate consistently. Both findings were corrected in `22460092e7d0e68c9b589c8046f2a8c71f5775c3`, which then passed a fresh exact-head Sol High review.
- A latest-commit GitHub Codex review identified one additional valid issue: because Claude imports this shared file, the Codex-specific worker and model-routing section also needed an explicit Codex-only scope. CodeRabbit's fresh latest-head review cleared its earlier change request without adding a new finding.

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

- Completed on the first commit: exact-diff inspection, documentation checks, agent-workflow checks, agent health, instruction-size verification, and a clean exact-head Sol High review.
- Current blocker: the Codex-only scoping fix requires focused checks and a fresh separate exact-head review before delivery.
- Required before merge: all existing CRX branch-protection, CodeRabbit, exact-SHA review, CI, and Vercel rules remain unchanged.

## FIRST ACTION

Run the focused documentation and agent-workflow checks on the Codex-only scoping fix, then obtain a fresh exact-head review before pushing it.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
