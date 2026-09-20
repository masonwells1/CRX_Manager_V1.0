## 2026-09-19 - Codex reviewer sandbox: PR #725 follow-up

**What changed.** This closes the four P1 findings from the Codex connector on PR #725, plus Mason's request to deny Claude's credential files:

- The Windows deny list now also covers Claude's credentials (`~/.claude/.credentials.json`), `~/.claude.json`, the Claude desktop config, and the active `CODEX_HOME` `auth.json`. Before, only `~/.codex/auth.json` was covered.
- Symlinked or junctioned credential paths are denied at their real target instead of being skipped. The Claude desktop config turns out to live inside the Windows Store app folder, and the deny lands there.
- Linux and macOS keep the packet-only `:root = deny` profile. Only Codex 0.155's elevated Windows sandbox needs whole-disk read.
- `write-apply-proofs.mjs` now runs Codex with the same scrubbed environment as the push reviewer, so tokens in the operator's shell don't reach model commands. Its captures are also redacted.

**Proof.**
- A canary through the real `buildCodexExecArgs` on Codex 0.155 finished in 44 s. All 14 deny paths were blocked, including the three Claude files. `icacls` shows a `CodexSandboxUsers:(DENY)(R)` entry on the desktop config's real file.
- `~/.claude/settings.json`, the packet and the repo stayed readable. Writes and network stayed blocked.
- `node scripts/write-codex-push-proof.test.mjs` and `node scripts/write-apply-proofs.test.mjs` pass.
