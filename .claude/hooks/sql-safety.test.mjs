#!/usr/bin/env node
// Tests for sql-safety.mjs, focused on the CRLF Edit-splice deadlock class
// (2026-08-26, same class as grant-change-guard / idempotency-body-check):
// the hook used to judge only the Edit FRAGMENT (tool_input.new_string), so a
// file-level `-- sql-safety: exempt-registry` marker already on disk was
// invisible to an Edit — the guard (or its registry-stale gate) denied the
// very migration the marker exempts. It now simulates the edit against the
// on-disk file (line-ending-safe — edit-splice-lib) and judges the FULL
// post-edit content.
//
// sql-safety.mjs resolves .claude/schema-registry.json relative to its OWN
// script location, so these tests run an ISOLATED COPY of the hook from a
// scratch .claude/hooks/ dir next to a crafted registry (same pattern as
// schema-registry-loud-failopen.test.mjs).
// Run: node .claude/hooks/sql-safety.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { scratchHookEnvironment } from "./git-test-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

// Isolated scratch project: copied hook + its two lib deps, crafted v2
// registry, and its own supabase/migrations dir.
const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-sql-safety-"));
const hooksDir = path.join(tmp, ".claude", "hooks");
mkdirSync(hooksDir, { recursive: true });
mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
for (const dep of ["sql-safety.mjs", "registry-freshness-lib.mjs", "edit-splice-lib.mjs"]) {
  copyFileSync(path.join(__dirname, dep), path.join(hooksDir, dep));
}
writeFileSync(path.join(tmp, ".claude", "schema-registry.json"), JSON.stringify({
  columns: { invoices: ["id", "status"] },
  not_null_columns: { invoices: { no_default: ["status"], with_default: [] } },
  sequences: [],
}));

const migPath = path.join(tmp, "supabase", "migrations", "20260826000000_test.sql");

function runHook(toolName, toolInput) {
  return spawnSync(process.execPath, [path.join(hooksDir, "sql-safety.mjs")], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: migPath, ...toolInput } }),
    encoding: "utf8",
    env: scratchHookEnvironment(tmp),
    cwd: tmp,
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }
// Allow-side assertions must be AFFIRMATIVE: a crashed hook produces empty
// stdout, and `!isDeny` would read that as an allow (CodeRabbit PR #489).
function isAllow(r) {
  return !r.error && r.status === 0 && r.stdout.includes('"permissionDecision":"allow"');
}

const CRLF = (s) => s.replace(/\n/g, "\r\n");

