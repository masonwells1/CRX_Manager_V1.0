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

import { readFileSync } from "node:fs";

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

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

if (/--\s*actor-binding-check:\s*exempt/i.test(content)) {
  out("allow");
}

// Locate each CREATE [OR REPLACE] FUNCTION header. The parameter list is then
// read with a BALANCED-paren scan rather than a [^)]* capture, because a real
// parameter list contains parens — numeric(12,2), varchar(50), timestamp(3).
// A naive capture stops at the first inner ')' and silently truncates the list,
// which would hide an actor parameter declared after a parenthesised type.
const fnHeadRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi;

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
function isDynamicSqlStatement(stmt) {
  return /\bEXECUTE\b/i.test(stmt) ||
    ASSIGN_RE.test(stmt) ||
    DECLARATION_INIT_RE.test(stmt) ||
    /\bSELECT\b[\s\S]*\bINTO\b/i.test(stmt) ||
    /\bVALUES\b[\s\S]*\bINTO\b/i.test(stmt) ||
    // pg_cron stores its command argument for later execution. Treat a
    // function-bearing command like every other runtime DDL builder; the
    // surrounding name/schedule literals mean it is not one direct DDL literal,
    // so fail closed and use the explicit exemption/manual-review path.
    /\bcron\s*\.\s*schedule\s*\(/i.test(stmt);
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
  const before = out.slice(out.lastIndexOf(";") + 1);
  const semi = firstTopLevelSemicolon(text, afterIdx);
  return isDynamicSqlStatement(
    before + " " + text.slice(afterIdx, semi === -1 ? text.length : semi)
  );
}

const CREATE_FN_HEAD_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[\w."]+\s*\(/i;

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
        const isExecutable = isProceduralContainer || /\bEXECUTE\s+$/i.test(out) ||
          (inProceduralCode && carriesFnHeader(payload)) ||
          (inExecuteStatement(out, text, close + tag.length) && carriesFnHeader(payload));
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
      const isDynamicSql = ch === "'" && (isProceduralContainer ||
        (carriesFnHeader(payload) && (inProceduralCode || inExecuteStatement(out, text, end))));
      if (isDynamicSql) {
        // Recursing into the raw payload is safe only when it needs no SQL
        // quote decoding. In an outer standard string, doubled quotes represent
        // one inner quote; treating them as two delimiters can turn an inner
        // `--` string into a fake comment and hide the mutation that follows.
        // Preserve exact source indexes by refusing this fancy valid form and
        // directing it to the explicit exemption/human-review path.
        if (payload.includes("''")) return null;
        const inner = maskSqlNoise(payload, inProceduralCode || isProceduralContainer);
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
  const masked = maskSqlNoise(content);
  if (masked === null) {
    violations.push(
      "This migration could not parse safely (unterminated SQL construct, encoded or nested-quoted " +
      "procedural body, or newline-concatenated procedural strings) — " +
      "the actor-binding guard cannot inspect it. Fix the unterminated construct, or if it is " +
      "genuinely valid SQL the lexer mishandles, add the exempt marker and get a manual review."
    );
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
      if (lits.length === 0) return false;
      if (!isDynamicSqlStatement(stmt)) return false;
      const ddlLiterals = directExecuteLiteral ? [directExecuteLiteral.literal] : lits;
      if (!carriesFnHeader(ddlLiterals.map((l) => l.payload).join(""))) return false;

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
