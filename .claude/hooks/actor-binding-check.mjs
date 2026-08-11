#!/usr/bin/env node
// Forgeable-actor binding guard for CRX Manager (write-time half of the
// actor-forgery / actor-forgery-fin-audit db-invariant sweeps).
//
// THE GAP THIS CLOSES
//   Two sweep predicates (predicates/actor-forgery.sql and
//   predicates/actor-forgery-fin-audit.sql) find SECURITY DEFINER functions that
//   trust a caller-supplied actor parameter — but they only run against the LIVE
//   catalog, i.e. AFTER the migration has been applied. Between writing the
//   migration and applying it there was no gate at all, so the forgery shipped
//   first and was detected second. This hook moves the same check to write time.
//
// WHAT IT BLOCKS
//   A migration file that CREATEs or REPLACEs a SECURITY DEFINER function which
//     (a) declares an actor-shaped parameter — p_<something>by, p_actor*, p_user*
//         (e.g. p_performed_by, p_created_by, p_actor_id, p_user_id), AND
//     (b) MUTATES (INSERT / UPDATE / DELETE) in its body, AND
//     (c) never raises the canonical ACTOR_MISMATCH token.
//   Under SECURITY DEFINER the function runs with the owner's privileges, so an
//   unbound actor parameter lets any authenticated caller attribute a write to
//   somebody else — the exact class fixed for link_blend_ticket_to_order /
//   unlink_blend_ticket_from_order in migration 20260617171500 (Live Foundation
//   Gauntlet Section 1 HIGH, 2026-06-17), where p_performed_by was stamped
//   straight into the immutable financial_audit_log with no binding check.
//
// THE CANONICAL FIX (what the hook wants to see)
//   DECLARE v_actor uuid;
//   BEGIN
//     v_actor := auth.uid();
//     IF p_performed_by IS DISTINCT FROM v_actor THEN
//       RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';
//     END IF;
//     -- ... and every actor stamp downstream derives from v_actor, not the param
//
// Escape hatch: the file-level marker comment
//   -- actor-binding-check: exempt
// skips the check. Use it ONLY for a body that never trusts the parameter as an
// actor (e.g. it is a filter on a lookup, or the function is an internal _impl
// called exclusively by an already-bound public wrapper) — and say which in the
// migration's header comment.
//
// Conservative by design, in both directions:
//   * Non-mutating functions are never flagged (a reporting function taking
//     p_user_id as a filter is not an attribution risk).
//   * SECURITY INVOKER functions are never flagged (RLS still applies to them).
//   * The check is satisfied by the presence of the ACTOR_MISMATCH token anywhere
//     in the body — it does not attempt to verify the guard is correct. That
//     deeper verification is the sweeps' job; this hook only stops the
//     no-guard-at-all case, which is the one that actually shipped.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// Split a parameter list on top-level commas (ignoring commas inside nested
// parens like numeric(10,2) or inside quoted defaults) so each entry is one
// parameter declaration we can read a name off of.
function splitTopLevelArgs(argsText, sourceText = argsText) {
  const args = [];
  let depth = 0;
  let start = 0;
  const structural = String(argsText || "");
  const source = String(sourceText || "");
  // Split indexes come from the masked structural text and are applied to the
  // matching raw source text. Refuse a future caller that breaks that alignment.
  if (structural.length !== source.length) return [];
  for (let i = 0; i < structural.length; i++) {
    const ch = structural[i];
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === "," && depth === 0) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
  }
  args.push(source.slice(start));
  return args.map((a) => a.trim()).filter((a) => a !== "");
}

// An actor-shaped parameter NAME — the same shape the live sweep predicates key
// on: ^p_\w*by$ | ^p_actor | ^p_user.
const ACTOR_PARAM_RE = /^p_\w*by$|^p_actor|^p_user/i;

// Read the declared name out of one parameter entry, skipping a leading
// IN/OUT/INOUT/VARIADIC mode keyword.
function paramName(decl) {
  const tokens = String(decl).trim().split(/\s+/);
  let i = 0;
  if (/^(in|out|inout|variadic)$/i.test(tokens[i] || "")) i++;
  return (tokens[i] || "").replace(/^"|"$/g, "");
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath || !filePath.endsWith(".sql") || !filePath.includes("supabase/migrations/")) {
  out("allow");
}

function proposedFileContent(toolInput, targetPath) {
  if (typeof toolInput?.content === "string") return { content: toolInput.content };
  if (typeof toolInput?.new_string !== "string") return { content: "" };
  if (typeof toolInput?.old_string !== "string") return { content: toolInput.new_string };

  let current;
  try {
    current = readFileSync(targetPath, "utf8");
  } catch {
    return { error: "the current migration file could not be read" };
  }
  const oldString = toolInput.old_string;
  const first = current.indexOf(oldString);
  if (first === -1) return { error: "old_string was not found in the current migration file" };
  if (toolInput.replace_all === true) {
    return { content: current.split(oldString).join(toolInput.new_string) };
  }
  if (current.indexOf(oldString, first + oldString.length) !== -1) {
    return { error: "old_string matched more than once in the current migration file" };
  }
  return {
    content: current.slice(0, first) + toolInput.new_string + current.slice(first + oldString.length),
  };
}

const proposed = proposedFileContent(payload?.tool_input, filePath);
if (proposed.error) {
  out("block", "ACTOR BINDING VIOLATION: This Edit could not be reconstructed against the current " +
    `migration (${proposed.error}), so the guard cannot inspect the resulting file. Refresh the edit ` +
    "against the current bytes and retry.");
}
const content = proposed.content;
if (!content) out("allow");

if (/--\s*actor-binding-check:\s*exempt/i.test(content)) {
  out("allow");
}

// Locate each CREATE [OR REPLACE] FUNCTION header. The parameter list is then
// read with a BALANCED-paren scan rather than a [^)]* capture, because a real
// parameter list contains parens — numeric(12,2), varchar(50), timestamp(3).
// A naive capture stops at the first inner ')' and silently truncates the list,
// which would hide an actor parameter declared after a parenthesised type.
const SQL_UNICODE_IDENTIFIER_PATTERN =
  'U&\\s*"(?:[^"]|"")*"(?:\\s+UESCAPE\\s*\'(?:[^\']|\'\')*\')?';
const SQL_IDENTIFIER_PATTERN =
  `(?:${SQL_UNICODE_IDENTIFIER_PATTERN}|"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)`;
const SQL_QUALIFIED_IDENTIFIER_PATTERN =
  `${SQL_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})*`;
