## 2026-09-08 — PR #605: the overnight handshake pauses every editor, not three of four

GitHub Codex (P2 on `df8f2442a`): with a fresh `OVERNIGHT-INTENT.flag` and autopilot NOT yet
armed, `overnightGateDecision()` paused `Write`, `Edit` and `NotebookEdit` but not `MultiEdit`,
so under `acceptEdits` a hands-free run could rewrite ordinary source before completing the
arm handshake. Probe-confirmed against the previous lib (`allow-through`).

Fix by class rather than by name: the unarmed branch now covers all four native editors,
every tool already in the armed deny-set (`DENY_TOOLNAME_RE` — armed mode is the more
permissive one, so nothing it refuses may pass unarmed), and MCP file writers by shape
(`write_file`, `edit_file`, `create_directory`, `move_file`, …). Reads (`read_file`,
`list_directory`) and the session-state carve-out are unchanged.

Proof: eleven new handshake cases in `autopilot-lib.test.mjs` (the previous lib fails at
`PROVEN BYPASS: MultiEdit blocked until armed`); the real hook probed with a fresh intent flag
and no arm flag in a temp project — the previous hook emitted nothing for `MultiEdit`, the
new one emits the handshake deny. `docs/reference/agent-guardrails.md` names the class.
