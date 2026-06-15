#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkClaudeAuth,
  checkCodexAuth,
  checkCodexSessionStartSyncsHooks,
  checkFilesPresent,
  compareSyncedFiles,
  summarizeChecks,
} from "./agent-health-check.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "crx-agent-health-"));

try {
  for (const dir of [
    ".claude/commands",
    ".claude/skills/claude-review",
    ".agents/skills/claude-review",
    ".codex",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  writeFileSync(path.join(root, ".claude/commands/claude-review.md"), "review command");
  writeFileSync(path.join(root, ".claude/skills/claude-review/SKILL.md"), "same");
  writeFileSync(path.join(root, ".agents/skills/claude-review/SKILL.md"), "same");

  const present = checkFilesPresent(root, [
    ".claude/commands/claude-review.md",
    ".claude/skills/claude-review/SKILL.md",
    ".agents/skills/claude-review/SKILL.md",
  ]);
  assert.equal(present.every((check) => check.status === "PASS"), true);

  const synced = compareSyncedFiles(root, [
    [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"],
  ]);
  assert.equal(synced[0].status, "PASS");

  const staleHooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\CRX_Manager\\.codex\\sync-from-claude.ps1'",
            },
          ],
        },
      ],
    },
  };
  const freshHooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\CRX_Manager\\.codex\\sync-from-claude.ps1' -IncludeHooks",
            },
          ],
        },
      ],
    },
  };

  assert.equal(checkCodexSessionStartSyncsHooks(staleHooks).status, "FAIL");
  assert.equal(checkCodexSessionStartSyncsHooks(freshHooks).status, "PASS");

  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "WARN" },
    ]).exitCode,
    0,
  );
  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "FAIL" },
    ]).exitCode,
    1,
  );

  // ── CLI auth smokes (not just --version) ────────────────────────────────
  // Each scenario gets its OWN fresh temp home so every assertion is fully
  // independent (no shared mutable state between the Codex and Claude blocks).
  const tmpHomes = [];
  const freshHome = () => {
    const h = mkdtempSync(path.join(os.tmpdir(), "crx-auth-"));
    tmpHomes.push(h);
    return h;
  };
  const withCodexAuth = (contents) => {
    const h = freshHome();
    mkdirSync(path.join(h, ".codex"), { recursive: true });
    writeFileSync(path.join(h, ".codex", "auth.json"), contents);
    return h;
  };
  const withClaudeCreds = (contents) => {
    const h = freshHome();
    mkdirSync(path.join(h, ".claude"), { recursive: true });
    writeFileSync(path.join(h, ".claude", ".credentials.json"), contents);
    return h;
  };
  try {
    // Codex auth — tokens present (non-empty) → PASS
    assert.equal(checkCodexAuth(withCodexAuth(JSON.stringify({ tokens: { access_token: "x" } })), {}).status, "PASS");
    // Codex auth — OPENAI_API_KEY present → PASS
    assert.equal(checkCodexAuth(withCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" })), {}).status, "PASS");
    // Codex auth — file missing → FAIL
    assert.equal(checkCodexAuth(freshHome(), {}).status, "FAIL");
    // Codex auth — present but empty → FAIL (a --version-only smoke would have missed this)
    assert.equal(checkCodexAuth(withCodexAuth("{}"), {}).status, "FAIL");
    // Codex auth — empty tokens object → FAIL (codex itself errors "missing field id_token")
    assert.equal(checkCodexAuth(withCodexAuth(JSON.stringify({ tokens: {} })), {}).status, "FAIL");
    // Codex auth — auth_mode set but NO token/key → FAIL (auth_mode is a mode selector, not a credential)
    assert.equal(checkCodexAuth(withCodexAuth(JSON.stringify({ auth_mode: "apikey" })), {}).status, "FAIL");
    // Codex auth — malformed JSON → FAIL (catch branch)
    assert.equal(checkCodexAuth(withCodexAuth("{ not json"), {}).status, "FAIL");
    // Codex auth — CODEX_HOME takes precedence: creds there → PASS even if `home` is logged out
    {
      const codexHome = freshHome();
      writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
      assert.equal(checkCodexAuth(freshHome(), { CODEX_HOME: codexHome }).status, "PASS");
      // …and a CODEX_HOME with no auth.json → FAIL even though `home` would have passed
      const loggedInHome = withCodexAuth(JSON.stringify({ tokens: { access_token: "x" } }));
      assert.equal(checkCodexAuth(loggedInHome, { CODEX_HOME: freshHome() }).status, "FAIL");
    }

    // Claude auth — ANTHROPIC_API_KEY env → PASS
    assert.equal(checkClaudeAuth(freshHome(), { ANTHROPIC_API_KEY: "x" }).status, "PASS");
    // Claude auth — CLAUDE_CODE_OAUTH_TOKEN env → PASS
    assert.equal(checkClaudeAuth(freshHome(), { CLAUDE_CODE_OAUTH_TOKEN: "y" }).status, "PASS");
    // Claude auth — claudeAiOauth creds → PASS
    assert.equal(checkClaudeAuth(withClaudeCreds(JSON.stringify({ claudeAiOauth: { accessToken: "x" } })), {}).status, "PASS");
    // Claude auth — mcpOAuth-only → WARN (connector/MCP tokens are NOT Claude CLI login)
    assert.equal(checkClaudeAuth(withClaudeCreds(JSON.stringify({ mcpOAuth: { server: {} } })), {}).status, "WARN");
    // Claude auth — present-but-empty creds → WARN
    assert.equal(checkClaudeAuth(withClaudeCreds("{}"), {}).status, "WARN");
    // Claude auth — nothing detectable → WARN (not FAIL — may be OS keychain)
    assert.equal(checkClaudeAuth(freshHome(), {}).status, "WARN");
    // Claude auth — CLAUDE_CONFIG_DIR honored
    {
      const cfgDir = freshHome();
      writeFileSync(path.join(cfgDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
      assert.equal(checkClaudeAuth(freshHome(), { CLAUDE_CONFIG_DIR: cfgDir }).status, "PASS");
    }
  } finally {
    for (const h of tmpHomes) rmSync(h, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("OK - agent-health-check helpers passed.");
