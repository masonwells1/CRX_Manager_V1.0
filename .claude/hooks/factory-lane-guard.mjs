#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACTIVE_STAGES,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  resolveHookFactoryPaths,
} from "../../scripts/factory-state-lib.mjs";
import { isBuildActionUnderHold } from "./hold-latch-lib.mjs";

function nothing() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function allowWithPermit(payload, token) {
  const input = payload?.tool_input || {};
  const command = String(input.command || "");
  const powerShell = process.platform === "win32"
    || /^(?:PowerShell|shell_command)$/i.test(String(payload?.tool_name || ""));
  const trustedCommand = powerShell
    ? `$env:CRX_FACTORY_PERMIT='${token}'; ${command}`
    : `CRX_FACTORY_PERMIT='${token}' ${command}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, command: trustedCommand },
    },
  }));
  process.exit(0);
}

function factoryCliInvocation(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return false;
  const command = String(toolInput?.command || "").trim().replace(/\\/g, "/");
  if (/[;&|]/.test(command)) return false;
  const absolute = path.join(projectDir, "scripts", "factory.mjs").replace(/\\/g, "/");
  const match = command.match(new RegExp(
    `^node(?:\\.exe)?\\s+(?:[\"']?${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']?|scripts/factory\\.mjs)\\s+(.+)$`,
    "i",
  ));
  if (!match) return false;
  const action = match[1].trim();
  return {
    action,
    status: /^status(?:\s|$)/i.test(action),
    recovery: /^recover\s+(?:unlock|torn-tail)(?:\s|$)/i.test(action),
  };
}

const SHELL_MUTATION_RE = /(?:^|[;&|]\s*|\s)(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|clear-content|sc|ni|rm|del|erase|mv|cp|copy|move|xcopy|robocopy|mkdir|md|rmdir|rd|touch|truncate|tee|patch|apply_patch)\b|(?:^|[^<])(?:>>?|[12]>>?)\s*(?!&)|\b(?:sed|perl)(?:\.exe)?\b[^\r\n;&|]*\s-i(?:[^\s]*)?|\bgit(?:\.exe)?\s+(?:add|am|apply|branch\s+(?:-[dDmM]|--delete|--move)|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|rm|switch\s+-c|tag|push)\b|\bnpm(?:\.cmd)?\s+(?:install|uninstall|update|ci|publish)\b|\bnpx(?:\.cmd)?\b/i;
const SAFE_NPM_RUN_RE = /^\s*npm(?:\.cmd)?\s+run\s+(?:test(?::[A-Za-z0-9:_-]+)?|lint|typecheck|build|verify-deps|check-doc-drift|check:agent-workflows|check:agent-guidance)\s*$/i;
const SAFE_NODE_RE = /^\s*node(?:\.exe)?\s+(?:--check\s+\S+|scripts[\\/](?:factory-board|check-doc-drift|verify-deps)\.mjs(?:\s+--[A-Za-z0-9_-]+)*|scripts[\\/]sync-agent-workflows\.mjs\s+--check)\s*$/i;
const SAFE_GIT_READ_RE = /^\s*git(?:\.exe)?(?:\s+-C\s+\S+)?\s+(?:status\b|diff\b|log\b|show\b|rev-parse\b|merge-base\b|cat-file\b|ls-files\b|remote\s+-v\b|branch\s+(?:--show-current|-vv|--list)\b|worktree\s+list\b)[^;&|<>]*$/i;
const SAFE_SHELL_READ_RE = /^\s*(?:rg|findstr|where(?:\.exe)?|ls|dir|pwd|Get-Location|Get-Content|Get-ChildItem|Get-Item|Test-Path|Resolve-Path|Select-String|Measure-Object)(?:\s+[^;&|<>]*)?\s*$/i;
const SAFE_VERSION_RE = /^\s*(?:node|npm|gh|git)(?:\.exe|\.cmd)?\s+--version\s*$/i;

