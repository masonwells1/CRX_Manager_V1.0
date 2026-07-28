#!/usr/bin/env node
// Runs the existing file/content safety guards once per file in an apply_patch
// payload. This preserves each mature guard's Write/Edit contract while making
// patch paths deterministic and preventing exemptions from crossing files.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractPatchChanges, isApplyPatchTool } from "./patch-input-lib.mjs";

function guardsForPath(filePath, content) {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || "";
  const isMigration = normalized.endsWith(".sql") && normalized.includes("/supabase/migrations/");
  const isSourceTs =
    /\/src\/.*\.tsx?$/.test(normalized) &&
    !/\.(?:test|spec)\.tsx?$/.test(normalized);
  const isSourceJs = /\/src\/.*\.jsx?$/.test(normalized);
  const selected = [];
  if (isMigration) selected.push("sql-safety.mjs", "idempotency-body-check.mjs", "rls-on-new-tables.mjs");
  if (isMigration || isSourceTs) selected.push("status-enum-check.mjs", "generated-column-check.mjs");
  if (isSourceTs) selected.push("money-safety.mjs");
  if (/^\.env(?:\.|$)/.test(basename) || isSourceTs || isSourceJs) selected.push("env-guard.mjs");
  if (!content && !/^\.env(?:\.|$)/.test(basename)) return [];
  return selected;
}

function respond(decision, reason, systemMessage) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
    },
  };
  if (reason) output.hookSpecificOutput.permissionDecisionReason = reason;
  if (systemMessage) output.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  respond("deny", "PATCH GUARD FANOUT: unreadable hook payload.");
}

if (!isApplyPatchTool(payload?.tool_name)) respond("allow");

const { changes, errors } = extractPatchChanges(
  payload?.tool_input,
  process.env.CLAUDE_PROJECT_DIR || process.cwd()
);
const relevantErrors = errors.filter(({ relevant }) => relevant);
if (relevantErrors.length > 0) {
  respond(
    "deny",
    "PATCH GUARD FANOUT: could not reconstruct a safety-relevant final file:\n" +
      relevantErrors.map(({ filePath, reason }) => `${filePath}: ${reason}`).join("\n")
  );
}
if (changes.length === 0 && errors.length === 0) {
  respond("deny", "PATCH GUARD FANOUT: apply_patch payload contained no parseable file changes.");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const denials = [];
const warnings = [];
const workItems = changes.reduce(
  (count, change) => count + guardsForPath(change.filePath, change.content).length,
  0
);
if (workItems > 120) {
  respond(
    "deny",
    `PATCH GUARD FANOUT: this patch requires ${workItems} safety checks, exceeding the bounded limit of 120. ` +
      "Split it into smaller patches so the PreToolUse gate cannot time out."
  );
}

for (const change of changes) {
  const syntheticPayload = JSON.stringify({
    tool_name: "Write",
    tool_input: {
      file_path: change.filePath,
      content: change.content,
    },
  });

  for (const guard of guardsForPath(change.filePath, change.content)) {
    const result = spawnSync(process.execPath, [path.join(here, guard)], {
      input: syntheticPayload,
      encoding: "utf8",
      env: process.env,
      timeout: 12_000,
    });
    if (result.error || result.status !== 0) {
      denials.push(
        `${change.filePath}: ${guard} did not complete cleanly (${result.error?.message || `exit ${result.status}`}).`
      );
      continue;
    }

    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      denials.push(`${change.filePath}: ${guard} returned an unreadable decision.`);
      continue;
    }

    const hookOutput = output?.hookSpecificOutput;
    if (hookOutput?.permissionDecision === "deny") {
      denials.push(`${change.filePath}: ${hookOutput.permissionDecisionReason || `${guard} denied the change.`}`);
    }
    if (output?.systemMessage) warnings.push(`${change.filePath}: ${output.systemMessage}`);
  }
}

if (denials.length > 0) {
  respond("deny", "PATCH SAFETY VIOLATION:\n" + denials.join("\n"));
}
respond("allow", null, warnings.length > 0 ? [...new Set(warnings)].join("\n") : undefined);
