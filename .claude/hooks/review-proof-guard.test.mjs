#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-proof-guard.mjs");

function run(payload) {
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

for (const payload of [
  { tool_name: "Write", tool_input: { file_path: ".claude/session-state/claude-review-push.json", content: "{}" } },
  { tool_name: "Edit", tool_input: { file_path: "C:\\repo\\.claude\\session-state\\codex-review-abc.json" } },
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude/session-state/claude-review-push.json" } },
  { tool_name: "Bash", tool_input: { command: "echo {} > .claude/session-state/claude-review-push.json" } },
  { tool_name: "PowerShell", tool_input: { command: "Remove-Item .claude/session-state/codex-review-abc.json" } },
  { tool_name: "Bash", tool_input: { command: "cd .claude/session-state" } },
  { tool_name: "Bash", cwd: "C:\\repo\\.claude\\session-state", tool_input: { command: "printf {} > harmless-name.json" } },
  { tool_name: "Bash", tool_input: { command: "printf {} > codex-review-forged.json" } },
  // Codex round-4: patch-style payloads carry the destination in free-form text.
  { tool_name: "apply_patch", tool_input: { patch: "*** Add File: .claude/session-state/claude-review-push.json\n+{}" } },
  { tool_name: "mcp__codex__apply_patch", tool_input: { input: "*** Update File: .claude/session-state/codex-review-abc.json" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
}

assert.equal(run({ tool_name: "Write", tool_input: { file_path: "docs/review.md", content: "ok" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "node scripts/run-claude-review.mjs --scope base-main" } }).stdout, "");

console.log("OK - review proof guard checks passed.");
