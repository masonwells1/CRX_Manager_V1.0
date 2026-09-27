## 2026-09-26 — Codex review of #794: a peer's dangling fence can no longer clear Mason's hold

The post-merge Codex review of PR #794 (Codex GitHub App, P1) found a peer-only message
that cleared a hold the pre-#794 parser kept: a fake `</cross-session-message>` followed by
an unclosed fence. #794's unclosed-fence give-back returned the peer's tail in both strip
orders, so `hasAuthoredText()` read it as Mason speaking and `hold-latch-prompt.mjs`
deleted `hold.json`.

Fix (`.claude/hooks/prompt-source-lib.mjs`): `hasAuthoredText()` now also requires
`stripPre794()` — the parser exactly as it was before #794 (unclosed fence dropped to the
end) — to leave text. Clearing a hold is therefore never easier than before #794.
`authoredByMason()` is unchanged, so halt detection is unchanged.

### Proof observed

- `prompt-hooks.test.mjs`: 275/275 with current `main` merged in (260/260 on the fix
  commit alone; #797 added 15), including the Codex prompt end to end (hold stays
  latched) and the same shape carrying `stop` still latching.
- `npm run test:correction-guards` passes.
- Fuzz, 400,000 random prompts: 0 where this version clears a hold that the pre-#794
  parser kept; 0 where `authoredByMason()` differs from merged main.

### Trade-off

A non-hold message Mason types below a peer's unfinished fence no longer clears his hold
(same as before #794). That is fail-safe: his next plain message clears it.
