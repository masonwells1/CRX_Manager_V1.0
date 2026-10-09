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

// Mason, 2026-10-02: five reminder modules were unwired here
// (dangerous-phrase-warning, codex-gauntlet-reminder, agent-pair-review-reminder,
// codex-to-claude-handoff-reminder, autopilot-intent-reminder). They duplicated
// the user-level risky-phrase nudge or the ship reminder, and fired on agent
// reports as often as on Mason's words. Without autopilot-intent-reminder the
// OVERNIGHT-INTENT flag is never written, so the overnight handshake no longer
// blocks work.
export const SHARED_PROMPT_MODULES = [
  "./ship-intent-reminder.mjs",
  "./hold-latch-prompt.mjs",
];

export const CLAUDE_ONLY_PROMPT_MODULES = [];

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
