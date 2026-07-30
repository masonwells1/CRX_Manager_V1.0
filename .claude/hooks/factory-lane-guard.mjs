#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACTIVE_STAGES,
  loadFactorySnapshot,
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

function isFactoryCli(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return false;
  const command = String(toolInput?.command || "").trim().replace(/\\/g, "/");
  if (/[;&|]/.test(command)) return false;
  const absolute = path.join(projectDir, "scripts", "factory.mjs").replace(/\\/g, "/");
  return new RegExp(`^node(?:\\.exe)?\\s+(?:[\"']?${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']?|scripts/factory\\.mjs)\\s+`, "i").test(command);
}

function isBuildMutation(toolName, toolInput) {
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(String(toolName || ""))) return true;
  return isBuildActionUnderHold(toolName, toolInput);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const buildMutation = isBuildMutation(payload?.tool_name, payload?.tool_input);
const factoryCli = isFactoryCli(payload?.tool_name, payload?.tool_input, projectDir);

let snapshot;
try {
  snapshot = loadFactorySnapshot(resolveHookFactoryPaths(projectDir));
} catch (error) {
  if (factoryCli || !buildMutation) nothing();
  deny(`CRX FACTORY GATE: shared factory state could not be verified (${error.message}). Factory-managed build writes fail closed.`);
}

if (factoryCli) nothing();
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
