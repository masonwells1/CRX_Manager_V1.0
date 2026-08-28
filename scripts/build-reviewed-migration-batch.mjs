import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { checkWrappable, topLevelSkeleton } from "../.claude/hooks/migration-wrappability-lib.mjs";

const destructiveModule = ["..", ".claude", "hooks", "live-testdata-lib.mjs"].join("/");
const { destructiveMigrationCheck, stripCommentsQuoteAware } = await import(new URL(destructiveModule, import.meta.url));

export const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
export const LEDGER_GUARD_MIGRATION = "20260828020000_enforce_global_migration_ledger_order";
export const LEDGER_GUARD_PROSRC = "\n" + [
  "DECLARE",
  "  authored_version text;",
  "  latest_version text;",
  "BEGIN",
  "  PERFORM pg_catalog.pg_advisory_xact_lock(1129465937);",
  "",
  "  IF coalesce(NEW.name, '') !~ '^[0-9]{14}(_|$)' THEN",
  "    RAISE EXCEPTION 'CRX migration ledger rows require an authored timestamp in name';",
  "  END IF;",
  "  authored_version := left(NEW.name, 14);",
  "",
  "  SELECT max(effective_version) INTO latest_version",
  "  FROM (",
  "    SELECT CASE",
  "      WHEN coalesce(name, '') ~ '^[0-9]{14}(_|$)' THEN left(name, 14)",
  "      WHEN coalesce(version, '') ~ '^[0-9]{14}$' THEN version",
  "      ELSE NULL",
  "    END AS effective_version",
  "    FROM supabase_migrations.schema_migrations",
  "  ) ledger",
  "  WHERE effective_version IS NOT NULL;",
  "",
  "  IF latest_version IS NOT NULL AND authored_version <= latest_version THEN",
  "    RAISE EXCEPTION 'CRX migration ledger ordering violation: authored %, live high-water %',",
  "      authored_version, latest_version;",
  "  END IF;",
  "  RETURN NEW;",
  "END;",
].join("\n") + "\n";
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

function ledgerGuardInvariantLines(message) {
  const bodyMd5 = createHash("md5").update(LEDGER_GUARD_PROSRC).digest("hex");
  return [
    "  IF (SELECT count(*) FROM pg_catalog.pg_trigger",
    "      WHERE tgrelid = 'supabase_migrations.schema_migrations'::regclass AND NOT tgisinternal) <> 1",
    "     OR (SELECT count(*)",
    "         FROM pg_catalog.pg_trigger t",
    "         JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid",
    "         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace",
    "         WHERE t.tgrelid = 'supabase_migrations.schema_migrations'::regclass",
    "           AND NOT t.tgisinternal",
    "           AND t.tgname = 'crx_enforce_monotonic_migration_ledger'",
    "           AND t.tgtype = 7 AND t.tgenabled = 'O'",
    "           AND n.nspname = 'supabase_migrations'",
    "           AND p.proname = 'crx_enforce_monotonic_migration_ledger'",
    "           AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''",
    "           AND p.prorettype = 'pg_catalog.trigger'::regtype",
    "           AND p.prosecdef",
    "           AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]",
    `           AND pg_catalog.md5(p.prosrc) = ${sqlLiteral(bodyMd5)}) <> 1 THEN`,
    `    RAISE EXCEPTION ${sqlLiteral(message)};`,
    "  END IF;",
  ];
}

