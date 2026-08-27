#!/usr/bin/env node
// One UserPromptSubmit process, preserving the existing independent rule modules.

import { runHookRouter } from "./hook-router-runtime.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  });
  if (output) process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
