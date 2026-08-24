#!/usr/bin/env node
// Read-only real-path smoke for the production migration guard.
// This runs the guard executable directly; it never invokes an MCP tool and
// therefore cannot apply the harmless probe SQL it supplies on stdin.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const guard = path.join(root, ".claude", "hooks", "migration-apply-guard.mjs");
const payload = {
  tool_name: "mcp__supabase__apply_migration",
  tool_input: {
    project_id: "rhyzpcqhnizqbxphqdkr",
    name: "20990101000000_guard_read_only_probe",
    query:
      "CREATE TABLE public.guard_read_only_probe (id bigint primary key); " +
      "ALTER TABLE public.guard_read_only_probe ENABLE ROW LEVEL SECURITY;",
  },
};

const result = spawnSync(process.execPath, [guard], {
  cwd: root,
  input: JSON.stringify(payload),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  timeout: 120_000,
});

assert.equal(result.status, 0, result.stderr || "production guard exited non-zero");
assert.match(result.stdout, /"permissionDecision":"deny"/);
assert.doesNotMatch(
  result.stdout,
  /no trustworthy live applied-migration evidence|trusted trigger\/FK.*could not be loaded/,
);
assert.match(
  result.stdout,
  /Cannot apply migration|linked production evidence contains enabled PostgreSQL event trigger/,
);
process.stdout.write("MIGRATION_APPLY_GUARD_LIVE_READ_SMOKE_PASS\n");
