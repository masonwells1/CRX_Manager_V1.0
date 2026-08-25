#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

import { normalizeHookOutput, resolveSharedHook } from "./codex-hook-adapter.mjs";
import { resolveCommandExecutionContext } from "../../.claude/hooks/command-execution-context-lib.mjs";

const root = path.resolve("C:/example/CRX_Manager");
assert.equal(normalizeHookOutput(""), "");
assert.equal(normalizeHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })), "");
assert.match(normalizeHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } })), /deny/);
{
  const permitInjection = JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "allow",
      updatedInput: { command: "node scripts/agent-health-check.mjs" },
    },
  });
  assert.equal(normalizeHookOutput(permitInjection), permitInjection, "Codex adapter preserves trusted updatedInput");
}

// Codex P2 2026-07-13 round 5: a swallowed allow payload must still forward its
// loud fail-open systemMessage (top-level or nested) to the warn channel.
{
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(
    normalizeHookOutput(
      JSON.stringify({ systemMessage: "⚠ registry unreadable — check SKIPPED", hookSpecificOutput: { permissionDecision: "allow" } }),
      warn,
    ),
    "",
  );
  assert.equal(warnings.length, 1, "top-level systemMessage forwarded once");
  assert.match(warnings[0], /check SKIPPED/);

  warnings.length = 0;
  normalizeHookOutput(
    JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", systemMessage: "nested warn" } }),
    warn,
  );
  assert.match(warnings[0], /nested warn/, "nested systemMessage forwarded");

  warnings.length = 0;
  normalizeHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }), warn);
  assert.equal(warnings.length, 0, "no systemMessage → no warning");
}
assert.equal(
  resolveSharedHook(root, ".claude/hooks/sql-safety.mjs"),
  path.resolve(root, ".claude/hooks/sql-safety.mjs"),
);
assert.throws(() => resolveSharedHook(root, "../outside.mjs"), /must be a file under/);
assert.equal(
  resolveCommandExecutionContext({ cwd: root, tool_input: { workdir: "output" } }, root).cwd,
  path.resolve(root, "output"),
  "an explicit tool workdir overrides the session cwd",
);
assert.match(
  resolveCommandExecutionContext({ cwd: root, tool_input: { cwd: root, workdir: "output" } }, root).error,
  /disagree/,
  "conflicting tool execution fields fail closed",
);
assert.match(resolveCommandExecutionContext({}, root).error, /missing/, "a missing execution directory fails closed");

console.log("OK - Codex hook adapter checks passed.");
