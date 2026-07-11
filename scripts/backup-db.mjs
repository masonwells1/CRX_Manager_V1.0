#!/usr/bin/env node
// Weekly DB backup helper — the deterministic half of the /backup-db flow.
//
// WHY THIS SHAPE: the Supabase project is on the FREE plan (no point-in-time
// recovery), and we keep NO service keys on disk — by design. So the actual
// data dumps are done by the scheduled Claude session through the Supabase MCP
// (read-only `execute_sql` SELECTs — the MCP holds the credentials). This
// script handles everything that does NOT need MCP access and must be
// deterministic:
//
//   --plan                 print the introspection SQL + the exact steps the
//                          driving session must run via MCP
//   --ingest <dir>         verify the per-table JSON dumps the session wrote
//     --expected-tables N  (one <table>.json raw row array per table), build
//                          <dir>/manifest.json, prune dated backup dirs older
//                          than 8 weeks (file-by-file — NEVER a recursive
//                          force delete; `rm -rf` is hard-blocked in this
//                          repo), and on success stamp <parent>/LATEST-OK.json
//                          — the marker the session-staleness hook watches.
//
// Safety properties:
//   - never touches the database (no driver, no keys — node builtins only)
//   - pruning runs ONLY after the new backup verified — we never trade the
//     last good backup for a broken new one
//   - a table-count mismatch or an unparseable dump FAILS the run and leaves
//     LATEST-OK.json and all older backups untouched
//   - warns (never fails) if total rows dropped >20% vs the previous manifest
//     (early corruption / mass-deletion signal — surface it to Mason)
//
// Usage:
//   node scripts/backup-db.mjs --plan
//   node scripts/backup-db.mjs --ingest backups/2026-07-04 --expected-tables 114
// Exit:   0 = OK, 1 = verification failure, 2 = usage error.
// Deps:   none (node builtins only).

