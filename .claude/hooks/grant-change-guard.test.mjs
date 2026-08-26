#!/usr/bin/env node
// Tests for grant-change-guard.mjs — the B10 caller-analysis guard — focused on
// the CRLF Edit-splice regression (2026-08-26, PR #401 branch): the guard
// simulates an Edit against the ON-DISK file, but an exact-match splice
// silently no-oped when disk was CRLF and the harness handed LF-normalized
// fragments. The guard then judged the UNEDITED file — denying the very Edit
// that added its required `-- caller-analysis:` marker (deadlock), and
// conversely ALLOWING an Edit that introduced a risky REVOKE (fail-open,
// because the unedited file looked benign).
// Spawns the real hook with crafted Edit/MultiEdit/Write stdin payloads.
// Run: node .claude/hooks/grant-change-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "grant-change-guard.mjs");
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

// Isolated fake project: its own caller-graph.json (fresh, so the stale-graph
// warning stays out of the way) and its own supabase/migrations dir.
const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-grant-guard-"));
mkdirSync(path.join(tmp, ".claude"), { recursive: true });
mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
writeFileSync(path.join(tmp, ".claude", "caller-graph.json"), JSON.stringify({
  _meta: { generated_at: new Date().toISOString() },
  rpc_callers: { my_fn: ["src/pages/Foo.tsx:12"] },
  edge_callers: {},
  cron_callers: {},
}));

const migPath = path.join(tmp, "supabase", "migrations", "20260826000000_test.sql");

function runHook(toolName, toolInput) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: migPath, ...toolInput } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
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
  let r = runHook("Write", { content: "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;\n" });
  ok(isDeny(r), "Write: risky REVOKE on a called function without a marker is denied");
  ok(r.stdout.includes("my_fn") && r.stdout.includes("Foo.tsx:12"), "Write deny lists the function and its caller");

  r = runHook("Write", {
    content: "-- caller-analysis: my_fn :: UI callsite removed in this branch\n" +
      "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;\n",
  });
  ok(isAllow(r), "Write: the same REVOKE with a caller-analysis marker is allowed");

  // ── THE DEADLOCK (allow direction): CRLF disk, LF fragments, marker-adding
  // Edit. The fragments span a line boundary — that is what makes an exact
  // (non-normalized) splice no-op against CRLF. The broken splice judged the
  // unedited file (REVOKE, no marker) → denied the marker-adding Edit. ──
  writeFileSync(migPath, CRLF(
    "-- test migration\n" +
    "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;\n"
  ));
  r = runHook("Edit", {
    old_string: "-- test migration\nREVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;",
    new_string: "-- test migration\n-- caller-analysis: my_fn :: UI callsite removed in this branch\n" +
      "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;",
  });
  ok(isAllow(r), "CRLF disk + multi-line LF Edit that ADDS the caller-analysis marker is allowed (deadlock fixed)");

  // Same edit shape via MultiEdit's edits array.
  r = runHook("MultiEdit", {
    edits: [{
      old_string: "-- test migration\nREVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;",
      new_string: "-- test migration\n-- caller-analysis: my_fn :: UI callsite removed in this branch\n" +
        "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;",
    }],
  });
  ok(isAllow(r), "CRLF disk + LF MultiEdit that adds the marker is allowed too");

  // ── FAIL-OPEN direction: CRLF disk looks benign; the multi-line LF Edit
  // introduces the risky REVOKE. Broken splice judged the unedited (benign)
  // file → allowed a marker-less REVOKE through. ──
  writeFileSync(migPath, CRLF(
    "-- benign migration\n" +
    "GRANT EXECUTE ON FUNCTION public.my_fn(uuid) TO service_role;\n"
  ));
  r = runHook("Edit", {
    old_string: "-- benign migration\nGRANT EXECUTE ON FUNCTION public.my_fn(uuid) TO service_role;",
    new_string: "-- benign migration\nGRANT EXECUTE ON FUNCTION public.my_fn(uuid) TO service_role;\n" +
      "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;",
  });
  ok(isDeny(r), "CRLF disk + multi-line LF Edit that ADDS a marker-less risky REVOKE is still denied");
  ok(r.stdout.includes("my_fn") && r.stdout.includes("Foo.tsx:12"), "the CRLF-path deny still lists the caller");

  // ── LF disk sanity: the exact-match path still behaves the same. ──
  writeFileSync(migPath,
    "-- lf migration\n" +
    "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;\n"
  );
  r = runHook("Edit", {
    old_string: "-- lf migration",
    new_string: "-- lf migration\n-- caller-analysis: my_fn :: cron runs as postgres owner, unaffected",
  });
  ok(isAllow(r), "LF disk: marker-adding Edit is allowed (unchanged behavior)");

  r = runHook("Edit", {
    old_string: "-- caller-analysis",
    new_string: "-- removed-analysis",
  });
  ok(isDeny(r), "an Edit whose old_string matches nothing still judges the on-disk content (marker-less REVOKE denied)");

  // ── Marker REMOVAL (CodeRabbit PR #489): disk has the marker AND the risky
  // REVOKE; the Edit deletes the marker line. Scanning the pre-edit disk
  // content alongside the reconstruction would still see the old marker and
  // allow a now-unjustified REVOKE. ──
  writeFileSync(migPath, CRLF(
    "-- caller-analysis: my_fn :: UI callsite removed in this branch\n" +
    "REVOKE EXECUTE ON FUNCTION public.my_fn(uuid) FROM authenticated;\n"
  ));
  r = runHook("Edit", {
    old_string: "-- caller-analysis: my_fn :: UI callsite removed in this branch\n",
    new_string: "",
  });
  ok(isDeny(r), "an Edit that REMOVES the caller-analysis marker from a risky-REVOKE file is denied");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`grant-change-guard: ${pass} assertions passed`);
