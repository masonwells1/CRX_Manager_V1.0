#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("OK - agent-health-check helpers passed.");