const fnHeadRe = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*\\(`,
  "gi"
);

/** From the index of an opening ' or ", return the index just past the closing
 * quote, or -1 if unterminated. Handles doubled quotes ('' / "") and
 * backslash escapes in E'...' strings. */
function scanQuoted(text, openIdx) {
  const strCh = text[openIdx];
  const isEStr = strCh === "'" &&
    /[eE]/.test(text[openIdx - 1] || "") && !/[\w$]/.test(text[openIdx - 2] || "");
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (isEStr && ch === "\\") { i++; continue; }
    if (ch === strCh) {
      if (text[i + 1] === strCh) { i++; continue; }
      return i + 1;
    }
  }
  return -1;
}

/** Match a dollar-quote opener ($tag$) at index i, or return null. */
const DOLLAR_TAG_RE = /\$\w*\$/y;
function dollarTagAt(text, i) {
  if (/[\w$]/.test(text[i - 1] || "")) return null;
  DOLLAR_TAG_RE.lastIndex = i;
  const m = DOLLAR_TAG_RE.exec(text);
  return m ? m[0] : null;
}

/** The first semicolon that actually ends a statement, skipping SQL noise. */
function firstTopLevelSemicolon(text, from) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ";") return i;
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) return -1;
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(text, i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    const tag = ch === "$" ? dollarTagAt(text, i) : null;
    if (tag) {
      const close = text.indexOf(tag, i + tag.length);
      if (close === -1) return -1;
      i = close + tag.length;
      continue;
    }
    i++;
  }
  return -1;
}

const ASSIGN_RE =
  /(?:^|\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b|\bDECLARE\b)\s*(?:"[^"]+"|[\w.]+)\s*(?::=|=(?!=))/i;
// PL/pgSQL also permits initialization in the declaration itself:
//   DECLARE v_ddl text := '...';  v_ddl text = '...';  v_ddl text DEFAULT '...';
// Keep this shaped like a declaration (name + type + optional modifiers) so a
// normal UPDATE of documentation text is not reclassified as runtime DDL.
const DECLARATION_INIT_RE =
  /(?:^|\bDECLARE\b)\s*(?:"[^"]+"|[A-Za-z_]\w*)\s+(?:CONSTANT\s+)?(?:"[^"]+"|[\w.]+(?:%(?:TYPE|ROWTYPE))?)(?:\s+(?:WITH(?:OUT)?\s+TIME\s+ZONE|DOUBLE\s+PRECISION|CHARACTER\s+VARYING|BIT\s+VARYING))?(?:\s*\([^;]*?\))?(?:\s*\[\s*\])?(?:\s+COLLATE\s+(?:"[^"]+"|[\w.]+))?(?:\s+NOT\s+NULL)?\s*(?::=|=(?!=)|DEFAULT\b)/i;
let pgCronJobViewAliases = new Set();
let pgCronJobViewHistoryChecked = false;
let pgCronJobViewHistoryUnavailable = false;
function isDynamicSqlStatement(stmt, rawStmt = stmt) {
  return /\bEXECUTE\b/i.test(stmt) ||
    ASSIGN_RE.test(stmt) ||
    DECLARATION_INIT_RE.test(stmt) ||
    /\bSELECT\b[\s\S]*\bINTO\b/i.test(stmt) ||
    /\bVALUES\b[\s\S]*\bINTO\b/i.test(stmt) ||
    isPgCronCall(rawStmt) ||
    isPgCronCommandWrite(rawStmt);
}

/** Mask data strings and comments but retain quoted identifiers. The main SQL
 * mask deliberately blanks quoted identifiers so a name such as "EXECUTE"
 * cannot impersonate syntax. pg_cron's schema/API identity is the one place we
 * need the original identifier spelling, including "cron"."schedule". */
function maskSqlForCallNames(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      const end = nl === -1 ? text.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) return null;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (text[i] === "'") {
      const end = scanQuoted(text, i);
      if (end === -1) return null;
      out += "'" + " ".repeat(end - i - 2) + "'";
      i = end;
      continue;
    }
    if (text[i] === '"') {
      const end = scanQuoted(text, i);
      if (end === -1) return null;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === "$") {
      const tag = dollarTagAt(text, i);
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        const end = close + tag.length;
        out += tag + " ".repeat(end - i - (2 * tag.length)) + tag;
        i = end;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** True only when the complete expression is one plain single-quoted or
 * dollar-quoted SQL string. Casts, concatenation, subqueries, variables, and
 * prefixed/escaped string syntaxes stay opaque and use the manual-review path. */
function isDirectSqlStringLiteral(expression) {
  const sql = String(expression || "").trim();
  if (sql.startsWith("'")) return scanQuoted(sql, 0) === sql.length;
  const tag = dollarTagAt(sql, 0);
  if (!tag) return false;
  const close = sql.indexOf(tag, tag.length);
  return close !== -1 && close + tag.length === sql.length;
}

function normalizedIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (/^U&/i.test(value)) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value.toLowerCase();
}

function normalizedQualifiedIdentifier(identifier) {
  const value = String(identifier || "").trim();
  const component = new RegExp(SQL_IDENTIFIER_PATTERN, "y");
  const parts = [];
  let cursor = 0;
  while (cursor < value.length) {
    component.lastIndex = cursor;
    const match = component.exec(value);
    if (!match) return null;
    const normalized = normalizedIdentifier(match[0]);
    if (normalized === null) return null;
    parts.push(normalized);
    cursor = component.lastIndex;
    while (/\s/.test(value[cursor] || "")) cursor++;
    if (cursor === value.length) break;
    if (value[cursor] !== ".") return null;
    cursor++;
    while (/\s/.test(value[cursor] || "")) cursor++;
  }
  return parts.join(".");
}

function isPgCronJobName(identifier) {
  const normalized = normalizedQualifiedIdentifier(identifier);
  return normalized === "job" || normalized === "cron.job";
}

function aliasSetHas(aliases, normalized) {
  return aliases.has(normalized) || aliases.has(normalized.split(".").at(-1));
}

function isPgCronJobViewAliasName(identifier) {
  const normalized = normalizedQualifiedIdentifier(identifier);
  if (normalized === null) return false;
  if (aliasSetHas(pgCronJobViewAliases, normalized)) return true;
  ensureHistoricalPgCronJobViewAliases();
  return pgCronJobViewHistoryUnavailable || aliasSetHas(pgCronJobViewAliases, normalized);
}

function isPgCronJobWriteTarget(identifier) {
  return isPgCronJobName(identifier) || isPgCronJobViewAliasName(identifier);
}

/** Find views declared by this migration whose query reads cron.job, including
 * later views layered over an earlier alias. PostgreSQL simple views are
 * updatable, so a write to such an alias changes cron.job.command even though
 * the lexical target no longer says cron.job. */
function declaredPgCronJobViewAliases(sql, seedAliases = new Set(), includeTemporaryViews = true) {
  const structural = maskSqlForCallNames(String(sql || ""));
  if (structural === null) return new Set(seedAliases);
  const viewHead = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(TEMP(?:ORARY)?)\\s+)?` +
    `(?:RECURSIVE\\s+)?VIEW\\s+(${SQL_QUALIFIED_IDENTIFIER_PATTERN})`,
    "i"
  );
  const relationSource = new RegExp(
    `\\b(?:FROM|JOIN|TABLE)\\s+(?:ONLY\\s+)?(${SQL_QUALIFIED_IDENTIFIER_PATTERN})`,
    "gi"
  );
  const renameHead = new RegExp(
    `\\bALTER\\s+(?:VIEW|TABLE)\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?` +
    `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s+RENAME\\s+TO\\s+(${SQL_IDENTIFIER_PATTERN})`,
    "i"
  );
  const declarations = [];
  const renames = [];
  for (const statement of structural.split(";")) {
    const head = viewHead.exec(statement);
    if (head && (includeTemporaryViews || !head[1])) {
      const alias = normalizedQualifiedIdentifier(head[2]);
      if (alias !== null) {
        const sources = [];
        relationSource.lastIndex = 0;
        let source;
        while ((source = relationSource.exec(statement)) !== null) {
          const normalized = normalizedQualifiedIdentifier(source[1]);
          if (normalized !== null) sources.push(normalized);
        }
        declarations.push({ alias, sources });
      }
    }
    const rename = renameHead.exec(statement);
    if (rename) {
      const from = normalizedQualifiedIdentifier(rename[1]);
      const toBase = normalizedIdentifier(rename[2]);
      if (from !== null && toBase !== null) {
        const schemaPrefix = from.includes(".") ? from.slice(0, from.lastIndexOf(".") + 1) : "";
        renames.push({ from, to: schemaPrefix + toBase });
      }
    }
  }

  const aliases = new Set(seedAliases);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (aliasSetHas(aliases, declaration.alias)) continue;
      const reachesCronJob = declaration.sources.some((source) =>
        source === "job" || source === "cron.job" || aliasSetHas(aliases, source)
      );
      if (!reachesCronJob) continue;
      aliases.add(declaration.alias);
      aliases.add(declaration.alias.split(".").at(-1));
      changed = true;
    }
    for (const rename of renames) {
      if (!aliasSetHas(aliases, rename.from) || aliasSetHas(aliases, rename.to)) continue;
      aliases.add(rename.to);
      aliases.add(rename.to.split(".").at(-1));
      changed = true;
    }
  }
  return aliases;
}

/** Persistent views survive the migration session, so a later migration can
 * update cron.job through an alias that is absent from its own SQL text. Read
 * earlier migration files in lexical order and retain every persistent alias
 * ever observed to reach cron.job. The monotonic set intentionally keeps
 * dropped/replaced names: a conservative false positive can use the explicit
 * review marker, while forgetting a live alias would reopen delayed SQL. */
function historicalPgCronJobViewAliases(targetPath) {
  const absoluteTarget = path.resolve(targetPath);
  const migrationDir = path.dirname(absoluteTarget);
  const currentName = path.basename(absoluteTarget);
  const priorNames = readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && entry.name < currentName)
    .map((entry) => entry.name)
    .sort();
  let aliases = new Set();
  for (const priorName of priorNames) {
    const priorSql = readFileSync(path.join(migrationDir, priorName), "utf8");
    aliases = declaredPgCronJobViewAliases(priorSql, aliases, false);
  }
  return aliases;
}

function ensureHistoricalPgCronJobViewAliases() {
  if (pgCronJobViewHistoryChecked) return;
  pgCronJobViewHistoryChecked = true;
  try {
    const historicalAliases = historicalPgCronJobViewAliases(filePath);
    pgCronJobViewAliases = declaredPgCronJobViewAliases(content, historicalAliases, true);
  } catch {
    // If the migration history cannot be read, an otherwise unknown command
    // target must be treated as a possible persistent cron.job view alias.
    pgCronJobViewHistoryUnavailable = true;
  }
}

