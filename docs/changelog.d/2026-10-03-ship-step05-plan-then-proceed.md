## 2026-10-03 — `/ship` Step 0.5: Claude plans, then proceeds

Follow-up on the same PR as `2026-10-03-slim-agent-guidance.md`, for a Codex GitHub App P2 finding on `aa179ad2b`.

- `.claude/commands/ship.md` Step 0.5 told Claude to show Mason the plan and wait for his confirmation before coding, which it called "Claude's checkpoint". It now says: post the plan, then proceed without waiting, for Claude and Codex alike. If Mason says "stop", stop at once; hard-gated actions still need his explicit approval. Mason approved this file in chat after the auto-mode classifier refused the first attempt. This closes the "Not verified" item in `2026-10-03-pr876-coderabbit-round-2-fixes.md`.
- `scripts/check-agent-guidance.mjs` pins the new Step 0.5 wording and fails if "Claude's checkpoint" returns.

**Proof observed:**
- `check-agent-guidance`: all PASS, including the new pin.
- `sync-agent-workflows --write`: no adapter change needed.
- `test:agent-workflows` and `check-doc-drift`: exit 0.

**Not verified:** no live `/ship` run was watched with the new wording.
