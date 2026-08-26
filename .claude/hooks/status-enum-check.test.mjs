#!/usr/bin/env node
// Tests for status-enum-check.mjs, focused on the CRLF Edit-splice deadlock
// class (2026-08-26, same class as grant-change-guard / idempotency-body-check):
// the hook used to judge only the Edit FRAGMENT (tool_input.new_string), so a
// file-level `-- status-enum-check: exempt` / `// status-enum-check: exempt`
// marker already on disk was invisible to an Edit — the guard denied the very
// file the marker exempts. It now simulates the edit against the on-disk file
// (line-ending-safe — edit-splice-lib) and judges the FULL post-edit content.
// Covers BOTH file types the hook gates: SQL migrations and TS under src/.
//
// status-enum-check.mjs resolves .claude/schema-registry.json relative to its
// OWN script location, so these tests run an ISOLATED COPY of the hook from a
// scratch .claude/hooks/ dir next to a crafted registry (same pattern as
// schema-registry-loud-failopen.test.mjs).
// Run: node .claude/hooks/status-enum-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { scratchHookEnvironment } from "./git-test-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

// Isolated scratch project: copied hook + lib dep, crafted registry, and its
// own supabase/migrations and src/lib dirs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-status-enum-"));
const hooksDir = path.join(tmp, ".claude", "hooks");
mkdirSync(hooksDir, { recursive: true });
mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
mkdirSync(path.join(tmp, "src", "lib"), { recursive: true });
for (const dep of ["status-enum-check.mjs", "edit-splice-lib.mjs"]) {
  copyFileSync(path.join(__dirname, dep), path.join(hooksDir, dep));
}
writeFileSync(path.join(tmp, ".claude", "schema-registry.json"), JSON.stringify({
  check_constraints: { "invoices.status": { values: ["draft", "posted", "voided"] } },
}));

const migPath = path.join(tmp, "supabase", "migrations", "20260826000000_test.sql");
const tsPath = path.join(tmp, "src", "lib", "queries.ts");

function runHook(toolName, filePath, toolInput) {
  return spawnSync(process.execPath, [path.join(hooksDir, "status-enum-check.mjs")], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath, ...toolInput } }),
    encoding: "utf8",
    env: scratchHookEnvironment(tmp),
    cwd: tmp,
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

const CRLF = (s) => s.replace(/\n/g, "\r\n");

try {
  // ── Write payloads (full content, no disk splice) — pre-existing behavior ──
  let r = runHook("Write", migPath, { content: "UPDATE invoices SET status = 'void' WHERE id = 1;\n" });
  ok(isDeny(r), "SQL Write: literal outside the CHECK set ('void') is denied");

  r = runHook("Write", migPath, {
    content: "-- status-enum-check: exempt (constraint expanded in this migration)\n" +
      "UPDATE invoices SET status = 'void' WHERE id = 1;\n",
  });
  ok(!isDeny(r), "SQL Write: the same literal with the exempt marker is allowed");

  // ── THE DEADLOCK, SQL (allow direction): CRLF disk carries the marker; the
  // LF Edit fragment spans a line boundary and does NOT contain the marker.
  // Fragment-only judging saw an out-of-set literal with no marker → denied an
  // edit to a file the marker exempts. Full-file judging sees the marker. ──
  writeFileSync(migPath, CRLF(
    "-- status-enum-check: exempt (this migration expands the CHECK)\n" +
    "UPDATE invoices SET status = 'archived' WHERE id = 1;\n" +
    "-- end of migration\n"
  ));
  r = runHook("Edit", migPath, {
    old_string: "UPDATE invoices SET status = 'archived' WHERE id = 1;\n-- end of migration",
    new_string: "UPDATE invoices SET status = 'archived' WHERE id = 2;\n-- end of migration",
  });
  ok(!isDeny(r), "SQL CRLF disk with on-disk exempt marker: marker-less multi-line Edit is allowed (deadlock fixed)");

  // Same shape via MultiEdit's edits array (used to be silently ALLOWED with
  // empty content — now judged like any Edit).
  r = runHook("MultiEdit", migPath, {
    edits: [{
      old_string: "UPDATE invoices SET status = 'archived' WHERE id = 1;\n-- end of migration",
      new_string: "UPDATE invoices SET status = 'archived' WHERE id = 2;\n-- end of migration",
    }],
  });
  ok(!isDeny(r), "SQL CRLF disk + LF MultiEdit: marker on disk is seen, edit allowed");

  // ── FAIL-OPEN direction, SQL: CRLF disk looks benign; the multi-line LF
  // Edit introduces the out-of-set literal. A non-normalized splice would
  // no-op and judge the unedited (benign) file → allow. Must still deny. ──
  writeFileSync(migPath, CRLF("-- benign migration\nSELECT 1;\n"));
  r = runHook("Edit", migPath, {
    old_string: "-- benign migration\nSELECT 1;",
    new_string: "-- benign migration\nSELECT 1;\n" +
      "UPDATE invoices SET status = 'void' WHERE id = 1;",
  });
  ok(isDeny(r), "SQL CRLF disk + multi-line LF Edit that ADDS an out-of-set literal is still denied");

  // ── THE DEADLOCK, TS: same marker mechanics for a src/ TypeScript file. ──
  writeFileSync(tsPath, CRLF(
    "// status-enum-check: exempt (migration in this branch adds 'archived')\n" +
    "export const q = supabase.from('invoices').eq('status', 'archived');\n" +
    "export default q;\n"
  ));
  r = runHook("Edit", tsPath, {
    old_string: "export const q = supabase.from('invoices').eq('status', 'archived');\nexport default q;",
    new_string: "export const query = supabase.from('invoices').eq('status', 'archived');\nexport default query;",
  });
  ok(!isDeny(r), "TS CRLF disk with on-disk // exempt marker: marker-less multi-line Edit is allowed (deadlock fixed)");

  // ── FAIL-OPEN direction, TS: benign CRLF disk; the Edit adds the violation. ──
  writeFileSync(tsPath, CRLF(
    "export const ids = [1, 2, 3];\n" +
    "export default ids;\n"
  ));
  r = runHook("Edit", tsPath, {
    old_string: "export const ids = [1, 2, 3];\nexport default ids;",
    new_string: "export const ids = [1, 2, 3];\n" +
      "export const q = supabase.from('invoices').eq('status', 'bogus');\n" +
      "export default ids;",
  });
  ok(isDeny(r), "TS CRLF disk + multi-line LF Edit that ADDS an out-of-set literal is still denied");

  // ── LF disk sanity: unchanged behavior on an already-LF file. ──
  writeFileSync(migPath, "-- lf migration\nSELECT 1;\n");
  r = runHook("Edit", migPath, {
    old_string: "SELECT 1;",
    new_string: "SELECT 1;\nUPDATE invoices SET status = 'void' WHERE id = 1;",
  });
  ok(isDeny(r), "LF disk: an Edit adding an out-of-set literal is denied (unchanged behavior)");

  r = runHook("Edit", migPath, {
    old_string: "-- lf migration",
    new_string: "-- lf migration, edited",
  });
  ok(!isDeny(r), "LF disk: a benign Edit on a benign file is allowed (unchanged behavior)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`status-enum-check: ${pass} assertions passed`);
