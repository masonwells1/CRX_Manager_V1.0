## 2026-09-05 — Guardrails reference now says `set_config_value` is denied (Codex P2 on PR #605)

The GitHub Codex reviewer flagged `docs/reference/agent-guardrails.md` on PR #605's head
`19cc679b6`: the mcp-tool-guard row said `set_config_value` "is now allowed", while the same PR
puts `mcp__Desktop_Commander__set_config_value` in `permissions.deny`, and the hook header and the
`2026-09-05-claude-settings-explicit-mcp-grants.md` entry both say denied. The reference doc is what
agents read to understand the boundary, so the contradiction is fixed here: it now says the tool
sits in `deny` alongside the other Desktop Commander mutators.

Documentation only. No settings, hook, or logic change.
