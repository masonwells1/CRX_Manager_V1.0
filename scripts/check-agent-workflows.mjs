#!/usr/bin/env node
// Local guard for CRX agent workflow handoffs.
// It verifies the Codex-to-Claude handoff source exists in .claude and that the
// local Codex-facing skill copy has been synced from Claude.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const checks = [];

function pass(name, note = "") {
  checks.push({ name, status: "PASS", note });
}

function fail(name, note = "") {
  checks.push({ name, status: "FAIL", note });
}

function read(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
}

// Is the machine-local Codex/agents mirror present AT ALL? The .codex/ and .agents/
// trees are gitignored (populated by .codex/sync-from-claude.ps1), so they are
// entirely absent in CI / a clean checkout. When the mirror is absent its files
// are optional (skip); when it IS present, a MISSING mirror file is a real
// partial-sync failure — don't let a half-synced mirror pass silently.
const codexMirrorPresent =
  existsSync(path.join(root, ".codex")) || existsSync(path.join(root, ".agents"));

function requireFile(rel) {
  const content = read(rel);
  if (content === null) {
    if ((rel.startsWith(".codex/") || rel.startsWith(".agents/")) && !codexMirrorPresent) {
      return null; // clean checkout: no mirror at all → optional
    }
    fail(rel, "missing");
    return null;
  }
  pass(rel, "present");
  return content;
}

function requireIncludes(rel, content, needle) {
  if (content?.includes(needle)) {
    pass(`${rel} includes ${needle}`);
  } else {
    fail(`${rel} includes ${needle}`);
  }
}

const commandPath = ".claude/commands/codex-to-claude-handoff.md";
const claudeSkillPath = ".claude/skills/codex-to-claude-handoff/SKILL.md";
const codexSkillPath = ".agents/skills/codex-to-claude-handoff/SKILL.md";
const claudeHookPath = ".claude/hooks/codex-to-claude-handoff-reminder.mjs";
const claudeHookTestPath = ".claude/hooks/codex-to-claude-handoff-reminder.test.mjs";
const codexHookPath = ".codex/hooks/codex-to-claude-handoff-reminder.mjs";
const claudeReviewCommandPath = ".claude/commands/claude-review.md";
const claudeReviewSkillPath = ".claude/skills/claude-review/SKILL.md";
const codexClaudeReviewSkillPath = ".agents/skills/claude-review/SKILL.md";
const pairReviewCommandPath = ".claude/commands/agent-pair-review.md";
const pairReviewSkillPath = ".claude/skills/agent-pair-review/SKILL.md";
const codexPairReviewSkillPath = ".agents/skills/agent-pair-review/SKILL.md";
const pairReviewHookPath = ".claude/hooks/agent-pair-review-reminder.mjs";
const pairReviewHookTestPath = ".claude/hooks/agent-pair-review-reminder.test.mjs";
const codexPairReviewHookPath = ".codex/hooks/agent-pair-review-reminder.mjs";
const agentHealthCommandPath = ".claude/commands/agent-health.md";
const agentHealthSkillPath = ".claude/skills/agent-health/SKILL.md";
const codexAgentHealthSkillPath = ".agents/skills/agent-health/SKILL.md";
const agentPrCommentCommandPath = ".claude/commands/agent-pr-comment.md";
const agentPrCommentSkillPath = ".claude/skills/agent-pr-comment/SKILL.md";
const codexAgentPrCommentSkillPath = ".agents/skills/agent-pr-comment/SKILL.md";

const command = requireFile(commandPath);
const claudeSkill = requireFile(claudeSkillPath);
const codexSkill = requireFile(codexSkillPath);
const claudeHook = requireFile(claudeHookPath);
const claudeHookTest = requireFile(claudeHookTestPath);
const codexHook = requireFile(codexHookPath);
const claudeReviewCommand = requireFile(claudeReviewCommandPath);
const claudeReviewSkill = requireFile(claudeReviewSkillPath);
const codexClaudeReviewSkill = requireFile(codexClaudeReviewSkillPath);
const pairReviewCommand = requireFile(pairReviewCommandPath);
const pairReviewSkill = requireFile(pairReviewSkillPath);
const codexPairReviewSkill = requireFile(codexPairReviewSkillPath);
const pairReviewHook = requireFile(pairReviewHookPath);
const pairReviewHookTest = requireFile(pairReviewHookTestPath);
const codexPairReviewHook = requireFile(codexPairReviewHookPath);
const agentHealthCommand = requireFile(agentHealthCommandPath);
const agentHealthSkill = requireFile(agentHealthSkillPath);
const codexAgentHealthSkill = requireFile(codexAgentHealthSkillPath);
const agentPrCommentCommand = requireFile(agentPrCommentCommandPath);
const agentPrCommentSkill = requireFile(agentPrCommentSkillPath);
const codexAgentPrCommentSkill = requireFile(codexAgentPrCommentSkillPath);
const runClaudeReviewScript = requireFile("scripts/run-claude-review.mjs");
const runClaudeReviewTest = requireFile("scripts/run-claude-review.test.mjs");
const agentHealthScript = requireFile("scripts/agent-health-check.mjs");
const agentHealthTest = requireFile("scripts/agent-health-check.test.mjs");
const prCommentScript = requireFile("scripts/post-agent-review-to-pr.mjs");
const prCommentTest = requireFile("scripts/post-agent-review-to-pr.test.mjs");
const claudeSettings = requireFile(".claude/settings.json");
const codexHooksJson = requireFile(".codex/hooks.json");
const packageJson = requireFile("package.json");

