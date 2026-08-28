## 2026-08-28 - Bind corrective reviews to the final commit

- Clarified that standing delivery authority waives only another in-chat approval, not GitHub's formal approval gate.
- Required corrected candidates to rerun checks and any applicable exact-HEAD Codex proof before the follow-up CodeRabbit review.
- Required the final CodeRabbit `APPROVED` review's `commit_id` to equal the PR's final `headRefOid` before merge.
- Aligned the top-level ship summary and Codex-review handoff with the same live-protection and proof-refresh rules.

Verification: the full agent-workflow suite, generated-adapter parity, documentation drift check,
deterministic ledger check, and whitespace check pass with these instructions.
