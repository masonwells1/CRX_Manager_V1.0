#!/usr/bin/env node
// Forgeable-actor binding guard for CRX Manager (write-time half of the
// actor-forgery / actor-forgery-fin-audit db-invariant sweeps).
//
// THE GAP THIS CLOSES
//   Two sweep predicates (predicates/actor-forgery.sql and
//   predicates/actor-forgery-fin-audit.sql) find SECURITY DEFINER routines that
//   trust a caller-supplied actor parameter — but they only run against the LIVE
//   catalog, i.e. AFTER the migration has been applied. Between writing the
//   migration and applying it there was no gate at all, so the forgery shipped
//   first and was detected second. This hook moves the same check to write time.
//
// WHAT IT BLOCKS
//   A migration file that CREATEs or REPLACEs a SECURITY DEFINER routine which
//     (a) declares an actor-shaped parameter — p_<something>by, p_actor*, p_user*
//         (e.g. p_performed_by, p_created_by, p_actor_id, p_user_id), AND
//     (b) MUTATES (INSERT / UPDATE / DELETE) in its body, AND
//     (c) never raises the canonical ACTOR_MISMATCH token.
//   Under SECURITY DEFINER the routine runs with the owner's privileges, so an
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
//   Both the actor parameter and any v_actor identity local must be declared
//   as uuid; custom types can overload equality and make the refusal lie.
//
// Escape hatch: the file-level marker comment
//   -- actor-binding-check: exempt
// skips the check. Use it ONLY for a body that never trusts the parameter as an
// actor (e.g. it is a filter on a lookup, or the function is an internal _impl
// called exclusively by an already-bound public wrapper) — and say which in the
// migration's header comment.
//
// Conservative by design, in both directions:
//   * A SECURITY INVOKER routine is never flagged FOR ACTOR BINDING (RLS still
//     applies to it). That is not the same as "never flagged": the file-level
//     checks below — unreadable/unparseable SQL, dynamic CREATE FUNCTION text
//     the reader cannot see as one literal, an ALTER that renames the
//     execute_sql_readonly or cron.job boundary, SQL handed to a callable not
//     proven data-only — refuse the whole migration regardless of any
//     routine's security mode, because they are about whether this reader can
//     see the definition at all.
//   * A routine whose body does not mutate at all is never flagged. It is NOT
//     true that "a routine with no reachable use of the actor is never
//     flagged": the mutation test scans the body text, not the actor's data
//     flow, so a definer routine that declares an actor parameter and mutates
//     ANY table — even one it never stamps the actor into — is flagged unless
//     it proves the refusal or uses the exempt marker. "Mutates"
//     is deliberately wider than INSERT/UPDATE/DELETE/MERGE, too: it also
//     covers EXECUTE and any hand-off of the actor across a boundary this
//     reader cannot see through — a call, an OPERATOR(...) or infix symbolic
//     operator, or a cast to a user-defined type, since all of those can run
//     caller-influenced code. So a read-only reporting function that merely
//     compares the parameter (`WHERE created_by = p_user_id`) IS flagged: `=`
//     is overloadable, and the reader cannot prove which operator resolves.
//     That is the accepted false-positive cost; clear it with the exempt
//     marker below, not by narrowing the operator rule.
//   * The canonical ACTOR_MISMATCH token remains the preferred guard. Legacy-main
//     refusals using `<actual actor parameter> does not match authenticated user`
//     count only when a real RAISE EXCEPTION is controlled by that parameter's
//     mismatch against auth.uid() (directly or through one stable local binding).

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
  const declaration = String(decl).trim().replace(/^(?:in|out|inout|variadic)\b\s*/i, "");
  const unicode = /^U&\s*"(?:[^"]|"")*"(?:\s+UESCAPE\s*'(?:[^']|'')*')?/i.exec(declaration);
  if (unicode) return unicode[0];
  return (declaration.split(/\s+/)[0] || "").replace(/^"|"$/g, "");
}

function paramMode(decl) {
  const first = String(decl).trim().split(/\s+/)[0] || "";
  return /^(in|out|inout|variadic)$/i.test(first) ? first.toLowerCase() : "in";
}

function isTrustedUuidParameterDeclaration(declaration, allowUnqualifiedUuid = true) {
  const normalized = normalizedRoutineIdentityArgs(declaration, true);
  return normalized === "pg_catalog.uuid" ||
    (allowUnqualifiedUuid && normalized === "uuid");
}

/** PostgreSQL lets routine bodies reference parameters by both their declared
 * name and their one-based positional alias ($1, $2, ...). PL/pgSQL positional
 * aliases follow full declaration order, including OUT parameters, even though
 * OUT-only values are not caller inputs and are skipped as actor candidates. */
function actorParameterDescriptors(maskedParams, rawParams, allowUnqualifiedUuid = true) {
  const declarations = splitTopLevelArgs(maskedParams, rawParams);
  const actors = [];
  for (const [index, declaration] of declarations.entries()) {
    const mode = paramMode(declaration);
    if (mode === "out") continue;
    const name = paramName(declaration);
    const opaqueUnicodeName = /^U&/i.test(name);
    if (!opaqueUnicodeName && !ACTOR_PARAM_RE.test(name)) continue;
    // PostgreSQL decodes U&\"...\" before name resolution. Rather than duplicate
    // that escape grammar and risk another lookalike bypass, conservatively
    // require every Unicode-named input on a mutating definer routine to prove
    // actor binding through its exact positional alias (or use exemption).
    const position = index + 1;
    const references = opaqueUnicodeName ? [`$${position}`] : [name, `$${position}`];
    actors.push({
      name,
      references,
      trustedUuid: isTrustedUuidParameterDeclaration(declaration, allowUnqualifiedUuid),
    });
  }
  return actors;
}

function escapedRegexLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
// Windows and macOS resolve paths case-insensitively, so `Supabase/Migrations/
// x.SQL` writes the SAME file in the SAME directory as the canonical spelling.
// Matching case-sensitively let a migration land in supabase/migrations/ with
// the guard skipping it entirely, which is a scope hole rather than a style
// preference. Compare case-insensitively; an out-of-scope path is still out of
// scope under either casing.
const scopePath = filePath.toLowerCase();
if (!filePath || !scopePath.endsWith(".sql") || !scopePath.includes("supabase/migrations/")) {
  out("allow");
}

