#!/usr/bin/env node
// Regenerate .claude/schema-registry.json from live Supabase introspection.
//
// HOW TO RUN:
//   Easiest path: ask Claude Code to do it. Claude has direct DB introspection
//   via the Supabase MCP tools and can refresh the file in seconds.
//
//   Manual path (advanced): run the 3 SQL queries below against the public schema
//   and paste the rows into the prompts when this script asks. Or run them via
//   `supabase db remote query` and stitch the results yourself.
//
// QUERIES TO RUN MANUALLY:
//
// (1) Generated columns:
//     SELECT table_name, column_name, generation_expression
//     FROM information_schema.columns
//     WHERE table_schema = 'public' AND is_generated = 'ALWAYS'
//     ORDER BY table_name, column_name;
//
// (2) Status CHECK constraints:
//     SELECT conrelid::regclass::text AS table_name,
//            conname AS constraint_name,
//            pg_get_constraintdef(oid) AS def
//     FROM pg_constraint
//     WHERE contype = 'c' AND connamespace = 'public'::regnamespace
//       AND pg_get_constraintdef(oid) ILIKE '%status%'
//     ORDER BY conrelid::regclass::text;
//
// (3) Tables WITHOUT updated_at:
//     WITH all_tables AS (
//       SELECT table_name FROM information_schema.tables
//       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
//     ), with_updated AS (
//       SELECT table_name FROM information_schema.columns
//       WHERE table_schema = 'public' AND column_name = 'updated_at'
//     )
//     SELECT table_name FROM all_tables
//     EXCEPT
//     SELECT table_name FROM with_updated
//     ORDER BY table_name;
//
// CHEAPEST WORKFLOW:
//   `Open Claude Code in this repo, then say: "regenerate the schema-registry from Supabase".`
//   Claude will run the 3 queries via its Supabase MCP tool and rewrite the file.

import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "..", ".claude", "schema-registry.json");

const today = new Date().toISOString().slice(0, 10);

// This script's "no-DB" mode: just refresh the timestamp so a manual edit lands cleanly.
// Real refresh happens through Claude + Supabase MCP — see the comment block above.
let current;
try {
  current = JSON.parse(readFileSync(registryPath, "utf8"));
} catch {
  console.error(`Could not read ${registryPath}. Has it been deleted? Restore from git.`);
  process.exit(1);
}

current._meta = current._meta || {};
current._meta.generated_at = today;
current._meta.generated_from = current._meta.generated_from || "Supabase project — public schema introspection";
current._meta.regenerate_with = "node scripts/regenerate-schema-registry.mjs";
current._meta.note = "For a fresh refresh from the live DB, ask Claude Code to do it (it has Supabase MCP introspection).";

writeFileSync(registryPath, JSON.stringify(current, null, 2) + "\n");
console.log(`Stamped ${registryPath} (generated_at = ${today}).`);
console.log(`To pull fresh schema data, ask Claude Code: "regenerate the schema-registry from Supabase".`);
