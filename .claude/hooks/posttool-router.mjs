#!/usr/bin/env node
// One path-aware PostToolUse process. Modules remain independent and keep their
// existing contracts; irrelevant modules are not loaded for the event.

import { readFileSync } from "node:fs";
import { runHookRouter } from "./hook-router-runtime.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function postToolModulesFor(payload, surface = process.env.CRX_AGENT_SURFACE || "claude") {
  const modules = [];
  const toolName = String(payload?.tool_name || "");

  if (/^(Write|Edit)$/i.test(toolName)) {
    modules.push("./posttooluse-migration.mjs", "./eslint-autofix.mjs");
  }
  if (/apply_migration/i.test(toolName)) {
    modules.push("./registry-freshness.mjs", "./applied-snapshot-invalidate.mjs");
  }
  if (surface !== "codex") modules.push("./session-heartbeat.mjs");
  return modules;
}

export async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = null;
  }

  const output = await runHookRouter({
    eventName: "PostToolUse",
    modulePaths: postToolModulesFor(payload),
    payload,
  });
  if (output) process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
