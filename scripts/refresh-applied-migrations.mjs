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

// Preserve the timestamp whatever shape the row has.
//
// Preferring `name` alone loses it: many real ledger rows carry a name with no
// timestamp at all — e.g. version `20260727174805`, name
// `deactivation_revokes_auth_access`. Dropping those rows would leave the guard
// comparing against an older parseable row and happily permitting a migration
// that is older than the true high-water mark, which is exactly the reversion
// this whole mechanism exists to stop. (Codex P1, PR #348.)
//
// So: keep `name` when it already embeds a timestamp, otherwise re-attach the
// version as a `<version>_<name>` prefix. normalizeMigrationName() understands
// that shape — it is the same one the live ledger produced on 2026-07-15.
const TS = /\d{14}/;
const applied = rows
  .map((r) => {
    if (typeof r === "string") return r;
    const name = (r?.name ?? "").toString().trim();
    const version = (r?.version ?? "").toString().trim();
    if (name && TS.test(name)) return name;
    if (version && name) return `${version}_${name}`;
    return version || name || "";
  })
  .filter(Boolean);

const withoutTimestamp = applied.filter((n) => !TS.test(n));
if (withoutTimestamp.length) {
  console.warn(
    `refresh-applied-migrations: ${withoutTimestamp.length} row(s) carry no 14-digit timestamp ` +
    `and cannot constrain ordering, e.g. ${withoutTimestamp.slice(0, 3).join(", ")}`
  );
}

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
