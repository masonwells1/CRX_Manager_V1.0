#!/usr/bin/env node
// generate-caller-graph.mjs — C5 control (docs/audits/2026-06-10-error-prevention-review.md §4)
//
// Builds .claude/caller-graph.json: the definitive "who calls what" map that the
// grant-change-guard.mjs PreToolUse hook uses to force per-function caller
// analysis on every GRANT/REVOKE migration (the B10 fix), with Edge-function
// action branches tracked as distinct keys (the B8 fix).
//
// WHAT IT MAPS
//   rpc_callers   — every literal supabase.rpc('name'…) callsite in src/ and
//                   supabase/functions/ (tests excluded) → ["file:line", …]
//   edge_callers  — every fetch(…/functions/v1/<fn>…) and
//                   supabase.functions.invoke('<fn>'…) callsite. When the call
//                   carries an action discriminator (either ?action=x in the URL
//                   or `action: 'x'` in the request body near the call), the
//                   callsite is recorded under the DISTINCT key "<fn>?action=x"
//                   (B8: the guard must land on the branch the UI actually calls).
//   cron_callers  — live pg_cron jobs (cron.job) → function names they invoke.
//   dynamic_rpc_warnings — every .rpc(<non-literal>) callsite the static scan
//                   CANNOT attribute (B10: 2-of-6 coverage came from exactly this
//                   kind of blind spot).
//   secdef_executable / zero_caller_authenticated — live-grant-derived list of
//                   SECURITY DEFINER functions executable by authenticated/anon
//                   that have ZERO callers anywhere (input to future REVOKE
//                   hardening), annotated with RLS-policy / trigger / internal-
//                   call references so nobody REVOKEs a load-bearing helper.
//
// ZERO new dependencies — node builtins only.
//
// USAGE
//   node scripts/generate-caller-graph.mjs --live-json <file>   # full regen
//   node scripts/generate-caller-graph.mjs                      # static-only refresh:
//        rescans the code, REUSES the live sections (cron/grants/annotations)
//        from the existing .claude/caller-graph.json and stamps the reuse.
//   node scripts/generate-caller-graph.mjs --print-sql          # print the live queries
//
// LIVE DATA (read-only; run via Supabase MCP execute_sql, or ask Claude Code:
// "regenerate the caller graph") — JSON file shape for --live-json:
//   {
//     "queried_at": "<ISO>",
//     "cron_jobs":        [ { "jobname": "...", "command": "...", "schedule": "...", "active": true } ],
//     "secdef_executable":[ { "name": "...", "args": "...", "auth_exec": true, "anon_exec": false } ],
//     "annotations":      [ { "name": "...", "in_rls_policy": false, "is_trigger_function": false,
//                             "called_by_other_function": false } ]   // optional, zero-caller fns only
//   }
// If `annotations` is missing, the script still writes the graph and prints the
// exact annotation SQL (scoped to the computed zero-caller set) to stderr so a
// second pass can fill them in.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outPath = path.join(root, ".claude", "caller-graph.json");

// ---------------------------------------------------------------------------
// Live SQL (read-only). Keep these in sync with the JSON shape above.
// ---------------------------------------------------------------------------
const SQL_CRON = `SELECT jobname, command, schedule, active FROM cron.job ORDER BY jobname;`;

const SQL_SECDEF_GRANTS = `SELECT p.proname AS name,
       pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'))
ORDER BY p.proname;`;

