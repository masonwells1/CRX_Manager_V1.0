import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
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

function topLevelSql(sql) {
  const text = String(sql);
  let out = "";
  let i = 0;
  let state = "code";
  let dollarTag = "";
  let blockDepth = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "/" && n === "*") { blockDepth += 1; out += "  "; i += 2; }
      else if (c === "*" && n === "/") {
        blockDepth -= 1;
        if (blockDepth === 0) state = "code";
        out += "  ";
        i += 2;
      } else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (state === "single") {
      if (c === "'" && n === "'") { out += "  "; i += 2; }
      else if (c === "'") { state = "code"; out += " "; i += 1; }
      else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    if (state === "escape") {
      if (c === "\\") { out += "  "; i += Math.min(2, text.length - i); }
      else if (c === "'" && n === "'") { out += "  "; i += 2; }
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
    if (c === "/" && n === "*") { state = "block"; blockDepth = 1; out += "  "; i += 2; continue; }
    if ((c === "e" || c === "E") && n === "'" && !/[A-Za-z0-9_$]/.test(text[i - 1] || "")) {
      state = "escape"; out += "  "; i += 2; continue;
    }
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
  return state === "code" || state === "line" ? { ok: true, visible: out } : { ok: false, visible: out };
}

export function transactionCompatibility(sql) {
  if (/standard_conforming_strings/i.test(String(sql))) {
    return { ok: false, reason: "standard_conforming_strings override" };
  }
  const scan = topLevelSql(sql);
  if (!scan.ok) return { ok: false, reason: "unterminated SQL quote or comment" };
  if (/(?:^|\n)\s*\\/m.test(scan.visible)) return { ok: false, reason: "client meta-command" };
  const statements = scan.visible.split(";").map((part) => part.trim()).filter(Boolean);
  const forbidden = [
    [/^(?:begin|commit|rollback|abort|end)(?:\s+(?:work|transaction))?(?:\s+and\s+(?:no\s+)?chain)?\b/i, "transaction control"],
    [/^start\s+transaction\b/i, "transaction control"],
    [/^(?:savepoint|release\s+savepoint|prepare\s+transaction)\b/i, "transaction control"],
    [/^set\s+(?:local\s+)?transaction\b/i, "transaction control"],
    [/^vacuum\b/i, "VACUUM"],
    [/^alter\s+system\b/i, "ALTER SYSTEM"],
    [/^create\s+(?:unique\s+)?index\s+concurrently\b/i, "CONCURRENTLY"],
    [/^drop\s+index\s+concurrently\b/i, "CONCURRENTLY"],
    [/^reindex\s+(?:index|table|schema|database|system)\s+concurrently\b/i, "CONCURRENTLY"],
    [/^(?:create|drop)\s+(?:database|tablespace)\b/i, "non-transactional database DDL"],
    [/^call\b/i, "CALL"],
  ];
  for (const statement of statements) {
    for (const [pattern, label] of forbidden) {
      if (pattern.test(statement)) return { ok: false, reason: label };
    }
  }
  return { ok: true };
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
    `    WHERE version = ${sqlLiteral(version)} OR name IN (${sqlLiteral(name)}, ${sqlLiteral(fullStem)})`,
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

export function prepareBatch({ repoRoot, projectId, migrationName, queryHash, output }) {
  if (String(projectId) !== CRX_PRODUCTION_REF) throw new Error("project id is not the fixed CRX production project");
  if (!MIGRATION_STEM_RE.test(String(migrationName))) throw new Error("migration name must be the exact file stem");
  if (!/^[a-f0-9]{64}$/.test(String(queryHash))) throw new Error("query hash must be lowercase SHA-256");
  const migrationsDir = path.join(repoRoot, "supabase", "migrations");
  const file = path.join(migrationsDir, `${migrationName}.sql`);
  if (path.dirname(file) !== migrationsDir || !existsSync(file)) throw new Error("exact migration file does not exist");
  const query = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
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
  const allowed = new Set(["--project-id", "--migration", "--query-sha256", "--output"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  for (const key of allowed) if (!values.get(key)) throw new Error(`missing argument: ${key}`);
  return values;
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  const result = prepareBatch({
    repoRoot: process.cwd(),
    projectId: values.get("--project-id"),
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
