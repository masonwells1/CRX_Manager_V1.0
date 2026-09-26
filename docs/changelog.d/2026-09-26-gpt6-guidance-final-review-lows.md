## 2026-09-26 — close the three LOW findings from the clean Opus review of the GPT-6 guidance change

Follow-up to `2026-09-25-gpt6-guidance-readiness-review.md` (PR #797). The third independent Opus
review of the exact PR head (`9521e6a7`) returned CLEAN — no BLOCKER, HIGH, or MED — with three LOW
findings, all fixed here:

- `.claude/commands/codex-gauntlet.md` — the scope step said "choose exactly one" of `--base`,
  `--uncommitted`, or `--commit`, while the previous fix told the agent to review committed and
  uncommitted work "together", which one `codex review` run cannot do. It now says "choose one per
  run" and, for mixed work, runs two passes (`--base origin/main`, then `--uncommitted`).
- `.claude/settings.json` — the deny list adds the Vercel tools that can block or unblock a
  deployment check (`create_check`, `update_check`, `rerequest_check`, the two deployment check-run
  tools), return a protection-bypass link (`get_access_to_vercel_url`), upload files or blobs,
  change a session network policy, or retry a CI run. Deny only; nothing added to `allow` or `ask`.
- The earlier changelog entry loses a duplicated sentence and now records all three review rounds.

**Proof observed (cloud session):** `npm run test:agent-workflows` passed; all 53 top-level hook and
script test files passed; `scripts/check-doc-drift.mjs` passed; the 37 Codex adapters re-synced.

**Not verified here:** no Codex review ran (no Codex CLI in the cloud container). Mason chose to rely
on the Opus reviews for this documentation and guardrail-text change.