/** Return the current pg_cron call sites while preserving the source argument
 * text. Unicode-escaped API names are returned with api=null and therefore use
 * the conservative unknown-API rule below. */
function pgCronCallSites(rawStmt) {
  const raw = String(rawStmt || "");
  const callableSql = maskSqlForCallNames(raw);
  if (callableSql === null) return [];
  const unicodeIdentifier =
    'U&\\s*"(?:[^"]|"")*"(?:\\s+UESCAPE\\s*\'(?:[^\']|\'\')*\')?';
  const identifier = `(?:${unicodeIdentifier}|"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)`;
  const currentApi = '(?:"(?:schedule|schedule_in_database|alter_job)"|(?:schedule|schedule_in_database|alter_job))';
  const patterns = [
    new RegExp(`(?:^|[^\\w$])(?:"cron"|cron|${unicodeIdentifier})\\s*\\.\\s*(${identifier})\\s*\\(`, "gi"),
    new RegExp(`(?:^|[^\\w$.\"])(` + currentApi + `)\\s*\\(`, "gi"),
    new RegExp(`(?:^|[^\\w$.\"])(` + unicodeIdentifier + `)\\s*\\(`, "gi"),
  ];
  const sites = [];
  const seen = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(callableSql)) !== null) {
      const relativeOpen = match[0].lastIndexOf("(");
      const open = match.index + relativeOpen;
      if (seen.has(open)) continue;
      // INSERT INTO/COPY cron.job (...) is a table column list, not a call.
      if (/\b(?:INSERT\s+INTO|COPY)\s+(?:"cron"|cron)\s*\.\s*(?:"job"|job)\s*$/i
        .test(callableSql.slice(0, open))) continue;
      const parsed = readBalancedParens(callableSql, open);
      if (!parsed) {
        sites.push({ api: normalizedIdentifier(match[1]), args: null });
        seen.add(open);
        continue;
      }
      sites.push({
        api: normalizedIdentifier(match[1]),
        args: splitTopLevelArgs(parsed.params, raw.slice(open + 1, parsed.end - 1)),
      });
      seen.add(open);
    }
  }
  return sites;
}

function namedArgumentValue(argument, name) {
  const masked = maskSqlForCallNames(String(argument || ""));
  if (masked === null) return null;
  const match = new RegExp(`^\\s*(?:"${name}"|${name})\\s*(?:=>|:=)\\s*`, "i").exec(masked);
  return match ? String(argument).slice(match[0].length) : null;
}

function hasUnicodeNamedArgument(argument) {
  const masked = maskSqlForCallNames(String(argument || ""));
  if (masked === null) return true;
  return /^\s*U&\s*"(?:[^"]|"")*"(?:\s+UESCAPE\s*'(?:[^']|'')*')?\s*(?:=>|:=)/i.test(masked);
}

/** The legacy SECURITY DEFINER executor accepts exactly one SQL expression.
 * Anything except one direct literal is opaque and requires manual review. */
function hasOpaqueExecuteSqlReadonlyCall(rawStmt) {
  const raw = String(rawStmt || "");
  const callableSql = maskSqlForCallNames(raw);
  if (callableSql === null) return true;
  const executor = '(?:"execute_sql_readonly"|execute_sql_readonly)';
  const patterns = [
    new RegExp(`(?:^|[^\\w$])(?:"public"|public)\\s*\\.\\s*${executor}\\s*\\(`, "gi"),
    new RegExp(`(?:^|[^\\w$.\"])${executor}\\s*\\(`, "gi"),
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(callableSql)) !== null) {
      const open = match.index + match[0].lastIndexOf("(");
      const parsed = readBalancedParens(callableSql, open);
      if (!parsed) return true;
      const args = splitTopLevelArgs(parsed.params, raw.slice(open + 1, parsed.end - 1));
      if (args.length !== 1) return true;
      const named = namedArgumentValue(args[0], "sql_query");
      const value = named === null ? args[0] : named;
      if (/(?:=>|:=)/.test(maskSqlForCallNames(args[0]) || "") && named === null) return true;
      if (!isDirectSqlStringLiteral(value)) return true;
    }
  }
  return false;
}

/** pg_cron persists command text beyond the migration. If that command arrives
 * through a variable, subquery, DEFAULT, concatenation, or another expression,
 * this lexical guard cannot inspect the eventual SQL and must fail closed. */