requireIncludes(commandPath, command, "docs/audits/<YYYY-MM-DD>-codex-to-claude-<short-slug>-handoff.md");
requireIncludes(commandPath, command, "Codex's Current Position");
requireIncludes(commandPath, command, "Questions For Claude");
requireIncludes(commandPath, command, "Anti-Prompt-Injection Note");
requireIncludes(commandPath, command, "Do not push, deploy, apply live migrations, delete data, or commit");
requireIncludes(commandPath, command, "prefer `claude-review` first");

requireIncludes(claudeSkillPath, claudeSkill, "name: codex-to-claude-handoff");
requireIncludes(claudeSkillPath, claudeSkill, "C:\\CRX_Manager\\.claude\\commands\\codex-to-claude-handoff.md");
requireIncludes(claudeSkillPath, claudeSkill, "durable handoff");
requireIncludes(claudeSkillPath, claudeSkill, "prefer the `claude-review` skill first");

requireIncludes(claudeHookPath, claudeHook, "CRX Codex-to-Claude Handoff/Review reminder:");
requireIncludes(claudeHookPath, claudeHook, "claude-review.md");
requireIncludes(claudeHookPath, claudeHook, "codex-to-claude-handoff.md");
requireIncludes(claudeHookPath, claudeHook, "Do not push, deploy, apply live migrations, delete data, or commit");
requireIncludes(claudeHookTestPath, claudeHookTest, "let Claude review this");
requireIncludes(claudeHookTestPath, claudeHookTest, "have Claude look at this");
requireIncludes(claudeHookTestPath, claudeHookTest, "ask Claude to check this");

requireIncludes(claudeReviewCommandPath, claudeReviewCommand, "node scripts/run-claude-review.mjs");
requireIncludes(claudeReviewCommandPath, claudeReviewCommand, ".claude/session-state/claude-review-latest.txt");
requireIncludes(claudeReviewCommandPath, claudeReviewCommand, "Do not push, deploy, apply live migrations, delete data, or commit");
requireIncludes(claudeReviewSkillPath, claudeReviewSkill, "name: claude-review");
requireIncludes(claudeReviewSkillPath, claudeReviewSkill, "run-claude-review.mjs");
requireIncludes("scripts/run-claude-review.mjs", runClaudeReviewScript, "Do not write, edit, commit, push, deploy, apply migrations, or delete data");
requireIncludes("scripts/run-claude-review.test.mjs", runClaudeReviewTest, "buildClaudeReviewPrompt");

requireIncludes(pairReviewCommandPath, pairReviewCommand, "agent-pair-review");
requireIncludes(pairReviewCommandPath, pairReviewCommand, "agree/disagree/needs more evidence");
requireIncludes(pairReviewCommandPath, pairReviewCommand, "node scripts/run-claude-review.mjs");
requireIncludes(pairReviewSkillPath, pairReviewSkill, "name: agent-pair-review");
requireIncludes(pairReviewSkillPath, pairReviewSkill, "two-model review");
requireIncludes(pairReviewHookPath, pairReviewHook, "CRX Agent Pair Review reminder:");
requireIncludes(pairReviewHookPath, pairReviewHook, "agent-pair-review.md");
requireIncludes(pairReviewHookTestPath, pairReviewHookTest, "have both Codex and Claude review this");

requireIncludes(agentHealthCommandPath, agentHealthCommand, "node scripts/agent-health-check.mjs");
requireIncludes(agentHealthCommandPath, agentHealthCommand, "npm run test:agent-workflows");
requireIncludes(agentHealthSkillPath, agentHealthSkill, "name: agent-health");
requireIncludes("scripts/agent-health-check.mjs", agentHealthScript, "checkCodexSessionStartSyncsHooks");
requireIncludes("scripts/agent-health-check.test.mjs", agentHealthTest, "checkCodexSessionStartSyncsHooks");

