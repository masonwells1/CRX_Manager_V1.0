#!/usr/bin/env node
// One UserPromptSubmit process, preserving the existing independent rule modules.

import { runHookRouter } from "./hook-router-runtime.mjs";
import { PUSH_POLICY } from "./prompt-source-lib.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The gauntlet and ship-intent reminders both embed PUSH_POLICY, and one prompt
// often trips both ("review this code, then ship it"). State it once per turn.
export const PROMPT_DEDUPE_BLOCKS = [
  { text: PUSH_POLICY, replacement: "LANDING POLICY: as stated above (unchanged)." },
];

export const SHARED_PROMPT_MODULES = [
  "./dangerous-phrase-warning.mjs",
  "./codex-gauntlet-reminder.mjs",
  "./agent-pair-review-reminder.mjs",
  "./codex-to-claude-handoff-reminder.mjs",
  "./ship-intent-reminder.mjs",
  "./hold-latch-prompt.mjs",
];

export const CLAUDE_ONLY_PROMPT_MODULES = [
  "./autopilot-intent-reminder.mjs",
];

export function promptModulesFor(surface = process.env.CRX_AGENT_SURFACE || "claude") {
  return surface === "codex"
    ? SHARED_PROMPT_MODULES
    : [...SHARED_PROMPT_MODULES, ...CLAUDE_ONLY_PROMPT_MODULES];
}

export async function main() {
  const output = await runHookRouter({
    eventName: "UserPromptSubmit",
    modulePaths: promptModulesFor(),
    dedupeBlocks: PROMPT_DEDUPE_BLOCKS,
  });
  if (output) process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
