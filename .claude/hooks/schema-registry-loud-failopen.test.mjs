#!/usr/bin/env node
// Tests for FIX 2 (2026-07-13): status-enum-check.mjs, generated-column-check.mjs,
// and sql-safety.mjs (rules 6-8) must WARN LOUDLY (via a PreToolUse `systemMessage`
// on an "allow" decision) instead of silently waving everything through when the
// schema registry is missing/unparseable (or, for sql-safety, still v1-shaped).
//
// These three hooks resolve .claude/schema-registry.json relative to their OWN
// script location (not via CLAUDE_PROJECT_DIR), so the only safe way to test a
// missing/broken registry — without touching this repo's REAL, actively-shared
// schema-registry.json (this worktree has other sessions writing to it right
// now) — is to run an ISOLATED COPY of each hook script from its own scratch
// .claude/hooks/ directory, next to a scratch (missing/broken) schema-registry.json.
// Run: node .claude/hooks/schema-registry-loud-failopen.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scratchHookEnvironment } from "./git-test-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

function runCopiedHook(hooksDir, scriptName, payload) {
  const projectDir = path.dirname(path.dirname(hooksDir));
  return spawnSync(process.execPath, [path.join(hooksDir, scriptName)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: scratchHookEnvironment(projectDir),
    cwd: projectDir,
  });
}

// Sets up <tmpDir>/.claude/hooks/<scriptName(s)> + <tmpDir>/.claude/schema-registry.json
// (or no registry file at all when registryContent is null).
function scaffoldIsolatedHook(tmpDir, scriptNames, registryContent) {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const name of scriptNames) {
    copyFileSync(path.join(__dirname, name), path.join(hooksDir, name));
  }
  if (registryContent !== null) {
    writeFileSync(path.join(tmpDir, ".claude", "schema-registry.json"), registryContent);
  }
  return hooksDir;
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "schema-registry-loud-test-"));

