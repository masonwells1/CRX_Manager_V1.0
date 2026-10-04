#!/usr/bin/env node
// One UserPromptSubmit process, preserving the existing independent rule modules.

import { runHookRouter } from "./hook-router-runtime.mjs";
import { PUSH_POLICY } from "./prompt-source-lib.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// If a second module ever embeds PUSH_POLICY again, state it once per turn.
export const PROMPT_DEDUPE_BLOCKS = [
  { text: PUSH_POLICY, replacement: "LANDING POLICY: as stated above (unchanged)." },
];

// Mason, 2026-10-02: five reminder modules were unwired here and later deleted
// (dangerous-phrase-warning, codex-gauntlet-reminder, agent-pair-review-reminder,
// codex-to-claude-handoff-reminder, autopilot-intent-reminder). They duplicated
// the user-level risky-phrase nudge or the ship reminder, and fired on agent
// reports as often as on Mason's words. The overnight handshake they fed is gone.
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
