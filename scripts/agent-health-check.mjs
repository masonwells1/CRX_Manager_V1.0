#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function check(status, name, note = "") {
  return { status, name, note };
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function checkFilesPresent(root, files) {
  return files.map((file) => (
    existsSync(path.join(root, file))
      ? check("PASS", file, "present")
      : check("FAIL", file, "missing")
  ));
}

export function compareSyncedFiles(root, pairs) {
  return pairs.map(([left, right]) => {
    const leftPath = path.join(root, left);
    const rightPath = path.join(root, right);
    if (!existsSync(leftPath) || !existsSync(rightPath)) {
      return check("FAIL", `${right} synced from ${left}`, "missing source or copy");
    }
    const matches = readFileSync(leftPath, "utf8") === readFileSync(rightPath, "utf8");
    return matches
      ? check("PASS", `${right} synced from ${left}`)
      : check("FAIL", `${right} synced from ${left}`, "run .codex\\sync-from-claude.ps1 -IncludeHooks");
  });
}

export function checkCodexSessionStartSyncsHooks(hooksJson) {
  const sessionStart = hooksJson?.hooks?.SessionStart || [];
  const commands = sessionStart
    .flatMap((entry) => entry.hooks || [])
    .map((hook) => String(hook.command || ""));
  const syncCommand = commands.find((command) => command.includes("sync-from-claude.ps1"));
  if (!syncCommand) {
    return check("FAIL", ".codex/hooks.json SessionStart sync", "sync-from-claude.ps1 not registered");
  }
  if (!syncCommand.includes("-IncludeHooks")) {
    return check("FAIL", ".codex/hooks.json SessionStart sync includes hooks", "add -IncludeHooks");
  }
  return check("PASS", ".codex/hooks.json SessionStart sync includes hooks");
}

function runCommand(name, command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: options.timeout || 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && options.shell !== false,
    }).trim();
    return check("PASS", name, output.split(/\r?\n/)[0] || "ok");
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message || "").trim().split(/\r?\n/)[0];
    return check(options.warn ? "WARN" : "FAIL", name, message || "not available");
  }
}

function resolveNewestCodexBinary(root = ROOT) {
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "OpenAI",
    "Codex",
    "bin",
  );
  try {
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate));
    dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    const fallback = path.join(root, "codex.exe");
    return existsSync(fallback) ? fallback : null;
  }
}

function checkCodexCli() {
  const codex = resolveNewestCodexBinary();
  if (!codex) {
    return check("FAIL", "Codex CLI", "newest OpenAI Codex binary not found");
  }
  return runCommand("Codex CLI", codex, ["--version"], { shell: false, warn: false });
}

// `--version` passes even when the CLI is logged out — but the whole headless
// review toolkit (codex-review / codex-gauntlet) silently fails without auth.
// Smoke the credential file `codex login` writes (~/.codex/auth.json) so a
// logged-out machine surfaces loudly instead of producing empty reviews.
export function checkCodexAuth(home = process.env.USERPROFILE || os.homedir()) {
  const authPath = path.join(home, ".codex", "auth.json");
  if (!existsSync(authPath)) {
    return check("FAIL", "Codex CLI auth", "~/.codex/auth.json missing — run `codex login`");
  }
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    // `auth_mode` only records which login flow was last selected — NOT a credential.
    // Require a real token/key so a logged-out-but-mode-set auth.json still FAILs.
    const hasCreds = Boolean(auth?.tokens || auth?.OPENAI_API_KEY);
    return hasCreds
      ? check("PASS", "Codex CLI auth", "auth.json present")
      : check("FAIL", "Codex CLI auth", "auth.json has no tokens/key — run `codex login`");
  } catch (error) {
    return check("FAIL", "Codex CLI auth", `auth.json unreadable: ${String(error?.message || error)}`);
  }
}

// Claude auth can live in an env var, the credentials file, or (on some
// platforms) an OS keychain we can't inspect here — so a missing file is a
// WARN, not a hard FAIL, to avoid false negatives on keychain-backed setups.
export function checkClaudeAuth(home = process.env.USERPROFILE || os.homedir(), env = process.env) {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return check("PASS", "Claude CLI auth", "API key/token in env");
  }
  const credPath = path.join(home, ".claude", ".credentials.json");
  if (!existsSync(credPath)) {
    return check("WARN", "Claude CLI auth", "no ~/.claude/.credentials.json and no API-key env (may use OS keychain) — run `claude login` if reviews fail to auth");
  }
  try {
    const cred = JSON.parse(readFileSync(credPath, "utf8"));
    const hasCreds = Boolean(cred?.claudeAiOauth || cred?.mcpOAuth);
    return hasCreds
      ? check("PASS", "Claude CLI auth", "credentials present")
      : check("WARN", "Claude CLI auth", "credentials file present but empty — run `claude login`");
  } catch (error) {
    return check("WARN", "Claude CLI auth", `credentials unreadable: ${String(error?.message || error)}`);
  }
}

