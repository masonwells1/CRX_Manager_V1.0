#!/usr/bin/env node
// UserPromptSubmit half of the stop/pause/scope hold latch.
//   - Mason says stop/pause/scope-only  → latch HOLD + inject a halt directive.
//   - Any other message                 → clear the latch (so it never sticks).
// The PreToolUse half (hold-latch-guard.mjs) blocks "building" tool calls while held.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isHoldPhrase, isResumePhrase } from "./hold-latch-lib.mjs";
import { isMachineGenerated, authoredByMason } from "./prompt-source-lib.mjs";

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
if (isMachineGenerated(payload?.prompt)) emit();

// Strip the spans of THIS prompt that Mason did not author — peer-session
// <cross-session-message> blocks, machine envelopes, quoted blockquote lines,
// and code spans — then match only on what is left. Proven 2026-08-26: a peer
// session's message ("stand down ... no need to stop the other lane") latched
// the receiver's hold, the quoted reply latched the sender's, and naming
// `stop-wrap.mjs` latched it again. Matching the raw prompt is the defect.
//
// This narrows the INPUT, never the vocabulary: if Mason typed a hold phrase
// anywhere outside those spans it still latches, including in the same message
// as a stripped block.
const prompt = authoredByMason(payload?.prompt);

// Nothing left after stripping → this prompt is entirely someone else's words.
// It is not Mason's turn to speak, so it must NEITHER latch a hold NOR clear
// one: a sibling session must not be able to release a hold Mason latched.
if (!prompt.trim()) emit();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");
const holdPath = path.join(stateDir, "hold.json");

function wasHeld() {
  try { return existsSync(holdPath) && JSON.parse(readFileSync(holdPath, "utf8")).held === true; } catch { return false; }
}

if (isHoldPhrase(prompt)) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(holdPath, JSON.stringify({ held: true, phrase: prompt.trim().slice(0, 200), ts: new Date().toISOString() }), "utf8");
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
