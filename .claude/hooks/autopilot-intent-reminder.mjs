#!/usr/bin/env node
// UserPromptSubmit hook: when Mason asks for an unattended / overnight run (or
// complains that the loop "keeps asking for permission"), inject a directive to
// ACTUALLY arm autopilot — not just reassure him it's safe. Reassurance without
// writing the flag is the exact repeated failure.
//
// Advisory only (a false positive is harmless — the reminder says to ignore it if
// he isn't asking for a hands-free run).

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMachineGenerated } from "./prompt-source-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

// Machine-generated envelopes (<task-notification>, <system-reminder>, slash-command
// output) are not something Mason typed — never latch OVERNIGHT-INTENT or remind off
// a word like "overnight" inside an embedded report.
if (isMachineGenerated(payload?.prompt)) emit();

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

// Strong, unambiguous hands-free signals additionally latch the deterministic
// handshake: unattended-autopilot.mjs blocks build tools until autopilot is
// actually armed (or the flag is deliberately cleared). Weak signals only remind.
const strong = [
  /going\s+to\s+bed/,
  /hands.?free/,
  /overnight/,
  /run\s+(it|this)\s+(all\s+)?night/,
  /while\s+i('?m| am)\s+(asleep|sleeping|away|gone)/,
];
if (strong.some((re) => re.test(prompt))) {
  try {
    const dir = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "session-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "OVERNIGHT-INTENT.flag"), JSON.stringify({
      created: new Date().toISOString(),
      source: "autopilot-intent-reminder",
    }));
  } catch { /* advisory hook — never fail the prompt */ }
}

emit([
  "CRX autopilot reminder:",
  "",
  "Mason is asking for an unattended / hands-free run. Do NOT just reassure him it's safe —",
  "ACTUALLY arm autopilot so the loop stops prompting him:",
  "  1. Run:  node .claude/hooks/autopilot-arm.mjs --hours <however long he'll be away>",
  "  2. Confirm in ONE plain-English line that the flag is set and until when.",
  "  3. Then start/continue the loop.",
  "",
  "Autopilot auto-approves ordinary tool calls. Feature-branch pushes and protected green-PR",
  "merges continue through their existing guards without another Mason confirmation. Out-of-band",
  "production deploys, destructive deletes, secret/auth changes, force-pushes, and bypasses stay",
  "blocked or gated. It auto-expires.",
  "Live migrations MAY apply during an armed run (Mason's settled 2026-07-13 policy) — but only",
  "through migration-apply-guard's same-session review proof + the Codex gate, and NEVER when the",
  "migration is destructive (DELETE/TRUNCATE of business rows, DROP of data-bearing tables/columns)",
  "— the guard hard-refuses those while armed; park them for Mason.",
  "Reassurance without running autopilot-arm.mjs is the exact thing he keeps having to repeat.",
  "(If this isn't a hands-free request, ignore this.)",
].join("\n"));
