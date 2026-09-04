#!/usr/bin/env node
// Regenerate .claude/schema-registry.json from live Supabase introspection.
// Registry v2 — extends v1 (generated_columns / status_enums / tables_without_updated_at)
// with: check_constraints (ALL parseable IN-list CHECKs), skipped_constraints (loud list of
// CHECKs the parser could NOT turn into a value set), not_null_columns, columns, sequences,
// and _meta.migrations_high_water (max APPLIED migration version live).
//
// MODES:
//   node scripts/regenerate-schema-registry.mjs
//       "Stamp" mode (v1 behavior preserved): refresh _meta.generated_at only.
//       Warns if the registry is still v1-shaped.
//
//   node scripts/regenerate-schema-registry.mjs --from-introspection <file.json | ->
//       Full rebuild from a JSON file of query results (use "-" to read stdin).
//       Claude Code runs the queries below via the Supabase MCP execute_sql tool,
//       saves the rows into one JSON object, and invokes this mode.
//
// INTROSPECTION INPUT FORMAT (one JSON object; each key = raw row array from its query):
//   {
//     "migrations_high_water": [ { "high_water": "20260610184551" } ],
//     "sequences":             [ { "sequence_name": "..." }, ... ],
//     "generated_columns":     [ { "table_name": "...", "column_name": "...", "generation_expression": "..." }, ... ],
//     "check_constraints":     [ { "table_name": "...", "constraint_name": "...", "def": "CHECK (...)" }, ... ],
//     "columns":               [ { "table_name": "...", "cols": [...], "not_null_no_default": [...], "not_null_with_default": [...] }, ... ],
//     "applied_names":         [ { "name": "..." }, ... ]   -- OPTIONAL, see Q6 below
//   }
//   (status_enums and tables_without_updated_at are DERIVED — no separate query needed.)
//   applied_names is OPTIONAL for backward compatibility: input without this key still
//   works exactly as before, it just omits _meta.applied_migration_names from the output.
//
// QUERIES TO RUN (read-only, public schema, via Supabase MCP execute_sql):
//
// (Q1) migrations_high_water:
//     SELECT max(version) AS high_water FROM supabase_migrations.schema_migrations;
//
// (Q2) sequences:
//     SELECT sequence_name FROM information_schema.sequences
//     WHERE sequence_schema = 'public' ORDER BY 1;
//
// (Q3) generated_columns:
//     SELECT table_name, column_name, generation_expression
//     FROM information_schema.columns
//     WHERE table_schema = 'public' AND is_generated = 'ALWAYS'
//     ORDER BY 1, 2;
//
// (Q4) check_constraints (EVERY CHECK, not just status):
//     SELECT conrelid::regclass::text AS table_name,
//            conname AS constraint_name,
//            pg_get_constraintdef(oid) AS def
//     FROM pg_constraint
//     WHERE contype = 'c' AND connamespace = 'public'::regnamespace
//     ORDER BY 1, 2;
//
// (Q5) columns (full list + NOT NULL split by has-default; excludes GENERATED cols
//      from the NOT NULL sets — those are covered by generated_columns):
//     SELECT c.table_name,
//       jsonb_agg(c.column_name ORDER BY c.ordinal_position) AS cols,
//       COALESCE(jsonb_agg(c.column_name ORDER BY c.ordinal_position)
//         FILTER (WHERE c.is_nullable = 'NO' AND c.is_generated <> 'ALWAYS'
//                 AND c.column_default IS NULL AND c.is_identity = 'NO'), '[]'::jsonb) AS not_null_no_default,
//       COALESCE(jsonb_agg(c.column_name ORDER BY c.ordinal_position)
//         FILTER (WHERE c.is_nullable = 'NO' AND c.is_generated <> 'ALWAYS'
//                 AND (c.column_default IS NOT NULL OR c.is_identity = 'YES')), '[]'::jsonb) AS not_null_with_default
//     FROM information_schema.columns c
//     JOIN information_schema.tables t
//       ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
//     WHERE c.table_schema = 'public'
//     GROUP BY c.table_name ORDER BY c.table_name;
//     -- If the MCP response is too large, split with `AND c.table_name <= 'mmm'` /
//     -- `AND c.table_name > 'mmm'` and concatenate the row arrays.
//
// (Q6) applied_names (OPTIONAL — powers name-based staleness comparison in
//      session-staleness.mjs; server-assigned `version` can be LOWER than the
//      migration filename's timestamp for migrations applied via the Supabase
//      MCP, which makes the numeric high-water compare false-positive forever
//      on those migrations. Name matching sidesteps that):
//     SELECT name FROM supabase_migrations.schema_migrations ORDER BY name;
//
// CHEAPEST WORKFLOW:
//   Open Claude Code in this repo and say: "regenerate the schema-registry from Supabase"
//   (the /regen-schema-registry skill). Claude runs Q1–Q6 via MCP, assembles the input
//   JSON, and runs this script with --from-introspection.