try {
  // ── Write payloads (full content, no disk splice) — pre-existing behavior ──
  let r = runHook("Write", { content: "UPDATE invoices SET status = NULL WHERE id = 1;\n" });
  ok(isDeny(r), "Write: rule 6 (SET NOT-NULL col = NULL) without a marker is denied");

  r = runHook("Write", {
    content: "-- sql-safety: exempt-registry (registry lags this backfill)\n" +
      "UPDATE invoices SET status = NULL WHERE id = 1;\n",
  });
  ok(isAllow(r), "Write: the same SQL with the exempt-registry marker is allowed");

  // ── THE DEADLOCK (allow direction): CRLF disk carries the marker; the LF
  // Edit fragment spans a line boundary and does NOT contain the marker.
  // Fragment-only judging saw rule-6 SQL with no marker → denied an edit to a
  // file the marker exempts. Full-file judging sees the marker → allowed. ──
  writeFileSync(migPath, CRLF(
    "-- sql-safety: exempt-registry (registry lags this backfill)\n" +
    "UPDATE invoices SET status = NULL WHERE id = 1;\n" +
    "-- end of migration\n"
  ));
  r = runHook("Edit", {
    old_string: "UPDATE invoices SET status = NULL WHERE id = 1;\n-- end of migration",
    new_string: "UPDATE invoices SET status = NULL WHERE id = 2;\n-- end of migration",
  });
  ok(isAllow(r), "CRLF disk with on-disk exempt-registry marker: marker-less multi-line Edit is allowed (deadlock fixed)");

  // Same shape via MultiEdit's edits array (used to be silently ALLOWED with
  // empty content — now judged like any Edit).
  r = runHook("MultiEdit", {
    edits: [{
      old_string: "UPDATE invoices SET status = NULL WHERE id = 1;\n-- end of migration",
      new_string: "UPDATE invoices SET status = NULL WHERE id = 2;\n-- end of migration",
    }],
  });
  ok(isAllow(r), "CRLF disk + LF MultiEdit: marker on disk is seen, edit allowed");

  // ── Registry-stale gate variant of the deadlock: REGISTRY-STALE.flag set,
  // marker on disk, benign Edit fragment without the marker. Fragment-only
  // judging hit the stale gate; full-file judging sees the marker exemption. ──
  const flagPath = path.join(tmp, ".claude", "session-state", "REGISTRY-STALE.flag");
  mkdirSync(path.dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, JSON.stringify({ created: new Date().toISOString(), reason: "test" }));
  r = runHook("Edit", {
    old_string: "-- end of migration",
    new_string: "-- end",
  });
  ok(isAllow(r), "stale flag + on-disk marker: benign marker-less Edit is allowed (stale-gate deadlock fixed)");

  // Sanity: with the flag up and NO marker anywhere, a migration Edit is still
  // gated on the stale registry.
  writeFileSync(migPath, CRLF("-- plain migration\nSELECT 1;\n"));
  r = runHook("Edit", {
    old_string: "-- plain migration",
    new_string: "-- plain migration, edited",
  });
  ok(isDeny(r) && r.stdout.includes("REGISTRY STALE"), "stale flag + no marker: migration Edit is still blocked by the stale gate");
  unlinkSync(flagPath);

  // ── FAIL-OPEN direction: CRLF disk looks benign; the multi-line LF Edit
  // introduces a rule-3 violation. A non-normalized splice would no-op and
  // judge the unedited (benign) file → allow. Must still deny. ──
  writeFileSync(migPath, CRLF("-- benign migration\nSELECT 1;\n"));
  r = runHook("Edit", {
    old_string: "-- benign migration\nSELECT 1;",
    new_string: "-- benign migration\nSELECT 1;\n" +
      "DELETE FROM idempotency_keys WHERE key = p_idempotency_key;",
  });
  ok(isDeny(r), "CRLF disk + multi-line LF Edit that ADDS a rule-3 violation is still denied");

  // ── Marker REMOVAL (CodeRabbit PR #489 class): disk has the marker AND the
  // rule-6 SQL; the Edit deletes the marker line outright. A pure-deletion
  // Edit has an empty new_string, so an emptiness early-exit ABOVE the
  // reconstruction would bypass the guard entirely; and any scan that still
  // sees pre-edit disk content would still see the old marker. ──
  writeFileSync(migPath, CRLF(
    "-- sql-safety: exempt-registry (registry lags this backfill)\n" +
    "UPDATE invoices SET status = NULL WHERE id = 1;\n"
  ));
  r = runHook("Edit", {
    old_string: "-- sql-safety: exempt-registry (registry lags this backfill)\n",
    new_string: "",
  });
  ok(isDeny(r), "an Edit that DELETES the exempt-registry marker from a rule-6 file is denied");

  // ── Reconstruction failure + deletion Edit fails CLOSED (CodeRabbit PR #489
  // round 2): existsSync passes but readFileSync throws (a directory named
  // *.sql), and the deletion's empty new_string leaves nothing to analyze —
  // allowing would let a marker-deleting edit through unanalyzed. ──
  const dirAsSql = path.join(tmp, "supabase", "migrations", "20260826000001_dir.sql");
  mkdirSync(dirAsSql, { recursive: true });
  r = runHook("Edit", {
    file_path: dirAsSql,
    old_string: "-- sql-safety: exempt-registry (x)\n",
    new_string: "",
  });
  ok(isDeny(r), "a deletion Edit whose file cannot be read is denied (fail closed), not allowed unanalyzed");
  ok(r.stdout.includes("could not be read"), "the unreadable-file deny explains itself");

  // Boundary: a deletion that empties a READABLE file reconstructs to empty
  // content — nothing left to analyze, allowed.
  writeFileSync(migPath, CRLF("-- sql-safety: exempt-registry (stale marker, nothing left)\n"));
  r = runHook("Edit", {
    old_string: "-- sql-safety: exempt-registry (stale marker, nothing left)\n",
    new_string: "",
  });
  ok(isAllow(r), "a deletion that empties a readable file is allowed (empty reconstruction is trustworthy)");

  // ── LF disk sanity: unchanged behavior on an already-LF file. ──
  writeFileSync(migPath, "-- lf migration\nSELECT 1;\n");
  r = runHook("Edit", {
    old_string: "SELECT 1;",
    new_string: "SELECT 1;\nUPDATE invoices SET status = NULL WHERE id = 1;",
  });
  ok(isDeny(r), "LF disk: an Edit adding a rule-6 violation is denied (unchanged behavior)");

  r = runHook("Edit", {
    old_string: "-- lf migration",
    new_string: "-- lf migration, edited",
  });
  ok(isAllow(r), "LF disk: a benign Edit on a benign file is allowed (unchanged behavior)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`sql-safety: ${pass} assertions passed`);
