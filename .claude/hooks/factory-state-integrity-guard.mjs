#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  completeFactoryManagedSessionBackfill,
  hasFactoryIntentFailureLatch,
  hasFactoryManagedSessionBackfillComplete,
  hasFactoryManagedSessionMarker,
  loadFactorySnapshot,
  resolveHookFactoryPaths,
  setFactoryManagedSessionMarker,
} from "../../scripts/factory-state-lib.mjs";

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

function collectPathLikeTargets(value, key = "", output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeTargets(item, key, output);
    return output;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string"
        && /^(?:file_?path|filepath|path|target|destination|dest|cwd|workdir|directory|root)$/i.test(key)) {
      output.push(value);
    }
    return output;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectPathLikeTargets(childValue, childKey, output);
  }
  return output;
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

let factoryPaths;
try {
  factoryPaths = resolveHookFactoryPaths(process.env.CLAUDE_PROJECT_DIR || process.cwd());
} catch {
  nothing();
}
const stateDir = path.resolve(factoryPaths.stateDir);
const stateNorm = norm(stateDir);
const permitsNorm = norm(path.resolve(factoryPaths.permitsDir));
const rawInput = payload?.tool_input;
const input = rawInput && typeof rawInput === "object" ? rawInput : {};
const toolName = String(payload?.tool_name || "");
const structuredTargets = [
  input.file_path,
  input.filePath,
  input.path,
  input.target,
  ...(Array.isArray(input.edits)
    ? input.edits.flatMap((edit) => [edit?.file_path, edit?.filePath, edit?.path, edit?.target])
    : []),
  ...collectPathLikeTargets(input),
].filter(Boolean).map((value) => norm(value));
const patchText = typeof rawInput === "string" ? rawInput : String(input.patch || input.input || "");
for (const match of patchText.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
  structuredTargets.push(norm(match[1].trim()));
}
const targets = [...new Set(structuredTargets)];
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const projectNorm = norm(projectDir);
const repositoryTargets = targets.map((target) =>
  target.startsWith(`${projectNorm}/`)
    ? target.slice(projectNorm.length + 1)
    : target,
);
const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
const actorTool = String(process.env.CRX_AGENT_SURFACE || payload?.agent_type || payload?.agent || "").trim().toLowerCase() === "codex"
  ? "codex"
  : "claude";
let governedSession = !sessionId;
let historicalBackfillComplete = hasFactoryManagedSessionBackfillComplete(factoryPaths);
if (sessionId) {
  try {
    const snapshot = loadFactorySnapshot(factoryPaths);
    completeFactoryManagedSessionBackfill(factoryPaths, { snapshot, actorTool });
    historicalBackfillComplete = true;
    governedSession = snapshot.factoryIntentSessions.includes(sessionId)
      || snapshot.jobs.some((job) =>
        job.sessionId === sessionId
        || job.laneSessionId === sessionId,
      );
    if (governedSession && !hasFactoryManagedSessionMarker(factoryPaths, sessionId)) {
      setFactoryManagedSessionMarker(factoryPaths, { sessionId, actorTool });
    }
  } catch {
    governedSession = hasFactoryIntentFailureLatch(factoryPaths, sessionId)
      || hasFactoryManagedSessionMarker(factoryPaths, sessionId);
  }
}

if (targets.some((target) => target.startsWith(stateNorm) || target.includes("/crx-factory/"))) {
  deny("CRX FACTORY STATE GUARD: direct tool access to the shared factory ledger/tickets/evidence is forbidden. Use the validated scripts/factory.mjs entrypoint or the read-only Factory Board.");
}
const governanceTarget = /(?:^|\/)(?:(?:AGENTS|CLAUDE)\.md|\.gitignore|package(?:-lock)?\.json|eslint-local-rules\.cjs|eslint-local-rules(?:\/.*)?|(?:eslint(?:-local-rules)?|postcss|tailwind)\.config\.(?:js|cjs|mjs|ts)|tsconfig(?:\.[^/]+)?\.json|vite\.config\.(?:js|mjs|ts)|vitest\.config\.(?:js|mjs|ts)|vercel\.json|supabase\/config\.toml|(?:scripts|\.claude|\.codex|\.husky)(?:\/.*)?|\.github\/(?:workflows|actions)(?:\/.*)?)$/i;
if (targets.some((target) => target.startsWith(permitsNorm))) {
  deny("CRX FACTORY STATE GUARD: one-time factory CLI permits are private to the trusted PreToolUse hook and canonical CLI.");
}
if (!historicalBackfillComplete
    && /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(toolName)
    && repositoryTargets.some((target) => governanceTarget.test(target))) {
  deny("CRX FACTORY STATE GUARD: protected governance edits stay fail-closed until the historical Factory session backfill is durably complete.");
}
if (governedSession
    && /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(toolName)
    && repositoryTargets.some((target) => governanceTarget.test(target))) {
  deny("CRX FACTORY STATE GUARD: an active factory lane cannot modify its own governance implementation.");
}

