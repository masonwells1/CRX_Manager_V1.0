## 2026-09-27 — review-proof-guard: an unreadable tool call now warns instead of passing silently

`review-proof-guard.mjs` runs before every tool call (matcher `"*"`). When it could not read its input
(malformed, empty or truncated JSON, or a `null`, array or number payload) it exited 0 with no output,
the same result as a call it had checked and found safe, so a guard that had stopped working looked
healthy. This was open in `docs/manual/KNOWN_ISSUES.md` since 2026-09-02.

- The guard still fails OPEN there, deliberately: denying on a stdin glitch would lock every tool call,
  which is what retired `guarded-surface-lock`. It now fails open LOUDLY: a top-level `systemMessage`
  says the check was SKIPPED. No `allow` decision is emitted, because that would skip the normal
  permission prompt.
- `.codex/hooks/codex-hook-adapter.mjs` forwards a warning-only payload (exactly one key,
  `systemMessage`) to stderr, as it already did for warnings that come with an `allow`, and passes
  nothing to Codex as a decision. Any other output is still passed through unchanged.

**Proof observed (cloud session):** before the change, all six unreadable inputs and a harmless
`ls` produced identical empty output. After it, each unreadable input produces the warning and `ls`
stays silent. Through the real Codex adapter: the warning arrives on stderr, `ls` is silent, and a
write to `.claude/session-state/claude-review-push.json` is still denied. `review-proof-guard.test.mjs`
and `codex-hook-adapter.test.mjs` pass with the new cases, all 35 `.claude/hooks` and `.codex/hooks`
test files pass, and `npm run test:agent-workflows` passes.

An independent pre-review (no BLOCKER/HIGH/MED) led to three follow-ups in this change. The test now
requires the warning to be the only key. The message says the guard received unreadable input, not
that it is not running. `docs/reference/agent-guardrails.md` documents the behavior and the adapter's
forwarding.

**Not verified:** how the Claude Code or Codex desktop apps display the warning when a real harness
sends malformed input. That cannot be triggered on purpose, so only the hook's output was observed.
On Codex in particular, the warning reaches only stderr. If the Codex app does not show exit-0 hook
stderr, the fail-open is still quiet there (recorded as a residual in `docs/manual/KNOWN_ISSUES.md`).