function hasOpaquePgCronCallCommand(rawStmt) {
  const noCommandApis = new Set(["unschedule"]);
  for (const site of pgCronCallSites(rawStmt)) {
    if (site.args === null) return true;
    const args = site.args;
    if (args.some(hasUnicodeNamedArgument)) return true;
    const namedCommand = args.map((arg) => namedArgumentValue(arg, "command"))
      .find((value) => value !== null);
    if (namedCommand !== undefined) {
      if (!isDirectSqlStringLiteral(namedCommand)) return true;
      continue;
    }

    const hasNamedArgs = args.some((arg) => /(?:=>|:=)/.test(maskSqlForCallNames(arg) || ""));
    if (site.api === "alter_job") {
      const thirdIsNamed = args.length >= 3 &&
        /^\s*(?:"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*(?:=>|:=)/
          .test(maskSqlForCallNames(args[2]) || "");
      if (args.length < 3 || thirdIsNamed) continue; // command was not changed
      if (!isDirectSqlStringLiteral(args[2])) return true;
      continue;
    }
    if (site.api === "schedule") {
      if (hasNamedArgs) return true; // required command was not readable by name
      const command = args.length >= 3 ? args[2] : args[1];
      if (!isDirectSqlStringLiteral(command)) return true;
      continue;
    }
    if (site.api === "schedule_in_database") {
      if (args.length < 3 || !isDirectSqlStringLiteral(args[2])) return true;
      continue;
    }
    if (site.api !== null && noCommandApis.has(site.api)) continue;

    // A new or Unicode-escaped cron API may itself store executable SQL. It is
    // safe to inspect only when every supplied value is a direct SQL literal.
    if (args.some((arg) => {
      const masked = maskSqlForCallNames(arg) || "";
      const named = /^\s*(?:"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*(?:=>|:=)\s*/.exec(masked);
      return !isDirectSqlStringLiteral(named ? arg.slice(named[0].length) : arg);
    })) return true;
  }
  return false;
}

function directLiteralAt(raw, from) {
  let start = from;
  while (/\s/.test(raw[start] || "")) start++;
  if (raw[start] === "'") {
    const end = scanQuoted(raw, start);
    return end === -1 ? null : { start, end };
  }
  const tag = dollarTagAt(raw, start);
  if (!tag) return null;
  const close = raw.indexOf(tag, start + tag.length);
  return close === -1 ? null : { start, end: close + tag.length };
}

function commandAssignmentsAreDirect(rawStmt, callableSql) {
  const assignment = /(?:\bSET\b|,)\s*(?:"command"|command)\s*=\s*/gi;
  let found = false;
  let match;
  while ((match = assignment.exec(callableSql)) !== null) {
    found = true;
    const literal = directLiteralAt(rawStmt, match.index + match[0].length);
    if (!literal) return false;
    const remainder = callableSql.slice(literal.end).trimStart();
    if (remainder !== "" && !/^(?:,|\b(?:FROM|WHERE|RETURNING|WHEN)\b)/i.test(remainder)) return false;
  }
  return found ? true : null;
}

function tupleCommandAssignmentsAreDirect(rawStmt, callableSql) {
  const tupleHead = /(?:\bSET\b|,)\s*\(/gi;
  let found = false;
  let match;
  while ((match = tupleHead.exec(callableSql)) !== null) {
    const columnsOpen = match.index + match[0].lastIndexOf("(");
    const columns = readBalancedParens(callableSql, columnsOpen);
    if (!columns) return false;
    const names = splitTopLevelArgs(columns.params).map(normalizedIdentifier);
    const commandIndex = names.indexOf("command");
    if (commandIndex === -1) { tupleHead.lastIndex = columns.end; continue; }
    found = true;
    const rhsHead = /^\s*=\s*\(/.exec(callableSql.slice(columns.end));
    if (!rhsHead) return false;
    const valuesOpen = columns.end + rhsHead[0].lastIndexOf("(");
    const values = readBalancedParens(callableSql, valuesOpen);
    if (!values) return false;
    const sourceValues = splitTopLevelArgs(
      values.params,
      rawStmt.slice(valuesOpen + 1, values.end - 1)
    );
    if (sourceValues.length !== names.length || !isDirectSqlStringLiteral(sourceValues[commandIndex])) {
      return false;
    }
    tupleHead.lastIndex = values.end;
  }
  return found ? true : null;
}

function insertCommandValuesAreDirect(rawStmt, callableSql) {
  const jobTable = '(?:(?:"cron"|cron)\\s*\\.\\s*)?(?:"job"|job)';
  const heads = new RegExp(
    `(?:^|[^\\w$.\"])(?:INSERT\\s+INTO)\\s+${jobTable}\\s*`,
    "gi"
  );
  let found = false;
  let head;
  while ((head = heads.exec(callableSql)) !== null) {
    found = true;
    const columnsOpen = head.index + head[0].length;
    if (callableSql[columnsOpen] !== "(") return false;
    const columns = readBalancedParens(callableSql, columnsOpen);
    if (!columns) return false;
    const names = splitTopLevelArgs(columns.params).map(normalizedIdentifier);
    const commandIndex = names.indexOf("command");
    if (commandIndex === -1) return false;
    const valuesHead = /^\s*VALUES\s*/i.exec(callableSql.slice(columns.end));
    if (!valuesHead) return false;
    let cursor = columns.end + valuesHead[0].length;
    let rows = 0;
    while (callableSql[cursor] === "(") {
      const values = readBalancedParens(callableSql, cursor);
      if (!values) return false;
      const sourceValues = splitTopLevelArgs(
        values.params,
        rawStmt.slice(cursor + 1, values.end - 1)
      );
      if (sourceValues.length !== names.length || !isDirectSqlStringLiteral(sourceValues[commandIndex])) {
        return false;
      }
      rows++;
      cursor = values.end;
      while (/\s/.test(callableSql[cursor] || "")) cursor++;
      if (callableSql[cursor] !== ",") break;
      cursor++;
      while (/\s/.test(callableSql[cursor] || "")) cursor++;
    }
    if (rows === 0) return false;
    heads.lastIndex = cursor;
  }
  return found ? true : null;
}

function hasOpaquePgCronCommandWrite(rawStmt) {
  if (!isPgCronCommandWrite(rawStmt)) return false;
  const raw = String(rawStmt || "");
  const callableSql = maskSqlForCallNames(raw);
  if (callableSql === null) return true;
  // The direct INSERT/MERGE validators are deliberately bound to cron.job's
  // known column layout. A migration-created view can reorder or omit columns,
  // so non-UPDATE writes through one require explicit manual review.
  if (pgCronCommandWriteSites(callableSql).some(
    (site) => site.viewAlias && site.kind !== "UPDATE"
  )) return true;
  if (/\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO|COPY)\b[\s\S]*U&\s*"/i.test(callableSql)) return true;
  if (/\bCOPY\b/i.test(callableSql)) return true;

  const insertDirect = insertCommandValuesAreDirect(raw, callableSql);
  if (insertDirect !== null && !insertDirect) return true;
  const directAssignment = commandAssignmentsAreDirect(raw, callableSql);
  const directTuple = tupleCommandAssignmentsAreDirect(raw, callableSql);
  if (directAssignment === false || directTuple === false) return true;
  const hasDirectCommand = directAssignment === true || directTuple === true;
  const isMerge = /\bMERGE\s+INTO\b/i.test(callableSql);
  // INSERT branches have an independent column/value mapping. A safe direct
  // UPDATE command cannot make an opaque WHEN NOT MATCHED branch inspectable.
  if (isMerge && /\bWHEN\s+NOT\s+MATCHED\b[\s\S]*\bINSERT\b/i.test(callableSql)) return true;
  if (isMerge && !hasDirectCommand) return true;
  if (!isMerge && /\bUPDATE\b/i.test(callableSql) &&
      insertDirect === null && !hasDirectCommand) return true;
  return false;
}

/** pg_cron stores executable command text through multiple APIs (currently
 * schedule, schedule_in_database, and alter_job). Treat any direct call in the
 * cron schema as a runtime-SQL boundary so a new qualified overload/API cannot
 * silently reopen this reader. Also recognize the current APIs when unqualified:
 * PostgreSQL can resolve `schedule(...)` to `cron.schedule(...)` through
 * search_path (or a wrapper), so requiring the literal `cron.` prefix would be
 * fail-open. Command-bearing APIs additionally require a direct, inspectable
 * command literal; non-command APIs such as unschedule remain ordinary calls. */
function isPgCronCall(rawStmt) {
  const callableSql = maskSqlForCallNames(String(rawStmt || ""));
  if (callableSql === null) return false;
  const unicodeIdentifier =
    'U&\\s*"(?:[^"]|"")*"(?:\\s+UESCAPE\\s*\'(?:[^\']|\'\')*\')?';
  const identifier = `(?:${unicodeIdentifier}|"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)`;
  const qualified = new RegExp(
    `(?:^|[^\\w$])(?:"cron"|cron)\\s*\\.\\s*${identifier}\\s*\\(`,
    "i"
  );
  const currentUnqualifiedApi =
    '(?:"(?:schedule|schedule_in_database|alter_job)"|(?:schedule|schedule_in_database|alter_job))';
  const unqualified = new RegExp(
    `(?:^|[^\\w$.\"])${currentUnqualifiedApi}\\s*\\(`,
    "i"
  );
  // PostgreSQL decodes U&"..." identifiers before name resolution. Decoding
  // every custom UESCAPE form here would be brittle, so any executable call
  // involving a Unicode identifier is conservatively treated as a SQL sink.
  const unicodeCall = new RegExp(
    `(?:${unicodeIdentifier}(?:\\s*\\.\\s*(?:${identifier}|${unicodeIdentifier}))?` +
    `|${identifier}\\s*\\.\\s*${unicodeIdentifier})\\s*\\(`,
    "i"
  );
  return qualified.test(callableSql) || unqualified.test(callableSql) ||
    unicodeCall.test(callableSql);
}

/** Return writes whose relation target is cron.job or a view declared over it
 * in this migration. The mask preserves quoted-identifier spelling, and target
 * comparison applies PostgreSQL's quoted/unquoted case rules. */
function pgCronCommandWriteSites(callableSql) {
  const writeBoundary = '(?:^|[^\\w$.\"])';
  const relation = `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})`;
  const suffix = '(?:\\s*\\*)?(?=\\s|\\(|$)';
  const patterns = [
    ["COPY", new RegExp(`${writeBoundary}COPY\\s+(?:ONLY\\s+)?${relation}${suffix}`, "gi")],
    ["INSERT", new RegExp(`${writeBoundary}INSERT\\s+INTO\\s+${relation}${suffix}`, "gi")],
    ["MERGE", new RegExp(`${writeBoundary}MERGE\\s+INTO\\s+${relation}${suffix}`, "gi")],
    ["UPDATE", new RegExp(`${writeBoundary}UPDATE\\s+(?:ONLY\\s+)?${relation}${suffix}`, "gi")],
  ];
  const sites = [];
  for (const [kind, pattern] of patterns) {
    let match;
    while ((match = pattern.exec(callableSql)) !== null) {
      if (!isPgCronJobWriteTarget(match[1])) continue;
      sites.push({
        kind,
        end: match.index + match[0].length,
        viewAlias: isPgCronJobViewAliasName(match[1]),
      });
    }
  }
  return sites;
}

/** cron.job.command is the table-level equivalent of cron.alter_job(command):
 * INSERT/COPY can create jobs and UPDATE/MERGE can replace their commands.
 * Recognize schema-qualified, quoted, ONLY/alias, tuple-assignment,
 * search_path-resolved `job`, and migration-declared updatable-view forms while
 * leaving unrelated schemas/views alone. */
function isPgCronCommandWrite(rawStmt) {
  const callableSql = maskSqlForCallNames(String(rawStmt || ""));
  if (callableSql === null) return false;

  // An escaped schema/table identifier can decode to cron.job. Any write using
  // such an identifier is opaque enough to require the runtime-DDL boundary.
  if (/\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO|COPY)\b[\s\S]*U&\s*"/i.test(callableSql)) {
    return true;
  }

  const sites = pgCronCommandWriteSites(callableSql);
  if (sites.some((site) => site.kind !== "UPDATE")) return true;
  const command = '(?:"command"|command)';
  const directAssignment = new RegExp(`(?:\\bSET\\b|,)\\s*${command}\\s*=`, "i");
  const tupleAssignment = new RegExp(
    `(?:\\bSET\\b|,)\\s*\\([^)]*(?:"command"|\\bcommand\\b)[^)]*\\)\\s*=`,
    "i"
  );
  return sites.some((site) => {
    const tail = callableSql.slice(site.end);
    // The optional target alias is deliberately left in `tail`; both
    // expressions search from SET/comma boundaries, so alias spelling cannot
    // impersonate a command-column assignment.
    return directAssignment.test(tail) || tupleAssignment.test(tail);
  });
}

// EXECUTE is also a PostgreSQL privilege keyword. These two complete statement
// heads grant/revoke permission to call an already-readable function; they do
// not run SQL dynamically. Keep the exception deliberately narrow and refuse
// any statement containing another EXECUTE token after the privilege keyword.
function isExecutePrivilegeStatement(stmt) {
  const sql = String(stmt || "").trim();
  const isPrivilegeHead =
    /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\b/i.test(sql) ||
    /^REVOKE\s+EXECUTE\s+ON\s+FUNCTION\b/i.test(sql);
  if (!isPrivilegeHead) return false;
  return (sql.match(/\bEXECUTE\b/gi) || []).length === 1;
}

// CREATE TRIGGER uses EXECUTE as declarative syntax, not as a dynamic-SQL
// operator. Accept only a complete trigger statement whose sole EXECUTE token
// directly invokes one named function/procedure. Any second EXECUTE token or
// trailing expression remains opaque and is refused by the runtime-SQL gate.
function isCreateTriggerStatement(stmt) {
  const sql = String(stmt || "").trim();
  if (!/^CREATE\s+(?:(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|EVENT\s+TRIGGER)\b/i.test(sql)) {
    return false;
  }
  const executeToken = /\bEXECUTE\b/i.exec(sql);
  if (!executeToken) return false;

  const tail = sql.slice(executeToken.index);
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][\\w$]*)';
  const callHead = new RegExp(
    `^EXECUTE\\s+(?:FUNCTION|PROCEDURE)\\s+${identifier}(?:\\s*\\.\\s*${identifier})*\\s*`,
    "i"
  ).exec(tail);
  if (!callHead || tail[callHead[0].length] !== "(") return false;
  const args = readBalancedParens(tail, callHead[0].length);
  return args !== null && tail.slice(args.end).trim() === "";
}

// Return the command literal when a PL/pgSQL EXECUTE statement uses exactly
// one direct command string. INTO/USING affect only result/parameter binding;
// they cannot rewrite the command text. Their payloads may contain additional
// data literals, so identify the first literal structurally instead of merely
// counting every literal in the statement.
function directExecuteLiteralShape(masked, stmtStart, stmtEnd, lits) {
  if (lits.length === 0) return null;
  const commandLiteral = lits[0];
  const prefix = masked.slice(stmtStart, commandLiteral.start).trim();
  const parenthesized = /^(?:BEGIN\s+)?EXECUTE\s*\(\s*$/i.test(prefix);
  if (!parenthesized && !/^(?:BEGIN\s+)?EXECUTE\s*$/i.test(prefix)) return null;

  let tail = masked.slice(commandLiteral.end, stmtEnd).trim();
  if (parenthesized) {
    if (!tail.startsWith(")")) return null;
    tail = tail.slice(1).trim();
  } else if (tail.startsWith(")")) {
    return null;
  }
  if (/\bEXECUTE\b/i.test(tail)) return null;
  if (tail === "") return { literal: commandLiteral };

  const usingHead = /^USING\b/i.exec(tail);
  if (usingHead) {
    const params = tail.slice(usingHead[0].length);
    return params.trim() !== "" &&
      !/\b(?:INTO|USING)\b/i.test(params)
      ? { literal: commandLiteral }
      : null;
  }

  const intoHead = /^INTO\b/i.exec(tail);
  if (!intoHead) return null;
  let intoTail = tail.slice(intoHead[0].length).trim();
  const strictHead = /^STRICT\b/i.exec(intoTail);
  if (strictHead) intoTail = intoTail.slice(strictHead[0].length).trim();
  if (intoTail === "") return null;

  const using = /\bUSING\b/i.exec(intoTail);
  if (!using) return { literal: commandLiteral };
  const target = intoTail.slice(0, using.index).trim();
  const params = intoTail.slice(using.index + using[0].length).trim();
  if (target === "" || params === "" || /\bUSING\b/i.test(params)) return null;
  return { literal: commandLiteral };
}

function inExecuteStatement(out, text, afterIdx) {
  const stmtStart = out.lastIndexOf(";") + 1;
  const before = out.slice(stmtStart);
  const semi = firstTopLevelSemicolon(text, afterIdx);
  const stmtEnd = semi === -1 ? text.length : semi;
  return isDynamicSqlStatement(
    before + " " + text.slice(afterIdx, stmtEnd),
    text.slice(stmtStart, stmtEnd)
  );
}

const CREATE_FN_HEAD_RE = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${SQL_QUALIFIED_IDENTIFIER_PATTERN}\\s*\\(`,
  "i"
);

/** Blank comments length-preservingly without touching string literals. */
function blankComments(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'" || s[i] === '"') {
      const end = scanQuoted(s, i);
      if (end === -1) return s;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (s[i] === "$") {
      const tag = dollarTagAt(s, i);
      if (tag) {
        const close = s.indexOf(tag, i + tag.length);
        if (close === -1) return s;
        const end = close + tag.length;
        out += s.slice(i, end);
        i = end;
        continue;
      }
    }
    if (s[i] === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i + 2);
      const stop = nl === -1 ? s.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "/" && s[j + 1] === "*") { depth++; j += 2; continue; }
        if (s[j] === "*" && s[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function carriesFnHeader(payload) {
  return CREATE_FN_HEAD_RE.test(payload) ||
    CREATE_FN_HEAD_RE.test(blankComments(payload));
}

/** Decode PostgreSQL U&'...' string escapes only for header detection. The
 * original source remains untouched for length-preserving structural scans. */
function unicodeStringForHeaderDetection(text, open, end, payload) {
  if (text.slice(Math.max(0, open - 2), open).toUpperCase() !== "U&" ||
      /[\w$]/.test(text[open - 3] || "")) return null;
  let escape = "\\";
  const custom = /^\s+UESCAPE\s+'([^'])'/i.exec(text.slice(end));
  if (custom) escape = custom[1];
  if (/[0-9A-Fa-f+'"\s]/.test(escape)) return { error: true };

  let decoded = "";
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== escape) {
      decoded += payload[i];
      continue;
    }
    if (payload[i + 1] === escape) {
      decoded += escape;
      i++;
      continue;
    }
    const plus = payload[i + 1] === "+";
    const digits = plus ? payload.slice(i + 2, i + 8) : payload.slice(i + 1, i + 5);
    if (!new RegExp(`^[0-9A-Fa-f]{${plus ? 6 : 4}}$`).test(digits)) return { error: true };
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff) return { error: true };
    decoded += String.fromCodePoint(codePoint);
    i += plus ? 7 : 4;
  }
  return { payload: decoded };
}

/** True when the current literal is executable procedural code rather than
 * data. PostgreSQL permits DO [LANGUAGE name] code, with code written as a
 * dollar-quoted or single-quoted string. AS bodies use the same literal forms. */
function proceduralSingleQuoteKind(text) {
  const stmt = text.slice(text.lastIndexOf(";") + 1);
  const language = "(?:[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*|\"[^\"]*\")";
  const container = `(?:\\bAS|\\bDO(?:\\s+LANGUAGE\\s+${language})?)`;
  if (new RegExp(`${container}\\s+$`, "i").test(stmt)) return "plain";
  if (new RegExp(`${container}\\s+[eE]$`, "i").test(stmt)) return "escape";
  if (new RegExp(`${container}\\s+(?:[uU]&|[nN])$`, "i").test(stmt)) return "unicode";
  return null;
}

function isProceduralContainerPrefix(text, singleQuoted = false) {
  if (singleQuoted) return proceduralSingleQuoteKind(text) !== null;
  const stmt = text.slice(text.lastIndexOf(";") + 1);
  const language = "(?:[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*|\"[^\"]*\")";
  return /\bAS\s+$/i.test(stmt) ||
    new RegExp(`\\bDO(?:\\s+LANGUAGE\\s+${language})?\\s+$`, "i").test(stmt);
}

/** PostgreSQL concatenates adjacent string tokens when their separating SQL
 * whitespace contains a newline. A procedural body split that way is no
 * longer one literal this length-preserving reader can safely recurse into. */
function hasAdjacentNewlineString(text, from) {
  let i = from;
  let sawNewline = false;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      if (text[i] === "\n" || text[i] === "\r") sawNewline = true;
      i++;
      continue;
    }
    if (text[i] === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      if (nl === -1) return false;
      sawNewline = true;
      i = nl + 1;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "\n" || text[j] === "\r") sawNewline = true;
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) return null;
      i = j;
      continue;
    }
    break;
  }
  return sawNewline && /^(?:[eEnN]|[uU]&)?'/.test(text.slice(i));
}

/** CRX's legacy execute_sql_readonly(text) function validates only the first
 * keyword, then dynamically EXECUTEs the supplied SELECT/WITH as its owner.
 * Treat a function-bearing literal in that argument as executable SQL. Unicode
 * identifiers are opaque, so matching ones conservatively take the same path. */
function isExecuteSqlReadonlyLiteralPrefix(prefix) {
  const unicodeIdentifier =
    'U&\\s*"(?:[^"]|"")*"(?:\\s+UESCAPE\\s*\'(?:[^\']|\'\')*\')?';
  const publicSchema = `(?:"public"|public|${unicodeIdentifier})`;
  const executor = `(?:"execute_sql_readonly"|execute_sql_readonly|${unicodeIdentifier})`;
  const sqlArg = `(?:(?:"sql_query"|sql_query|${unicodeIdentifier})\\s*(?:=>|:=)\\s*)?`;
  const qualified = new RegExp(
    `(?:^|[^\\w$.\"])(?:${publicSchema})\\s*\\.\\s*${executor}\\s*\\(\\s*${sqlArg}$`,
    "i"
  );
  const unqualified = new RegExp(
    `(?:^|[^\\w$.\"])(?:${executor})\\s*\\(\\s*${sqlArg}$`,
    "i"
  );
  return qualified.test(prefix) || unqualified.test(prefix);
}

const NON_CALLABLE_PAREN_KEYWORDS = new Set([
  "all", "any", "array", "as", "case", "cast", "exists", "in", "query", "row", "select", "values",
]);

function unmatchedOpenParens(prefix) {
  const stack = [];
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(prefix, i);
      if (end === -1) return [];
      i = end - 1;
      continue;
    }
    const tag = ch === "$" ? dollarTagAt(prefix, i) : null;
    if (tag) {
      const close = prefix.indexOf(tag, i + tag.length);
      if (close === -1) return [];
      i = close + tag.length - 1;
      continue;
    }
    if (ch === "(") stack.push(i);
    else if (ch === ")") stack.pop();
  }
  return stack;
}

function callableNameBeforeOpen(prefix, open) {
  const match = new RegExp(`(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*$`, "i")
    .exec(prefix.slice(0, open));
  if (!match) return null;
  const name = match[1];
  if (/^[A-Za-z_]\w*$/.test(name) &&
      NON_CALLABLE_PAREN_KEYWORDS.has(name.toLowerCase())) return null;
  return name;
}

function isKnownSqlExecutorName(name) {
  const normalized = normalizedQualifiedIdentifier(name);
  return new Set([
    "execute_sql_readonly",
    "public.execute_sql_readonly",
    "schedule",
    "schedule_in_database",
    "alter_job",
    "cron.schedule",
    "cron.schedule_in_database",
    "cron.alter_job",
  ]).has(normalized);
}

function isExecuteFormatBuilderName(name) {
  return /^(?:(?:"pg_catalog"|pg_catalog)\s*\.\s*)?(?:"format"|format)$/i.test(name);
}

/** Inspect every enclosing callable, not only the immediate/first argument.
 * This catches later positional/named arguments and CAST/paren wrappers. */
function hasUnprovenCallableContext(callablePrefix, structuralPrefix, fullText, literalEnd) {
  for (const open of unmatchedOpenParens(callablePrefix)) {
    const name = callableNameBeforeOpen(callablePrefix, open);
    if (name === null || isKnownSqlExecutorName(name)) continue;
    if (isExecuteFormatBuilderName(name) &&
        inExecuteStatement(structuralPrefix, fullText, literalEnd)) continue;
    return true;
  }
  return false;
}

function hasStringLiteral(expression) {
  const text = String(expression || "");
  for (let i = 0; i < text.length;) {
    if (text[i] === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i + 2);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; continue; }
        if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (text[i] === "'") return scanQuoted(text, i) !== -1;
    if (text[i] === '"') {
      const end = scanQuoted(text, i);
      if (end === -1) return false;
      i = end;
      continue;
    }
    const tag = text[i] === "$" ? dollarTagAt(text, i) : null;
    if (tag) return text.indexOf(tag, i + tag.length) !== -1;
    i++;
  }
  return false;
}

/** A callable not proven data-only may execute or store any string argument.
 * If that argument is an expression rather than one inspectable literal, the
 * reader cannot prove that chr()/concat()/format() did not obscure SQL tokens. */
function isPotentialSqlTextSinkName(name) {
  const normalized = normalizedQualifiedIdentifier(name);
  if (normalized === null) return true;
  const base = normalized.split(".").at(-1) || "";
  return /(?:^|_)(?:exec(?:ute)?|query|sql)(?:_|$)/i.test(base);
}

function hasOpaqueUnprovenSqlCallableArgument(rawStmt) {
  const structural = maskSqlForCallNames(rawStmt);
  if (structural === null) return true;
  for (let open = 0; open < structural.length; open++) {
    if (structural[open] !== "(") continue;
    const name = callableNameBeforeOpen(structural, open);
    if (name === null || isKnownSqlExecutorName(name) || !isPotentialSqlTextSinkName(name)) continue;
    const parsed = readBalancedParens(structural, open);
    if (!parsed) return true;
    const args = splitTopLevelArgs(
      parsed.params,
      rawStmt.slice(open + 1, parsed.end - 1)
    );
    if (args.some((arg) => hasStringLiteral(arg) && !isDirectSqlStringLiteral(arg))) {
      return true;
    }
  }
  return false;
}

/** Renaming or moving the known owner-executing SQL function would make later
 * calls invisible to the name-bound reader. Require the explicit exemption and
 * manual review instead of trying to carry aliases across migration files. */
function hasExecuteSqlReadonlyIdentityChange(rawSql) {
  const callableSql = maskSqlForCallNames(String(rawSql || ""));
  if (callableSql === null) return false;
  const unicodeIdentifier =
    'U&\\s*"(?:[^"]|"")*"(?:\\s+UESCAPE\\s*\'(?:[^\']|\'\')*\')?';
  const schema = `(?:(?:"public"|public)\\s*\\.\\s*)?`;
  const executor = '(?:"execute_sql_readonly"|execute_sql_readonly)';
  const identityAction = '(?:RENAME\\s+TO|SET\\s+SCHEMA)';
  const exact = new RegExp(
    `\\bALTER\\s+(?:FUNCTION|ROUTINE)\\s+(?:IF\\s+EXISTS\\s+)?` +
    `${schema}${executor}\\s*\\([^;]*\\)\\s*${identityAction}`,
    "i"
  );
  const opaqueUnicode = new RegExp(
    `\\bALTER\\s+(?:FUNCTION|ROUTINE)\\s+(?:IF\\s+EXISTS\\s+)?` +
    `(?:${SQL_QUALIFIED_IDENTIFIER_PATTERN})?${unicodeIdentifier}` +
    `(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})?\\s*\\([^;]*\\)\\s*${identityAction}`,
    "i"
  );
  return exact.test(callableSql) || opaqueUnicode.test(callableSql);
}

let sawOpaqueFunctionCallable = false;

/** Replace comments and quoted-string contents with spaces, while recursively
 * retaining executable SQL held inside procedural bodies and dynamic DDL.
 * Length-preserving so structural indexes map back to the original content.
 * Returns null for any unterminated construct; callers fail closed. */
function maskSqlNoise(text, inProceduralCode = false) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "-" && text[i + 1] === "-") {
      let nl = text.indexOf("\n", i + 2);
      if (nl === -1) nl = text.length;
      out += " ".repeat(nl - i);
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      if (depth > 0) return null;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "$") {
      const tag = dollarTagAt(text, i);
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        const payload = text.slice(i + tag.length, close);
        const isProceduralContainer = isProceduralContainerPrefix(out);
        const hasFunctionHeader = carriesFnHeader(payload);
        const isKnownSqlExecutor = hasFunctionHeader &&
          isExecuteSqlReadonlyLiteralPrefix(out);
        const callablePrefix = hasFunctionHeader
          ? maskSqlForCallNames(text.slice(0, i))
          : "";
        if (hasFunctionHeader && callablePrefix !== null &&
            hasUnprovenCallableContext(
              callablePrefix, out, text, close + tag.length
            )) {
          sawOpaqueFunctionCallable = true;
          return null;
        }
        const isExecutable = isProceduralContainer || /\bEXECUTE\s+$/i.test(out) ||
          isKnownSqlExecutor ||
          (inProceduralCode && hasFunctionHeader) ||
          (hasFunctionHeader && inExecuteStatement(out, text, close + tag.length));
        const inner = isExecutable
          ? maskSqlNoise(payload, inProceduralCode || isProceduralContainer)
          : " ".repeat(payload.length);
        if (inner === null) return null;
        out += tag + inner + tag;
        i = close + tag.length;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(text, i);
      if (end === -1) return null;
      const payload = text.slice(i + 1, end - 1);
      const proceduralStringKind = ch === "'" ? proceduralSingleQuoteKind(out) : null;
      const isProceduralContainer = proceduralStringKind !== null;
      // Escape/Unicode bodies need decoding that cannot remain both exact and
      // length-preserving. Multi-token bodies are likewise not one readable
      // literal. Recognize all of them, then fail closed.
      if (isProceduralContainer && proceduralStringKind !== "plain") return null;
      if (isProceduralContainer && hasAdjacentNewlineString(text, end) !== false) return null;
      const unicodePayload = ch === "'"
        ? unicodeStringForHeaderDetection(text, i, end, payload)
        : null;
      if (unicodePayload?.error) return null;
      const hasFunctionHeader = carriesFnHeader(unicodePayload?.payload ?? payload);
      const isKnownSqlExecutor = ch === "'" && hasFunctionHeader &&
        isExecuteSqlReadonlyLiteralPrefix(out);
      const callablePrefix = ch === "'" && hasFunctionHeader
        ? maskSqlForCallNames(text.slice(0, i))
        : "";
      if (ch === "'" && hasFunctionHeader && callablePrefix !== null &&
          hasUnprovenCallableContext(callablePrefix, out, text, end)) {
        sawOpaqueFunctionCallable = true;
        return null;
      }
      const isDynamicSql = ch === "'" && (isProceduralContainer || isKnownSqlExecutor ||
        (hasFunctionHeader && (inProceduralCode || inExecuteStatement(out, text, end))));
      if (isDynamicSql) {
        // Recursing into the raw payload is safe only when it needs no SQL
        // quote decoding. In an outer standard string, doubled quotes represent
        // one inner quote; treating them as two delimiters can turn an inner
        // `--` string into a fake comment and hide the mutation that follows.
        // Preserve exact source indexes by refusing this fancy valid form and
        // directing it to the explicit exemption/human-review path.
        if (payload.includes("''")) return null;
        const inner = maskSqlNoise(
          payload,
          inProceduralCode || isProceduralContainer || isKnownSqlExecutor
        );
        if (inner === null) return null;
        out += ch + inner + ch;
      } else {
        out += ch + " ".repeat(end - i - 2) + ch;
      }
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Read balanced parentheses from the length-preserving SQL-noise mask. String,
 * comment, and dollar-quote contents have already been blanked, so only real
 * structural parentheses remain. */
function readBalancedParens(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth === 0) return { params: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** From just past the parameter list, return every function attribute and the
 * exact indexes for the AS $tag$...$tag$ body. PostgreSQL permits attributes
 * such as SECURITY DEFINER both before and after the body, so the post-body
 * region is included through the statement's terminating semicolon. The caller
 * scans the length-preserving mask but slices the real body so ACTOR_MISMATCH
 * string literals remain visible. */
function readAttrsAndBody(text, fromIdx) {
  let i = fromIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(text, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === "$") {
      const tag = dollarTagAt(text, i);
      if (tag) {
        if (/\bAS\s+$/i.test(text.slice(fromIdx, i))) {
          const bodyStart = i + tag.length;
          const bodyEnd = text.indexOf(tag, bodyStart);
          if (bodyEnd === -1) return null;
          // `text` is the SQL-noise mask: semicolons inside comments and quoted
          // data are already spaces, while executable nested DDL stays visible.
          // The next visible semicolon is therefore this function statement's
          // terminator. Missing terminator is unreadable and must fail closed.
          const statementEnd = text.indexOf(";", bodyEnd + tag.length);
          if (statementEnd === -1) return null;
          return {
            attrs: text.slice(fromIdx, i) + " " +
              text.slice(bodyEnd + tag.length, statementEnd),
            bodyStart,
            bodyEnd,
          };
        }
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        i = close + tag.length;
        continue;
      }
      i++;
      continue;
    }
    if ((ch === "c" || ch === "C") && /^CREATE\s/i.test(text.slice(i, i + 7)) && !/[\w$]/.test(text[i - 1] || "")) {
      return null;
    }
    i++;
  }
  return null;
}

const violations = [];
try {
  pgCronJobViewAliases = declaredPgCronJobViewAliases(content);
  if (hasExecuteSqlReadonlyIdentityChange(content)) {
    violations.push(
      "This migration renames or moves execute_sql_readonly, so later owner-executing SQL calls " +
      "would no longer match the actor-binding reader. Keep the canonical identity, or add the " +
      "file-level exempt marker (-- actor-binding-check: exempt) and get a manual review."
    );
  }
  const masked = maskSqlNoise(content);
  if (masked === null) {
    if (sawOpaqueFunctionCallable) {
      violations.push(
        "This migration passes CREATE FUNCTION text to a callable that is not allowlisted as a " +
        "data-only sink. The callable may execute or store that SQL under another name. Use a " +
        "known reviewed executor, or add the file-level exempt marker " +
        "(-- actor-binding-check: exempt) and get a manual review."
      );
    } else {
      violations.push(
        "This migration could not parse safely (unterminated SQL construct, encoded or nested-quoted " +
        "procedural body, or newline-concatenated procedural strings) — " +
        "the actor-binding guard cannot inspect it. Fix the unterminated construct, or if it is " +
        "genuinely valid SQL the lexer mishandles, add the exempt marker and get a manual review."
      );
    }
  }

  // Fail closed on runtime SQL unless EXECUTE receives exactly one complete,
  // direct string literal. Any variable/expression can be overwritten or can
  // assemble DDL through writers this lexer cannot enumerate safely.
  function checkDynamicDdl(from, to) {
    let stmtStart = from;
    let lits = [];
    let i = from;
    let hasProceduralContainer = false;
    const verdict = (stmtEnd) => {
      const stmt = masked.slice(stmtStart, stmtEnd);
      const marker = "__ACTOR_DDL_LITERAL__";
      const singleLiteralSkeleton = lits.length === 1
        ? (masked.slice(stmtStart, lits[0].start) + marker + masked.slice(lits[0].end, stmtEnd)).trim()
        : null;
      const directExecuteLiteral = directExecuteLiteralShape(masked, stmtStart, stmtEnd, lits);
      const directExecute = directExecuteLiteral !== null;
      if (!hasProceduralContainer && /\bEXECUTE\b/i.test(stmt) &&
          !directExecute && !isExecutePrivilegeStatement(stmt) &&
          !isCreateTriggerStatement(stmt)) {
        violations.push(
          "This migration executes SQL assembled through variables or multiple statements, and the " +
          "actor-binding guard cannot read it as one complete literal supplied directly to EXECUTE. Put the complete " +
          "SQL text directly in EXECUTE as one literal, or add the file-level exempt marker " +
          "(-- actor-binding-check: exempt) and get a manual review."
        );
        return true;
      }
      const rawStmt = content.slice(stmtStart, stmtEnd);
      if (!hasProceduralContainer &&
          (hasOpaquePgCronCallCommand(rawStmt) || hasOpaquePgCronCommandWrite(rawStmt) ||
           hasOpaqueExecuteSqlReadonlyCall(rawStmt))) {
        violations.push(
          "This migration stores a pg_cron command or passes SQL through execute_sql_readonly " +
          "using a variable, subquery, DEFAULT, concatenation, or another expression that the " +
          "actor-binding guard cannot inspect. " +
          "Supply the complete command directly as one plain or dollar-quoted string literal, " +
          "or add the file-level exempt marker (-- actor-binding-check: exempt) and get a manual review."
        );
        return true;
      }
      if (!hasProceduralContainer && hasOpaqueUnprovenSqlCallableArgument(rawStmt)) {
        violations.push(
          "This migration passes a dynamically assembled string to a callable that is not " +
          "allowlisted as a data-only sink. The callable may execute or store SQL whose tokens " +
          "are obscured by concatenation or helper functions. Supply one complete direct literal, " +
          "or add the file-level exempt marker (-- actor-binding-check: exempt) and get a manual review."
        );
        return true;
      }
      if (lits.length === 0) return false;
      const ddlLiterals = directExecuteLiteral ? [directExecuteLiteral.literal] : lits;
      if (!carriesFnHeader(ddlLiterals.map((l) => l.payload).join(""))) return false;
      const hasUnprovenCallable = lits.some((lit) => {
        const callablePrefix = maskSqlForCallNames(content.slice(0, lit.start));
        return callablePrefix !== null && hasUnprovenCallableContext(
          callablePrefix,
          masked.slice(0, lit.start),
          content,
          lit.end
        );
      });
      if (!isDynamicSqlStatement(stmt, rawStmt) && !hasUnprovenCallable) return false;

      // "One literal" is safe only when the dynamic-SQL expression is exactly
      // that literal. A format()/concat()/CASE template can keep the header in
      // one literal while substituting the actor parameter or body at runtime.
      // Replace the literal with a marker and accept only the three deliberately
      // supported direct shapes. Fancy but valid builders use the exemption.
      if (lits.length === 1 && carriesFnHeader(lits[0].payload)) {
        const lit = lits[0];
        const skeleton = singleLiteralSkeleton;
        const directAssign = /^(?:BEGIN\s+)?(?:"[^"]+"|[\w.]+)\s*(?::=|=(?!=))\s*__ACTOR_DDL_LITERAL__$/i.test(skeleton);
        const directSelectInto = /^(?:BEGIN\s+)?SELECT\s+__ACTOR_DDL_LITERAL__\s+INTO\s+(?:"[^"]+"|[\w.]+)$/i.test(skeleton);
        if (directAssign || directSelectInto) return false;
      }
      if (directExecuteLiteral && carriesFnHeader(directExecuteLiteral.literal.payload)) return false;
      violations.push(
        "This migration builds a CREATE FUNCTION statement at runtime, and the actor-binding guard " +
        "cannot read it as one complete literal — the definition is split across fragments, transformed " +
        "through format/concatenation/conditional logic, or not parseable on its own. Built that way, " +
        "the guard cannot tell whether the " +
        "function is SECURITY DEFINER, mutates, accepts a caller-supplied actor, and raises " +
        "ACTOR_MISMATCH. Build the dynamic DDL as a single string literal, or add the file-level " +
        "exempt marker (-- actor-binding-check: exempt) and get a manual review."
      );
      return true;
    };

    while (i < to) {
      const ch = masked[i];
      if (ch === ";") {
        if (verdict(i)) return true;
        stmtStart = i + 1;
        lits = [];
        hasProceduralContainer = false;
        i++;
        continue;
      }
      let start = -1;
      let end = -1;
      let innerFrom = -1;
      let innerTo = -1;
      let isProceduralContainer = false;
      if (ch === "'" || ch === '"') {
        start = i;
        isProceduralContainer = ch === "'" &&
          isProceduralContainerPrefix(masked.slice(stmtStart, start), true);
        end = scanQuoted(masked, i);
        if (isProceduralContainer && end !== -1) {
          innerFrom = i + 1;
          innerTo = end - 1;
        }
      } else {
        const tag = ch === "$" ? dollarTagAt(masked, i) : null;
        if (tag) {
          const close = masked.indexOf(tag, i + tag.length);
          if (close !== -1) {
            start = i;
            end = close + tag.length;
            innerFrom = i + tag.length;
            innerTo = close;
            isProceduralContainer = isProceduralContainerPrefix(masked.slice(stmtStart, start));
          }
        }
      }
      if (end === -1 || start === -1) { i++; continue; }
      if (innerFrom !== -1 && checkDynamicDdl(innerFrom, innerTo)) return true;
      // DO/AS dollar bodies are procedural containers, not literals supplied
      // to a runtime SQL builder. Their contents were just checked recursively;
      // counting the container itself would turn `DO $do$ EXECUTE '...' $do$`
      // into a fake one-literal dynamic statement with skeleton `DO <literal>`.
      if (innerFrom !== -1 && isProceduralContainer) {
        hasProceduralContainer = true;
        i = end;
        continue;
      }
      lits.push({
        start,
        end,
        payload: innerFrom !== -1
          ? content.slice(innerFrom, innerTo)
          : content.slice(start + 1, end - 1),
      });
      i = end;
    }
    return verdict(to);
  }

  if (masked !== null) checkDynamicDdl(0, masked.length);
  let head;
  while (masked !== null && (head = fnHeadRe.exec(masked)) !== null) {
    const fnName = head[1];
    const paramsOpen = fnHeadRe.lastIndex - 1;
    const parsed = readBalancedParens(masked, paramsOpen);
    if (!parsed) {
      violations.push(
        `Function ${fnName}: could not parse its parameter list (unbalanced parentheses, ` +
        `unterminated string/comment/dollar-quote?) — the actor-binding guard cannot inspect it. ` +
        `Simplify the signature, or if it is genuinely valid SQL the lexer mishandles, add the ` +
        `exempt marker and get a manual review.`
      );
      break;
    }
    const rest = readAttrsAndBody(masked, parsed.end);
    if (!rest) {
      violations.push(
        `Function ${fnName}: could not parse its AS $tag$...$tag$ body — the actor-binding guard ` +
        `cannot verify its SECURITY DEFINER attributes or actor binding. Simplify the definition, ` +
        `or if it is genuinely valid SQL the lexer mishandles, add the exempt marker and get a ` +
        `manual review.`
      );
      break;
    }
    const params = content.slice(paramsOpen + 1, parsed.end - 1);
    const maskedParams = parsed.params;
    const attrs = rest.attrs;
    const body = content.slice(rest.bodyStart, rest.bodyEnd);
    const maskedBody = masked.slice(rest.bodyStart, rest.bodyEnd);
    // Do not jump past this definition: maskSqlNoise deliberately exposes
    // executable CREATE FUNCTION definitions nested in this body. Continuing
    // from the current regex position lets the next iteration inspect those
    // definitions independently instead of trusting the outer function's result.

    // Only SECURITY DEFINER functions can forge an actor with the owner's rights.
    if (!/SECURITY\s+DEFINER/i.test(attrs)) continue;

    // Static mutation keywords are readable after full noise masking. Also scan
    // the comment-only mask so executable strings passed to APIs such as
    // cron.schedule remain visible. This intentionally accepts false positives:
    // if a definer function with a forgeable actor parameter contains mutation
    // text anywhere outside a comment, it must bind the actor or use exemption.
    const commentBlankedBody = blankComments(body);
    const hasMutation = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(maskedBody) ||
      /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(commentBlankedBody) ||
      /\bEXECUTE\b/i.test(maskedBody);
    if (!hasMutation) continue;

    const actorParams = splitTopLevelArgs(maskedParams, blankComments(params))
      .map(paramName)
      .filter((n) => ACTOR_PARAM_RE.test(n));
    if (actorParams.length === 0) continue;

    if (/ACTOR_MISMATCH/i.test(commentBlankedBody)) continue;

    violations.push(
      `Function ${fnName}: SECURITY DEFINER, mutates or executes dynamic SQL, and declares the forgeable actor parameter(s) ` +
      `[${actorParams.join(", ")}] but the body never raises ACTOR_MISMATCH — any authenticated caller ` +
      `can attribute the write to another user.`
    );
  }
} catch (err) {
  // FAIL-OPEN, but loud: a broken hook must never brick the session.
  process.stderr.write(`actor-binding-check.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

if (violations.length > 0) {
  out("block",
    "ACTOR BINDING VIOLATION: " + violations.join(" | ") +
    " A SECURITY DEFINER function that takes a caller-supplied actor id MUST bind it to auth.uid() " +
    "before using it: v_actor := auth.uid(); IF p_performed_by IS DISTINCT FROM v_actor THEN " +
    "RAISE EXCEPTION 'ACTOR_MISMATCH: ...'; END IF; -- and stamp every downstream actor column from " +
    "v_actor, not from the parameter. This is the link_blend_ticket_to_order class fixed by migration " +
    "20260617171500 (Gauntlet Section 1 HIGH, 2026-06-17); the live sweeps " +
    "scripts/db-invariant-sweeps/predicates/actor-forgery.sql and actor-forgery-fin-audit.sql catch it " +
    "only AFTER apply. If the parameter is genuinely not an actor (a lookup filter, or an internal _impl " +
    "whose public wrapper is already bound), add the marker " +
    "-- actor-binding-check: exempt near the top of the migration file and say why.");
}

out("allow");