function annotationSql(names) {
  const values = names.map((n) => `('${n.replace(/'/g, "''")}')`).join(",\n  ");
  return `WITH cand(name) AS (VALUES\n  ${values}\n)
SELECT c.name,
  EXISTS (SELECT 1 FROM pg_policy pol
          WHERE COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
                COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ (c.name || '\\\\(')
  ) AS in_rls_policy,
  EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc tp ON tp.oid = t.tgfoid
          WHERE tp.proname = c.name AND NOT t.tgisinternal
  ) AS is_trigger_function,
  EXISTS (SELECT 1 FROM pg_proc p2
          WHERE p2.pronamespace = 'public'::regnamespace
            AND p2.proname <> c.name
            AND p2.prosrc ~ (c.name || '\\\\s*\\\\(')
  ) AS called_by_other_function,
  (SELECT pg_get_function_identity_arguments(p3.oid) FROM pg_proc p3
   WHERE p3.pronamespace = 'public'::regnamespace AND p3.proname = c.name
   LIMIT 1) AS args
FROM cand c ORDER BY c.name;`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes("--print-sql")) {
  console.log("-- (1) cron jobs:\n" + SQL_CRON + "\n");
  console.log("-- (2) authenticated/anon-executable SECURITY DEFINER functions:\n" + SQL_SECDEF_GRANTS + "\n");
  console.log("-- (3) zero-caller annotations: run generate-caller-graph.mjs once with (1)+(2);");
  console.log("--     it prints the exact VALUES-scoped annotation query for the computed zero-caller set.");
  process.exit(0);
}

let liveJsonPath = null;
const liveIdx = argv.indexOf("--live-json");
if (liveIdx !== -1) {
  liveJsonPath = argv[liveIdx + 1];
  if (!liveJsonPath) {
    console.error("--live-json requires a file path");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Static scan
// ---------------------------------------------------------------------------
const SCAN_DIRS = ["src", path.join("supabase", "functions")];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/i;
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "dist", ".git"]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry)) && !TEST_FILE_RE.test(entry)) {
      yield full;
    }
  }
}

