#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Mason (zero coding experience) should never have to type a slash command. When he
// expresses intent to BUILD / FIX / SHIP / PUSH / "go live" / "do it", this hook
// deterministically reminds Claude to drive the work through the /ship pipeline —
// the "hard scaffolding" version of the CLAUDE.md auto-trigger, so it fires reliably.
//
// SAFETY: this NEVER authorizes a prod action beyond the recorded push policy —
// it injects the single canonical PUSH_POLICY (auto-push once green; hard gates =
// edge deploy / data deletion stay Mason-only, live migration per the settled
// 2026-07-13 rule: interactive = ask, armed hands-free run = proof gate,
// destructive = never autonomous).
//
// It only injects context (additionalContext) — it cannot force a tool call, and a
// false-positive is harmless (the reminder itself says: if this is a question or a
// trivial one-liner, ignore it). Machine-generated prompts (task notifications,
// system reminders) are skipped entirely — only things Mason typed count.

import { readFileSync } from "node:fs";
import { isMachineGenerated, PUSH_POLICY } from "./prompt-source-lib.mjs";
import {
  appendFactoryEvent,
  resolveHookFactoryPaths,
} from "../../scripts/factory-state-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: extra,
      },
    }));
  }
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}

const rawPrompt = String(payload?.prompt || "");
if (!rawPrompt || isMachineGenerated(rawPrompt)) emit();
const prompt = rawPrompt.toLowerCase();

// Intent to get real work done / ship it / push it. Broad on purpose — Mason talks in
// plain English and the injected reminder tells Claude to ignore it for questions.
const triggerPatterns = [
  /\bship\b/,                                            // ship, ship it, /ship
  /\bpush(?:es|ed|ing|\s+it|\s+this|\s+that)?\b/,        // push / push it / push this
  /\bgo\s+live\b/,
  /\bdeploy(?:s|ed|ing|ment)?\b/,
  /\bmake\s+(?:it|this|that)\s+(?:live|happen)\b/,
  /\bgo\s+ahead\s+and\b/,
  /\b(?:get|getting)\s+(?:it|this|these|them)\s+done\b/,
  /\bsend\s+it\b/,
  /\bfinish\s+(?:it|this|up|the)\b/,
  /\bdo\s+(?:it|this|that|everything|all|the)\b/,        // "do it", "do everything", "do all phases"
  /\bready\s+to\s+(?:ship|go|push|deploy)\b/,
  /\b(?:build|implement|create|add|fix|wire(?:\s+up)?|set\s+up)\b/, // substantive coding verbs
];

const shipIntent = triggerPatterns.some((pattern) => pattern.test(prompt));
const factoryIndicator = [
  /\bfactory\b/,
  /\bautonomous(?:ly)?\b/,
  /\bovernight\b/,
  /\bwhile\s+i(?:'m| am)\s+(?:asleep|sleeping|away|gone)\b/,
  /\bmany\s+jobs?\b/,
].some((pattern) => pattern.test(prompt));
const standaloneFactoryIntent = [
  /\b(?:run|start|use|activate|launch)\b.{0,50}\bfactory\b/,
  /\bfactory\b.{0,50}\b(?:run|start|overnight|autonomous(?:ly)?|jobs?)\b/,
  /\b(?:run|start)\b.{0,50}\bovernight\b/,
  /\bwhile\s+i(?:'m| am)\s+(?:asleep|sleeping|away|gone)\b/,
].some((pattern) => pattern.test(prompt));
const factoryIntent = standaloneFactoryIntent || (shipIntent && factoryIndicator);

if (!shipIntent && !factoryIntent) emit();

if (factoryIntent) {
  const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
  if (sessionId) {
    try {
      appendFactoryEvent(
        resolveHookFactoryPaths(process.env.CLAUDE_PROJECT_DIR || process.cwd()),
        {
          type: "factory-intent",
          jobId: null,
          actorTool: String(process.env.CRX_AGENT_SURFACE || payload?.agent_type || payload?.tool_surface || "claude").toLowerCase().includes("codex")
            ? "codex"
            : "claude",
          sessionId,
          payload: { ownerRequest: rawPrompt.slice(0, 1_000) },
        },
      );
    } catch {
      // Routing remains advisory. The lane guard fails closed only after a
      // verifiable session intent exists in the shared ledger.
    }
  }
}

emit([
  "CRX Ship-It reminder:",
  "",
  "Mason rarely types slash commands — this message looks like an intent to build / fix / ship / push / \"go live\" / \"do it.\"",
  "",
  "IF this is a substantive coding job (a feature, page, RPC, migration, or a fix beyond a one-line tweak) OR a request to ship/push existing work, drive it through the /ship pipeline automatically (read .claude/commands/ship.md):",
  "  Step 0.5 size it + write a plain-English plan for Mason's OK on real (multi-file / SQL / money / RLS) changes",
  "  -> implement -> Step 2.5 prove it actually RUNS (not just 'tests pass') -> scoped review fan-out + fix (hard cap 3 rounds) -> migration/Codex gates.",
  "Tell Mason in ONE line you're running it through /ship; do NOT make him type the command.",
  ...(factoryIntent ? [
    "",
    "FACTORY-MANAGED REQUEST:",
    "  Before any implementation, draft the mission ticket, register it with scripts/factory.mjs in the shared Git-common-dir ledger, present exactly one approval question, and ask nothing else.",
    "  Mason's chat reply is processed by factory-owner-input.mjs. Start work only through the deterministic factory lane-start command after approval.",
    "  The Factory Board is the only owner output surface; do not introduce another command or form for Mason.",
  ] : []),
  "",
  PUSH_POLICY,
  "",
  "If this message is just a question, a discussion, or a genuinely trivial one-line change, IGNORE this reminder (don't spin up the heavy pipeline).",
].join("\n"));