requireIncludes(agentPrCommentCommandPath, agentPrCommentCommand, "post-agent-review-to-pr.mjs");
requireIncludes(agentPrCommentCommandPath, agentPrCommentCommand, "--dry-run");
requireIncludes(agentPrCommentCommandPath, agentPrCommentCommand, "--confirm");
requireIncludes(agentPrCommentSkillPath, agentPrCommentSkill, "name: agent-pr-comment");
requireIncludes("scripts/post-agent-review-to-pr.mjs", prCommentScript, "Default is safe dry-run");
requireIncludes("scripts/post-agent-review-to-pr.test.mjs", prCommentTest, "buildPrCommentBody");

requireIncludes(".claude/settings.json", claudeSettings, "codex-to-claude-handoff-reminder.mjs");
requireIncludes(".claude/settings.json", claudeSettings, "agent-pair-review-reminder.mjs");
requireIncludes(".claude/settings.json", claudeSettings, "codex-gauntlet-reminder.mjs");
if (codexHooksJson !== null) {
  // Only when the machine-local Codex hook mirror is present (skipped in CI / clean checkouts).
  requireIncludes(".codex/hooks.json", codexHooksJson, "codex-to-claude-handoff-reminder.mjs");
  requireIncludes(".codex/hooks.json", codexHooksJson, "agent-pair-review-reminder.mjs");
  // The gauntlet reminder ("is this safe to ship?") must be mirrored to Codex too —
  // otherwise a stale mirror missing only it would still pass while Codex never prompts.
  requireIncludes(".codex/hooks.json", codexHooksJson, "codex-gauntlet-reminder.mjs");
  requireIncludes(".codex/hooks.json", codexHooksJson, "-IncludeHooks");
}

if (claudeSkill !== null && codexSkill !== null) {
  if (claudeSkill === codexSkill) {
    pass("Codex skill copy is synced from Claude");
  } else {
    fail("Codex skill copy is synced from Claude", "run .codex\\sync-from-claude.ps1");
  }
}

for (const [source, copy, label] of [
  [claudeReviewSkill, codexClaudeReviewSkill, "Claude review skill copy is synced from Claude"],
  [pairReviewSkill, codexPairReviewSkill, "Agent pair review skill copy is synced from Claude"],
  [agentHealthSkill, codexAgentHealthSkill, "Agent health skill copy is synced from Claude"],
  [agentPrCommentSkill, codexAgentPrCommentSkill, "Agent PR comment skill copy is synced from Claude"],
]) {
  if (source !== null && copy !== null) {
    if (source === copy) {
      pass(label);
    } else {
      fail(label, "run .codex\\sync-from-claude.ps1");
    }
  }
}

if (claudeHook !== null && codexHook !== null) {
  if (claudeHook === codexHook) {
    pass("Codex hook copy is synced from Claude");
  } else {
    fail("Codex hook copy is synced from Claude", "run .codex\\sync-from-claude.ps1 -IncludeHooks");
  }
}

if (pairReviewHook !== null && codexPairReviewHook !== null) {
  if (pairReviewHook === codexPairReviewHook) {
    pass("Codex pair review hook copy is synced from Claude");
  } else {
    fail("Codex pair review hook copy is synced from Claude", "run .codex\\sync-from-claude.ps1 -IncludeHooks");
  }
}

try {
  const scripts = JSON.parse(packageJson).scripts || {};
  if (scripts["check:agent-workflows"] === "node scripts/check-agent-workflows.mjs") {
    pass("package.json check:agent-workflows script");
  } else {
    fail("package.json check:agent-workflows script");
  }
  if (scripts["test:agent-workflows"] === "node .claude/hooks/codex-gauntlet-reminder.test.mjs && node .claude/hooks/codex-to-claude-handoff-reminder.test.mjs && node .claude/hooks/agent-pair-review-reminder.test.mjs && node scripts/run-claude-review.test.mjs && node scripts/agent-health-check.test.mjs && node scripts/post-agent-review-to-pr.test.mjs && node scripts/check-agent-workflows.mjs") {
    pass("package.json test:agent-workflows script");
  } else {
    fail("package.json test:agent-workflows script");
  }
  if (scripts["agent-health"] === "node scripts/agent-health-check.mjs") {
    pass("package.json agent-health script");
  } else {
    fail("package.json agent-health script");
  }
} catch (error) {
  fail("package.json parse", error.message);
}

console.log("check-agent-workflows");
for (const check of checks) {
  console.log(`${check.status.padEnd(4)} ${check.name}${check.note ? ` - ${check.note}` : ""}`);
}

const failed = checks.filter((check) => check.status === "FAIL");
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log("PASS - agent workflows are present and synced.");
