#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

import { normalizeHookOutput, resolveSharedHook } from "./codex-hook-adapter.mjs";

const root = path.resolve("C:/example/CRX_Manager");
assert.equal(normalizeHookOutput(""), "");
assert.equal(normalizeHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })), "");
assert.match(normalizeHookOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } })), /deny/);
assert.equal(
  resolveSharedHook(root, ".claude/hooks/sql-safety.mjs"),
  path.resolve(root, ".claude/hooks/sql-safety.mjs"),
);
assert.throws(() => resolveSharedHook(root, "../outside.mjs"), /must be a file under/);

console.log("OK - Codex hook adapter checks passed.");
