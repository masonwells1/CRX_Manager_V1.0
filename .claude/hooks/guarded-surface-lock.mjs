#!/usr/bin/env node

// PreToolUse lock over the enforcement surface (hooks, hook registration,
// husky, CI workflows, package scripts, proof/validation scripts).
//
// Rationale, the unlock protocol, and the read-vs-write rule live in
// guarded-surface-lib.mjs. This file is only the wiring: read the payload,
// load any unlock, ask the rule book, emit a deny if told to.
//
// FAIL-CLOSED POSTURE: if the rule book throws, this hook denies rather than
// falling open. A guard that fails open under a malformed payload is a guard an
// attacker only has to malform.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPatchDestinations } from "./codex-push-lib.mjs";
import { evaluateGuardedSurface } from "./guarded-surface-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNLOCK_PATH = path.join(__dirname, "..", "session-state", "guard-unlock.json");

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

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // No parseable payload means no tool call to judge.
  process.exit(0);
}

let unlock = null;
try {
  unlock = JSON.parse(readFileSync(UNLOCK_PATH, "utf8"));
} catch {
  unlock = null;   // absent or unreadable == locked
}

let verdict;
try {
  verdict = evaluateGuardedSurface({
    toolName: String(payload?.tool_name || payload?.toolName || ""),
    input: payload?.tool_input || payload?.toolInput || {},
    unlock,
    nowMs: Date.now(),
    extractPatchDestinations,
  });
} catch (error) {
  deny(`GUARDED SURFACE LOCK: rule book failed to evaluate this call (${String(error?.message || error).slice(0, 200)}). Failing closed.`);
}

if (verdict?.decision === "block") deny(verdict.reason);
process.exit(0);
