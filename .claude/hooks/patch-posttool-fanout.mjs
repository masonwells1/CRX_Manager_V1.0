#!/usr/bin/env node
// Routes each apply_patch destination through the existing per-file PostToolUse
// hooks so migration reminders and eslint autofix also run for patch edits.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractPatchTargetPaths, isApplyPatchTool } from "./patch-input-lib.mjs";

function emit(output) {
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}
if (!isApplyPatchTool(payload?.tool_name)) emit();

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const targets = extractPatchTargetPaths(payload?.tool_input, root);
const here = path.dirname(fileURLToPath(import.meta.url));
const reminders = [];
const contexts = [];

for (const filePath of targets) {
  const hooks = ["posttooluse-migration.mjs"];
  if (existsSync(filePath)) hooks.push("eslint-autofix.mjs");

  for (const hook of hooks) {
    const result = spawnSync(process.execPath, [path.join(here, hook)], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: filePath },
        tool_response: payload?.tool_response,
      }),
      encoding: "utf8",
      env: process.env,
      timeout: 20_000,
    });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    try {
      const output = JSON.parse(result.stdout);
      if (output?.decision === "block" && output?.reason) reminders.push(output.reason);
      const context = output?.hookSpecificOutput?.additionalContext;
      if (context) contexts.push(context);
    } catch {
      contexts.push(`${hook} returned unreadable output for ${filePath}.`);
    }
  }
}

if (reminders.length > 0) {
  emit({ decision: "block", reason: [...new Set(reminders)].join("\n\n") });
}
if (contexts.length > 0) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [...new Set(contexts)].join("\n\n"),
    },
  });
}
emit();
