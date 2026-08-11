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
//   then pipe that JSON in, naming the project it came FROM:
//
//     node scripts/refresh-applied-migrations.mjs --project=<ref> < rows.json
//     cat rows.json | node scripts/refresh-applied-migrations.mjs --project=<ref>
//
//   Accepts either a bare array or {result: [...]} / {applied: [...]}, and rows
//   shaped as strings, {name}, or {version}.
//
// WHY --project IS REQUIRED
//   A ledger is only evidence about the database it was read from. Recording
//   only time, count and names made the snapshot portable between databases:
//   capture production's ledger, then aim an apply at a restored copy or a
//   staging branch, and the guard reads production's migration names as though
//   they were that database's — the one-shot replay protection switches itself
//   off against the very database that has not run the migration (Codex High,
//   PR #364 round 10). The project ref is written here and must match the
//   apply's target ref there; there is no default, because a guessed default is
//   what makes a mismatch invisible.
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

// Which database did these rows come from? Required, CLI-only. Deliberately no
// environment fallback: SUPABASE_PROJECT_REF is exported by nothing in either
// manifest, so an env default would be empty in every normal run and a stray
// value in an abnormal one — the two ways a binding stops binding.
const PROJECT_REF_SHAPE = /^[a-z0-9]{15,40}$/;
const projectArg = process.argv
  .slice(2)
  .map((a) => (a.startsWith("--project=") ? a.slice("--project=".length) : ""))
  .filter(Boolean)
  .pop();
const projectRef = (projectArg || "").toString().trim().toLowerCase();

if (!projectRef) {
  console.error(
    "refresh-applied-migrations: --project=<supabase project ref> is required.\n" +
    "  A ledger snapshot is evidence about ONE database. Without the ref, production's\n" +
    "  ledger can be replayed against a restored or staging database and the one-shot\n" +
    "  replay guard would read it as that database's own history.\n" +
    "  Example: node scripts/refresh-applied-migrations.mjs --project=rhyzpcqhnizqbxphqdkr < rows.json"
  );
  process.exit(1);
}

if (!PROJECT_REF_SHAPE.test(projectRef)) {
  console.error(
    `refresh-applied-migrations: --project=${JSON.stringify(projectRef)} is not a Supabase project ` +
    "ref (expected 15-40 lowercase alphanumeric characters). Refusing to stamp the snapshot with " +
    "a value that cannot be matched against the apply target."
  );
  process.exit(1);
}

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
// Accept an array only if it actually looks like ledger rows. Taking the first
// array reached would happily adopt some unrelated list of strings and turn it
// into "applied migration names". (CodeRabbit, PR #348.)
// A bare array of strings is NOT enough. `["note", "20260808170000"]` passed the
// first version of this predicate and then satisfied the timestamp check below,
// so findRows could adopt some unrelated list and write it out as ordering
// evidence. (CodeRabbit, PR #354.) Strings must now look like an actual
// migration identifier, and objects must carry a real ledger field.
const LEDGER_NAME = /^(?:.*\/)?\d{14}(?:_[^/]*)?(?:\.sql)?$/;

function looksLikeLedgerRow(r) {
  if (typeof r === "string") return LEDGER_NAME.test(r.trim());
  if (!r || typeof r !== "object") return false;
  if (!("name" in r) && !("version" in r)) return false;
  // The canonical ledger row is version-keyed; a 14-digit version is the one
  // field that cannot be mistaken for arbitrary data.
  const version = (r.version ?? "").toString().trim();
  if (/^\d{14}$/.test(version)) return true;
  // Tolerate a version-less row only when its name is itself migration-shaped.
  return LEDGER_NAME.test((r.name ?? "").toString().trim());
}

function looksLikeLedgerRows(arr) {
  if (!arr.length) return false;
  return arr.every(looksLikeLedgerRow);
}

function findRows(node, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(node)) return looksLikeLedgerRows(node) ? node : null;
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

// A snapshot where NOTHING is timestamped is worse than no snapshot: it is
// fresh and non-empty, so it satisfies the guard's presence and freshness
// checks, and then the ordering comparison has nothing to work with. Refuse to
// write it rather than manufacture evidence that answers no question.
// (CodeRabbit, PR #348.)
if (!applied.some((n) => TS.test(n))) {
  console.error(
    "refresh-applied-migrations: not one row carries a 14-digit migration timestamp, so this " +
    "snapshot could not constrain ordering at all. Refusing to write it — a snapshot that looks " +
    "valid but answers nothing would silently disable the guard. Check that the query selected " +
    "both `version` and `name` from supabase_migrations.schema_migrations."
  );
  process.exit(1);
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
  `${JSON.stringify(
    { captured_at: new Date().toISOString(), project_id: projectRef, count: applied.length, applied },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(
  `refresh-applied-migrations: wrote ${applied.length} applied migration names for project ` +
  `${projectRef} to ${outPath}`
);