try {
  // ── status-enum-check.mjs: registry file missing entirely ───────────────
  const dirA = path.join(tmpRoot, "a");
  const hooksA = scaffoldIsolatedHook(dirA, ["status-enum-check.mjs", "edit-splice-lib.mjs"], null);
  let r = runCopiedHook(hooksA, "status-enum-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/lib/x.ts", content: ".from('invoices').eq('status','anything')" },
  });
  let out = JSON.parse(r.stdout);
  ok(out.hookSpecificOutput.permissionDecision === "allow", "status-enum-check: still allows (fail-open) with missing registry");
  ok(typeof out.systemMessage === "string" && out.systemMessage.includes("status-enum-check"), "status-enum-check: missing registry -> loud systemMessage naming the hook");
  ok(out.systemMessage.includes("SKIPPED"), "status-enum-check: warning says the check was SKIPPED");
  ok(out.systemMessage.includes("/regen-schema-registry"), "status-enum-check: warning points at the fix");

  // ── status-enum-check.mjs: registry file present but unparseable JSON ───
  const dirB = path.join(tmpRoot, "b");
  const hooksB = scaffoldIsolatedHook(dirB, ["status-enum-check.mjs", "edit-splice-lib.mjs"], "{ not valid json ");
  r = runCopiedHook(hooksB, "status-enum-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/lib/x.ts", content: ".from('invoices').eq('status','anything')" },
  });
  out = JSON.parse(r.stdout);
  ok(out.hookSpecificOutput.permissionDecision === "allow", "status-enum-check: unparseable registry still allows");
  ok(out.systemMessage && out.systemMessage.includes("SKIPPED"), "status-enum-check: unparseable registry also warns loudly");

  // ── status-enum-check.mjs: healthy registry -> no warning at all ─────────
  const dirC = path.join(tmpRoot, "c");
  const hooksC = scaffoldIsolatedHook(dirC, ["status-enum-check.mjs", "edit-splice-lib.mjs"], JSON.stringify({
    check_constraints: { "invoices.status": { values: ["draft", "posted", "voided"] } },
  }));
  r = runCopiedHook(hooksC, "status-enum-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "/project/src/lib/x.ts", content: ".from('invoices').eq('status','posted')" },
  });
  out = JSON.parse(r.stdout);
  ok(!out.systemMessage, "status-enum-check: healthy registry -> no warning emitted");

  // ── generated-column-check.mjs: registry file missing entirely ──────────
  const dirD = path.join(tmpRoot, "d");
  const hooksD = scaffoldIsolatedHook(dirD, ["generated-column-check.mjs"], null);
  r = runCopiedHook(hooksD, "generated-column-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "UPDATE invoices SET balance_cents = 0;" },
  });
  out = JSON.parse(r.stdout);
  ok(out.hookSpecificOutput.permissionDecision === "allow", "generated-column-check: still allows (fail-open) with missing registry");
  ok(out.systemMessage && out.systemMessage.includes("generated-column-check") && out.systemMessage.includes("SKIPPED"), "generated-column-check: missing registry -> loud systemMessage");

  // ── generated-column-check.mjs: unparseable registry ─────────────────────
  const dirE = path.join(tmpRoot, "e");
  const hooksE = scaffoldIsolatedHook(dirE, ["generated-column-check.mjs"], "not json at all");
  r = runCopiedHook(hooksE, "generated-column-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "UPDATE invoices SET balance_cents = 0;" },
  });
  out = JSON.parse(r.stdout);
  ok(out.systemMessage && out.systemMessage.includes("SKIPPED"), "generated-column-check: unparseable registry also warns loudly");

  // ── generated-column-check.mjs: healthy registry -> no warning ───────────
  const dirF = path.join(tmpRoot, "f");
  const hooksF = scaffoldIsolatedHook(dirF, ["generated-column-check.mjs"], JSON.stringify({
    generated_columns: [{ table: "invoices", column: "balance_cents", expression: "total_cents - paid_cents" }],
  }));
  r = runCopiedHook(hooksF, "generated-column-check.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "SELECT 1;" },
  });
  out = JSON.parse(r.stdout);
  ok(!out.systemMessage, "generated-column-check: healthy registry, no violation -> no warning emitted");

  // ── sql-safety.mjs: registry missing entirely -> rules 6-8 skip, warns loudly ──
  // sql-safety.mjs imports ./registry-freshness-lib.mjs relatively, so it must
  // be copied alongside it into the isolated hooks dir.
  const dirG = path.join(tmpRoot, "g");
  const hooksG = scaffoldIsolatedHook(dirG, ["sql-safety.mjs", "registry-freshness-lib.mjs", "edit-splice-lib.mjs"], null);
  r = runCopiedHook(hooksG, "sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "SELECT 1;" },
  });
  out = JSON.parse(r.stdout);
  ok(out.hookSpecificOutput.permissionDecision === "allow", "sql-safety: missing registry still allows a benign migration write");
  ok(out.systemMessage && out.systemMessage.includes("sql-safety") && out.systemMessage.includes("rules 6-8"), "sql-safety: missing registry -> loud systemMessage naming rules 6-8");
  ok(out.systemMessage.includes("SKIPPED"), "sql-safety: warning says SKIPPED");

  // ── sql-safety.mjs: v1-shaped registry (no columns/not_null_columns/sequences) ──
  const dirH = path.join(tmpRoot, "h");
  const hooksH = scaffoldIsolatedHook(dirH, ["sql-safety.mjs", "registry-freshness-lib.mjs", "edit-splice-lib.mjs"], JSON.stringify({
    generated_columns: [], status_enums: {}, tables_without_updated_at: [],
  }));
  r = runCopiedHook(hooksH, "sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "SELECT 1;" },
  });
  out = JSON.parse(r.stdout);
  ok(out.systemMessage && out.systemMessage.includes("rules 6-8"), "sql-safety: v1-shaped registry (no v2 keys) also warns loudly");

  // ── sql-safety.mjs: exempt-registry marker present -> no warning (deliberate opt-out) ──
  const dirI = path.join(tmpRoot, "i");
  const hooksI = scaffoldIsolatedHook(dirI, ["sql-safety.mjs", "registry-freshness-lib.mjs", "edit-splice-lib.mjs"], null);
  r = runCopiedHook(hooksI, "sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "-- sql-safety: exempt-registry (test)\nSELECT 1;" },
  });
  out = JSON.parse(r.stdout);
  ok(!out.systemMessage, "sql-safety: exempt-registry marker suppresses the loud warning (deliberate opt-out, not a failure)");

  // ── sql-safety.mjs: healthy v2 registry -> no warning ────────────────────
  const dirJ = path.join(tmpRoot, "j");
  const hooksJ = scaffoldIsolatedHook(dirJ, ["sql-safety.mjs", "registry-freshness-lib.mjs", "edit-splice-lib.mjs"], JSON.stringify({
    columns: { invoices: ["id", "status"] }, not_null_columns: { invoices: { no_default: [], with_default: [] } }, sequences: [],
  }));
  r = runCopiedHook(hooksJ, "sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_x.sql", content: "SELECT 1;" },
  });
  out = JSON.parse(r.stdout);
  ok(!out.systemMessage, "sql-safety: healthy v2 registry -> no warning emitted");

  console.log(`schema-registry-loud-failopen: ${pass} assertions passed`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