import {
  existsSync, readFileSync, readdirSync, rmdirSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const PRUNE_AFTER_DAYS = 56; // 8 weeks
const DATED_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const INTROSPECTION_SQL =
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;";

function usage(msg) {
  if (msg) console.error(`USAGE ERROR: ${msg}\n`);
  console.error(
    `Usage:\n` +
    `  node scripts/backup-db.mjs --plan\n` +
    `  node scripts/backup-db.mjs --ingest <dir> --expected-tables <N>\n\n` +
    `  --plan                print the introspection SQL + the steps the driving\n` +
    `                        Claude session must run via the Supabase MCP\n` +
    `  --ingest <dir>        verify per-table JSON dumps in <dir>, write\n` +
    `                        <dir>/manifest.json, prune dated sibling backup dirs\n` +
    `                        older than ${PRUNE_AFTER_DAYS} days, stamp <parent>/LATEST-OK.json\n` +
    `  --expected-tables <N> required with --ingest; the table count from the\n` +
    `                        introspection SQL — a mismatch fails the run`
  );
  process.exit(2);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  console.error(`      LATEST-OK.json was NOT written; older backups were NOT pruned.`);
  process.exit(1);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Arg parsing ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let mode = null;
let ingestDir = null;
let expectedTables = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--plan") mode = "plan";
  else if (a === "--ingest") { mode = "ingest"; ingestDir = argv[++i]; }
  else if (a === "--expected-tables") expectedTables = Number(argv[++i]);
  else usage(`unknown argument: ${a}`);
}
if (!mode) usage("pick a mode: --plan or --ingest <dir>");

// ─── MODE: --plan ─────────────────────────────────────────────────────────
if (mode === "plan") {
  const today = new Date().toISOString().slice(0, 10); // UTC date
  console.log(
    `═══ DB BACKUP PLAN — run these steps via the Supabase MCP ═══\n\n` +
    `This script cannot reach the database (no keys on disk — by design).\n` +
    `The driving Claude session does the dumps through the Supabase MCP\n` +
    `(read-only SELECTs only), then hands the files back to this script\n` +
    `to verify + finalize.\n\n` +
    `STEP 1 — list the tables (execute_sql, read-only):\n\n` +
    `    ${INTROSPECTION_SQL}\n\n` +
    `  Note the table count N. (Gotcha: execute_sql returns only the LAST\n` +
    `  statement's result — run it as a single statement.)\n\n` +
    `STEP 2 — dump each table (execute_sql, read-only), one file per table:\n\n` +
    `    SELECT * FROM public.<table>;\n\n` +
    `  Write the raw row array EXACTLY as returned to:\n` +
    `    backups/${today}/<table>.json      (UTC date; empty table = [])\n` +
    `  Large tables (execute_sql truncates big results): paginate with\n` +
    `  ORDER BY <pk> LIMIT 1000 OFFSET <k> and concatenate the pages into\n` +
    `  ONE array before writing the file.\n\n` +
    `STEP 3 — verify + finalize (this script, deterministic):\n\n` +
    `    node scripts/backup-db.mjs --ingest backups/${today} --expected-tables <N>\n\n` +
    `  On success it writes backups/${today}/manifest.json, prunes dated\n` +
    `  backup dirs older than ${PRUNE_AFTER_DAYS} days (file-by-file), and stamps\n` +
    `  backups/LATEST-OK.json — the marker the session-staleness hook\n` +
    `  watches. Any mismatch FAILS without touching LATEST-OK.json or the\n` +
    `  older backups.`
  );
  process.exit(0);
}

// ─── MODE: --ingest ───────────────────────────────────────────────────────
if (!ingestDir) usage("--ingest requires a directory");
if (!Number.isInteger(expectedTables) || expectedTables <= 0) {
  usage("--ingest requires --expected-tables <N> (positive integer — the count from the introspection SQL)");
}

const dir = path.resolve(ingestDir);
let dirStat = null;
try { dirStat = statSync(dir); } catch { /* handled below */ }
if (!dirStat || !dirStat.isDirectory()) fail(`ingest dir not found or not a directory: ${dir}`);

const dumpFiles = readdirSync(dir)
  .filter(f => f.endsWith(".json") && f !== "manifest.json" && f !== "LATEST-OK.json")
  .sort();

// 1. Verify every dump parses as a raw row array.
const problems = [];
const tables = {};
let totalRows = 0;
let totalBytes = 0;
for (const f of dumpFiles) {
  const p = path.join(dir, f);
  let rows;
  try {
    rows = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    problems.push(`${f}: unparseable JSON (${e.message})`);
    continue;
  }
  if (!Array.isArray(rows)) {
    problems.push(`${f}: expected a raw row ARRAY (as returned by execute_sql), got ${typeof rows}`);
    continue;
  }
  const bytes = statSync(p).size;
  tables[f.slice(0, -".json".length)] = { row_count: rows.length, bytes };
  totalRows += rows.length;
  totalBytes += bytes;
}
if (problems.length > 0) {
  fail(`bad table dump(s) in ${dir}:\n      ` + problems.join("\n      "));
}

// 2. Table-count gate — a missing/extra dump means the backup is incomplete.
if (dumpFiles.length !== expectedTables) {
  fail(
    `table count mismatch: --expected-tables says ${expectedTables}, ` +
    `but ${dir} has ${dumpFiles.length} table dump(s). Nothing finalized.`
  );
}

// 3. Row-count sanity vs the previous manifest (warn-only — never fails the
//    backup; a >20% total-row drop is an early corruption/deletion signal).
const parent = path.dirname(dir);
const thisName = path.basename(dir);
let prev = null;
try {
  const candidates = readdirSync(parent)
    .filter(n => DATED_DIR_RE.test(n) && n !== thisName)
    .filter(n => {
      try { return statSync(path.join(parent, n)).isDirectory(); } catch { return false; }
    })
    .filter(n => existsSync(path.join(parent, n, "manifest.json")))
    .sort();
  const last = candidates[candidates.length - 1];
  if (last) {
    prev = { name: last, manifest: JSON.parse(readFileSync(path.join(parent, last, "manifest.json"), "utf8")) };
  }
} catch { /* comparison is best-effort — never block the backup on it */ }

if (prev && Number.isFinite(prev.manifest?.total_rows) && prev.manifest.total_rows > 0
    && totalRows < prev.manifest.total_rows * 0.8) {
  console.error(
    `WARNING: total rows dropped >20% vs the previous backup ` +
    `(${prev.name}: ${prev.manifest.total_rows} rows → today: ${totalRows} rows).\n` +
    `         That is an early corruption / mass-deletion signal — tell Mason ` +
    `before trusting this backup or deleting older ones.`
  );
}

// 4. Write the manifest.
const manifest = {
  generated_at: new Date().toISOString(),
  backup_dir: thisName,
  expected_tables: expectedTables,
  table_count: dumpFiles.length,
  total_rows: totalRows,
  total_bytes: totalBytes,
  tables,
};
writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 5. Prune dated backup dirs older than 8 weeks — file-by-file, NEVER a
//    recursive force delete. Anything unexpected inside a dir (a subdir, a
//    permission error) leaves that dir in place with a note. Runs only now,
//    AFTER the new backup verified.
const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
const pruned = [];
const pruneNotes = [];
try {
  for (const name of readdirSync(parent)) {
    if (!DATED_DIR_RE.test(name) || name === thisName) continue;
    const dPath = path.join(parent, name);
    try {
      if (!statSync(dPath).isDirectory()) continue;
      const stamp = Date.parse(`${name}T00:00:00Z`);
      if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
      const entries = readdirSync(dPath, { withFileTypes: true });
      const nonFile = entries.find(e => !e.isFile());
      if (nonFile) {
        pruneNotes.push(`${name}: contains unexpected non-file entry '${nonFile.name}' — left in place`);
        continue;
      }
      for (const e of entries) unlinkSync(path.join(dPath, e.name));
      rmdirSync(dPath); // non-recursive — dir is empty by now
      pruned.push(name);
    } catch (e) {
      pruneNotes.push(`${name}: ${e.message} — left in place`);
    }
  }
} catch (e) {
  pruneNotes.push(`prune scan failed: ${e.message}`);
}

// 6. Stamp the success marker (read by .claude/hooks/session-staleness.mjs).
const latestOkPath = path.join(parent, "LATEST-OK.json");
writeFileSync(latestOkPath, JSON.stringify({
  completed_at: new Date().toISOString(),
  tables: dumpFiles.length,
  total_rows: totalRows,
}, null, 2) + "\n");

console.log(`OK: verified ${dumpFiles.length} table dump(s), ${totalRows} row(s), ${fmtBytes(totalBytes)} in ${dir}`);
console.log(`    manifest.json written; LATEST-OK.json stamped at ${latestOkPath}`);
if (pruned.length > 0) {
  console.log(`    pruned ${pruned.length} backup dir(s) older than ${PRUNE_AFTER_DAYS} days: ${pruned.join(", ")}`);
}
for (const n of pruneNotes) console.log(`    prune note: ${n}`);
