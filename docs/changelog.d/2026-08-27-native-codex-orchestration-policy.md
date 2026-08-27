## 2026-08-27 — Define native Codex multi-agent orchestration

Added a concise CRX-specific `AGENTS.md` policy that makes the Codex coordinating agent own task decomposition, bounded worker contracts, worktree isolation, integration, and one Mason-facing status. The policy explicitly leaves Claude's canonical workflows and model routing unchanged, prefers native Codex capabilities, keeps critical architecture and final review with Sol High, limits ad-hoc parallel workers, and preserves all existing exact-commit review and protected delivery gates.

Added a verified setup handoff recording the current Codex capability evidence, the intentional decision not to add speculative custom-agent infrastructure, and the remaining delivery gate.

Proof observed: `npm run check:docs`, `npm run test:agent-workflows`, `npm run agent-health`, and the direct workflow check all passed. Agent health retained one unrelated existing warning that the schema registry trails one migration on disk. The combined global and project agent guidance is 30,290 bytes, below Codex's default 32 KiB discovery limit.

Not verified: no Spark or other subagent was spawned for this policy-only edit, and no application, production, or live database behavior changed.
