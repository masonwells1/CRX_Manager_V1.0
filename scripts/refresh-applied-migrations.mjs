#!/usr/bin/env node
// Refresh the applied-migration snapshot that the ordering preflight in
// .claude/hooks/migration-apply-guard.mjs compares against.
//
// WHY A SNAPSHOT
//   The hook runs in-process with no database access, but the ordering rule is
//   only meaningful against what the DATABASE has actually applied — comparing
//   against files on disk is wrong and would block a correct ascending batch of
//   new migrations (the bug Codex and CodeRabbit both caught on PR #348).
//   So the ledger is captured here and read there.
//
// USAGE
//   Query the live ledger via the Supabase MCP (read-only):
//
//     select version, name from supabase_migrations.schema_migrations
//      order by version;
//
//   then pipe that JSON in:
//
//     node scripts/refresh-applied-migrations.mjs < rows.json
//     cat rows.json | node scripts/refresh-applied-migrations.mjs
//
//   Accepts either a bare array or {result: [...]} / {applied: [...]}, and rows
//   shaped as strings, {name}, or {version}.
//
// STALENESS
//   The snapshot records when it was taken. It is advisory input to a guard
//   that ABSTAINS when the snapshot is missing — it never manufactures a pass.
//   Refresh it after applying migrations so the next apply is judged against
//   current truth.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const outPath = path.join(projectDir, ".claude", "session-state", "applied-migrations.json");

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  console.error("refresh-applied-migrations: no input on stdin.");
  process.exit(1);
}

if (!raw.trim()) {
  console.error("refresh-applied-migrations: stdin was empty — nothing written.");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`refresh-applied-migrations: input is not valid JSON — ${err.message}`);
  process.exit(1);
}

// Locate the row array wherever the MCP response wraps it.
function findRows(node, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(node)) return node;
  if (node && typeof node === "object") {
    for (const key of ["applied", "result", "rows", "data"]) {
      if (key in node) {
        const found = findRows(node[key], depth + 1);
        if (found) return found;
      }
    }
    for (const value of Object.values(node)) {
      const found = findRows(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const rows = findRows(parsed);
if (!rows) {
  console.error("refresh-applied-migrations: could not find a row array in the input.");
  process.exit(1);
}

const applied = rows
  .map((r) => (typeof r === "string" ? r : (r?.name ?? r?.version ?? "")))
  .filter(Boolean);

if (!applied.length) {
  console.error(
    "refresh-applied-migrations: input contained zero usable rows — refusing to write an " +
    "empty snapshot, which would look like 'nothing applied' to the guard."
  );
  process.exit(1);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ captured_at: new Date().toISOString(), count: applied.length, applied }, null, 2)}\n`,
  "utf8"
);

console.log(`refresh-applied-migrations: wrote ${applied.length} applied migration names to ${outPath}`);
