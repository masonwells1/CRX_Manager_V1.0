## 2026-09-30 — follow-up clearance wording matches the gate on empty reply artifacts

CodeRabbit's re-review of PR #836 (`53d14569`) noted that two live descriptions of the follow-up
clearance said it needs "nothing posted since" the approval. That is stricter than the gate:
`standingCodeRabbitApproval()` tolerates an empty `COMMENTED` reply artifact after the approval and
refuses only later substantive CodeRabbit content. Both lines now say "no later substantive
CodeRabbit content", and name the tolerated empty reply:

- `.claude/commands/ship.md` (the prod-landing line; the `.agents/` adapters were re-synced)
- `docs/reference/gotchas.md`

`docs/reference/agent-guardrails.md` already said "nothing CodeRabbit posted since carries content"
and is unchanged. Also clarified in `2026-09-30-coderabbit-review-836-doc-fixes.md`: the
`codex-review` skill's early *advisory* Sol round for complex work is separate from the final Sol
proof, which always runs after CodeRabbit clears the head. Wording only; no gate logic changed.