import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "..", ".claude", "schema-registry.json");
const today = new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// CHECK-constraint parser.
// Accepts pg_get_constraintdef() output. Returns { column, values, nullable }
// for single-column IN-list CHECKs (col = ANY (ARRAY[...]), optionally wrapped
// in "(col IS NULL) OR (...)"), or null when the constraint is anything else.
// Anything that returns null lands in skipped_constraints — LOUDLY — so nobody
// assumes the hooks validate a constraint they can't parse.
// ─────────────────────────────────────────────────────────────────────────────
const CAST_RE = /::(?:character varying|double precision|timestamp(?: with(?:out)? time zone)?|text|bigint|numeric|integer|smallint|boolean|date|uuid|jsonb|json|real|interval|bpchar|varchar)(?:\[\])?/g;

export function parseCheckDef(def) {
  let s = String(def).replace(/^CHECK\s*/i, "").replace(CAST_RE, "");
  const m = s.match(/\(?(\w+)\)?\s*=\s*ANY\s*\(+\s*ARRAY\[([\s\S]*?)\]/);
  if (!m) return null;
  const column = m[1];
  const values = [];
  const itemRe = /'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g;
  let im;
  while ((im = itemRe.exec(m[2])) !== null) {
    values.push(im[1] !== undefined ? im[1].replace(/''/g, "'") : Number(im[2]));
  }
  if (values.length === 0) return null;
  // Everything OUTSIDE the matched IN-list must be parens/whitespace, or the
  // "(col IS NULL) OR" wrapper. Otherwise the constraint has extra conditions
  // we don't understand -> refuse to parse (caller records it as skipped).
  let rest = s.replace(m[0], "");
  const nullRe = new RegExp(`\\(\\s*${column}\\s+IS\\s+NULL\\s*\\)\\s*OR`, "i");
  const nullable = nullRe.test(rest);
  rest = rest.replace(nullRe, "").replace(/[()\s]/g, "");
  if (rest !== "") return null;
  return { column, values, nullable };
}

function skipReason(def) {
  if (/[<>]=?|<>|IS\s+DISTINCT\s+FROM/i.test(def)) return "range/comparison — not an IN-list; hooks do NOT validate this constraint";
  if (/\bOR\b|\bAND\b/i.test(def)) return "conditional/multi-column — not a single-column IN-list; hooks do NOT validate this constraint";
  return "unparseable — hooks do NOT validate this constraint";
}

function rebuildFromIntrospection(inputArg) {
  let raw;
  try {
    raw = inputArg === "-" ? readFileSync(0, "utf8") : readFileSync(inputArg, "utf8");
  } catch (e) {
    console.error(`Could not read introspection input ${inputArg}: ${e.message}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Introspection input is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  for (const key of ["migrations_high_water", "sequences", "generated_columns", "check_constraints", "columns"]) {
    if (!Array.isArray(data[key])) {
      console.error(`Introspection input missing array key "${key}" — see header of this script for the format.`);
      process.exit(1);
    }
  }

  // ── parse CHECK constraints ────────────────────────────────────────────
  const checkConstraintsRaw = {};   // "table.column" -> { values, nullable?, constraints }
  const skipped = [];
  for (const row of data.check_constraints) {
    const parsed = parseCheckDef(row.def);
    if (!parsed) {
      skipped.push({ table: row.table_name, constraint: row.constraint_name, def: row.def, reason: skipReason(row.def) });
      continue;
    }
    const key = `${row.table_name}.${parsed.column}`;
    if (checkConstraintsRaw[key]) {
      // Two IN-list CHECKs on the same column: effective set = intersection.
      const prev = checkConstraintsRaw[key];
      prev.values = prev.values.filter(v => parsed.values.some(p => String(p) === String(v)));
      prev.constraints.push(row.constraint_name);
      if (parsed.nullable) prev.nullable = true;
    } else {
      const entry = { values: parsed.values, constraints: [row.constraint_name] };
      if (parsed.nullable) entry.nullable = true;
      checkConstraintsRaw[key] = entry;
    }
  }
  // Deterministic output: sort keys alphabetically.
  const checkConstraints = {};
  for (const key of Object.keys(checkConstraintsRaw).sort()) checkConstraints[key] = checkConstraintsRaw[key];

  // ── derive v1 keys ─────────────────────────────────────────────────────
  const statusEnums = {};
  for (const [key, entry] of Object.entries(checkConstraints)) {
    if (/status$/.test(key.split(".")[1])) statusEnums[key] = entry.values;
  }

  const generatedColumns = data.generated_columns.map(r => ({
    table: r.table_name, column: r.column_name, expression: r.generation_expression,
  }));

  const columns = {};
  const notNullColumns = {};
  for (const row of data.columns) {
    columns[row.table_name] = row.cols;
    notNullColumns[row.table_name] = {
      no_default: row.not_null_no_default,
      with_default: row.not_null_with_default,
    };
  }
  const tablesWithoutUpdatedAt = Object.keys(columns)
    .filter(t => !columns[t].includes("updated_at"))
    .sort();

  const sequences = data.sequences.map(r => r.sequence_name).sort();
  const highWater = data.migrations_high_water[0]?.high_water || null;

  // applied_names (Q6): sorted list of every migration `name` in
  // supabase_migrations.schema_migrations live. When the input omits it,
  // CARRY FORWARD the previous registry's list rather than dropping the field —
  // dropping it would silently push session-staleness back onto the numeric
  // version comparison whose false positives the name list exists to fix
  // (Codex P2 2026-07-13). A carried-forward list can only be *behind* (names
  // only ever get added), which at worst re-warns about a recently applied
  // migration — the safe direction.
  let appliedMigrationNames = Array.isArray(data.applied_names)
    ? [...new Set(data.applied_names.map(r => String(r.name)))].sort()
    : null;
  if (!appliedMigrationNames) {
    try {
      const previous = JSON.parse(readFileSync(registryPath, "utf8"));
      if (Array.isArray(previous?._meta?.applied_migration_names)) {
        appliedMigrationNames = previous._meta.applied_migration_names;
        console.warn("applied_names not in introspection input — carried forward the previous registry's applied_migration_names (run Q6 next refresh to update it).");
      }
    } catch { /* no previous registry to carry from */ }
  }

  const registry = {
    _meta: {
      registry_version: 2,
      generated_at: today,
      generated_from: "Supabase project rhyzpcqhnizqbxphqdkr — public schema introspection",
      regenerate_with: "node scripts/regenerate-schema-registry.mjs --from-introspection <queries.json> (queries documented in the script header)",
      purpose: "Single source of truth for hooks: generated columns, status enums, ALL parseable CHECK IN-lists, NOT NULL columns, full column lists, sequences, tables-with/without updated_at, applied-migration high water.",
      note: "For a fresh refresh from the live DB, ask Claude Code: 'regenerate the schema-registry from Supabase' (/regen-schema-registry). skipped_constraints lists every CHECK the hooks can NOT validate — review it when touching those tables.",
      migrations_high_water: highWater,
      ...(appliedMigrationNames ? { applied_migration_names: appliedMigrationNames } : {}),
    },
    generated_columns: generatedColumns,
    status_enums: statusEnums,
    tables_without_updated_at: tablesWithoutUpdatedAt,
    check_constraints: checkConstraints,
    skipped_constraints: skipped,
    not_null_columns: notNullColumns,
    columns,
    sequences,
  };

  // ── v1 drift report (informational, loud) ──────────────────────────────
  let prior = null;
  try { prior = JSON.parse(readFileSync(registryPath, "utf8")); } catch { /* first run */ }
  if (prior) {
    const canon = (v) => {
      if (Array.isArray(v) || v === null || typeof v !== "object") return JSON.stringify(v);
      return JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
    };
    for (const key of ["generated_columns", "status_enums", "tables_without_updated_at"]) {
      if (prior[key] !== undefined && canon(prior[key]) !== canon(registry[key])) {
        console.warn(`⚠️  v1 key "${key}" changed vs the previous registry — live schema moved (or parser drift). Diff before trusting hooks.`);
      }
    }
  }

  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  console.log(`Wrote ${registryPath} (registry v2).`);
  console.log(`  check_constraints: ${Object.keys(checkConstraints).length} columns | skipped_constraints: ${skipped.length}`);
  console.log(`  status_enums: ${Object.keys(statusEnums).length} | generated_columns: ${generatedColumns.length}`);
  console.log(`  columns: ${Object.keys(columns).length} tables | tables_without_updated_at: ${tablesWithoutUpdatedAt.length}`);
  console.log(`  not_null_columns: ${Object.keys(notNullColumns).length} tables | sequences: ${sequences.length}`);
  console.log(`  migrations_high_water: ${highWater}`);
  console.log(`  applied_migration_names: ${appliedMigrationNames ? appliedMigrationNames.length : "(not provided — Q6 omitted, session-staleness falls back to numeric compare)"}`);
  if (skipped.length > 0) {
    console.log(`\n⚠️  ${skipped.length} CHECK constraint(s) could not be parsed into value sets — the hooks do NOT validate these:`);
    for (const s of skipped) console.log(`   - ${s.table}.${s.constraint}: ${s.reason}`);
  }
}

function stampMode() {
  // "No-DB" mode: just refresh the timestamp so a manual edit lands cleanly.
  // Real refresh happens through Claude + Supabase MCP — see the header above.
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
  current._meta.regenerate_with = "node scripts/regenerate-schema-registry.mjs --from-introspection <queries.json> (queries documented in the script header)";
  current._meta.note = current._meta.note || "For a fresh refresh from the live DB, ask Claude Code to do it (it has Supabase MCP introspection).";

  writeFileSync(registryPath, JSON.stringify(current, null, 2) + "\n");
  console.log(`Stamped ${registryPath} (generated_at = ${today}).`);
  if (!current.check_constraints) {
    console.warn(`⚠️  Registry is still v1-shaped (no check_constraints key). Run the --from-introspection mode for the v2 rebuild — queries are in this script's header.`);
  }
  console.log(`To pull fresh schema data, ask Claude Code: "regenerate the schema-registry from Supabase".`);
}

const args = process.argv.slice(2);
const fiIdx = args.indexOf("--from-introspection");
if (fiIdx !== -1) {
  const inputArg = args[fiIdx + 1];
  if (!inputArg) {
    console.error("Usage: node scripts/regenerate-schema-registry.mjs --from-introspection <file.json | ->");
    process.exit(1);
  }
  rebuildFromIntrospection(inputArg);
} else {
  stampMode();
}
