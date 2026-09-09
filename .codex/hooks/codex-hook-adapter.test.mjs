#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { normalizeHookOutput, resolveSharedHook } from "./codex-hook-adapter.mjs";

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

// The adapter must preserve event-level cwd as it forwards raw native
// apply_patch JSON to the registered shared review-proof guard.
{
  const repoRoot = process.cwd();
  const adapterPath = path.join(repoRoot, ".codex", "hooks", "codex-hook-adapter.mjs");
  const result = spawnSync(process.execPath, [adapterPath, ".claude/hooks/review-proof-guard.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify({
      tool_name: "apply_patch",
      cwd: path.join(repoRoot, ".claude", "hooks"),
      tool_input: "*** Begin Patch\n*** Update File: review-proof-guard.mjs\n@@\n-old\n+new\n*** End Patch",
    }),
  });
  assert.equal(result.error, undefined, "adapter event-cwd probe starts without a process error");
  assert.equal(result.status, 0, "adapter forwards the hook denial without process failure");
  assert.equal(result.stderr, "", "adapter event-cwd probe emits no stderr");
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput?.permissionDecision, "deny", "adapter preserves event cwd for raw patch destinations");
  assert.match(String(decision.hookSpecificOutput?.permissionDecisionReason || ""), /through a path field/);
}

console.log("OK - Codex hook adapter checks passed.");