function auditedDdlAdmission(skeleton) {
  const statements = String(skeleton).split(";").map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, " ");
    if (/^set\s+local\s+(?:statement_timeout|lock_timeout|search_path|check_function_bodies)\b/i.test(normalized)) continue;
    if (/^create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(normalized)) continue;
    if (/^(?:alter|drop)\s+(?:function|procedure)\b/i.test(normalized)) continue;
    if (/^create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b/i.test(normalized)) {
      if (/\bpartition\s+of\b/i.test(normalized) || /\bas\s*\(*\s*(?:select|table|values|with|execute)\b/i.test(normalized)) {
        return { ok: false, reason: "query-executing CREATE TABLE is outside the audited DDL allowlist" };
      }
      continue;
    }
    if (/^(?:create|alter|drop)\s+policy\b/i.test(normalized)) continue;
    if (/^create\s+(?:type|domain|sequence)\b/i.test(normalized)) continue;
    if (/^alter\s+(?:type|sequence)\b/i.test(normalized)) continue;
    if (/^drop\s+(?:view|index)\b/i.test(normalized)) continue;
    if (/^grant\s+execute\s+on\s+(?:function|procedure)\b.+\s+to\s+(?:authenticated|service_role)(?:\s*,\s*(?:authenticated|service_role))*$/i.test(normalized)) continue;
    if (/^revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|procedure)\b.+\s+from\s+(?:public|anon|authenticated|service_role)(?:\s*,\s*(?:public|anon|authenticated|service_role))*(?:\s+(?:cascade|restrict))?$/i.test(normalized)) continue;
    if (/^comment\s+on\b/i.test(normalized)) continue;
    return { ok: false, reason: "top-level statement is outside the audited DDL allowlist" };
  }
  return { ok: true };
}