function isShellMutation(toolName, toolInput) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return false;
  const command = String(toolInput?.command || "").trim();
  if (!command) return false;
  if (SHELL_MUTATION_RE.test(command)) return true;
  if (/\$\(|`|\b(?:invoke-expression|iex)\b/i.test(command)) return true;
  if (SAFE_NPM_RUN_RE.test(command)
      || SAFE_NODE_RE.test(command)
      || SAFE_GIT_READ_RE.test(command)
      || SAFE_SHELL_READ_RE.test(command)
      || SAFE_VERSION_RE.test(command)) {
    return false;
  }
  return true;
}

function isBuildMutation(toolName, toolInput) {
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(String(toolName || ""))) return true;
  return isBuildActionUnderHold(toolName, toolInput) || isShellMutation(toolName, toolInput);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const buildMutation = isBuildMutation(payload?.tool_name, payload?.tool_input);
const factoryCli = factoryCliInvocation(payload?.tool_name, payload?.tool_input, projectDir);
const actorTool = String(process.env.CRX_AGENT_SURFACE || payload?.agent_type || payload?.tool_surface || "claude").toLowerCase().includes("codex")
  ? "codex"
  : "claude";
const paths = resolveHookFactoryPaths(projectDir);

let snapshot;
try {
  snapshot = loadFactorySnapshot(paths);
} catch (error) {
  if (factoryCli?.status || !buildMutation) nothing();
  if (factoryCli?.recovery) {
    if (!sessionId) deny("CRX FACTORY GATE: recovery requires a verifiable chat session.");
    const permit = mintFactoryCliPermit(paths, { sessionId, actorTool });
    allowWithPermit(payload, permit.token);
  }
  deny(`CRX FACTORY GATE: shared factory state could not be verified (${error.message}). Factory-managed build writes fail closed.`);
}

if (factoryCli) {
  if (factoryCli.status) nothing();
  if (!sessionId) deny("CRX FACTORY GATE: mutating factory commands require a verifiable chat session.");
  if (snapshot.held && !factoryCli.recovery) {
    deny(`CRX FACTORY GATE: the factory is globally paused${snapshot.holdReason ? ` (${snapshot.holdReason})` : ""}. Only status and canonical recovery remain available.`);
  }
  const permit = mintFactoryCliPermit(paths, { sessionId, actorTool });
  allowWithPermit(payload, permit.token);
}
const otherActive = snapshot.jobs.find((job) =>
  ACTIVE_STAGES.has(job.stage)
  && job.laneSessionId !== sessionId,
);
if (buildMutation && otherActive) {
  deny(`CRX FACTORY GATE: pilot job ${otherActive.id} is already ${otherActive.stage} in another chat. The one-lane pilot blocks parallel repository writes until it reaches morning review or is parked.`);
}
if (!sessionId) nothing();

const sessionJobs = snapshot.jobs.filter((job) => job.sessionId === sessionId);
const hasIntent = snapshot.factoryIntentSessions.includes(sessionId);
const governedJob = sessionJobs.find((job) =>
  ACTIVE_STAGES.has(job.stage)
  || ["needs-ticket-ok", "queued", "awaiting-morning-review", "parked", "approved-to-land"].includes(job.stage),
);
if (!hasIntent && !governedJob) nothing();
if (!buildMutation) nothing();

if (snapshot.held) {
  deny(`CRX FACTORY GATE: the factory is globally paused${snapshot.holdReason ? ` (${snapshot.holdReason})` : ""}. Reads and verification remain available; build writes are blocked.`);
}
if (!governedJob) {
  deny("CRX FACTORY GATE: this chat requested factory/autonomous work, but no mission ticket is presented and approved. Draft and present the ticket through scripts/factory.mjs before any implementation.");
}
if (governedJob.stage === "needs-ticket-ok") {
  deny(`CRX FACTORY GATE: ticket ${governedJob.id} is waiting for Mason's exact chat approval. Ask only its recorded yes/no question.`);
}
if (governedJob.stage === "queued") {
  deny(`CRX FACTORY GATE: ticket ${governedJob.id} is approved but the deterministic lane-start check has not run. Start it through scripts/factory.mjs lane start.`);
}
if (ACTIVE_STAGES.has(governedJob.stage)) nothing();

deny(`CRX FACTORY GATE: job ${governedJob.id} is ${governedJob.stage}. Further build writes are parked until Mason disposes the job in chat.`);