const command = String(input.command || input.code || input.script || input.source || "");
if (!command) nothing();
if (!historicalBackfillComplete && /[\r\n]/.test(command)) {
  deny("CRX FACTORY STATE GUARD: multiline shell execution stays fail-closed until the historical Factory session backfill is durably complete.");
}
if (governedSession && /[\r\n]/.test(command)) {
  deny("CRX FACTORY STATE GUARD: multiline shell commands are disabled inside a governed lane.");
}
const commandNorm = norm(command);
if (/crx_factory_permit/i.test(command) || commandNorm.includes("/crx-factory/permits/")) {
  deny("CRX FACTORY STATE GUARD: agents cannot read, set, or forward trusted factory CLI permits.");
}
if (/\bnode(?:\.exe)?\b[^\r\n;&|]*(?:factory-owner-input|factory-lane-guard|ship-intent-reminder)\.mjs\b/i.test(commandNorm)) {
  deny("CRX FACTORY STATE GUARD: canonical factory hook entrypoints are reserved for the supported hook workflow. Direct named invocation is denied; these local hooks are coordination controls, not Windows-user authentication.");
}
const factoryInternals = /factory-state-lib\.mjs|appendfactoryevent|writeimmutableticket|runharnessevidence|recoverfactorystate|mintfactoryclipermit|consumefactoryclipermit/i.test(command);
const dynamicExecution = /\bnode(?:\.exe)?\s+(?:-e|--eval|-p|--print)\b|\bpython(?:\.exe)?\s+(?:-c|-)\b|\b(?:invoke-expression|iex)\b|(?:<<|@['\"])/i.test(command);
if (factoryInternals && dynamicExecution) {
  deny("CRX FACTORY STATE GUARD: direct invocation of factory state internals is forbidden. Use only the canonical scripts/factory.mjs CLI.");
}
if (!historicalBackfillComplete && dynamicExecution) {
  deny("CRX FACTORY STATE GUARD: dynamic inline execution stays fail-closed until the historical Factory session backfill is durably complete.");
}
if (governedSession && dynamicExecution) {
  deny("CRX FACTORY STATE GUARD: dynamic inline code execution is disabled inside a governed lane because it can bypass approval controls.");
}
const mentionsState = commandNorm.includes(stateNorm)
  || commandNorm.includes("/crx-factory/")
  || commandNorm.includes("\\crx-factory\\");
const derivesCommonDir = /git\s+rev-parse\s+--git-common-dir/i.test(command);
const derivesFactoryGitPath = /git(?:\.exe)?\s+rev-parse\b[^\r\n;&|]*--git-path\b[^\r\n;&|]*crx[-_/\\]?factory/i.test(command);
const mutates = /(?:^|[;&|]\s*|\s)(?:remove-item|move-item|copy-item|rename-item|set-content|add-content|out-file|new-item|set-item|clear-item|clear-content|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty|set-acl|ac|clc|cli|clp|cpi|mi|ni|ri|ren|rni|sc|si|sp|sac|rm|del|erase|mv|cp|writefile|appendfile|unlink|rename|truncate|tee)\b|(?:>>?|2>)|node\s+(?:-e|--eval)\b|python(?:\.exe)?\s+(?:-c|-)\b|\b(?:sed|perl)(?:\.exe)?\b[^\r\n;&|]*\s-i(?:[^\s]*)?|\bgit(?:\.exe)?\s+(?:diff|show|log)\b[^\r\n;&|]*--output(?:=|\s)/i.test(command);
const opaqueRepoMutation = /\bgit\s+(?:apply\b|checkout\s+--(?:\s|$)|restore\b)/i.test(command);
const mentionsGovernanceTarget = /(?:^|[\\/\s"'`])(?:(?:(?:AGENTS|CLAUDE)\.md|\.gitignore|package(?:-lock)?\.json|(?:eslint(?:-local-rules)?|postcss|tailwind)\.config\.(?:js|cjs|mjs|ts)|tsconfig(?:\.[^\\/\s"'`]*)?\.json|vite\.config\.(?:js|mjs|ts)|vitest\.config\.(?:js|mjs|ts)|vercel\.json|supabase[\\/]config\.toml)(?=$|[\s"'`])|(?:scripts|\.claude|\.codex|\.husky)(?:[\\/][^\s"'`]*)?(?=$|[\s"'`])|\.github[\\/](?:workflows|actions)(?:[\\/][^\s"'`]*)?(?=$|[\s"'`]))/i.test(commandNorm);

if (!historicalBackfillComplete && ((mentionsGovernanceTarget && mutates) || opaqueRepoMutation)) {
  deny("CRX FACTORY STATE GUARD: governance and opaque repository mutations stay fail-closed until the historical Factory session backfill is durably complete.");
}
if (governedSession && ((mentionsGovernanceTarget && mutates) || opaqueRepoMutation)) {
  deny("CRX FACTORY STATE GUARD: a governed lane cannot mutate its governance implementation through the shell.");
}

if (mentionsState || derivesFactoryGitPath) {
  deny("CRX FACTORY STATE GUARD: direct shell access to shared factory state is forbidden. Use only the canonical factory CLI or read-only Factory Board.");
}

if (derivesCommonDir && mutates) {
  deny("CRX FACTORY STATE GUARD: shell mutation of the shared factory directory is forbidden. Use only node scripts/factory.mjs for validated state changes.");
}

nothing();