// Blank out comment-only lines (// …, *, /* …) preserving offsets, so doc
// comments that mention `.rpc(...)` don't create phantom callers/warnings.
function scrubComments(content) {
  return content
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function relPath(full) {
  return path.relative(root, full).replace(/\\/g, "/");
}

const rpcCallers = {}; // fn -> ["file:line"]
const edgeCallers = {}; // fn or "fn?action=x" -> ["file:line"]
const dynamicWarnings = []; // { file, line, snippet }

function addCaller(map, key, loc) {
  (map[key] = map[key] || []).push(loc);
}

const RPC_LITERAL_RE = /\.rpc\(\s*(['"`])([A-Za-z0-9_]+)\1/g;
const RPC_ANY_RE = /\.rpc\(/g;
const INVOKE_RE = /\.functions\s*\.\s*invoke\(\s*(['"`])([A-Za-z0-9_-]+)\1/g;
const EDGE_URL_RE = /functions\/v1\/([A-Za-z0-9_-]+)((?:\?)[^'"`\s]*)?/g;
const BODY_ACTION_RE = /\baction\s*:\s*(['"])([\w-]+)\1/;
const ACTION_LOOKAHEAD = 800; // chars after the callsite to look for a body `action:` discriminator

let filesScanned = 0;
for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(root, dir))) {
    filesScanned++;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const content = scrubComments(raw);
    const rel = relPath(file);

    // (a) literal RPC callsites
    let m;
    RPC_LITERAL_RE.lastIndex = 0;
    const literalIdx = new Set();
    while ((m = RPC_LITERAL_RE.exec(content)) !== null) {
      literalIdx.add(m.index);
      addCaller(rpcCallers, m[2], `${rel}:${lineOf(content, m.index)}`);
    }
    // dynamic / non-literal .rpc( calls — flagged, never silently dropped (B10)
    RPC_ANY_RE.lastIndex = 0;
    while ((m = RPC_ANY_RE.exec(content)) !== null) {
      if (literalIdx.has(m.index)) continue;
      const after = content.slice(m.index + m[0].length).match(/\S/);
      const nextCh = after ? after[0] : "";
      let dynamic = !["'", '"', "`"].includes(nextCh);
      if (!dynamic && nextCh === "`") {
        const tail = content.slice(m.index, m.index + 200);
        if (/`[^`]*\$\{/.test(tail)) dynamic = true; // template literal with interpolation
        else continue; // plain backtick literal already captured? (not by RPC_LITERAL_RE if it had ${…}) — recheck
      }
      if (dynamic) {
        dynamicWarnings.push({
          file: rel,
          line: lineOf(content, m.index),
          snippet: content.slice(m.index, m.index + 70).replace(/\s+/g, " ").trim(),
        });
      }
    }

    // (b) edge-function callers — invoke()
    INVOKE_RE.lastIndex = 0;
    while ((m = INVOKE_RE.exec(content)) !== null) {
      const fn = m[2];
      const ahead = content.slice(m.index, m.index + ACTION_LOOKAHEAD);
      const act = ahead.match(BODY_ACTION_RE);
      const key = act ? `${fn}?action=${act[2]}` : fn;
      addCaller(edgeCallers, key, `${rel}:${lineOf(content, m.index)}`);
    }
    // (b) edge-function callers — /functions/v1/<fn> URLs (fetch etc.)
    EDGE_URL_RE.lastIndex = 0;
    while ((m = EDGE_URL_RE.exec(content)) !== null) {
      const fn = m[1];
      let key = fn;
      const qs = m[2] || "";
      const qsAction = qs.match(/[?&]action=([\w-]+)/);
      if (qsAction) {
        key = `${fn}?action=${qsAction[1]}`;
      } else {
        // action discriminator may travel in the POST body instead of the query string
        const ahead = content.slice(m.index, m.index + ACTION_LOOKAHEAD);
        const act = ahead.match(BODY_ACTION_RE);
        if (act) key = `${fn}?action=${act[2]}`;
      }
      addCaller(edgeCallers, key, `${rel}:${lineOf(content, m.index)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Live data: --live-json file, or reuse the previous graph's live sections
// ---------------------------------------------------------------------------
let live = null;
let liveReused = false;
if (liveJsonPath) {
  live = JSON.parse(readFileSync(liveJsonPath, "utf8"));
} else if (existsSync(outPath)) {
  try {
    const prev = JSON.parse(readFileSync(outPath, "utf8"));
    live = {
      queried_at: prev._meta?.live_queried_at || null,
      cron_jobs: prev._live_raw?.cron_jobs || [],
      secdef_executable: prev.secdef_executable || [],
      annotations: (prev.zero_caller_authenticated || []).map((z) => ({
        name: z.name,
        in_rls_policy: z.in_rls_policy,
        is_trigger_function: z.is_trigger_function,
        called_by_other_function: z.called_by_other_function,
      })),
    };
    liveReused = true;
    console.error(
      "NOTE: no --live-json given — reusing live DB sections (cron/grants/annotations) from the existing graph.\n" +
        "      For a fresh pull run with --live-json (see --print-sql), or ask Claude Code to regenerate the caller graph."
    );
  } catch {
    live = null;
  }
}
if (!live) {
  console.error(
    "ERROR: no live data available. Run the queries from --print-sql against the live DB\n" +
      "(read-only) and pass the results via --live-json <file>."
  );
  process.exit(1);
}

// (c) cron callers — extract invoked function names from each job command
const SQL_KEYWORDS = new Set(["select", "call", "perform", "execute", "do", "values", "public"]);
const cronCallers = {};
for (const job of live.cron_jobs || []) {
  const cmd = String(job.command || "");
  const re = /(?:\bpublic\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const fn = m[1].toLowerCase();
    if (SQL_KEYWORDS.has(fn)) continue;
    addCaller(
      cronCallers,
      fn,
      `cron.job "${job.jobname}" (schedule: ${job.schedule}, active: ${job.active})`
    );
  }
}

// (d) zero-caller authenticated/anon-executable SECDEF functions
const secdef = live.secdef_executable || [];
const annotations = new Map((live.annotations || []).map((a) => [a.name, a]));
const seen = new Set();
const zeroCaller = [];
for (const fn of secdef) {
  if (seen.has(fn.name)) continue;
  seen.add(fn.name);
  const hasRpc = Object.prototype.hasOwnProperty.call(rpcCallers, fn.name);
  const hasCron = Object.prototype.hasOwnProperty.call(cronCallers, fn.name);
  const hasEdge =
    Object.prototype.hasOwnProperty.call(edgeCallers, fn.name) ||
    Object.keys(edgeCallers).some((k) => k.startsWith(fn.name + "?"));
  if (hasRpc || hasCron || hasEdge) continue;
  const ann = annotations.get(fn.name);
  const entry = {
    name: fn.name,
    args: ann && ann.args !== undefined ? ann.args : (fn.args ?? null),
    auth_exec: fn.auth_exec,
    anon_exec: fn.anon_exec,
    in_rls_policy: ann ? ann.in_rls_policy : null,
    is_trigger_function: ann ? ann.is_trigger_function : null,
    called_by_other_function: ann ? ann.called_by_other_function : null,
  };
  entry.revoke_risk = !ann
    ? "UNKNOWN — annotations not loaded; run the annotation SQL before any REVOKE"
    : ann.is_trigger_function || ann.in_rls_policy
      ? "DO-NOT-REVOKE-BLINDLY — load-bearing for triggers/RLS evaluation"
      : ann.called_by_other_function
        ? "caution — called internally by other SQL functions (owner-executed; REVOKE usually safe, verify)"
        : "candidate — zero callers found anywhere";
  zeroCaller.push(entry);
}
zeroCaller.sort((a, b) => a.name.localeCompare(b.name));

const missingAnnotations = zeroCaller.filter((z) => z.in_rls_policy === null).map((z) => z.name);
if (missingAnnotations.length > 0) {
  console.error(
    `\nNOTE: ${missingAnnotations.length} zero-caller function(s) lack RLS/trigger/internal-call annotations.\n` +
      "Run this read-only query and add the rows to the live JSON `annotations` array, then re-run:\n\n" +
      annotationSql(missingAnnotations) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Assemble + write
// ---------------------------------------------------------------------------
function sortMap(map) {
  const out = {};
  for (const k of Object.keys(map).sort()) out[k] = map[k].slice().sort();
  return out;
}

const rpcCallsiteCount = Object.values(rpcCallers).reduce((n, v) => n + v.length, 0);
const edgeCallsiteCount = Object.values(edgeCallers).reduce((n, v) => n + v.length, 0);

const graph = {
  _meta: {
    generated_at: new Date().toISOString(),
    generator: "node scripts/generate-caller-graph.mjs",
    purpose:
      "C5 control — caller graph consumed by .claude/hooks/grant-change-guard.mjs to force per-function " +
      "caller analysis on GRANT/REVOKE migrations (B10) and branch-accurate Edge guards (B8).",
    scanned_dirs: SCAN_DIRS.map((d) => d.replace(/\\/g, "/") + "/"),
    excluded: ["*.test.*", "*.spec.*", "__tests__/", "__mocks__/", "node_modules/"],
    files_scanned: filesScanned,
    live_queried_at: live.queried_at || null,
    live_data_reused: liveReused,
    counts: {
      rpc_functions_called: Object.keys(rpcCallers).length,
      rpc_callsites: rpcCallsiteCount,
      edge_caller_keys: Object.keys(edgeCallers).length,
      edge_action_branch_keys: Object.keys(edgeCallers).filter((k) => k.includes("?action=")).length,
      edge_callsites: edgeCallsiteCount,
      cron_jobs: (live.cron_jobs || []).length,
      cron_functions_called: Object.keys(cronCallers).length,
      secdef_executable_functions: seen.size,
      zero_caller_authenticated: zeroCaller.length,
      dynamic_rpc_warnings: dynamicWarnings.length,
    },
  },
  rpc_callers: sortMap(rpcCallers),
  edge_callers: sortMap(edgeCallers),
  cron_callers: sortMap(cronCallers),
  dynamic_rpc_warnings: dynamicWarnings,
  zero_caller_authenticated: zeroCaller,
  secdef_executable: secdef,
  _live_raw: { cron_jobs: live.cron_jobs || [] },
};

writeFileSync(outPath, JSON.stringify(graph, null, 2) + "\n");
console.log(`Wrote ${relPath(outPath)}`);
console.log(JSON.stringify(graph._meta.counts, null, 2));
if (dynamicWarnings.length > 0) {
  console.log("\nDYNAMIC .rpc() CALLS (cannot be attributed statically — review by hand):");
  for (const w of dynamicWarnings) console.log(`  ${w.file}:${w.line}  ${w.snippet}`);
}
