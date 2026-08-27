import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { checkWrappable, topLevelSkeleton } from "../.claude/hooks/migration-wrappability-lib.mjs";

export const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
const MIGRATION_STEM_RE = /^(\d{14})_((?![A-Za-z0-9_-]*\d{14})[A-Za-z0-9][A-Za-z0-9_-]*)$/;

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

export function transactionCompatibility(sql) {
  const verdict = checkWrappable(sql);
  if (!verdict.wrappable) return { ok: false, reason: verdict.reason };
  const skeleton = topLevelSkeleton(sql);
  if (/standard_conforming_strings/i.test(skeleton)) return { ok: false, reason: "standard_conforming_strings override" };
  if (/(?:^|\n)\s*\\/m.test(skeleton)) return { ok: false, reason: "client meta-command" };
  if (/(?:^|;)\s*call\b/i.test(skeleton)) return { ok: false, reason: "CALL" };
  return { ok: true };
}

function git(repoRoot, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

export function readRegularMigrationBlob({ repoRoot, expectedCommit, migrationName }) {
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  const relativeMigration = `supabase/migrations/${migrationName}.sql`;
  const entry = String(git(repoRoot, ["ls-tree", expectedCommit, "--", relativeMigration])).trim().split(/\s+/);
  if (entry[0] !== "100644" || entry[1] !== "blob") throw new Error("exact migration must be a regular 100644 Git blob");
  const bytes = git(repoRoot, ["cat-file", "blob", `${expectedCommit}:${relativeMigration}`], null);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n"); }
  catch { throw new Error("migration blob must be strict UTF-8 SQL"); }
}

export function buildAtomicMigrationSql({ migrationName, query, queryHash }) {
  const match = MIGRATION_STEM_RE.exec(String(migrationName));
  if (!match) throw new Error("migration name must be an exact timestamped file stem");
  const [, version, name] = match;
  const fullStem = `${version}_${name}`;
  const body = String(query).replace(/\s+$/, "") + "\n";
  return [
    "BEGIN;",
    "SET LOCAL standard_conforming_strings = on;",
    "SET LOCAL lock_timeout = '30s';",
    "SELECT pg_advisory_xact_lock(1129465937);",
    "LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE;",
    "DO $crx_guard$",
    "DECLARE",
    "  latest_version text;",
    "BEGIN",
    "  IF EXISTS (",
    "    SELECT 1 FROM supabase_migrations.schema_migrations",
    `    WHERE version = ${sqlLiteral(version)}`,
    `       OR name IN (${sqlLiteral(name)}, ${sqlLiteral(fullStem)})`,
    `       OR idempotency_key = ${sqlLiteral(queryHash)}`,
    "  ) THEN",
    `    RAISE EXCEPTION ${dollarLiteral(`CRX migration already recorded: ${fullStem}`, "dup")};`,
    "  END IF;",
    "",
    "  SELECT max(effective_version) INTO latest_version",
    "  FROM (",
    "    SELECT CASE",
    "      WHEN coalesce(name, '') ~ '^[0-9]{14}(?:_|$)' THEN left(name, 14)",
    "      WHEN coalesce(version, '') ~ '^[0-9]{14}$' THEN version",
    "      ELSE NULL",
    "    END AS effective_version",
    "    FROM supabase_migrations.schema_migrations",
    "  ) ledger",
    "  WHERE effective_version IS NOT NULL;",
    "",
    `  IF latest_version IS NOT NULL AND latest_version >= ${sqlLiteral(version)} THEN`,
    `    RAISE EXCEPTION ${dollarLiteral(`CRX migration is not newer than the live ledger: ${fullStem}`, "order")};`,
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
    "DO $crx_verify$",
    "BEGIN",
    "  IF (SELECT count(*) FROM supabase_migrations.schema_migrations",
    `      WHERE version = ${sqlLiteral(version)} AND idempotency_key = ${sqlLiteral(queryHash)}) <> 1 THEN`,
    "    RAISE EXCEPTION 'CRX content-bound migration ledger verification failed';",
    "  END IF;",
    "END",
    "$crx_verify$;",
    "COMMIT;",
    "",
  ].join("\n");
}

export function prepareBatch({ repoRoot, projectId, expectedCommit, migrationName, queryHash, output }) {
  if (String(projectId) !== CRX_PRODUCTION_REF) throw new Error("project id is not the fixed CRX production project");
  if (!MIGRATION_STEM_RE.test(String(migrationName))) throw new Error("migration name must be the exact file stem");
  if (!/^[a-f0-9]{64}$/.test(String(queryHash))) throw new Error("query hash must be lowercase SHA-256");
  const query = readRegularMigrationBlob({ repoRoot, expectedCommit, migrationName });
  const actualHash = sha256(query);
  if (actualHash !== queryHash) throw new Error(`migration hash mismatch (expected ${actualHash})`);
  const compatible = transactionCompatibility(query);
  if (!compatible.ok) throw new Error(`migration is not atomic-batch compatible: ${compatible.reason}`);
  const batch = buildAtomicMigrationSql({ migrationName, query, queryHash });
  writeFileSync(output, batch, { encoding: "utf8", flag: "wx" });
  return { migrationName, queryHash, output };
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] == null) throw new Error("arguments must be exact --key value pairs");
    if (values.has(argv[i])) throw new Error(`duplicate argument: ${argv[i]}`);
    values.set(argv[i], argv[i + 1]);
  }
  const allowed = new Set(["--project-id", "--expected-commit", "--migration", "--query-sha256", "--output"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  for (const key of allowed) if (!values.get(key)) throw new Error(`missing argument: ${key}`);
  return values;
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  const result = prepareBatch({
    repoRoot: process.cwd(),
    projectId: values.get("--project-id"),
    expectedCommit: values.get("--expected-commit"),
    migrationName: values.get("--migration"),
    queryHash: values.get("--query-sha256"),
    output: path.resolve(values.get("--output")),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
}