function proposedFileContent(toolInput, targetPath) {
  if (typeof toolInput?.content === "string") return { content: toolInput.content };
  // Anything else reaching this point is a write to a migration whose resulting
  // bytes this reader cannot reconstruct — the settings matcher `Write|Edit` is
  // an unanchored regex, so a batched or future edit shape (an `edits` array,
  // say) arrives here with neither `content` nor `new_string`. Reconstructing
  // it as "" would silently allow the whole file. Fail closed instead.
  if (typeof toolInput?.new_string !== "string") {
    return { error: "this tool payload carries no readable file content or single old/new string pair" };
  }
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

// Locate each CREATE [OR REPLACE] FUNCTION/PROCEDURE header. The parameter list is then
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
// PostgreSQL's lexer needs NO whitespace between a keyword and a following
// double-quoted identifier: UPDATE"audit_log", INTO"v_actor", FOR"v_row",
// CREATE FUNCTION"public"."f"(...) and ALTER FUNCTION"public"."f"(...) are all
// legal and mean exactly what their spaced spellings mean. Every plain `\s+`
// sitting between a keyword and an IDENTIFIER position is therefore a hole
// rather than a separator — the abutting spelling slips past the pattern
// entirely and the construct becomes invisible to this reader. Use this gap for
// every keyword->identifier boundary on a DENY path. (Only `"` can abut: an
// unquoted name or U&"..." would fuse with the keyword into one identifier
// token, so those spellings still require real whitespace.)
const SQL_KEYWORD_IDENTIFIER_GAP = '(?:\\s+|\\s*(?="))';
// The mirror hole, in the other direction: a keyword may abut the CLOSING quote
// of a quoted identifier — ALTER TABLE"cron_job"RENAME TO x is legal — so a
// plain `\s+` between an IDENTIFIER position and a following keyword is a hole
// too. The lookbehind keeps this from splitting an unquoted identifier that
// merely ends in the keyword's letters.
const SQL_IDENTIFIER_KEYWORD_GAP = '(?:\\s+|(?<=")\\s*)';
// INTO / FOR / FOREACH accept a comma-separated list of assignment targets, and
// each target may be qualified by its block label. Reading the whole list (not
// just the first name) is what lets the reader correlate output expressions
// with the local that actually receives them.
const SQL_ASSIGNMENT_TARGET_LIST_PATTERN =
  `${SQL_QUALIFIED_IDENTIFIER_PATTERN}(?:\\s*,\\s*${SQL_QUALIFIED_IDENTIFIER_PATTERN})*`;
const routineHeadRe = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(FUNCTION|PROCEDURE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
    `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*\\(`,
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
    /\bCOPY\b[\s\S]*\bPROGRAM\b/i.test(stmt) ||
    /\bOPERATOR\s*\(/i.test(stmt) ||
    isPgCronCall(rawStmt) ||
    isPgCronCommandWrite(rawStmt);
}

/** A user-defined operator can be an alias for the reviewed SQL executor and
 * later receive text without looking like a callable. Refuse creation of that
 * alias at the identity boundary; future SQL can use the symbolic operator
 * spelling, which cannot be tied back to its procedure lexically. */
function hasExecuteSqlReadonlyOperatorAlias(structuralSql) {
  const sql = String(structuralSql || "");
  const executor =
    `(?:(?:"public"|public)\\s*\\.\\s*)?(?:"execute_sql_readonly"|execute_sql_readonly)`;
  const opaqueUnicodeExecutor =
    `(?:${SQL_UNICODE_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})?|` +
      `${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*${SQL_UNICODE_IDENTIFIER_PATTERN})`;
  return new RegExp(
    `\\bCREATE\\s+OPERATOR\\s+[^;]*?\\([^;]*?` +
      `\\b(?:FUNCTION|PROCEDURE)\\s*=\\s*(?:${executor}|${opaqueUnicodeExecutor})(?![\\w$])`,
    "i"
  ).test(sql);
}

/** Mask data strings and comments but retain quoted identifiers. The main SQL
 * mask deliberately blanks quoted identifiers so a name such as "EXECUTE"
 * cannot impersonate syntax. pg_cron's schema/API identity is the one place we
 * need the original identifier spelling, including "cron"."schedule".
 *
 * Alias discovery opts into executableSql so a direct EXECUTE literal can
 * create, rename, or move an updatable cron.job view without disappearing as
 * ordinary string data. Only procedural containers and the command literal
 * immediately supplied to EXECUTE are retained; documentation/data strings
 * remain masked. */
function maskSqlForCallNames(text, executableSql = false) {
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
      const payload = text.slice(i + 1, end - 1);
      const proceduralStringKind = executableSql ? proceduralSingleQuoteKind(out) : null;
      const isProceduralContainer = proceduralStringKind !== null;
      const isExecutable = executableSql && (isProceduralContainer ||
        /\bEXECUTE\s*(?:\(\s*)?$/i.test(out));
      if (isProceduralContainer && proceduralStringKind !== "plain") return null;
      if (isProceduralContainer && hasAdjacentNewlineString(text, end) !== false) return null;
      if (isExecutable) {
        // This alias-only mask does not need the contents of nested data
        // strings; it only preserves the executable relation structure.
        const inner = maskSqlForCallNames(payload, true);
        if (inner === null) return null;
        out += " " + inner + " ";
      } else {
        out += "'" + " ".repeat(end - i - 2) + "'";
      }
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
        const payload = text.slice(i + tag.length, close);
        const isProceduralContainer = executableSql && isProceduralContainerPrefix(out);
        const isExecutable = executableSql && (isProceduralContainer ||
          /\bEXECUTE\s*(?:\(\s*)?$/i.test(out));
        if (isExecutable) {
          const inner = maskSqlForCallNames(payload, true);
          if (inner === null) return null;
          // Dollar tags may legally contain `$`, which is also legal inside an
          // unquoted identifier. Blank the delimiters so `cron.job$view$`
          // cannot be misread as the source relation name.
          out += " ".repeat(tag.length) + inner + " ".repeat(tag.length);
        } else {
          out += tag + " ".repeat(end - i - (2 * tag.length)) + tag;
        }
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

/** Decode the payload from the direct-literal shape accepted above. Alias
 * discovery does not map offsets back to the outer migration, so standard SQL
 * doubled-quote decoding is safe here. */
function directSqlStringPayload(expression) {
  const sql = String(expression || "").trim();
  if (!isDirectSqlStringLiteral(sql)) return null;
  if (sql.startsWith("'")) return sql.slice(1, -1).replace(/''/g, "'");
  const tag = dollarTagAt(sql, 0);
  return tag === null ? null : sql.slice(tag.length, -tag.length);
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

function hasSchemaBeforeExplicitPgCatalog(structuralSql, statementOnly = false) {
  if (structuralSql === null || structuralSql === undefined) return false;
  const boundary = statementOnly ? "(?:^|;)\\s*" : "\\b";
  const searchPath = new RegExp(
    `${boundary}SET\\s+(?:LOCAL\\s+)?search_path\\s*(?:=|TO)\\s*([^;]+)`,
    "gi"
  );
  let match;
  while ((match = searchPath.exec(structuralSql)) !== null) {
    // Routine attributes can follow the path without a semicolon (`...,
    // pg_catalog AS $body$`). Locate pg_catalog inside the captured value
    // instead of requiring the final list item to consume the whole suffix.
    // `'pg_catalog'` (a single-quoted list item) is the spelling PostgreSQL's
    // own \df output and nearly every CRX migration uses. Accept it alongside
    // the bare and double-quoted forms; the caller must supply text in which
    // string literals are still readable for this branch to fire.
    const catalog = /(?:^|,)\s*(?:'pg_catalog'|"pg_catalog"|pg_catalog)(?=\s*(?:,|$|\b(?:AS|LANGUAGE|SECURITY|SET|RESET|CALLED|RETURNS|STRICT|IMMUTABLE|STABLE|VOLATILE|PARALLEL|COST|ROWS|SUPPORT)\b))/i
      .exec(match[1]);
    if (catalog && match[1].slice(0, catalog.index).trim() !== "") return true;
  }
  return false;
}

/** Bare `uuid` normally resolves to pg_catalog.uuid because PostgreSQL searches
 * pg_catalog first. A migration can defeat that guarantee by creating its own
 * uuid type/domain or by explicitly placing another schema before pg_catalog.
 * In either case, actor declarations and legacy local bindings must spell
 * pg_catalog.uuid so equality cannot dispatch through an attacker-controlled
 * type or operator. */
function hasUnqualifiedUuidShadowRisk(...structuralSqlVariants) {
  const typeHead = new RegExp(
    `\\bCREATE\\s+(?:DOMAIN|TYPE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:IF\\s+NOT\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?` +
      `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})(?![\\w$])`,
    "gi"
  );
  for (const structuralSql of structuralSqlVariants) {
    if (structuralSql === null || structuralSql === undefined) continue;
    let match;
    typeHead.lastIndex = 0;
    while ((match = typeHead.exec(structuralSql)) !== null) {
      const normalized = normalizedQualifiedIdentifier(match[1]);
      if (normalized === null || normalized.split(".").at(-1) === "uuid") return true;
    }
    if (hasSchemaBeforeExplicitPgCatalog(structuralSql, true)) return true;
  }
  return false;
}

function isPgCronJobName(identifier) {
  const normalized = normalizedQualifiedIdentifier(identifier);
  return normalized === "job" || normalized === "cron.job";
}

const UNKNOWN_PG_CRON_JOB_VIEW_ALIAS = Symbol("unknown-pg-cron-job-view-alias");

function aliasSetHas(aliases, normalized) {
  return aliases.has(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS) ||
    aliases.has(normalized) || aliases.has(normalized.split(".").at(-1));
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

/** Concatenate plain/dollar SQL string payloads for conservative keyword
 * detection. This is not execution or exact decoding: it only makes
 * `'CREATE ' || 'VIEW ...'` visible to the fail-closed lifecycle boundary. */
function joinedSqlStringPayloads(text) {
  const source = String(text || "");
  let payloads = "";
  for (let i = 0; i < source.length;) {
    if (source[i] === "'") {
      const end = scanQuoted(source, i);
      if (end === -1) return payloads + source.slice(i + 1);
      const payload = source.slice(i + 1, end - 1).replace(/''/g, "'");
      payloads += payload;
      if (/['$]/.test(payload)) payloads += joinedSqlStringPayloads(payload);
      i = end;
      continue;
    }
    const tag = source[i] === "$" ? dollarTagAt(source, i) : null;
    if (tag) {
      const close = source.indexOf(tag, i + tag.length);
      if (close === -1) return payloads + source.slice(i + tag.length);
      const payload = source.slice(i + tag.length, close);
      payloads += payload + joinedSqlStringPayloads(payload);
      i = close + tag.length;
      continue;
    }
    i++;
  }
  return payloads;
}

function hasPossiblePgCronViewLifecycle(sql, aliases) {
  const source = String(sql || "");
  const candidates = [source, joinedSqlStringPayloads(source)];
  const hasLifecycle = candidates.some((candidate) =>
    /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?VIEW|ALTER\s+(?:VIEW|TABLE))\b/i.test(candidate)
  );
  if (!hasLifecycle) return false;
  return candidates.some((candidate) => {
    if (/\bcron\s*\.\s*job\b/i.test(candidate) || /\bU&\s*"/i.test(candidate)) return true;
    const folded = candidate.toLowerCase();
    return [...aliases].some((alias) =>
      typeof alias === "string" && folded.includes(alias.toLowerCase())
    );
  });
}

/** If executable alias parsing is unreadable, distinguish an unrelated fancy
 * procedural body from one that may create or rename a persistent cron.job
 * alias. The latter gets the wildcard/manual-review identity rather than being
 * forgotten across later migrations. */
function hasPossibleOpaquePgCronViewLifecycle(sql, aliases) {
  return /\bEXECUTE\b/i.test(String(sql || "")) &&
    hasPossiblePgCronViewLifecycle(sql, aliases);
}

/** Find views declared by this migration whose query reads cron.job, including
 * later views layered over an earlier alias. PostgreSQL simple views are
 * updatable, so a write to such an alias changes cron.job.command even though
 * the lexical target no longer says cron.job. */
function declaredPgCronJobViewAliases(sql, seedAliases = new Set(), includeTemporaryViews = true) {
  const sourceSql = String(sql || "");
  const aliases = new Set(seedAliases);
  const staticStructural = maskSqlForCallNames(sourceSql);
  const executableStructural = maskSqlForCallNames(sourceSql, true);
  if (staticStructural === null) {
    if (hasPossibleOpaquePgCronViewLifecycle(sourceSql, aliases)) {
      aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
    }
    return aliases;
  }
  // An unrelated procedural body can be too fancy for the executable reader
  // without making static view discovery uncertain. The main SQL reader still
  // fails closed on such current-file code; historical alias discovery keeps
  // the proven static result instead of turning every relation into an alias.
  if (executableStructural === null &&
      hasPossibleOpaquePgCronViewLifecycle(sourceSql, aliases)) {
    aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
  }
  const structural = executableStructural ?? staticStructural;
  const viewHead = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(TEMP(?:ORARY)?)\\s+)?` +
    `(?:RECURSIVE\\s+)?VIEW${SQL_KEYWORD_IDENTIFIER_GAP}(${SQL_QUALIFIED_IDENTIFIER_PATTERN})`,
    "i"
  );
  const relationSource = new RegExp(
    `\\b(?:FROM|JOIN|TABLE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:ONLY${SQL_KEYWORD_IDENTIFIER_GAP})?(${SQL_QUALIFIED_IDENTIFIER_PATTERN})`,
    "gi"
  );
  const renameHead = new RegExp(
    `\\bALTER\\s+(?:VIEW|TABLE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
    `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?(?:ONLY${SQL_KEYWORD_IDENTIFIER_GAP})?` +
    `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})${SQL_IDENTIFIER_KEYWORD_GAP}RENAME\\s+TO` +
    `${SQL_KEYWORD_IDENTIFIER_GAP}(${SQL_IDENTIFIER_PATTERN})`,
    "i"
  );
  const declarations = [];
  const renames = [];
  for (const statement of structural.split(";")) {
    const head = viewHead.exec(statement);
    if (head && (includeTemporaryViews || !head[1])) {
      const alias = normalizedQualifiedIdentifier(head[2]);
      const sources = [];
      let hasOpaqueSource = false;
      relationSource.lastIndex = 0;
      let source;
      while ((source = relationSource.exec(statement)) !== null) {
        const normalized = normalizedQualifiedIdentifier(source[1]);
        if (normalized === null) hasOpaqueSource = true;
        else sources.push(normalized);
      }
      declarations.push({ alias, sources, hasOpaqueSource });
    }
    const rename = renameHead.exec(statement);
    if (rename) {
      const from = normalizedQualifiedIdentifier(rename[1]);
      const toBase = normalizedIdentifier(rename[2]);
      if (from !== null && toBase !== null) {
        const schemaPrefix = from.includes(".") ? from.slice(0, from.lastIndexOf(".") + 1) : "";
        renames.push({ from, to: schemaPrefix + toBase });
      } else renames.push({ from, to: null });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (declaration.alias !== null && aliasSetHas(aliases, declaration.alias)) continue;
      const reachesCronJob = declaration.hasOpaqueSource || declaration.sources.some((source) =>
        source === "job" || source === "cron.job" || aliasSetHas(aliases, source)
      );
      if (!reachesCronJob) continue;
      if (declaration.alias === null) {
        if (!aliases.has(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS)) {
          aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
          changed = true;
        }
        continue;
      }
      aliases.add(declaration.alias);
      aliases.add(declaration.alias.split(".").at(-1));
      changed = true;
    }
    for (const rename of renames) {
      if (rename.from === null) {
        if (!aliases.has(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS)) {
          aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
          changed = true;
        }
        continue;
      }
      if (!aliasSetHas(aliases, rename.from)) continue;
      if (rename.to === null) {
        if (!aliases.has(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS)) {
          aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
          changed = true;
        }
        continue;
      }
      if (aliasSetHas(aliases, rename.to)) continue;
      aliases.add(rename.to);
      aliases.add(rename.to.split(".").at(-1));
      changed = true;
    }
  }

  // pg_cron can execute the command after this migration returns. A persistent
  // view created by that delayed command is therefore part of the historical
  // alias lifecycle, while a TEMP view remains session-local to the cron run.
  const delayedCommands = pgCronCommandLiteralPayloads(sourceSql, true);
  if (delayedCommands.length > 0) {
    const delayedAliases = declaredPgCronJobViewAliases(
      delayedCommands.join(";\n"), aliases, false
    );
    for (const alias of delayedAliases) aliases.add(alias);
  }
  if (hasOpaquePgCronCallCommand(sourceSql, true) &&
      hasPossiblePgCronViewLifecycle(sourceSql, aliases)) {
    aliases.add(UNKNOWN_PG_CRON_JOB_VIEW_ALIAS);
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
function pgCronCallSites(rawStmt, executableSql = false) {
  const raw = String(rawStmt || "");
  const callableSql = maskSqlForCallNames(raw, executableSql);
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
      if (new RegExp(
        `\\b(?:INSERT\\s+INTO|COPY)${SQL_KEYWORD_IDENTIFIER_GAP}` +
          `(?:"cron"|cron)\\s*\\.\\s*(?:"job"|job)\\s*$`,
        "i"
      ).test(callableSql.slice(0, open))) continue;
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

function genericNamedArgumentValue(argument) {
  const masked = maskSqlForCallNames(String(argument || ""));
  if (masked === null) return null;
  const named = new RegExp(
    `^\\s*${SQL_IDENTIFIER_PATTERN}\\s*(?:=>|:=)\\s*`, "i"
  ).exec(masked);
  return named ? String(argument).slice(named[0].length) : String(argument);
}

/** Return every direct command literal stored by a pg_cron call. The positional
 * indexes follow PostgreSQL's supported APIs and still work when later
 * arguments switch to named notation. Unknown/Unicode APIs conservatively scan
 * every direct literal value because any of them may be command-bearing. */
function pgCronCommandLiteralPayloads(rawStmt, executableSql = false) {
  const payloads = [];
  const noCommandApis = new Set(["unschedule"]);
  for (const site of pgCronCallSites(rawStmt, executableSql)) {
    if (site.args === null || noCommandApis.has(site.api)) continue;
    const args = site.args;
    const namedCommand = args.map((arg) => namedArgumentValue(arg, "command"))
      .find((value) => value !== null);
    if (namedCommand !== undefined) {
      const payload = directSqlStringPayload(namedCommand);
      if (payload !== null) payloads.push(payload);
      continue;
    }

    let command = null;
    if (site.api === "alter_job") {
      if (args.length >= 3 && !/(?:=>|:=)/.test(maskSqlForCallNames(args[2]) || "")) {
        command = args[2];
      }
    } else if (site.api === "schedule") {
      const index = args.length >= 3 ? 2 : 1;
      if (args[index] !== undefined &&
          !/(?:=>|:=)/.test(maskSqlForCallNames(args[index]) || "")) {
        command = args[index];
      }
    } else if (site.api === "schedule_in_database") {
      if (args.length >= 3 && !/(?:=>|:=)/.test(maskSqlForCallNames(args[2]) || "")) {
        command = args[2];
      }
    } else {
      for (const arg of args) {
        const value = genericNamedArgumentValue(arg);
        const payload = value === null ? null : directSqlStringPayload(value);
        if (payload !== null) payloads.push(payload);
      }
    }
    const payload = command === null ? null : directSqlStringPayload(command);
    if (payload !== null) payloads.push(payload);
  }
  return payloads;
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
function hasOpaquePgCronCallCommand(rawStmt, executableSql = false) {
  const noCommandApis = new Set(["unschedule"]);
  for (const site of pgCronCallSites(rawStmt, executableSql)) {
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
    `(?:^|[^\\w$.\"])(?:INSERT\\s+INTO)${SQL_KEYWORD_IDENTIFIER_GAP}${jobTable}\\s*`,
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
    ["INSERT", new RegExp(
      `${writeBoundary}INSERT\\s+INTO${SQL_KEYWORD_IDENTIFIER_GAP}${relation}${suffix}`, "gi")],
    ["MERGE", new RegExp(
      `${writeBoundary}MERGE\\s+INTO${SQL_KEYWORD_IDENTIFIER_GAP}${relation}${suffix}`, "gi")],
    ["UPDATE", new RegExp(
      `${writeBoundary}UPDATE${SQL_KEYWORD_IDENTIFIER_GAP}` +
        `(?:ONLY${SQL_KEYWORD_IDENTIFIER_GAP})?${relation}${suffix}`, "gi")],
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
  // A view can rename cron.job.command (for example, `command AS payload`).
  // Treat every tracked-view UPDATE as a command write unless the later direct
  // assignment checks can prove the canonical command column is inspectable.
  if (sites.some((site) => site.viewAlias || site.kind !== "UPDATE")) return true;
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
  const directRoutinePrivilege =
    /^(?:GRANT|REVOKE)(?:\s+GRANT\s+OPTION\s+FOR)?\s+EXECUTE\s+ON\s+(?:(?:FUNCTION|PROCEDURE|ROUTINE)\b|ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES)\s+IN\s+SCHEMA\b)/i;
  const defaultRoutinePrivilege =
    /^ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\b(?:GRANT|REVOKE)(?:\s+GRANT\s+OPTION\s+FOR)?\s+EXECUTE\s+ON\s+(?:FUNCTIONS|ROUTINES)\b/i;
  const isPrivilegeHead = directRoutinePrivilege.test(sql) || defaultRoutinePrivilege.test(sql);
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

const CREATE_ROUTINE_HEAD_RE = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
    `${SQL_QUALIFIED_IDENTIFIER_PATTERN}\\s*\\(`,
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

function identifierReferencePattern(name) {
  const value = String(name || "");
  const quoted = `"${value.replace(/"/g, '""')}"`;
  const quotedPattern = escapedRegexLiteral(quoted);
  if (!/^[A-Za-z_][\w$]*$/.test(value)) return quotedPattern;
  return `(?:(?<![\\w$])${escapedRegexLiteral(value)}(?![\\w$])|${quotedPattern})`;
}

function actorReferencePattern(reference) {
  const value = String(reference || "");
  if (/^\$\d+$/.test(value)) {
    return `${escapedRegexLiteral(value)}(?!\\d)`;
  }
  const qualified = value.split(".");
  if (qualified.length > 1 && qualified.every((part) => /^[A-Za-z_][\w$]*$/.test(part))) {
    return qualified.map(identifierReferencePattern).join("\\s*\\.\\s*");
  }
  return identifierReferencePattern(value);
}

/** Read only PL/pgSQL's query/cursor INTO assignment lists. This deliberately
 * stays inside the capped guard's existing target grammar: it does not attempt
 * general SQL parsing or follow values through locals. The bounded repair is
 * that every target in a recognized SELECT/RETURNING/FETCH/EXECUTE list is
 * inspected instead of only the first one. */
function intoAssignmentTargetLists(structuralBody) {
  const targetLists = [];
  // A PL/pgSQL parameter may also be assigned through its positional alias
  // (`$1`). Keep that spelling local to this rebinding check: the broader
  // laundering analysis intentionally retains its pre-existing identifier-only
  // target grammar under the best-effort cap.
  const rebindingTarget = `(?:${SQL_QUALIFIED_IDENTIFIER_PATTERN}|\\$\\d+)`;
  const rebindingTargetList = `${rebindingTarget}(?:\\s*,\\s*${rebindingTarget})*`;
  const patterns = [
    new RegExp(
      `\\b(?:SELECT|RETURNING)\\b[^;]*?\\bINTO${SQL_KEYWORD_IDENTIFIER_GAP}` +
        `(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?(${rebindingTargetList})`,
      "gi"
    ),
    new RegExp(
      `\\bFETCH\\b[^;]*?\\bINTO${SQL_KEYWORD_IDENTIFIER_GAP}` +
        `(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?(${rebindingTargetList})`,
      "gi"
    ),
    new RegExp(
      `\\bEXECUTE\\b[^;]*?\\bINTO${SQL_KEYWORD_IDENTIFIER_GAP}` +
        `(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?(${rebindingTargetList})`,
      "gi"
    ),
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(structuralBody)) !== null) targetLists.push(match[1]);
  }
  return targetLists;
}

function hasIntoAssignmentTarget(structuralBody, targetPattern) {
  const exactTarget = new RegExp(`^\\s*${targetPattern}\\s*$`, "i");
  return intoAssignmentTargetLists(structuralBody).some((rawList) => {
    const targets = splitTopLevelCommaList(rawList);
    // The recognized target grammar should always balance. If a future change
    // breaks that invariant, refuse rather than silently restoring first-only
    // coverage.
    return targets === null || targets.some((target) => exactTarget.test(target));
  });
}

/** A legacy guard may compare the actor parameter to a local v_actor-style
 * binding, but only when that local is initialized unconditionally from
 * auth.uid() exactly once and is not overwritten through assignment,
 * SELECT ... INTO, or GET [STACKED] DIAGNOSTICS. */
function stableAuthUidBindings(structuralBody, beforeIndex, allowUnqualifiedUuid = true) {
  const prefix = structuralBody.slice(0, beforeIndex);
  const bindings = new Set();
  const controlBody = blankQuotedControlIdentifiers(structuralBody);
  if (controlBody === null) return bindings;
  const outerBegin = /\bBEGIN\b/i.exec(controlBody);
  if (!outerBegin) return bindings;
  const hasOuterDeclare = /^\s*DECLARE\b/i.test(controlBody.slice(0, outerBegin.index));
  const bindingRe = new RegExp(
    `(?:^|[;\\n]|\\bDECLARE\\b)\\s*` +
      `(?!(?:DECLARE|BEGIN|IF|THEN|ELSE|LOOP|CASE|END)\\b)([A-Za-z_][\\w$]*)` +
      `(?:\\s+[^;\\n:=]+?)?\\s*:=\\s*auth\\s*\\.\\s*uid\\s*\\(\\s*\\)\\s*;`,
    "gi"
  );
  let match;
  while ((match = bindingRe.exec(prefix)) !== null) {
    const isOuterDeclarationInitializer = hasOuterDeclare && match.index < outerBegin.index;
    const isTopLevelBodyAssignment = match.index >= outerBegin.index &&
      isTopLevelPlpgsqlStatement(controlBody, match.index);
    if (!isOuterDeclarationInitializer && !isTopLevelBodyAssignment) continue;
    const name = match[1];
    const ref = identifierReferencePattern(name);
    const uuidType = allowUnqualifiedUuid
      ? `(?:pg_catalog\\s*\\.\\s*)?uuid`
      : `pg_catalog\\s*\\.\\s*uuid`;
    const declarationRe = new RegExp(
      `(?:^|;|\\bDECLARE\\b)\\s*${ref}\\s+` +
        `${uuidType}\\b(?:\\s+NOT\\s+NULL)?\\s*` +
        `(?=;|:=|=(?!=)|DEFAULT\\b)`,
      "i"
    );
    if (!declarationRe.test(structuralBody.slice(0, outerBegin.index))) continue;
    // PL/pgSQL permits a local to be qualified by its function/block label,
    // and that label follows the full PostgreSQL identifier grammar. Treat
    // quoted and Unicode-escaped qualifiers as assignments too; otherwise
    // `"fn".v_actor := ...` can overwrite the trusted auth.uid() binding while
    // evading the reassignment count.
    const optionalBlockQualifier = `(?:${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*)?`;
    const assignmentRe = new RegExp(
      `(?:^|[;\\n]|\\bDECLARE\\b)\\s*${optionalBlockQualifier}${ref}` +
        `(?:\\s+[^;\\n:=]+?)?\\s*:=`,
      "gi"
    );
    const assignments = structuralBody.match(assignmentRe) || [];
    const equalsAssignmentRe = new RegExp(
      `(?:^|[;\\n]|\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b|\\bLOOP\\b)\\s*` +
        `${optionalBlockQualifier}${ref}\\s*=(?!=)`,
      "i"
    );
    const intoTarget = `${optionalBlockQualifier}${ref}`;
    const loopTargetRe = new RegExp(
      `\\b(?:FOR|FOREACH)\\b${SQL_KEYWORD_IDENTIFIER_GAP}[^;]*?${ref}[^;]*?\\bIN\\b`,
      "i"
    );
    // GET DIAGNOSTICS and GET STACKED DIAGNOSTICS assign their status items
    // into PL/pgSQL variables without using the ordinary assignment or INTO
    // forms above. In an exception handler, MESSAGE_TEXT can therefore launder
    // a caller-controlled UUID into a local that was initialized from
    // auth.uid(). Treat any diagnostics assignment to this trusted binding as
    // an overwrite, including function/block-qualified targets.
    const diagnosticsTargetRe = new RegExp(
      `\\bGET\\s+(?:(?:CURRENT|STACKED)\\s+)?DIAGNOSTICS\\b[^;]*?` +
        `${optionalBlockQualifier}${ref}\\s*(?::=|=(?!=))`,
      "i"
    );
    // PostgreSQL decodes U&"..." identifiers before resolving a PL/pgSQL
    // variable. This reader deliberately treats that spelling as opaque, so a
    // Unicode-escaped assignment target cannot preserve a trusted local bind.
    const opaqueUnicodeTarget =
      `(?:${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*)?${SQL_UNICODE_IDENTIFIER_PATTERN}`;
    const opaqueUnicodeAssignmentRe = new RegExp(
      `(?:^|[;\\n]|\\bDECLARE\\b|\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b|\\bLOOP\\b)\\s*` +
        `${opaqueUnicodeTarget}(?:\\s+[^;\\n:=]+?)?\\s*(?::=|=(?!=))`,
      "i"
    );
    const opaqueUnicodeLoopTargetRe = new RegExp(
      `\\b(?:FOR|FOREACH)\\b${SQL_KEYWORD_IDENTIFIER_GAP}${opaqueUnicodeTarget}[^;]*?\\bIN\\b`,
      "i"
    );
    const opaqueUnicodeDiagnosticsTargetRe = new RegExp(
      `\\bGET\\s+(?:(?:CURRENT|STACKED)\\s+)?DIAGNOSTICS\\b[^;]*?` +
        `${opaqueUnicodeTarget}\\s*(?::=|=(?!=))`,
      "i"
    );
    if (assignments.length === 1 &&
        !equalsAssignmentRe.test(structuralBody) &&
        !hasIntoAssignmentTarget(structuralBody, intoTarget) &&
        !loopTargetRe.test(structuralBody) &&
        !diagnosticsTargetRe.test(structuralBody) &&
        !opaqueUnicodeAssignmentRe.test(structuralBody) &&
        !hasIntoAssignmentTarget(structuralBody, opaqueUnicodeTarget) &&
        !opaqueUnicodeLoopTargetRe.test(structuralBody) &&
        !opaqueUnicodeDiagnosticsTargetRe.test(structuralBody)) {
      bindings.add(name);
    }
  }
  return bindings;
}

/** A compatible legacy guard must be an unconditional top-level statement in
 * the function's outer BEGIN block. An IF nested in a loop, CASE, or secondary
 * BEGIN may never run (or may sit inside an exception-handled sub-block). */
function blankQuotedControlIdentifiers(text) {
  const source = String(text || "");
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '"') {
      out += source[i];
      i++;
      continue;
    }
    const end = scanQuoted(source, i);
    if (end === -1) return null;
    out += " ".repeat(end - i);
    i = end;
  }
  return out;
}

function isTopLevelPlpgsqlStatement(controlBody, beforeIndex) {
  const prefix = controlBody.slice(0, beforeIndex);
  const tokenRe = /\bEND\s+IF\b|\bEND\s+LOOP\b|\bEND\s+CASE\b|\bBEGIN\b|\bEND\b|\bIF\b|\bLOOP\b|\bCASE\b/gi;
  let beginDepth = 0;
  let ifDepth = 0;
  let loopDepth = 0;
  let caseDepth = 0;
  let token;
  while ((token = tokenRe.exec(prefix)) !== null) {
    const keyword = token[0].toUpperCase().replace(/\s+/g, " ");
    if (keyword === "END IF") { ifDepth--; continue; }
    if (keyword === "END LOOP") { loopDepth--; continue; }
    if (keyword === "END CASE") { caseDepth--; continue; }
    if (keyword === "BEGIN") { beginDepth++; continue; }
    if (keyword === "IF") { ifDepth++; continue; }
    if (keyword === "LOOP") { loopDepth++; continue; }
    if (keyword === "CASE") { caseDepth++; continue; }
    if (keyword === "END") {
      // SQL CASE expressions close with bare END; nested PL/pgSQL blocks do too.
      if (caseDepth > 0) caseDepth--;
      else beginDepth--;
    }
    if (beginDepth < 0 || ifDepth < 0 || loopDepth < 0 || caseDepth < 0) return false;
  }
  return beginDepth === 1 && ifDepth === 0 && loopDepth === 0 && caseDepth === 0;
}

/** An exception handler catches an actor refusal only when it belongs to the
 * routine's outer BEGIN block. Nested handlers are ordinary local cleanup and
 * must not make an already-proven outer identity guard unreadable. */
function hasOuterExceptionHandler(controlBody) {
  const tokenRe = /\bEND\s+IF\b|\bEND\s+LOOP\b|\bEND\s+CASE\b|\bBEGIN\b|\bEND\b|\bIF\b|\bLOOP\b|\bCASE\b|\bEXCEPTION\s+WHEN\b/gi;
  let beginDepth = 0;
  let ifDepth = 0;
  let loopDepth = 0;
  let caseDepth = 0;
  let token;
  while ((token = tokenRe.exec(controlBody)) !== null) {
    const keyword = token[0].toUpperCase().replace(/\s+/g, " ");
    if (keyword === "BEGIN") { beginDepth++; continue; }
    if (keyword === "END IF") { ifDepth--; continue; }
    if (keyword === "END LOOP") { loopDepth--; continue; }
    if (keyword === "END CASE") { caseDepth--; continue; }
    if (keyword === "IF") { ifDepth++; continue; }
    if (keyword === "LOOP") { loopDepth++; continue; }
    if (keyword === "CASE") { caseDepth++; continue; }
    if (keyword === "EXCEPTION WHEN" && beginDepth === 1 && ifDepth === 0 && loopDepth === 0 && caseDepth === 0) return true;
    if (keyword === "END") {
      if (caseDepth > 0) caseDepth--;
      else beginDepth--;
    }
    if (beginDepth < 0 || ifDepth < 0 || loopDepth < 0 || caseDepth < 0) return true;
  }
  return false;
}

function hasRecognizedMutationBefore(structuralBody, beforeIndex, actorReferences = []) {
  const prefix = structuralBody.slice(0, beforeIndex);
  const forwardingReferences = actorForwardingReferences(prefix, actorReferences);
  if (hasActorCallableForwarding(prefix, forwardingReferences) ||
      hasActorOperatorForwarding(prefix, forwardingReferences) ||
      hasActorSymbolicOperatorForwarding(prefix, forwardingReferences)) return true;
  // A pre-guard control-flow exit can skip the identity check after evaluating
  // a side-effecting expression (for example RETURN helper(p_performed_by)).
  // Treat exits as disqualifying rather than trying to prove expressions pure.
  // Quoted identifiers must remain visible to the callable scan above, while
  // quoted keyword-like names must not impersonate control-flow syntax here.
  const controlPrefix = blankQuotedControlIdentifiers(prefix);
  if (controlPrefix === null) return true;
  return new RegExp(
    `\\b(?:INSERT\\s+INTO|UPDATE${SQL_KEYWORD_IDENTIFIER_GAP}|DELETE\\s+FROM|MERGE\\s+INTO|` +
      `TRUNCATE\\b|EXECUTE\\b|CALL\\b|PERFORM\\b|RETURN\\b|EXIT\\b|CONTINUE\\b)`,
    "i"
  ).test(controlPrefix);
}

function hasExactLegacyMismatchCondition(condition, actorParam, identityBindings) {
  const actor = actorReferencePattern(actorParam);
  // A nullable actor may deliberately be omitted by established callers. The
  // plain `<>` form is safe only when the same top-level condition first proves
  // the parameter non-null; without that prefix it remains null-unsafe and is
  // refused by this exact-condition parser.
  const distinctOperator = "IS\\s+DISTINCT\\s+FROM";
  const identities = [
    "auth\\s*\\.\\s*uid\\s*\\(\\s*\\)",
    ...Array.from(identityBindings, identifierReferencePattern),
  ];
  return identities.some((identity) => {
    const distinctMismatch = `(?:${actor}\\s*${distinctOperator}\\s*${identity}|` +
      `${identity}\\s*${distinctOperator}\\s*${actor})`;
    const explicitNullableMismatch = `(?:${actor}\\s*<>\\s*${identity}|` +
      `${identity}\\s*<>\\s*${actor})`;
    const optionalNullCheck = new RegExp(
      `^\\s*(?:${actor}\\s+IS\\s+NOT\\s+NULL\\s+AND\\s+)?${distinctMismatch}\\s*$`,
      "i"
    );
    const requiredNullCheck = new RegExp(
      `^\\s*${actor}\\s+IS\\s+NOT\\s+NULL\\s+AND\\s+${explicitNullableMismatch}\\s*$`,
      "i"
    );
    return optionalNullCheck.test(condition) || requiredNullCheck.test(condition);
  });
}

function hasActorMismatchRaiseException(rawAction, structuralAction, actorParam) {
  const phrase = new RegExp(
    `(?:^|[^\\w$])${escapedRegexLiteral(actorParam)}` +
      `\\s+does\\s+not\\s+match\\s+authenticated\\s+user\\b`,
    "i"
  );
  const raiseRe = /\bRAISE\s+EXCEPTION\b/gi;
  let raise;
  while ((raise = raiseRe.exec(structuralAction)) !== null) {
    const statementEnd = structuralAction.indexOf(";", raise.index);
    if (statementEnd === -1) continue;
    if (structuralAction.slice(0, raise.index).trim() !== "" ||
        structuralAction.slice(statementEnd + 1).trim() !== "") continue;
    const rawStatement = blankComments(rawAction.slice(raise.index, statementEnd));
    if (/ACTOR_MISMATCH/i.test(rawStatement) || phrase.test(rawStatement)) return true;
  }
  return false;
}

/** The refusal proof is about a NAME, but a PL/pgSQL parameter is an ordinary
 * mutable local: `p_performed_by := p_target_id;` after a passing guard makes
 * every downstream stamp of that name carry a value auth.uid() never approved.
 * The guard would still read as "bound" while the routine forges attribution.
 * So a recognized refusal only establishes identity when the actor name is
 * never re-bound anywhere in the routine. These are the same overwrite shapes
 * stableAuthUidBindings() refuses for a trusted auth.uid() local, applied in
 * the opposite direction: assignment (:= and PL/pgSQL's `=` spelling),
 * SELECT/FETCH ... INTO, a FOR/FOREACH loop target, and GET [STACKED]
 * DIAGNOSTICS. A routine that genuinely needs to reassign its actor parameter
 * uses the file-level exempt marker and a manual review. */
function hasActorReferenceRebinding(structuralBody, actorReferences) {
  const blockQualifier = `(?:${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*)?`;
  // PostgreSQL decodes U&"..." before resolving a PL/pgSQL assignment target.
  // This guard intentionally does not duplicate that escape grammar, so any
  // opaque Unicode target in a recognized INTO list could be the guarded actor
  // under another spelling. Fail closed for this bounded assignment surface.
  const opaqueUnicodeTarget =
    `(?:${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*)?${SQL_UNICODE_IDENTIFIER_PATTERN}`;
  if (hasIntoAssignmentTarget(structuralBody, opaqueUnicodeTarget)) return true;
  for (const reference of actorReferences) {
    const ref = actorReferencePattern(reference);
    if (hasIntoAssignmentTarget(structuralBody, `${blockQualifier}${ref}`)) return true;
    const rebindings = [
      new RegExp(
        `(?:^|[;\\n]|\\bDECLARE\\b|\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b|\\bLOOP\\b)\\s*` +
          `${blockQualifier}${ref}(?:\\s+[^;\\n:=]+?)?\\s*(?::=|=(?!=))`,
        "i"
      ),
      new RegExp(
        `\\b(?:FOR|FOREACH)\\b${SQL_KEYWORD_IDENTIFIER_GAP}[^;]*?${ref}[^;]*?\\bIN\\b`,
        "i"
      ),
      new RegExp(
        `\\bGET\\s+(?:(?:CURRENT|STACKED)\\s+)?DIAGNOSTICS\\b[^;]*?` +
          `${blockQualifier}${ref}\\s*(?::=|=(?!=))`,
        "i"
      ),
    ];
    if (rebindings.some((rebinding) => rebinding.test(structuralBody))) return true;
  }
  return false;
}

/** Each forgeable actor parameter needs its own unconditional, reviewable
 * auth.uid()-identity refusal. A bare ACTOR_MISMATCH token is not sufficient:
 * one parameter can be guarded while a second parameter is written downstream.
 * The established CRX legacy phrase remains compatible, but only inside the
 * same simple IF mismatch THEN RAISE EXCEPTION shape. */
function hasEnforcedActorRefusal(
  body,
  actorParam,
  actorReferences = [actorParam],
  trustedUuid = false,
  allowUnqualifiedUuid = true
) {
  // IS DISTINCT FROM and <> dispatch through PostgreSQL equality operators.
  // A custom actor type can overload equality and claim a forged identity is
  // authentic, so only a catalog-UUID actor can establish this refusal.
  if (!trustedUuid) return false;
  const structuralBody = maskSqlForCallNames(body);
  if (structuralBody === null) return false;
  // maskSqlForCallNames deliberately preserves quoted identifiers for relation
  // parsing. They are data to every control-flow read below: an alias named
  // "END LOOP" must not pop a real loop frame or seed a fake IF match.
  const controlBody = blankQuotedControlIdentifiers(structuralBody);
  if (controlBody === null) return false;
  // Only an outer handler can catch the top-level actor refusal. Nested handlers
  // are scoped to their own blocks and cannot bypass the already-run guard.
  if (hasOuterExceptionHandler(controlBody)) return false;
  // A refusal that guards a name the routine later re-binds proves nothing.
  if (hasActorReferenceRebinding(structuralBody, actorReferences)) return false;
  const ifRe = /\bIF\b[\s\S]*?\bTHEN\b[\s\S]*?\bEND\s+IF\b/gi;
  let block;
  while ((block = ifRe.exec(controlBody)) !== null) {
    const then = /\bTHEN\b/i.exec(block[0]);
    const endIf = /\bEND\s+IF\b/i.exec(block[0]);
    if (!then || !endIf || endIf.index <= then.index) continue;
    const condition = structuralBody.slice(block.index + 2, block.index + then.index);
    const actionStart = block.index + then.index + then[0].length;
    const actionEnd = block.index + endIf.index;
    const bindings = stableAuthUidBindings(
      structuralBody,
      block.index,
      allowUnqualifiedUuid
    );
    if (!isTopLevelPlpgsqlStatement(controlBody, block.index)) continue;
    if (hasRecognizedMutationBefore(structuralBody, block.index, actorReferences)) continue;
    if (!actorReferences.some((reference) =>
      hasExactLegacyMismatchCondition(condition, reference, bindings)
    )) continue;
    if (hasActorMismatchRaiseException(
      body.slice(actionStart, actionEnd),
      structuralBody.slice(actionStart, actionEnd),
      actorParam
    )) return true;
  }
  return false;
}

function carriesRoutineHeader(payload) {
  return CREATE_ROUTINE_HEAD_RE.test(payload) ||
    CREATE_ROUTINE_HEAD_RE.test(blankComments(payload));
}

function carriesSecurityRelevantRoutineDdl(payload) {
  if (carriesRoutineHeader(payload)) return true;
  return /\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b[\s\S]*?\bSECURITY\s+DEFINER\b/i
    .test(blankComments(payload));
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
 * Treat a routine-bearing literal in that argument as executable SQL. Unicode
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
  "all", "any", "array", "as", "assert", "case", "cast", "elsif", "exists", "if", "in", "query",
  "raise", "return", "row", "select", "values", "when", "while",
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

function isNonCallableSqlParenContext(prefix, open) {
  const beforeOpen = prefix.slice(0, open);
  const match = new RegExp(`(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*$`, "i").exec(beforeOpen);
  if (!match) return false;
  return /\b(?:INTO|TABLE|VIEW|FUNCTION|PROCEDURE|AGGREGATE|TYPE|INDEX|TRIGGER|CONSTRAINT|WITH)\s*$/i
    .test(beforeOpen.slice(0, match.index));
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

/** A SECURITY DEFINER wrapper can pass a forged actor through any function
 * expression, not only CALL/PERFORM. At each actor reference, inspect every
 * still-open parenthesis and fail closed when one belongs to a callable name.
 * This covers SELECT helper(p_actor), assignment, RETURN, RETURN QUERY, and
 * nested/named-argument forms without treating control-flow parentheses as
 * calls. */
function hasActorCallableForwarding(structuralBody, actorParams) {
  for (const actorParam of actorParams) {
    const reference = new RegExp(actorReferencePattern(actorParam), "gi");
    let match;
    while ((match = reference.exec(structuralBody)) !== null) {
      const prefix = structuralBody.slice(0, match.index);
      for (const open of unmatchedOpenParens(prefix)) {
        const name = callableNameBeforeOpen(prefix, open);
        if (name === null || isNonCallableSqlParenContext(prefix, open)) continue;
        return true;
      }
    }
  }
  return false;
}

/** Explicit OPERATOR(schema.symbol) syntax invokes a user-defined function but
 * places an infix operand outside the operator's parentheses. Treat any tainted
 * actor reference in the same SQL statement as callable forwarding. */
function hasActorOperatorForwarding(structuralBody, actorParams) {
  const operator = /\bOPERATOR\s*\(/gi;
  let match;
  while ((match = operator.exec(structuralBody)) !== null) {
    const start = structuralBody.lastIndexOf(";", match.index) + 1;
    const nextSemicolon = structuralBody.indexOf(";", match.index);
    const end = nextSemicolon === -1 ? structuralBody.length : nextSemicolon;
    const statement = structuralBody.slice(start, end);
    if (actorParams.some((actorParam) =>
      new RegExp(actorReferencePattern(actorParam), "i").test(statement)
    )) return true;
  }
  return false;
}

const SQL_SYMBOLIC_OPERATOR_PATTERN = '[-+*/\\\\<>=~!@#%^&|`?]+';
const SQL_CAST_TYPE_PATTERN =
  `${SQL_QUALIFIED_IDENTIFIER_PATTERN}(?:\\s*\\([^;()]*\\))?(?:\\s*\\[\\s*\\])*`;

/** pg_catalog's own conversions are the only casts a caller cannot redefine.
 * Multi-word spellings (`double precision`, `character varying`, `timestamp
 * with time zone`) are captured by their first word, so the leading word is
 * listed here rather than the full type name. Anything not on this list —
 * including every schema-qualified name outside pg_catalog — is read as
 * user-defined and therefore callable. */
const BUILT_IN_SQL_CAST_TYPE_NAMES = new Set([
  "bigint", "bigserial", "bit", "bool", "boolean", "box", "bpchar", "bytea",
  "char", "character", "cid", "cidr", "circle", "date", "daterange", "decimal",
  "double", "float4", "float8", "inet", "int", "int2", "int4", "int4range",
  "int8", "int8range", "integer", "interval", "json", "jsonb", "jsonpath",
  "line", "lseg", "macaddr", "macaddr8", "money", "name", "numeric",
  "numrange", "oid", "path", "point", "polygon", "real", "record", "regclass",
  "regconfig", "regdictionary", "regnamespace", "regoper", "regoperator",
  "regproc", "regprocedure", "regrole", "regtype", "serial", "smallint",
  "smallserial", "text", "tid", "time", "timestamp", "timestamptz", "timetz",
  "tsquery", "tsrange", "tstzrange", "tsvector", "uuid", "varbit", "varchar",
  "void", "xid", "xml",
]);

function isBuiltInSqlCastTypeName(rawType) {
  const normalized = normalizedQualifiedIdentifier(
    String(rawType || "").replace(/\s*\([^)]*\)/g, "").replace(/(?:\s*\[\s*\])+\s*$/, "")
  );
  if (normalized === null) return false;
  const parts = normalized.split(".");
  if (parts.length > 2) return false;
  if (parts.length === 2 && parts[0] !== "pg_catalog") return false;
  return BUILT_IN_SQL_CAST_TYPE_NAMES.has(parts.at(-1) || "");
}

/** A cast to a user-defined type runs that type's cast function, or its input
 * function, with the caller-supplied actor as the argument — the same callable
 * boundary as helper(p_actor), just spelled as a conversion. Both PostgreSQL
 * spellings are covered: CAST(actor AS t) and actor::t, including chains and
 * the grouping/field/subscript syntax that can sit between them. */
function hasActorUserDefinedCastForwarding(structuralBody, actorParams) {
  for (const actorParam of actorParams) {
    const reference = new RegExp(actorReferencePattern(actorParam), "gi");
    let match;
    while ((match = reference.exec(structuralBody)) !== null) {
      const prefix = structuralBody.slice(0, match.index);
      for (const open of unmatchedOpenParens(prefix)) {
        if (!/\bCAST\s*$/i.test(prefix.slice(0, open))) continue;
        const parsed = readBalancedParens(structuralBody, open);
        if (!parsed) return true;
        const asType = new RegExp(`\\bAS\\s+(${SQL_CAST_TYPE_PATTERN})\\s*$`, "i")
          .exec(parsed.params);
        if (!asType || !isBuiltInSqlCastTypeName(asType[1])) return true;
      }
      let rest = structuralBody.slice(match.index + match[0].length);
      while (true) {
        const cast = new RegExp(`^\\s*::\\s*(${SQL_CAST_TYPE_PATTERN})`, "i").exec(rest);
        if (cast) {
          if (!isBuiltInSqlCastTypeName(cast[1])) return true;
          rest = rest.slice(cast[0].length);
          continue;
        }
        const transparent = new RegExp(`^\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN}`, "i").exec(rest) ||
          /^\s*\[[^;\]]*\]/.exec(rest) || /^\s*\)/.exec(rest);
        if (!transparent) break;
        rest = rest.slice(transparent[0].length);
      }
    }
  }
  return false;
}

function hasOpenCastContext(prefix) {
  return unmatchedOpenParens(prefix).some((open) =>
    /\bCAST\s*$/i.test(prefix.slice(0, open))
  );
}

/** Skip syntax that preserves the actor value while separating it from an
 * operator token. Grouping, CAST/::, field selection, and subscripting do not
 * make a caller-supplied actor safe. */
function afterTransparentActorExpression(prefix, suffix) {
  let rest = suffix;
  const openCast = hasOpenCastContext(prefix);
  while (true) {
    const castTail = openCast
      ? new RegExp(`^\\s+AS\\s+${SQL_CAST_TYPE_PATTERN}\\s*\\)`, "i").exec(rest)
      : null;
    const postgresCast = new RegExp(`^\\s*::\\s*${SQL_CAST_TYPE_PATTERN}`, "i").exec(rest);
    const field = new RegExp(`^\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN}`, "i").exec(rest);
    const subscript = /^\s*\[[^;\]]*\]/.exec(rest);
    const closeParen = /^\s*\)/.exec(rest);
    const transparent = castTail || postgresCast || field || subscript || closeParen;
    if (!transparent) return rest;
    rest = rest.slice(transparent[0].length);
  }
}

/** Ordinary infix syntax can invoke a user-defined PostgreSQL operator without
 * the explicit OPERATOR(schema.symbol) spelling. PostgreSQL permits custom
 * overloads even for comparison symbols such as `=`, so every symbolic
 * operator immediately adjacent to a tainted actor is a fail-closed callable
 * boundary unless the routine has the canonical actor-refusal proof. This also
 * covers prefix/postfix operators and local/$n aliases. */
function hasActorSymbolicOperatorForwarding(structuralBody, actorParams) {
  for (const actorParam of actorParams) {
    const reference = new RegExp(actorReferencePattern(actorParam), "gi");
    let match;
    while ((match = reference.exec(structuralBody)) !== null) {
      const prefix = structuralBody.slice(0, match.index);
      const suffix = structuralBody.slice(match.index + match[0].length);
      const before = prefix.match(new RegExp(
        `(${SQL_SYMBOLIC_OPERATOR_PATTERN})\\s*(?:(?:CAST\\s*)?\\(\\s*)*$`,
        "i"
      ));
      const after = afterTransparentActorExpression(prefix, suffix)
        .match(new RegExp(`^\\s*(${SQL_SYMBOLIC_OPERATOR_PATTERN})`));
      if ([before?.[1], after?.[1]].some(Boolean)) return true;
    }
  }
  return false;
}

/** Split a comma-separated PL/pgSQL list at top level. Grouping parens and
 * subscripts survive structural masking, so a bare `.split(",")` would tear
 * `coalesce(a, b)` into two operands and mis-correlate the assignment. Returns
 * null when the brackets do not balance, which makes the caller fail closed. */
function splitTopLevelCommaList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") { depth--; if (depth < 0) return null; }
    else if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

function assignmentTargetList(rawList) {
  const parts = splitTopLevelCommaList(rawList);
  if (parts === null) return [];
  return parts.map((part) => normalizedQualifiedIdentifier(part)).filter((t) => t !== null);
}

/** Record a laundering target. A qualified target also taints its ROOT: writing
 * `v_rec.actor` makes the whole `v_rec` composite carry the actor, and a later
 * `helper(v_rec)` forwards it without ever naming the field again. A block-label
 * qualifier (`blk.v_id`) taints the label too, which is over-broad and safe. */
function addForwardingTarget(references, target) {
  if (target === null) return false;
  let changed = false;
  for (const candidate of [target, target.split(".")[0]]) {
    if (references.has(candidate)) continue;
    references.add(candidate);
    changed = true;
  }
  return changed;
}

/** Enumerate every PL/pgSQL construct that copies query, cursor, loop, or
 * diagnostics output into locals, paired with the expressions that produce it.
 *
 * `sources === null` marks a producer whose value is NOT readable from the
 * statement itself — a cursor FETCH (the cursor was opened elsewhere) and
 * GET STACKED DIAGNOSTICS (the value arrives through a raised exception, which
 * a caller-supplied actor can reach via RAISE ... USING or a helper). Those
 * targets are tainted unconditionally, which is the fail-closed reading.
 *
 * `correlated` is true only when the output list and the target list have the
 * same length, so `SELECT 1, p_actor INTO v_dummy, v_id` taints v_id and not
 * v_dummy. When the lists cannot be lined up, ANY actor-bearing output taints
 * EVERY target. */
function intoAssignmentSites(structuralBody) {
  const sites = [];
  const push = (rawTargets, sources) => {
    const targets = assignmentTargetList(rawTargets);
    if (targets.length === 0) return;
    sites.push({
      targets,
      sources,
      correlated: sources !== null && sources.length === targets.length,
    });
  };
  const readSources = (rawSources) => {
    const parts = splitTopLevelCommaList(rawSources);
    return parts === null ? [rawSources] : parts;
  };

  // `SELECT <exprs> INTO [STRICT] <targets>` and the RETURNING form. INSERT's
  // own `INTO <table>` cannot match: this requires SELECT/RETURNING first and
  // never crosses a statement terminator.
  const postList = new RegExp(
    `\\b(?:SELECT|RETURNING)\\b([^;]*?)\\bINTO${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?(${SQL_ASSIGNMENT_TARGET_LIST_PATTERN})`,
    "gi"
  );
  // `SELECT INTO [STRICT] <targets> <exprs>` — PostgreSQL's older spelling,
  // where the target list precedes the output expressions.
  const preList = new RegExp(
    `\\bSELECT\\s+INTO${SQL_KEYWORD_IDENTIFIER_GAP}(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?` +
      `(${SQL_ASSIGNMENT_TARGET_LIST_PATTERN})\\s+([^;]*)`,
    "gi"
  );
  const fetchInto = new RegExp(
    `\\bFETCH\\b[^;]*?\\bINTO${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:STRICT${SQL_KEYWORD_IDENTIFIER_GAP})?(${SQL_ASSIGNMENT_TARGET_LIST_PATTERN})`,
    "gi"
  );
  // FOR/FOREACH bind their loop variables from the iterator expression. The
  // row is not positionally correlatable with the target list, so any
  // actor-bearing iterator taints every loop variable.
  const loopTargets = new RegExp(
    `\\b(?:FOR|FOREACH)${SQL_KEYWORD_IDENTIFIER_GAP}(${SQL_ASSIGNMENT_TARGET_LIST_PATTERN})\\s+` +
      `(?:SLICE\\s+\\d+\\s+)?\\bIN\\b([^;]*?)\\bLOOP\\b`,
    "gi"
  );
  const stackedDiagnostics = /\bGET\s+STACKED\s+DIAGNOSTICS\b([^;]*)/gi;

  let match;
  while ((match = postList.exec(structuralBody)) !== null) {
    push(match[2], readSources(match[1]));
  }
  while ((match = preList.exec(structuralBody)) !== null) {
    push(match[1], readSources(match[2]));
  }
  while ((match = fetchInto.exec(structuralBody)) !== null) {
    push(match[1], null);
  }
  while ((match = loopTargets.exec(structuralBody)) !== null) {
    const targets = assignmentTargetList(match[1]);
    if (targets.length > 0) sites.push({ targets, sources: [match[2]], correlated: false });
  }
  while ((match = stackedDiagnostics.exec(structuralBody)) !== null) {
    const items = new RegExp(
      `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*(?::=|=(?!=))`,
      "gi"
    );
    let item;
    while ((item = items.exec(match[1])) !== null) push(item[1], null);
  }
  return sites;
}

/** PostgreSQL decodes U&"..." before resolving a PL/pgSQL variable, and this
 * reader deliberately treats that spelling as opaque — normalizedQualifiedIdentifier
 * returns null for it, so such a target can never enter the taint set and every
 * later use of it is invisible. stableAuthUidBindings() already treats a U&
 * write as destroying a trusted binding; this is the same rule in the
 * propagation direction. A statement that writes an opaque target and mentions
 * a tainted actor cannot be proven not to launder it, so it fails closed. */
function hasOpaqueUnicodeActorLaundering(structuralBody, actorParams) {
  const target = `(?:${SQL_IDENTIFIER_PATTERN}\\s*\\.\\s*)?${SQL_UNICODE_IDENTIFIER_PATTERN}`;
  const writes = [
    new RegExp(
      `(?:^|[;\\n]|\\bDECLARE\\b|\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b|\\bLOOP\\b)\\s*` +
        `${target}(?:\\s+[^;\\n:=]+?)?\\s*(?::=|=(?!=))`,
      "i"
    ),
    new RegExp(`\\b(?:FOR|FOREACH)\\b${SQL_KEYWORD_IDENTIFIER_GAP}${target}[^;]*?\\bIN\\b`, "i"),
    new RegExp(
      `\\bGET\\s+(?:(?:CURRENT|STACKED)\\s+)?DIAGNOSTICS\\b[^;]*?${target}\\s*(?::=|=(?!=))`,
      "i"
    ),
  ];
  const actorRes = actorParams.map((p) => new RegExp(actorReferencePattern(p), "i"));
  for (const statement of structuralBody.split(";")) {
    if (!hasIntoAssignmentTarget(statement, target) &&
        !writes.some((write) => write.test(statement))) continue;
    if (actorRes.some((actor) => actor.test(statement))) return true;
  }
  return false;
}

/** Carry direct actor taint through the ordinary PL/pgSQL local-binding forms
 * that wrappers use before invoking helpers. The analysis is deliberately
 * monotonic: once a local receives an unbound actor in the routine, a later
 * overwrite does not make it trusted for this static guard. */
function actorForwardingReferences(structuralBody, actorParams) {
  const references = new Set(actorParams);
  const sites = intoAssignmentSites(structuralBody);
  for (const site of sites) {
    if (site.sources !== null) continue;
    for (const target of site.targets) addForwardingTarget(references, target);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of [...references]) {
      const sourceRef = actorReferencePattern(source);
      const patterns = [
        // The assigned expression runs to the statement terminator, NOT to the
        // end of the line: `v_id := CASE\n WHEN true THEN p_actor\n END;` is
        // one assignment, and stopping at the newline missed it entirely.
        new RegExp(
          `(?:^|[;\\n]|\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b)\\s*(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*` +
            `(?::=|=(?!=))\\s*[^;]*(?:${sourceRef})`,
          "gi"
        ),
        // `DECLARE` may sit on the same line as the first declaration, in which
        // case it is what the target group captures unless it is consumed here.
        new RegExp(
          `(?:^|[;\\n])\\s*(?:DECLARE\\s+)?(${SQL_IDENTIFIER_PATTERN})\\s+(?:CONSTANT\\s+)?[^;\\n:=]+?` +
            `(?::=|DEFAULT)\\s*[^;]*(?:${sourceRef})`,
          "gi"
        ),
        new RegExp(
          `(?:^|[;\\n])\\s*(${SQL_IDENTIFIER_PATTERN})\\s+ALIAS\\s+FOR${SQL_KEYWORD_IDENTIFIER_GAP}(?:${sourceRef})`,
          "gi"
        ),
        // A cursor carries the actor from where it is defined to wherever it is
        // consumed. Taint the cursor NAME so `FOR v_row IN c LOOP` -- whose
        // iterator never mentions the actor -- picks it up through the loop
        // rule. FETCH is already unconditional; this covers the bound-cursor
        // FOR loop and OPEN ... FOR.
        new RegExp(
          `(?:^|[;\\n])\\s*(?:DECLARE\\s+)?(${SQL_IDENTIFIER_PATTERN})\\s+(?:(?:NO\\s+)?SCROLL\\s+)?CURSOR\\b` +
            `\\s*(?:\\([^;)]*\\))?\\s*(?:IS|FOR)\\b[^;]*(?:${sourceRef})`,
          "gi"
        ),
        new RegExp(
          `\\bOPEN${SQL_KEYWORD_IDENTIFIER_GAP}(${SQL_IDENTIFIER_PATTERN})\\s*` +
            `(?:(?:NO\\s+)?SCROLL\\s+)?FOR\\b[^;]*(?:${sourceRef})`,
          "gi"
        ),
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(structuralBody)) !== null) {
          if (addForwardingTarget(references, normalizedQualifiedIdentifier(match[1]))) {
            changed = true;
          }
        }
      }
      const sourceRe = new RegExp(sourceRef, "i");
      for (const site of sites) {
        if (site.sources === null) continue;
        if (site.correlated) {
          site.targets.forEach((target, index) => {
            if (sourceRe.test(site.sources[index] || "") &&
                addForwardingTarget(references, target)) changed = true;
          });
        } else if (site.sources.some((expr) => sourceRe.test(expr))) {
          for (const target of site.targets) {
            if (addForwardingTarget(references, target)) changed = true;
          }
        }
      }
    }
  }
  return [...references];
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
    if (name === null || isNonCallableSqlParenContext(structural, open) ||
        isKnownSqlExecutorName(name) || !isPotentialSqlTextSinkName(name)) continue;
    const parsed = readBalancedParens(structural, open);
    if (!parsed) return true;
    const args = splitTopLevelArgs(
      parsed.params,
      rawStmt.slice(open + 1, parsed.end - 1)
    );
    if (args.some((arg) => {
      const maskedArg = maskSqlForCallNames(arg);
      if (maskedArg === null) return true;
      const named = /^\s*(?:"(?:[^"]|"")*"|[A-Za-z_]\w*)\s*(?:=>|:=)\s*/.exec(maskedArg);
      const value = named ? arg.slice(named[0].length) : arg;
      if (isDirectSqlStringLiteral(value)) return false;

      // Known scalar literals are visibly not SQL text. Every other indirect
      // value (column, variable, subquery, builder, cast, or Unicode form) is
      // opaque at an unproven SQL-text sink and requires manual review.
      const maskedValue = maskSqlForCallNames(value);
      if (maskedValue === null) return true;
      return !/^\s*(?:true|false|[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[-+]?\d+)?)\s*$/i
        .test(maskedValue);
    })) {
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
    `\\bALTER\\s+(?:FUNCTION|ROUTINE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
    `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?` +
    `${schema}${executor}\\s*\\([^;]*\\)\\s*${identityAction}`,
    "i"
  );
  const opaqueUnicode = new RegExp(
    `\\bALTER\\s+(?:FUNCTION|ROUTINE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
    `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?` +
    `(?:${SQL_QUALIFIED_IDENTIFIER_PATTERN})?${unicodeIdentifier}` +
    `(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN})?\\s*\\([^;]*\\)\\s*${identityAction}`,
    "i"
  );
  return exact.test(callableSql) || opaqueUnicode.test(callableSql);
}

/** cron.job.command is a delayed owner-executing SQL boundary. Renaming or
 * schema-moving the physical table, or renaming that column, makes subsequent
 * writes invisible to the name-bound reader. Refuse the identity change
 * itself instead of attempting to follow temporary names through arbitrary
 * SQL and later migration files. */
function hasPgCronJobIdentityChange(rawSql) {
  const callableSql = maskSqlForCallNames(String(rawSql || ""), true);
  if (callableSql === null) return false;
  const alterSchema = new RegExp(
    `\\bALTER\\s+SCHEMA${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?` +
      `(${SQL_IDENTIFIER_PATTERN})${SQL_IDENTIFIER_KEYWORD_GAP}RENAME\\s+TO` +
      `${SQL_KEYWORD_IDENTIFIER_GAP}(${SQL_IDENTIFIER_PATTERN})`,
    "gi"
  );
  let schemaMatch;
  while ((schemaMatch = alterSchema.exec(callableSql)) !== null) {
    const from = normalizedQualifiedIdentifier(schemaMatch[1]);
    const to = normalizedQualifiedIdentifier(schemaMatch[2]);
    // Unicode-escaped names are opaque until PostgreSQL decodes them. A rename
    // involving an opaque identity could move the canonical cron schema, so it
    // requires the explicit reviewed-exemption path.
    if (from === null || to === null || from === "cron" || to === "cron") return true;
  }
  const alterTable = new RegExp(
    `\\bALTER\\s+TABLE${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?(?:ONLY${SQL_KEYWORD_IDENTIFIER_GAP})?` +
      `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})(?:\\s*\\*)?${SQL_IDENTIFIER_KEYWORD_GAP}`,
    "gi"
  );
  let match;
  while ((match = alterTable.exec(callableSql)) !== null) {
    const target = normalizedQualifiedIdentifier(match[1]);
    const action = callableSql.slice(alterTable.lastIndex).split(";", 1)[0];
    const changesIdentity = new RegExp(
      `^\\s*(?:RENAME\\s+TO\\b|SET\\s+SCHEMA\\b|` +
        `RENAME\\s+(?:COLUMN\\s+)?` +
        `(?:"command"|command|${SQL_UNICODE_IDENTIFIER_PATTERN})\\s+TO\\b|` +
        `ALTER\\s+(?:COLUMN\\s+)?` +
        `(?:"command"|command|${SQL_UNICODE_IDENTIFIER_PATTERN})\\s+` +
        `(?:TYPE\\b|SET\\s+DATA\\s+TYPE\\b))`,
      "i"
    ).test(action);
    if (!changesIdentity) continue;
    // PostgreSQL decodes U&"..." identifiers before lookup. This reader does
    // not guess their decoded relation identity, so an identity-changing ALTER
    // with an opaque target requires the explicit manual-review path.
    if (target === null || target === "job" || target === "cron.job") return true;
  }
  return false;
}

let sawOpaqueRoutineCallable = false;

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
        const hasSecurityRelevantRoutineDdl = carriesSecurityRelevantRoutineDdl(payload);
        const isKnownSqlExecutor = hasSecurityRelevantRoutineDdl &&
          isExecuteSqlReadonlyLiteralPrefix(out);
        const callablePrefix = hasSecurityRelevantRoutineDdl
          ? maskSqlForCallNames(text.slice(0, i))
          : "";
        if (hasSecurityRelevantRoutineDdl && callablePrefix !== null &&
            hasUnprovenCallableContext(
              callablePrefix, out, text, close + tag.length
            )) {
          sawOpaqueRoutineCallable = true;
          return null;
        }
        const isExecutable = isProceduralContainer || /\bEXECUTE\s+$/i.test(out) ||
          isKnownSqlExecutor ||
          (inProceduralCode && hasSecurityRelevantRoutineDdl) ||
          (hasSecurityRelevantRoutineDdl && inExecuteStatement(out, text, close + tag.length));
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
      const hasSecurityRelevantRoutineDdl = carriesSecurityRelevantRoutineDdl(
        unicodePayload?.payload ?? payload
      );
      const isKnownSqlExecutor = ch === "'" && hasSecurityRelevantRoutineDdl &&
        isExecuteSqlReadonlyLiteralPrefix(out);
      const callablePrefix = ch === "'" && hasSecurityRelevantRoutineDdl
        ? maskSqlForCallNames(text.slice(0, i))
        : "";
      if (ch === "'" && hasSecurityRelevantRoutineDdl && callablePrefix !== null &&
          hasUnprovenCallableContext(callablePrefix, out, text, end)) {
        sawOpaqueRoutineCallable = true;
        return null;
      }
      const isDynamicSql = ch === "'" && (isProceduralContainer || isKnownSqlExecutor ||
        (hasSecurityRelevantRoutineDdl &&
          (inProceduralCode || inExecuteStatement(out, text, end))));
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
            // Exact source ranges of the same two attribute regions. The mask
            // blanks string CONTENTS, so `SET search_path TO 'evil',
            // 'pg_catalog'` reads as empty quotes there and the operator-
            // resolution check cannot see which schema comes first. The caller
            // re-slices these ranges out of the real source for that check.
            attrsRanges: [[fromIdx, i], [bodyEnd + tag.length, statementEnd]],
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

/** Return SECURITY DEFINER/INVOKER changes made by top-level ALTER statements.
 * The caller must supply a mask whose quoted/procedural bodies are blanked:
 * an ALTER stored in a routine body is deferred until that routine is called
 * and therefore cannot prove that a top-level CREATE finished as INVOKER.
 * PostgreSQL applies the last executed mode after CREATE, so looking only at
 * the CREATE attributes would still misclassify a real top-level demotion. */
function alteredRoutineSecurityModes(structuralSql) {
  const altered = [];
  const head = new RegExp(
    `\\bALTER\\s+(?:FUNCTION|PROCEDURE|ROUTINE)${SQL_KEYWORD_IDENTIFIER_GAP}` +
      `(?:IF\\s+EXISTS${SQL_KEYWORD_IDENTIFIER_GAP})?` +
      `(${SQL_QUALIFIED_IDENTIFIER_PATTERN})\\s*\\(`,
    "gi"
  );
  let match;
  while ((match = head.exec(structuralSql)) !== null) {
    const paramsOpen = head.lastIndex - 1;
    const parsed = readBalancedParens(structuralSql, paramsOpen);
    if (!parsed) {
      altered.push({ name: null, signature: null, mode: "DEFINER", index: match.index });
      break;
    }
    const terminator = structuralSql.indexOf(";", parsed.end);
    const statementEnd = terminator === -1 ? structuralSql.length : terminator;
    const actionList = structuralSql.slice(parsed.end, statementEnd);
    const securityModeRe = /\b(?:EXTERNAL\s+)?SECURITY\s+(DEFINER|INVOKER)\b/gi;
    let mode = null;
    let securityMode;
    while ((securityMode = securityModeRe.exec(actionList)) !== null) mode = securityMode;
    if (mode !== null) {
      altered.push({
        name: normalizedQualifiedIdentifier(match[1]),
        signature: normalizedRoutineIdentityArgs(parsed.params, false),
        mode: mode[1].toUpperCase(),
        index: match.index,
      });
    }
    head.lastIndex = terminator === -1 ? structuralSql.length : terminator + 1;
  }
  return altered;
}

/** A lexical "last ALTER wins" model is unsafe when the migration can roll a
 * later SECURITY INVOKER demotion back. We deliberately do not attempt to
 * reconstruct PostgreSQL transaction/savepoint state here: if executable SQL
 * contains ROLLBACK (including ROLLBACK TO) or ABORT, no INVOKER ALTER may be
 * used as evidence that an earlier DEFINER mode is gone. This is conservative
 * by design; the reviewed file-level exemption remains available for a safe
 * migration whose transaction flow is too unusual for this reader. */
function hasRollbackCapableTransactionControl(structuralSql) {
  return /(?:^|;)\s*(?:ROLLBACK|ABORT)\b/i.test(String(structuralSql || ""));
}

function routineNamesMayMatch(left, right) {
  // A SECURITY mode change may reduce risk only when both sides identify the
  // same schema-qualified routine. PostgreSQL search_path makes unqualified
  // names ambiguous, and a shared basename across schemas is not an identity.
  if (left === null || right === null) return false;
  if (!left.includes(".") || !right.includes(".")) return false;
  return left === right;
}

function beforeTopLevelDefault(argument) {
  const text = String(argument || "");
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") { depth++; continue; }
    if (text[i] === ")") { depth--; continue; }
    if (depth !== 0) continue;
    if (text[i] === "=") return text.slice(0, i).trim();
    if (/^DEFAULT\b/i.test(text.slice(i)) && !/[\w$]/.test(text[i - 1] || "")) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

/** An unqualified custom type is not a stable routine identity: SET search_path
 * can make identical source spellings resolve to different overloads. Built-in
 * pg_catalog types remain safe in their ordinary unqualified form; every custom
 * type must carry its schema so CREATE and ALTER can be compared exactly. */
function normalizedUnambiguousRoutineIdentityType(rawType) {
  const sourceType = String(rawType || "").trim();
  const type = sourceType
    .replace(/\s+/g, " ")
    .replace(/\s*([(),.\[\]])\s*/g, "$1");
  if (!type) return null;
  if (!type.includes('"') && isBuiltInSqlCastTypeName(type)) return type.toLowerCase();
  const arrays = type.match(/(?:\[\])+$/)?.[0] || "";
  const base = type.slice(0, type.length - arrays.length);
  const qualified = normalizedQualifiedIdentifier(base);
  return qualified?.includes(".") ? qualified + arrays : null;
}

/** Normalize CREATE parameters or ALTER identity arguments into a conservative
 * comparable type list. An unusual unnamed multi-word CREATE type may refuse
 * to match and require manual review; it cannot make a different overload look
 * identical, which is the fail-closed direction needed here. */
function normalizedRoutineIdentityArgs(argsText, createDefinition) {
  const types = [];
  for (const rawArgument of splitTopLevelArgs(argsText)) {
    let argument = beforeTopLevelDefault(rawArgument);
    const mode = /^(INOUT|IN|OUT|VARIADIC)\s+/i.exec(argument);
    if (mode) {
      if (/^OUT$/i.test(mode[1])) continue;
      argument = argument.slice(mode[0].length).trim();
    }
    if (createDefinition) {
      const named = new RegExp(`^${SQL_IDENTIFIER_PATTERN}\\s+`).exec(argument);
      if (named) argument = argument.slice(named[0].length).trim();
    }
    if (!argument) return null;
    const normalizedType = normalizedUnambiguousRoutineIdentityType(argument);
    if (normalizedType === null) return null;
    types.push(normalizedType);
  }
  return types.join(",");
}

function routineAlterMatchesCreate(created, altered) {
  return routineNamesMayMatch(created.name, altered.name) &&
    created.signature !== null && altered.signature !== null &&
    created.signature === altered.signature;
}

function routineAltersMatch(left, right) {
  return routineNamesMayMatch(left.name, right.name) &&
    left.signature !== null && right.signature !== null &&
    left.signature === right.signature;
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
  if (hasPgCronJobIdentityChange(content)) {
    violations.push(
      "This migration renames the cron schema, renames or moves cron.job, or renames its command " +
      "column, or rewrites that column's type, so later scheduled SQL writes would no longer match " +
      "the actor-binding reader. " +
      "Keep cron.job.command at its " +
      "canonical identity, or add the file-level exempt marker (-- actor-binding-check: exempt) " +
      "and get a manual review."
    );
  }
  const masked = maskSqlNoise(content);
  const callNameMasked = maskSqlForCallNames(content);
  const allowUnqualifiedUuid = !hasUnqualifiedUuidShadowRisk(
    callNameMasked,
    masked,
    blankComments(content)
  );
  const executableSecurityModes = masked === null
    ? []
    : alteredRoutineSecurityModes(masked);
  const topLevelSecurityModeIndexes = new Set((callNameMasked === null
    ? []
    : alteredRoutineSecurityModes(callNameMasked)
  ).map(({ index }) => index));
  // Any readable DEFINER elevation is dangerous, including dynamic SQL. An
  // INVOKER demotion is trusted only when it is top-level and executes as part
  // of the migration itself rather than being stored for a later code path.
  const alteredSecurityModes = executableSecurityModes.filter((altered) =>
    altered.mode === "DEFINER" || topLevelSecurityModeIndexes.has(altered.index)
  );
  const hasRollbackControl = masked !== null &&
    hasRollbackCapableTransactionControl(masked);
  const createdRoutines = [];
  if (masked !== null && hasExecuteSqlReadonlyOperatorAlias(masked)) {
    violations.push(
      "This migration aliases execute_sql_readonly behind a PostgreSQL operator, so later SQL text " +
      "would cross the owner-executing boundary without a recognizable callable name. Keep the " +
      "executor directly named, or add the file-level exempt marker " +
      "(-- actor-binding-check: exempt) and get a manual review."
    );
  }
  if (masked === null) {
    if (sawOpaqueRoutineCallable) {
      violations.push(
        "This migration passes CREATE FUNCTION/PROCEDURE text to a callable that is not allowlisted as a " +
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
          "This migration passes indirect or dynamically assembled SQL text to a callable that is not " +
          "allowlisted as a data-only sink. The callable may execute or store SQL whose tokens " +
          "are hidden in a column, variable, subquery, concatenation, or helper function. Supply one complete direct literal, " +
          "or add the file-level exempt marker (-- actor-binding-check: exempt) and get a manual review."
        );
        return true;
      }
      if (lits.length === 0) return false;
      const ddlLiterals = directExecuteLiteral ? [directExecuteLiteral.literal] : lits;
      if (!carriesSecurityRelevantRoutineDdl(
        ddlLiterals.map((l) => l.payload).join("")
      )) return false;
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
      if (lits.length === 1 && carriesSecurityRelevantRoutineDdl(lits[0].payload)) {
        const lit = lits[0];
        const skeleton = singleLiteralSkeleton;
        const directAssign = /^(?:BEGIN\s+)?(?:"[^"]+"|[\w.]+)\s*(?::=|=(?!=))\s*__ACTOR_DDL_LITERAL__$/i.test(skeleton);
        const directSelectInto = /^(?:BEGIN\s+)?SELECT\s+__ACTOR_DDL_LITERAL__\s+INTO\s+(?:"[^"]+"|[\w.]+)$/i.test(skeleton);
        if (directAssign || directSelectInto) return false;
      }
      if (directExecuteLiteral &&
          carriesSecurityRelevantRoutineDdl(directExecuteLiteral.literal.payload)) return false;
      violations.push(
        "This migration builds a CREATE FUNCTION/PROCEDURE or security-elevating ALTER routine " +
        "statement at runtime, and the actor-binding guard " +
        "cannot read it as one complete literal — the definition is split across fragments, transformed " +
        "through format/concatenation/conditional logic, or not parseable on its own. Built that way, " +
        "the guard cannot tell whether the " +
        "routine is SECURITY DEFINER, mutates, accepts a caller-supplied actor, and raises " +
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
  while (masked !== null && (head = routineHeadRe.exec(masked)) !== null) {
    const routineKind = head[1].toUpperCase();
    const routineName = head[2];
    const normalizedRoutineName = normalizedQualifiedIdentifier(routineName);
    const paramsOpen = routineHeadRe.lastIndex - 1;
    const parsed = readBalancedParens(masked, paramsOpen);
    if (!parsed) {
      violations.push(
        `Routine ${routineName}: could not parse its parameter list (unbalanced parentheses, ` +
        `unterminated string/comment/dollar-quote?) — the actor-binding guard cannot inspect it. ` +
        `Simplify the signature, or if it is genuinely valid SQL the lexer mishandles, add the ` +
        `exempt marker and get a manual review.`
      );
      break;
    }
    const rest = readAttrsAndBody(masked, parsed.end);
    if (!rest) {
      violations.push(
        `Routine ${routineName}: could not parse its AS $tag$...$tag$ body — the actor-binding guard ` +
        `cannot verify its SECURITY DEFINER attributes or actor binding. Simplify the definition, ` +
        `or if it is genuinely valid SQL the lexer mishandles, add the exempt marker and get a ` +
        `manual review.`
      );
      break;
    }
    const params = content.slice(paramsOpen + 1, parsed.end - 1);
    const maskedParams = parsed.params;
    const identityParams = callNameMasked === null
      ? maskedParams
      : callNameMasked.slice(paramsOpen + 1, parsed.end - 1);
    const createdRoutine = {
      kind: routineKind,
      name: normalizedRoutineName,
      signature: normalizedRoutineIdentityArgs(identityParams, true),
    };
    createdRoutines.push(createdRoutine);
    const attrs = rest.attrs;
    const body = content.slice(rest.bodyStart, rest.bodyEnd);
    const maskedBody = masked.slice(rest.bodyStart, rest.bodyEnd);
    // Do not jump past this definition: maskSqlNoise deliberately exposes
    // executable CREATE FUNCTION definitions nested in this body. Continuing
    // from the current regex position lets the next iteration inspect those
    // definitions independently instead of trusting the outer function's result.

    // Only SECURITY DEFINER routines can forge an actor with the owner's rights.
    // The mode may be attached later through ALTER FUNCTION/PROCEDURE/ROUTINE, so evaluate
    // the final same-file mode rather than trusting CREATE attributes alone.
    const laterSecurityModes = alteredSecurityModes.filter((altered) =>
      altered.index > head.index && routineAlterMatchesCreate(createdRoutine, altered)
    );
    const finalAlteredMode = laterSecurityModes.findLast((altered) =>
      !hasRollbackControl || altered.mode !== "INVOKER"
    )?.mode;
    const isSecurityDefiner = finalAlteredMode
      ? finalAlteredMode === "DEFINER"
      : /SECURITY\s+DEFINER/i.test(attrs);
    if (!isSecurityDefiner) continue;

    // Static mutation keywords are readable after full noise masking. Also scan
    // the comment-only mask so executable strings passed to APIs such as
    // cron.schedule remain visible. This intentionally accepts false positives:
    // if a definer function with a forgeable actor parameter contains mutation
    // text anywhere outside a comment, it must bind the actor or use exemption.
    const actorDescriptors = actorParameterDescriptors(
      maskedParams,
      blankComments(params),
      allowUnqualifiedUuid
    );
    const actorParams = actorDescriptors.map(({ name }) => name);
    if (actorParams.length === 0) continue;

    const commentBlankedBody = blankComments(body);
    const actorReferences = actorDescriptors.flatMap(({ references }) => references);
    const actorParamReference = actorReferences.map(actorReferencePattern).join("|");
    const actorForwardedInvocation = new RegExp(
      `\\b(?:CALL|PERFORM)\\b[^;]*?(?:${actorParamReference})`,
      "i"
    );
    const maskedForwardingReferences = actorForwardingReferences(maskedBody, actorReferences);
    const commentBlankedForwardingReferences = actorForwardingReferences(commentBlankedBody, actorReferences);
    const actorForwardedCallable = hasActorCallableForwarding(maskedBody, maskedForwardingReferences) ||
      hasActorCallableForwarding(commentBlankedBody, commentBlankedForwardingReferences);
    const actorForwardedOperator = hasActorOperatorForwarding(maskedBody, maskedForwardingReferences) ||
      hasActorOperatorForwarding(commentBlankedBody, commentBlankedForwardingReferences);
    const actorForwardedSymbolicOperator = hasActorSymbolicOperatorForwarding(
      maskedBody,
      maskedForwardingReferences
    ) || hasActorSymbolicOperatorForwarding(
      commentBlankedBody,
      commentBlankedForwardingReferences
    );
    const actorForwardedUserCast = hasActorUserDefinedCastForwarding(
      maskedBody,
      maskedForwardingReferences
    ) || hasActorUserDefinedCastForwarding(
      commentBlankedBody,
      commentBlankedForwardingReferences
    );
    const actorLaunderedIntoOpaqueTarget = hasOpaqueUnicodeActorLaundering(
      maskedBody,
      maskedForwardingReferences
    ) || hasOpaqueUnicodeActorLaundering(
      commentBlankedBody,
      commentBlankedForwardingReferences
    );
    const staticMutationRe = new RegExp(
      `\\b(?:INSERT\\s+INTO|UPDATE${SQL_KEYWORD_IDENTIFIER_GAP}|DELETE\\s+FROM|MERGE\\s+INTO)`,
      "i"
    );
    const hasMutation = staticMutationRe.test(maskedBody) ||
      staticMutationRe.test(commentBlankedBody) ||
      /\bEXECUTE\b/i.test(maskedBody) ||
      actorForwardedInvocation.test(maskedBody) ||
      actorForwardedInvocation.test(commentBlankedBody) ||
      actorForwardedCallable ||
      actorForwardedOperator ||
      actorForwardedSymbolicOperator ||
      actorForwardedUserCast ||
      actorLaunderedIntoOpaqueTarget;
    if (!hasMutation) continue;

    // IS DISTINCT FROM resolves its equality operator through the routine's
    // runtime search_path. Explicitly putting a user schema before pg_catalog
    // lets a same-signature user operator lie even when both operands spell
    // pg_catalog.uuid, so that order cannot establish caller identity.
    const rawAttrs = (rest.attrsRanges || [])
      .map(([from, to]) => blankComments(content.slice(from, to)))
      .join(" ");
    const trustedUuidOperatorResolution = !hasSchemaBeforeExplicitPgCatalog(attrs) &&
      !hasSchemaBeforeExplicitPgCatalog(rawAttrs);
    const hasRecognizedActorRefusal = actorDescriptors.every(({ name, references, trustedUuid }) =>
      hasEnforcedActorRefusal(
        body,
        name,
        references,
        trustedUuid && trustedUuidOperatorResolution,
        allowUnqualifiedUuid
      )
    );
    if (hasRecognizedActorRefusal) continue;

    violations.push(
      `Routine ${routineName}: SECURITY DEFINER, mutates, executes dynamic SQL, or forwards an actor to another callable, and declares the forgeable actor parameter(s) ` +
      `[${actorParams.join(", ")}] but the body does not prove an ACTOR_MISMATCH refusal for every parameter — any authenticated caller ` +
      `can attribute the write to another user.`
    );
  }
  for (const altered of alteredSecurityModes) {
    if (altered.mode !== "DEFINER") continue;
    const laterMode = alteredSecurityModes.findLast((candidate) =>
      candidate.index > altered.index &&
      routineAltersMatch(candidate, altered) &&
      (!hasRollbackControl || candidate.mode !== "INVOKER")
    );
    if (laterMode?.mode === "INVOKER") continue;
    if (createdRoutines.some((created) => routineAlterMatchesCreate(created, altered))) {
      continue;
    }
    violations.push(
      `ALTER FUNCTION/PROCEDURE/ROUTINE ${altered.name ?? "with an opaque identifier"} changes a routine to ` +
      `SECURITY DEFINER, but this migration does not include a readable CREATE routine body for ` +
      `the actor-binding guard to verify. Include the complete definition, or add the file-level ` +
      `exempt marker (-- actor-binding-check: exempt) and get a manual review.`
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
    " A SECURITY DEFINER routine that takes a caller-supplied actor id MUST bind it to auth.uid() " +
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
