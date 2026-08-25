#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaudeHookRefs, hookManifestParity } from "./agent-manifest-parity.mjs";

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
  ".claude/hooks/review-proof-guard.mjs",
  "scripts/run-claude-review.mjs",
  "scripts/post-agent-review-to-pr.mjs",
  "scripts/sync-agent-workflows.mjs",
  "scripts/check-agent-guidance.mjs",
  "scripts/agent-health-check.mjs",
  // Shared by the two mirror comparisons above. Listed so deleting it reports a
  // clean "missing required file" instead of an ESM resolution crash.
  "scripts/normalize-eol.mjs",
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
requireIncludes(".claude/settings.json", claudeSettingsText, "review-proof-guard.mjs");
requireIncludes(".codex/hooks.json", codexHooksText, "review-proof-guard.mjs");
requireIncludes(".codex/hooks.json", codexHooksText, "production-action-guard.mjs");
// Scope to the [mcp_servers.supabase] url line, parsed line-by-line so a
// commented heading, a commented url, a backup_url key, or a url in a later
// TOML table can never satisfy the check; the read_only flag is matched at
// query-parameter boundaries so read_only=false0 / other_read_only=false fail.
let codexSupabaseUrl = "";
{
  let inSupabase = false;
  for (const line of (contents.get(".codex/config.toml") || "").split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) { inSupabase = heading[1].trim() === "mcp_servers.supabase"; continue; }
    if (!inSupabase) continue;
    const url = line.match(/^\s*url\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (url) { codexSupabaseUrl = url[1]; break; }
  }
}
if (/[?&]read_only=false(?:&|$)/.test(codexSupabaseUrl) && !/[?&]read_only=true(?:&|$)/.test(codexSupabaseUrl)) {
  pass(".codex/config.toml supabase url declares read_only=false");
} else {
  fail(".codex/config.toml supabase url declares read_only=false");
}
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
// Require the PASS line, not just exit 0. A subprocess that does NOTHING also
// exits 0, so keying off the status alone turns any future silent no-op in the
// generator into a green "synced" that checked nothing. That is not theoretical:
// sync-agent-workflows.mjs guards its CLI behind an entry-point comparison, and a
// mis-detect there would produce exactly this - no output, exit 0, reported PASS.
if (sync.status === 0 && /^PASS - \d+ Codex workflow file\(s\) match/m.test(sync.stdout)) {
  pass("Codex workflow adapters are synced", sync.stdout.trim().split(/\r?\n/)[0]);
} else if (sync.status === 0) {
  fail(
    "Codex workflow adapters are synced",
    `--check exited 0 without its PASS line (produced ${sync.stdout.trim() ? "unexpected output" : "no output"}) — the generator may not have run at all`,
  );
} else {
  fail("Codex workflow adapters are synced", (sync.stderr || sync.stdout).trim().split(/\r?\n/)[0]);
}

// Hook-manifest parity: the two manifests wire the SAME shared .claude/hooks/
// implementations, and a NEW Claude-side guard that isn't also wired for Codex
// (or explicitly declared Claude-only) would silently never fire for Codex.
const parity = hookManifestParity({
  claudeHooks: extractClaudeHookRefs(claudeSettingsText),
  codexHooks: extractClaudeHookRefs(codexHooksText),
});
if (parity.ok) pass("Hook manifests are in parity (or explicitly one-sided)");
else {
  const parts = [];
  if (parity.claudeOnlyUnexpected.length) parts.push(`Claude-only, undeclared: ${parity.claudeOnlyUnexpected.join(", ")} — wire in .codex/hooks.json, or add to CLAUDE_ONLY_HOOKS in scripts/agent-manifest-parity.mjs with the reason`);
  if (parity.codexOnlyUnexpected.length) parts.push(`Codex-only, undeclared: ${parity.codexOnlyUnexpected.join(", ")} — wire in .claude/settings.json, or add to CODEX_ONLY_HOOKS`);
  fail("Hook manifests are in parity (or explicitly one-sided)", parts.join(" | "));
}

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
