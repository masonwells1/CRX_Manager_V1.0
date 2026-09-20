## 2026-09-19 - Codex reviewer sandbox: deny the active Codex config.toml

**What changed.** `config.toml` can hold inline MCP headers, environment values, and other credentials. `--ignore-user-config` stops Codex loading it as configuration, but it does not stop a model-issued command from opening it under the Windows `:root = read` profile. The deny list now covers `~/.codex/config.toml` and the active `CODEX_HOME` `config.toml` alongside `auth.json`.

Found by the Codex connector on PR #725 at head 04d426914.

**Proof.** A canary through the real `buildCodexExecArgs` on Codex 0.155 (48 s) reported `codex-config: DENIED` along with the other 14 deny paths. `~/.claude/settings.json`, the packet and `package.json` stayed readable; writes and network stayed blocked. Both reviewer test files pass.
