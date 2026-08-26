#!/usr/bin/env node
// UserPromptSubmit half of the stop/pause/scope hold latch.
//   - Mason says stop/pause/scope-only  → latch HOLD + inject a halt directive.
//   - Any other message                 → clear the latch (so it never sticks).
// The PreToolUse half (hold-latch-guard.mjs) blocks "building" tool calls while held.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isHoldPhrase, isResumePhrase } from "./hold-latch-lib.mjs";
import { isCrossSessionMessage, isMachineGenerated } from "./prompt-source-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

// Machine-generated envelopes (<task-notification>, <system-reminder>, slash-command
// output) are not something Mason typed — they must NEITHER latch NOR clear the hold.
// Proven 2026-07-04: a <task-notification> audit digest containing "stop" latched hold.json.
// Sibling-session envelopes (<cross-session-message ...>) are likewise not Mason:
// proven 2026-08-26, a sibling's "stand-down report" latched the hold — and the same
// gap would let any sibling message silently CLEAR a hold Mason had latched.
if (isMachineGenerated(payload?.prompt) || isCrossSessionMessage(payload?.prompt)) emit();

const prompt = String(payload?.prompt || "");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");
const holdPath = path.join(stateDir, "hold.json");

function wasHeld() {
  try { return existsSync(holdPath) && JSON.parse(readFileSync(holdPath, "utf8")).held === true; } catch { return false; }
}

if (isHoldPhrase(prompt)) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(holdPath, JSON.stringify({ held: true, phrase: prompt.slice(0, 200), ts: new Date().toISOString() }), "utf8");
  } catch { /* non-fatal */ }
  emit([
    "HOLD LATCHED — Mason said stop / pause / scope-only.",
    "",
    "HALT building now: get to a clean checkpoint, write a one-paragraph plain-English progress note, and WAIT.",
    "Do NOT keep coding, committing, migrating, or deploying. If he was only scoping a FUTURE session, your whole",
    "deliverable is a written plan (a SCOPE.md: goal, the 2-4 files to touch, plan, open questions) — no code.",
    "This overrides the auto-ship / keep-moving default. The hold clears automatically on his next instruction.",
    "(From hold-latch — build-actions are blocked until he resumes.)",
  ].join("\n"));
}

// Not a hold phrase → clear any existing latch.
if (wasHeld()) {
  try { rmSync(holdPath); } catch { /* ignore */ }
  if (isResumePhrase(prompt)) {
    emit("HOLD CLEARED — Mason resumed. Build-actions are unblocked. Proceed with his instruction.");
  }
  emit("HOLD CLEARED — new instruction received; build-actions are unblocked.");
}

emit();
