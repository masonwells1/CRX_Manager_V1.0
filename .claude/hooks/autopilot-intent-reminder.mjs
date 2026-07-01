#!/usr/bin/env node
// UserPromptSubmit hook: when Mason asks for an unattended / overnight run (or
// complains that the loop "keeps asking for permission"), inject a directive to
// ACTUALLY arm autopilot — not just reassure him it's safe. Reassurance without
// writing the flag is the exact repeated failure.
//
// Advisory only (a false positive is harmless — the reminder says to ignore it if
// he isn't asking for a hands-free run).

import { readFileSync } from "node:fs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }
const prompt = String(payload?.prompt || "").toLowerCase();
if (!prompt) emit();

const triggers = [
  /keeps?\s+asking/,
  /non.?stop.*(permission|allow)/,
  /(full|more)\s+permission/,
  /never\s+ask/,
  /don'?t\s+ask\s+(me\s+)?(for\s+)?(permission|again)/,
  /going\s+to\s+bed/,
  /hands.?free/,
  /overnight/,
  /run\s+(it|this)\s+(all\s+)?night/,
  /while\s+i('?m| am)\s+(asleep|sleeping|away|gone)/,
  /without\s+(asking|stopping|me)/,
];

if (!triggers.some((re) => re.test(prompt))) emit();

emit([
  "CRX autopilot reminder:",
  "",
  "Mason is asking for an unattended / hands-free run. Do NOT just reassure him it's safe —",
  "ACTUALLY arm autopilot so the loop stops prompting him:",
  "  1. Run:  node .claude/hooks/autopilot-arm.mjs --hours <however long he'll be away>",
  "  2. Confirm in ONE plain-English line that the flag is set and until when.",
  "  3. Then start/continue the loop.",
  "",
  "Autopilot auto-approves ordinary tool calls but STILL blocks push / deploy / live migration /",
  "destructive deletes / secret writes — those keep needing his explicit OK. It auto-expires.",
  "Reassurance without running autopilot-arm.mjs is the exact thing he keeps having to repeat.",
  "(If this isn't a hands-free request, ignore this.)",
].join("\n"));
