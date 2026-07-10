#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const checks = [];
const pass = (name, note = "") => checks.push({ status: "PASS", name, note });
const fail = (name, note = "") => checks.push({ status: "FAIL", name, note });

function requireFile(relative) {
  const full = path.join(ROOT, relative);
  if (!existsSync(full)) {
    fail(relative, "missing");
    return null;
  }
  pass(relative, "present");
  return readFileSync(full, "utf8");
}

function requireIncludes(relative, content, expected) {
  if (content?.includes(expected)) pass(`${relative} contains ${expected}`);
  else fail(`${relative} contains ${expected}`);
}

const required = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/commands/claude-review.md",
  ".claude/commands/agent-pair-review.md",
  ".claude/commands/codex-to-claude-handoff.md",
  ".claude/commands/agent-health.md",
  ".claude/commands/agent-pr-comment.md",
  ".claude/commands/codex-gauntlet.md",
  ".claude/skills/claude-review/SKILL.md",
  ".claude/skills/agent-pair-review/SKILL.md",
  ".claude/skills/codex-to-claude-handoff/SKILL.md",
  ".claude/skills/agent-health/SKILL.md",
  ".claude/skills/agent-pr-comment/SKILL.md",
  ".claude/skills/codex-gauntlet/SKILL.md",
  ".agents/skills/claude-review/SKILL.md",
  ".agents/skills/agent-pair-review/SKILL.md",
  ".agents/skills/codex-to-claude-handoff/SKILL.md",
  ".agents/skills/agent-health/SKILL.md",
  ".agents/skills/agent-pr-comment/SKILL.md",
  ".agents/skills/codex-gauntlet/SKILL.md",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/hooks/codex-hook-adapter.mjs",
  ".codex/hooks/production-action-guard.mjs",
  "scripts/run-claude-review.mjs",
  "scripts/post-agent-review-to-pr.mjs",
  "scripts/sync-agent-workflows.mjs",
  "scripts/check-agent-guidance.mjs",
  "scripts/agent-health-check.mjs",
];
const contents = new Map(required.map((relative) => [relative, requireFile(relative)]));

const claudeSettingsText = contents.get(".claude/settings.json");
const codexHooksText = contents.get(".codex/hooks.json");
try {
  JSON.parse(claudeSettingsText);
  pass(".claude/settings.json parses");
} catch (error) {
  fail(".claude/settings.json parses", error.message);
}
try {
  JSON.parse(codexHooksText);
  pass(".codex/hooks.json parses");
} catch (error) {
  fail(".codex/hooks.json parses", error.message);
}

for (const reminder of [
  "codex-to-claude-handoff-reminder.mjs",
  "agent-pair-review-reminder.mjs",
  "codex-gauntlet-reminder.mjs",
]) {
  requireIncludes(".claude/settings.json", claudeSettingsText, reminder);
  requireIncludes(".codex/hooks.json", codexHooksText, reminder);
}

requireIncludes(".codex/hooks.json", codexHooksText, ".claude/hooks/sql-safety.mjs");
requireIncludes(".codex/hooks.json", codexHooksText, "production-action-guard.mjs");
requireIncludes(".codex/config.toml", contents.get(".codex/config.toml"), "read_only=true");
requireIncludes(".claude/commands/claude-review.md", contents.get(".claude/commands/claude-review.md"), "node scripts/run-claude-review.mjs");
requireIncludes(".claude/commands/agent-pr-comment.md", contents.get(".claude/commands/agent-pr-comment.md"), "--dry-run");
requireIncludes(".claude/commands/agent-pr-comment.md", contents.get(".claude/commands/agent-pr-comment.md"), "--confirm");
requireIncludes(".claude/commands/codex-gauntlet.md", contents.get(".claude/commands/codex-gauntlet.md"), "Do not push.");

const combinedWorkflowSources = [
  ...[...contents.entries()]
    .filter(([relative]) => relative.startsWith(".claude/commands/") || relative.startsWith(".claude/skills/"))
    .map(([, content]) => content || ""),
].join("\n");
if (/C:\\\\CRX_Manager|C:\/CRX_Manager/i.test(combinedWorkflowSources)) fail("Claude workflow sources are worktree portable", "hard-coded C:\\CRX_Manager found");
else pass("Claude workflow sources are worktree portable");

const sync = spawnSync(process.execPath, [path.join(ROOT, "scripts", "sync-agent-workflows.mjs"), "--check"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (sync.status === 0) pass("Codex workflow adapters are synced", sync.stdout.trim().split(/\r?\n/)[0]);
else fail("Codex workflow adapters are synced", (sync.stderr || sync.stdout).trim().split(/\r?\n/)[0]);

try {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {};
  for (const name of ["check:agent-guidance", "check:agent-workflows", "test:agent-workflows", "agent-health"]) {
    if (scripts[name]) pass(`package.json ${name} script`);
    else fail(`package.json ${name} script`, "missing");
  }
} catch (error) {
  fail("package.json parses", error.message);
}

console.log("check-agent-workflows");
for (const item of checks) console.log(`${item.status.padEnd(4)} ${item.name}${item.note ? ` - ${item.note}` : ""}`);
const failed = checks.filter((item) => item.status === "FAIL");
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} workflow check(s) failed.`);
  process.exit(1);
}
console.log("PASS - Claude and Codex workflows are present, portable, and synced.");