function checkSessionStaleness() {
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT, ".claude", "hooks", "session-staleness.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    }).trim();
    if (!output) return check("PASS", "Session staleness", "no warnings");
    const parsed = JSON.parse(output);
    const extra = parsed?.hookSpecificOutput?.additionalContext || "";
    if (!extra) return check("PASS", "Session staleness", "no warnings");
    const first = extra.split(/\r?\n/).find((line) => line.includes("Schema registry") || line.includes("CLAUDE.md") || line.includes("uncommitted")) || "warnings present";
    return check("WARN", "Session staleness", first.replace(/^═══.*$/, "warnings present"));
  } catch (error) {
    return check("WARN", "Session staleness", String(error.message || "could not check"));
  }
}

export function summarizeChecks(checks) {
  const failed = checks.filter((item) => item.status === "FAIL");
  const warned = checks.filter((item) => item.status === "WARN");
  return {
    failed,
    warned,
    exitCode: failed.length > 0 ? 1 : 0,
  };
}

function buildHealthChecks(root = ROOT) {
  const requiredFiles = [
    ".claude/commands/claude-review.md",
    ".claude/skills/claude-review/SKILL.md",
    ".agents/skills/claude-review/SKILL.md",
    ".claude/commands/agent-pair-review.md",
    ".claude/skills/agent-pair-review/SKILL.md",
    ".agents/skills/agent-pair-review/SKILL.md",
    ".claude/commands/agent-health.md",
    ".claude/skills/agent-health/SKILL.md",
    ".agents/skills/agent-health/SKILL.md",
    ".claude/commands/agent-pr-comment.md",
    ".claude/skills/agent-pr-comment/SKILL.md",
    ".agents/skills/agent-pr-comment/SKILL.md",
    ".claude/hooks/agent-pair-review-reminder.mjs",
    ".codex/hooks/agent-pair-review-reminder.mjs",
    "scripts/run-claude-review.mjs",
    "scripts/agent-health-check.mjs",
    "scripts/post-agent-review-to-pr.mjs",
    "scripts/check-agent-workflows.mjs",
  ];

  const checks = [
    ...checkFilesPresent(root, requiredFiles),
    ...compareSyncedFiles(root, [
      [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"],
      [".claude/skills/agent-pair-review/SKILL.md", ".agents/skills/agent-pair-review/SKILL.md"],
      [".claude/skills/agent-health/SKILL.md", ".agents/skills/agent-health/SKILL.md"],
      [".claude/skills/agent-pr-comment/SKILL.md", ".agents/skills/agent-pr-comment/SKILL.md"],
      [".claude/hooks/agent-pair-review-reminder.mjs", ".codex/hooks/agent-pair-review-reminder.mjs"],
      [".claude/hooks/codex-to-claude-handoff-reminder.mjs", ".codex/hooks/codex-to-claude-handoff-reminder.mjs"],
      [".claude/hooks/codex-gauntlet-reminder.mjs", ".codex/hooks/codex-gauntlet-reminder.mjs"],
    ]),
  ];

  checks.push(checkCodexSessionStartSyncsHooks(readJsonIfPresent(path.join(root, ".codex", "hooks.json"))));
  checks.push(runCommand("Claude CLI", "claude", ["--version"], { warn: false }));
  checks.push(checkClaudeAuth());
  checks.push(checkCodexCli());
  checks.push(checkCodexAuth());
  checks.push(runCommand("GitHub auth", "gh", ["auth", "status"], { warn: true }));
  checks.push(runCommand("Vercel CLI", "vercel", ["--version"], { warn: true }));
  checks.push(runCommand("Supabase CLI", "supabase", ["--version"], { warn: true }));
  checks.push(checkSessionStaleness());

  return checks;
}

function main() {
  const checks = buildHealthChecks(ROOT);
  const summary = summarizeChecks(checks);

  console.log("agent-health-check");
  for (const item of checks) {
    console.log(`${item.status.padEnd(4)} ${item.name}${item.note ? ` - ${item.note}` : ""}`);
  }
  if (summary.failed.length > 0) {
    console.log(`FAIL - ${summary.failed.length} required check(s) failed.`);
  } else if (summary.warned.length > 0) {
    console.log(`PASS with ${summary.warned.length} warning(s).`);
  } else {
    console.log("PASS - agent collaboration health is clean.");
  }
  process.exit(summary.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
