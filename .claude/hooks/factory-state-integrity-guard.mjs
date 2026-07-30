#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadFactorySnapshot, resolveHookFactoryPaths } from "../../scripts/factory-state-lib.mjs";

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

function norm(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

let stateDir;
try {
  stateDir = path.resolve(resolveHookFactoryPaths(process.env.CLAUDE_PROJECT_DIR || process.cwd()).stateDir);
} catch {
  nothing();
}
const stateNorm = norm(stateDir);
const input = payload?.tool_input || {};
const toolName = String(payload?.tool_name || "");
const target = norm(input.file_path || input.filePath || input.path || input.target || "");
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
let governedSession = false;
if (sessionId) {
  try {
    const snapshot = loadFactorySnapshot(resolveHookFactoryPaths(projectDir));
    governedSession = snapshot.factoryIntentSessions.includes(sessionId)
      || snapshot.jobs.some((job) =>
        job.sessionId === sessionId
        || job.laneSessionId === sessionId,
      );
  } catch {
    governedSession = true;
  }
}

if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(toolName)
    && (target.startsWith(stateNorm) || target.includes("/crx-factory/"))) {
  deny("CRX FACTORY STATE GUARD: direct edits to the shared factory ledger/tickets/evidence are forbidden. Use the validated scripts/factory.mjs entrypoint.");
}
const governanceTarget = /(?:^|\/)(?:package\.json|scripts\/factory(?:-[^/]*)?\.mjs|\.claude\/settings(?:\.local)?\.json|\.codex\/hooks\.json|\.codex\/hooks\/codex-hook-adapter\.mjs|\.claude\/hooks\/(?:factory-[^/]+|ship-intent-reminder|prompt-source-lib|hold-latch-lib)\.mjs)$/;
if (governedSession
    && /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(toolName)
    && governanceTarget.test(target)) {
  deny("CRX FACTORY STATE GUARD: an active factory lane cannot modify its own governance implementation.");
}

const command = String(input.command || "");
if (!command) nothing();
const commandNorm = norm(command);
if (/\bnode(?:\.exe)?\b[^\r\n;&|]*factory-owner-input\.mjs\b/i.test(commandNorm)) {
  deny("CRX FACTORY STATE GUARD: the owner-input hook may run only as a real UserPromptSubmit hook. Agents cannot invoke it as a command.");
}
const factoryInternals = /factory-state-lib\.mjs|appendfactoryevent|writeimmutableticket|runharnessevidence|recoverfactorystate/i.test(command);
const dynamicExecution = /\bnode(?:\.exe)?\s+(?:-e|--eval|-p|--print)\b|\bpython(?:\.exe)?\s+(?:-c|-)\b|\b(?:invoke-expression|iex)\b|(?:<<|@['\"])/i.test(command);
if (factoryInternals && dynamicExecution) {
  deny("CRX FACTORY STATE GUARD: direct invocation of factory state internals is forbidden. Use only the canonical scripts/factory.mjs CLI.");
}
if (governedSession && dynamicExecution) {
  deny("CRX FACTORY STATE GUARD: dynamic inline code execution is disabled inside a governed lane because it can bypass approval controls.");
}
const mentionsState = commandNorm.includes(stateNorm)
  || commandNorm.includes("/crx-factory/")
  || commandNorm.includes("\\crx-factory\\");
const derivesCommonDir = /git\s+rev-parse\s+--git-common-dir/i.test(command);
const mutates = /(?:^|[;&|]\s*|\s)(?:remove-item|rm|del|erase|move-item|mv|copy-item|cp|set-content|add-content|out-file|new-item|writefile|appendfile|unlink|rename|truncate|tee)\b|(?:>>?|2>)|node\s+(?:-e|--eval)\b|python(?:\.exe)?\s+(?:-c|-)\b|\b(?:sed|perl)(?:\.exe)?\b[^\r\n;&|]*\s-i(?:[^\s]*)?/i.test(command);
const opaqueRepoMutation = /\bgit\s+(?:apply\b|checkout\s+--(?:\s|$)|restore\b)/i.test(command);
const mentionsGovernanceTarget = /(?:^|[\\/\s"'`])(?:package\.json|scripts[\\/]factory(?:-[^\\/\s"'`]*)?\.mjs|\.claude[\\/]settings(?:\.local)?\.json|\.codex[\\/]hooks\.json|\.codex[\\/]hooks[\\/]codex-hook-adapter\.mjs|\.claude[\\/]hooks[\\/](?:factory-[^\\/\s"'`]+|ship-intent-reminder|prompt-source-lib|hold-latch-lib)\.mjs)(?:$|[\s"'`])/i.test(commandNorm);

if (governedSession && ((mentionsGovernanceTarget && mutates) || opaqueRepoMutation)) {
  deny("CRX FACTORY STATE GUARD: a governed lane cannot mutate its governance implementation through the shell.");
}

if ((mentionsState || derivesCommonDir) && mutates) {
  deny("CRX FACTORY STATE GUARD: shell mutation of the shared factory directory is forbidden. Use only node scripts/factory.mjs for validated state changes.");
}

nothing();
