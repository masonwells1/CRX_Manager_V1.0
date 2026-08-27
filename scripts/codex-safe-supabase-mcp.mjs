// CRX-only Supabase bridge for Codex. Public Supabase SQL write tools are
// disabled in project config; this is the only Codex-visible write path. The
// proof decision is inside the handler, so a failed hook cannot turn deny into
// a live write.

import { createHash, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  CRX_PRODUCTION_REF,
  evaluateMigrationApply,
  normalizeMigName,
} from "../.claude/hooks/migration-apply-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const MIGRATION_STEM_RE = /^(\d{14})_([A-Za-z0-9][A-Za-z0-9_-]*)$/;

function sqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function dollarLiteral(value, prefix = "crx") {
  const body = String(value);
  let tag = prefix;
  while (body.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${body}$${tag}$`;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stripSqlForTopLevelScan(sql) {
  const text = String(sql);
  let out = "";
  let i = 0;
  let state = "code";
  let dollarTag = "";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") { out += "  "; i += 2; }
      else if (c === "'") { state = "code"; out += " "; i += 1; }
      else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (state === "double") {
      if (c === '"' && n === '"') { out += "  "; i += 2; }
      else if (c === '"') { state = "code"; out += " "; i += 1; }
      else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (state === "dollar") {
      if (text.startsWith(dollarTag, i)) {
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        state = "code";
      } else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (c === "-" && n === "-") { state = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { state = "block"; out += "  "; i += 2; continue; }
    if (c === "'") { state = "single"; out += " "; i += 1; continue; }
    if (c === '"') { state = "double"; out += " "; i += 1; continue; }
    if (c === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

export function transactionCompatibility(sql) {
  const visible = stripSqlForTopLevelScan(sql);
  const forbidden = [
    [/\b(?:begin|commit|rollback|savepoint|release\s+savepoint|prepare\s+transaction)\b/i, "transaction control"],
    [/\bset\s+(?:local\s+)?transaction\b/i, "transaction control"],
    [/\bvacuum\b/i, "VACUUM"],
    [/\balter\s+system\b/i, "ALTER SYSTEM"],
    [/\bcreate\s+(?:unique\s+)?index\s+concurrently\b/i, "CONCURRENTLY"],
    [/\bdrop\s+index\s+concurrently\b/i, "CONCURRENTLY"],
    [/\breindex\s+(?:index|table|schema|database|system)\s+concurrently\b/i, "CONCURRENTLY"],
    [/\b(?:create|drop)\s+(?:database|tablespace)\b/i, "non-transactional database DDL"],
    [/\bcall\b/i, "CALL"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(visible)) return { ok: false, reason: label };
  }
  return { ok: true };
}

export function buildAtomicMigrationSql({ migrationName, query, queryHash }) {
  const match = MIGRATION_STEM_RE.exec(normalizeMigName(migrationName));
  if (!match) throw new Error("migration_name must be an exact timestamped migration stem");
  const [, version, name] = match;
  const fullStem = `${version}_${name}`;
  const body = String(query).replace(/\s+$/, "") + "\n";
  return [
    "BEGIN;",
    "DO $crx_guard$",
    "BEGIN",
    "  IF EXISTS (",
    "    SELECT 1 FROM supabase_migrations.schema_migrations",
    `    WHERE version = ${sqlLiteral(version)} OR name IN (${sqlLiteral(name)}, ${sqlLiteral(fullStem)})`,
    "  ) THEN",
    `    RAISE EXCEPTION ${dollarLiteral(`CRX migration already recorded: ${fullStem}`, "dup")};`,
    "  END IF;",
    "END",
    "$crx_guard$;",
    body,
    "INSERT INTO supabase_migrations.schema_migrations",
    "  (version, statements, name, created_by, idempotency_key)",
    "VALUES (",
    `  ${sqlLiteral(version)},`,
    `  ARRAY[${dollarLiteral(body, "stmt")}],`,
    `  ${sqlLiteral(name)},`,
    "  current_user,",
    `  ${sqlLiteral(queryHash)}`,
    ");",
    "COMMIT;",
    "",
  ].join("\n");
}

export function resolvePrimaryLinkRoot(repoRoot = DEFAULT_ROOT, run = execFileSync) {
  const raw = run("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  });
  const first = String(raw).split(/\r?\n/).find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("could not resolve the primary CRX checkout");
  const root = first.slice("worktree ".length).trim();
  const refPath = path.join(root, "supabase", ".temp", "project-ref");
  if (!existsSync(refPath) || readFileSync(refPath, "utf8").trim() !== CRX_PRODUCTION_REF) {
    throw new Error("primary checkout is not linked to the exact CRX production project");
  }
  return root;
}

function exactMigrationFile(repoRoot, migrationName) {
  const stem = normalizeMigName(migrationName);
  if (!MIGRATION_STEM_RE.test(stem) || stem !== String(migrationName).trim()) {
    throw new Error("migration_name must be the exact file stem, with no path or .sql suffix");
  }
  const migrationsDir = path.join(repoRoot, "supabase", "migrations");
  const file = path.join(migrationsDir, `${stem}.sql`);
  if (path.dirname(file) !== migrationsDir || !existsSync(file)) {
    throw new Error(`migration file does not exist: supabase/migrations/${stem}.sql`);
  }
  return file;
}

function runSupabaseQuery({ sqlFile, linkRoot, run = execFileSync }) {
  return run("supabase", [
    "db", "query", "--linked", "--workdir", linkRoot,
    "--agent", "yes", "--output-format", "json", "--file", sqlFile,
  ], {
    cwd: linkRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
  });
}

function parseRows(output) {
  const parsed = JSON.parse(String(output));
  return Array.isArray(parsed) ? parsed : (parsed.rows || parsed.data || []);
}

function runPostApplyHooks({ repoRoot, migrationName, query, run = execFileSync }) {
  const payload = JSON.stringify({
    tool_name: "mcp__crx_supabase__apply_migration",
    cwd: repoRoot,
    session_id: `codex-safe-${randomUUID()}`,
    tool_input: { project_id: CRX_PRODUCTION_REF, name: migrationName, query },
    tool_response: { isError: false },
  });
  for (const hook of ["registry-freshness.mjs", "applied-snapshot-invalidate.mjs"]) {
    run(process.execPath, [path.join(repoRoot, ".claude", "hooks", hook)], {
      cwd: repoRoot, input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
    });
  }
}

export function applyReviewedMigration(args, deps = {}) {
  const repoRoot = path.resolve(deps.repoRoot || DEFAULT_ROOT);
  if (String(args?.project_id || "").trim() !== CRX_PRODUCTION_REF) {
    throw new Error(`project_id must exactly equal ${CRX_PRODUCTION_REF}`);
  }
  const file = exactMigrationFile(repoRoot, args?.migration_name);
  const query = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const queryHash = sha256(query);
  if (!/^[a-f0-9]{64}$/.test(String(args?.query_sha256 || "")) || args.query_sha256 !== queryHash) {
    throw new Error(`query_sha256 does not match the exact repository file (expected ${queryHash})`);
  }
  const compatibility = transactionCompatibility(query);
  if (!compatibility.ok) {
    throw new Error(`migration cannot use the atomic Codex gate (${compatibility.reason}); leave it parked for a human-operated path`);
  }
  const verdict = (deps.evaluate || evaluateMigrationApply)({
    name: args.migration_name,
    query,
    projectId: args.project_id,
    projectDir: repoRoot,
    cwd: repoRoot,
  });
  if (verdict.decision !== "allow") throw new Error(verdict.reason || "migration proof gate denied the apply");

  const run = deps.run || execFileSync;
  const linkRoot = deps.linkRoot || resolvePrimaryLinkRoot(repoRoot, run);
  const temp = mkdtempSync(path.join(tmpdir(), "crx-safe-migration-"));
  const sqlFile = path.join(temp, `${args.migration_name}.sql`);
  try {
    writeFileSync(sqlFile, buildAtomicMigrationSql({ migrationName: args.migration_name, query, queryHash }), { flag: "wx" });
    (deps.runQuery || runSupabaseQuery)({ sqlFile, linkRoot, run });
    const verifyFile = path.join(temp, "verify.sql");
    writeFileSync(verifyFile, [
      "SELECT count(*)::int AS count",
      "FROM supabase_migrations.schema_migrations",
      `WHERE version = ${sqlLiteral(args.migration_name.slice(0, 14))}`,
      `  AND idempotency_key = ${sqlLiteral(queryHash)};`,
      "",
    ].join("\n"), { flag: "wx" });
    const verification = (deps.runQuery || runSupabaseQuery)({ sqlFile: verifyFile, linkRoot, run });
    const count = Number(parseRows(verification)?.[0]?.count || 0);
    if (count !== 1) throw new Error("live ledger verification did not find exactly one content-bound migration row");
    (deps.runPostApplyHooks || runPostApplyHooks)({ repoRoot, migrationName: args.migration_name, query, run });
    return { applied: true, migration_name: args.migration_name, query_sha256: queryHash, ledger_rows: count };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const TOOLS = [{
  name: "apply_reviewed_migration",
  description: "Apply one exact reviewed CRX migration file. Always requires Mason's native approval prompt.",
  inputSchema: {
    type: "object", additionalProperties: false,
    required: ["project_id", "migration_name", "query_sha256"],
    properties: {
      project_id: { type: "string", const: CRX_PRODUCTION_REF },
      migration_name: { type: "string", pattern: "^[0-9]{14}_[A-Za-z0-9][A-Za-z0-9_-]*$" },
      query_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
  annotations: { title: "Apply reviewed CRX migration", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}];

export function handleRpcMessage(message, deps = {}) {
  if (message?.method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "crx-safe-supabase", version: "1.0.0" } };
  }
  if (message?.method === "ping") return {};
  if (message?.method === "tools/list") return { tools: TOOLS };
  if (message?.method === "resources/list") return { resources: [] };
  if (message?.method === "prompts/list") return { prompts: [] };
  if (message?.method === "tools/call") {
    try {
      if (message.params?.name !== "apply_reviewed_migration") throw new Error(`unknown tool: ${message.params?.name}`);
      const value = applyReviewedMigration(message.params?.arguments || {}, deps);
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
    }
  }
  throw new Error(`unsupported method: ${message?.method}`);
}

async function serve() {
  process.stdin.setEncoding("utf8");
  let pending = "";
  for await (const chunk of process.stdin) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (request.id == null) continue;
      try {
        const result = handleRpcMessage(request);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          error: { code: -32601, message: error?.message || String(error) },
        }) + "\n");
      }
    }
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  serve().catch((error) => {
    process.stderr.write(`crx-safe-supabase fatal: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