export function transactionCompatibility(sql) {
  const rawSql = String(sql);
  if (/\bU\s*&\s*["']/i.test(rawSql)) return { ok: false, reason: "Unicode-escaped SQL syntax is outside the audited migration path" };
  if (/\bsupabase_migrations\b/i.test(rawSql)) return { ok: false, reason: "protected migration ledger reference" };
  const skeleton = topLevelSkeleton(sql);
  if (skeleton === null) return { ok: false, reason: "migration SQL could not be tokenized safely" };
  const destructive = destructiveMigrationCheck(skeleton);
  if (destructive.destructive) return { ok: false, reason: `destructive migration: ${destructive.reason}` };
  const verdict = checkWrappable(sql);
  if (!verdict.wrappable) return { ok: false, reason: verdict.reason };
  if (/\\/.test(skeleton)) return { ok: false, reason: "client meta-command" };
  if (/(?:^|;)\s*select\b/i.test(skeleton)) return { ok: false, reason: "top-level SELECT is not allowed in the production migration path" };
  if (/(?:^|;)\s*do\b/i.test(skeleton)) return { ok: false, reason: "top-level DO is not allowed in the production migration path" };
  const visible = stripCommentsQuoteAware(sql);
  if (/\bexecute\s+(?!function\b|on\b)/i.test(visible)) return { ok: false, reason: "dynamic SQL execution" };
  if (/standard_conforming_strings/i.test(skeleton)) return { ok: false, reason: "standard_conforming_strings override" };
  if (/(?:^|;)\s*call\b/i.test(skeleton)) return { ok: false, reason: "CALL" };
  const admission = auditedDdlAdmission(skeleton);
  if (!admission.ok) return admission;
  return { ok: true };
}

function git(repoRoot, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function readGitBlobUtf8(repoRoot, objectName, label) {
  const bytes = git(repoRoot, ["cat-file", "blob", objectName], null);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n"); }
  catch { throw new Error(`${label} must be strict UTF-8`); }
}

export function readRegularMigrationBlob({ repoRoot, expectedCommit, migrationName }) {
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  const relativeMigration = `supabase/migrations/${migrationName}.sql`;
  const entry = String(git(repoRoot, ["ls-tree", expectedCommit, "--", relativeMigration])).trim().split(/\s+/);
  if (entry[0] !== "100644" || entry[1] !== "blob") throw new Error("exact migration must be a regular 100644 Git blob");
  return readGitBlobUtf8(repoRoot, `${expectedCommit}:${relativeMigration}`, "migration blob");
}

export function listRequiredEarlierMigrations({ repoRoot, expectedCommit, migrationName }) {
  if (!/^[a-f0-9]{40}$/.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  const selected = MIGRATION_STEM_RE.exec(String(migrationName));
  if (!selected) throw new Error("migration name must be an exact timestamped file stem");
  let baseline;
  try {
    baseline = JSON.parse(readGitBlobUtf8(repoRoot, `${expectedCommit}:supabase/baselines/manifest.json`, "baseline manifest"));
  } catch (error) {
    throw new Error(`baseline manifest is unavailable or invalid: ${error?.message || error}`);
  }
  const highWater = String(baseline?.migrations_high_water || "");
  if (!/^\d{14}$/.test(highWater)) throw new Error("baseline migration high-water must be a 14-digit timestamp");
  const selectedVersion = selected[1];
  if (selectedVersion <= highWater) throw new Error("selected migration is not newer than the repository baseline");

  const required = [];
  const listing = String(git(repoRoot, ["ls-tree", "-r", expectedCommit, "--", "supabase/migrations"]));
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    const entry = /^(\d{6})\s+(\w+)\s+[a-f0-9]+\t(.+)$/.exec(line);
    if (!entry) throw new Error("migration Git tree entry could not be parsed safely");
    const [, mode, type, relativePath] = entry;
    const file = /^supabase\/migrations\/(\d{14})_(.+)\.sql$/.exec(relativePath);
    if (!file) continue;
    if (mode !== "100644" || type !== "blob") throw new Error(`repository migration must be a regular 100644 Git blob: ${relativePath}`);
    const [, version, name] = file;
    const fullStem = `${version}_${name}`;
    if (version === selectedVersion && fullStem !== migrationName) throw new Error("repository contains duplicate migration timestamps");
    if (version > highWater && version < selectedVersion) required.push({ version, name, fullStem });
  }
  return required.sort((left, right) => left.fullStem.localeCompare(right.fullStem));
}

export function buildAtomicMigrationSql({ migrationName, query, queryHash, requiredEarlierMigrations = [] }) {
  const match = MIGRATION_STEM_RE.exec(String(migrationName));
  if (!match) throw new Error("migration name must be an exact timestamped file stem");
  const [, version, name] = match;
  const fullStem = `${version}_${name}`;
  const body = String(query).replace(/\s+$/, "") + "\n";
  const requiredRows = requiredEarlierMigrations.map((migration) =>
    `      (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.fullStem)})`);
  const predecessorGuard = requiredRows.length ? [
    "  SELECT min(required.full_stem) INTO missing_migration",
    "  FROM (VALUES",
    requiredRows.join(",\n"),
    "  ) AS required(version, name, full_stem)",
    "  WHERE NOT EXISTS (",
    "    SELECT 1 FROM supabase_migrations.schema_migrations applied",
    "    WHERE (applied.version = required.version AND applied.name IN (required.name, required.full_stem))",
    "       OR applied.name = required.full_stem",
    "       OR (char_length(coalesce(applied.name, '')) = 15 + char_length(required.full_stem)",
    "           AND substring(applied.name from 1 for 14) ~ '^[0-9]{14}$'",
    "           AND substring(applied.name from 15 for 1) = '_'",
    "           AND right(applied.name, char_length(required.full_stem)) = required.full_stem)",
    "  );",
    "",
    "  IF missing_migration IS NOT NULL THEN",
    "    RAISE EXCEPTION 'CRX older repository migration is not recorded live: %', missing_migration;",
    "  END IF;",
    "",
  ] : [];
  return [
    "BEGIN;",
    "SET LOCAL standard_conforming_strings = on;",
    "SET LOCAL lock_timeout = '30s';",
    "SELECT pg_advisory_xact_lock(1129465937);",
    "LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE;",
    "DO $crx_guard$",
    "DECLARE",
    "  latest_version text;",
    "  missing_migration text;",
    "BEGIN",
    ...ledgerGuardInvariantLines("CRX global migration ledger ordering guard is missing or changed"),
    "",
    ...predecessorGuard,
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
    "DO $crx_ledger_surface$",
    "BEGIN",
    ...ledgerGuardInvariantLines("CRX global migration ledger ordering guard changed during candidate SQL"),
    "END",
    "$crx_ledger_surface$;",
    "INSERT INTO supabase_migrations.schema_migrations",
    "  (version, statements, name, created_by, idempotency_key)",
    "VALUES (",
    `  ${sqlLiteral(version)},`,
    `  ARRAY[${dollarLiteral(body, "stmt")}],`,
    `  ${sqlLiteral(fullStem)},`,
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
  const requiredEarlierMigrations = listRequiredEarlierMigrations({ repoRoot, expectedCommit, migrationName });
  const batch = buildAtomicMigrationSql({ migrationName, query, queryHash, requiredEarlierMigrations });
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
