#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PRODUCTION_BRANCHES = new Set(["main", "master", "production"]);
const LIVE_TOOL_ACTIONS = /(?:apply_migration|deploy_edge_function|delete_branch)$/i;

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function isClearlyReadOnlySql(sql) {
  const value = normalize(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .trim();
  if (!/^(?:select|with|explain|show)\b/i.test(value)) return false;
  return !/\b(?:insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|call|copy)\b/i.test(value);
}

export function evaluateProductionAction({ toolName = "", toolInput = {}, branch = "" } = {}) {
  const name = String(toolName);
  const currentBranch = normalize(branch).toLowerCase();

  if (LIVE_TOOL_ACTIONS.test(name)) {
    return { blocked: true, reason: "Live migrations and production deployments require Mason's explicit approval and must be run outside the default Codex guard." };
  }

  if (/execute_sql$/i.test(name)) {
    const sql = toolInput.query ?? toolInput.sql ?? "";
    if (!isClearlyReadOnlySql(sql)) {
      return { blocked: true, reason: "Codex only permits clearly read-only SQL by default. Live data or schema changes require Mason's explicit approval." };
    }
  }

  const command = normalize(toolInput.command ?? toolInput.cmd ?? "");
  if (!command) return { blocked: false };

  const explicitProductionPush = /\bgit\s+push\b[^\r\n]*(?:\s|:)(main|master|production)(?:\s|$)/i.test(command);
  const commandSegments = command.split(/(?:&&|\|\||;|\r?\n)/).map((segment) => segment.trim());
  const genericPush = commandSegments.some((segment) => {
    if (!/^git\s+push\b/i.test(segment)) return false;
    const args = segment.split(/\s+/).slice(2);
    const positional = args.filter((arg) => !arg.startsWith("-"));
    return positional.length <= 1;
  });
  if (explicitProductionPush || (genericPush && PRODUCTION_BRANCHES.has(currentBranch))) {
    return { blocked: true, reason: "Production branch pushes require Mason's explicit confirmation and are blocked by the default Codex guard." };
  }

  const productionDeploy =
    /\bvercel\b[^\r\n]*(?:--prod|--production)(?:\s|$)/i.test(command) ||
    /\bsupabase\s+functions\s+deploy\b/i.test(command) ||
    /\bsupabase\s+(?:db\s+push|migration\s+up)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/i.test(command);
  if (productionDeploy) {
    return { blocked: true, reason: "Production deployments and live migration commands require Mason's explicit approval and are blocked by the default Codex guard." };
  }

  return { blocked: false };
}

function currentGitBranch() {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

async function main() {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const result = evaluateProductionAction({
    toolName: payload.tool_name ?? payload.toolName ?? "",
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    branch: currentGitBranch(),
  });
  // Codex treats a plain Claude-style "allow" payload as noisy/failed output.
  // A successful hook with no output means allow; emit JSON only for a denial.
  if (!result.blocked) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
    },
  }));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
