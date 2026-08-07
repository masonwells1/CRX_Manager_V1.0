#!/usr/bin/env node
// Idempotency body-check guard for CRX Manager.
// Detects SQL migration functions that declare p_idempotency_key text DEFAULT NULL
// but never actually USE it.
//
// TWO wiring patterns count as correctly wired (checked per function body):
//   1. Direct table access:
//        FROM idempotency_keys WHERE idempotency_key = p_idempotency_key   (check)
//        INSERT INTO idempotency_keys ...                                  (record)
//   2. Canonical helper calls (preferred — see CLAUDE.md "Idempotency" and
//      20260210000000_tier3_idempotency_and_triggers.sql):
//        check_idempotency(p_idempotency_key, '<op>')    (check, at top)
//        save_idempotency(p_idempotency_key, '<op>', v)  (record, at end)
//
// BOTH halves of ONE pattern are required. A body with only check_idempotency()
// or only save_idempotency() is HALF-WIRED — exactly the bug class this hook
// exists for — and is blocked. Mixing halves across patterns (e.g. a
// check_idempotency() call paired with a direct INSERT INTO idempotency_keys)
// is also blocked: use both halves of the same pattern.
//
// Escape hatch: the file-level marker comment
//   -- idempotency-body-check: exempt
// skips the check (only for wrappers that genuinely delegate idempotency —
// helper-wired bodies do NOT need it since this hook recognizes the helpers).
//
// Bug pattern: issue_return_credit declared the parameter and threw it away,
// so retries silently created duplicate credits (9b36cd2).
//
// FIX 6 (2026-07-13 audit — "idempotency unscoped-lookup variant"): being
// correctly WIRED (both a check and a record step present) is not the same as
// being correctly SCOPED. The restore_quote_version bug class (Codex
// 2026-06-08, fixed at scale by migration 20260611211058) was 22 live RPCs
// whose lookup filtered ONLY on idempotency_key with no operation filter — a
// key collision across two DIFFERENT operations silently honored the wrong
// cached result. This hook now also requires the lookup itself to reference
// `operation` (a literal or a parameter) — for the direct pattern, inside the
// SAME lookup statement; for the helper pattern, as a second argument to
// check_idempotency(). Conservative by design: it only fires when the lookup
// clearly carries NO operation reference at all.

import { readFileSync } from "node:fs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// Split a call's argument text on top-level commas (ignoring commas inside
// nested parens or quoted strings) so we can conservatively count arguments —
// e.g. distinguish check_idempotency(p_idempotency_key) [1 arg, unscoped] from
// check_idempotency(p_idempotency_key, 'my_op') [2 args, scoped].
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  let strCh = "";
  for (const ch of String(argsText || "")) {
    if (inStr) {
      cur += ch;
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = true; strCh = ch; cur += ch; continue; }
    if (ch === "(") { depth++; cur += ch; continue; }
    if (ch === ")") { depth--; cur += ch; continue; }
    if (ch === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  args.push(cur);
  return args.map((a) => a.trim()).filter((a) => a !== "");
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

if (/--\s*idempotency-body-check:\s*exempt/i.test(content)) {
  out("allow");
}

// Locate each CREATE [OR REPLACE] FUNCTION header. The parameter list is then
// read with a BALANCED-paren scan rather than a [^)]* capture, because a real
// parameter list contains parens — numeric(12,2), varchar(50), timestamp(3).
// A naive capture stops at the first inner ')' and silently truncates the list,
// which would hide p_idempotency_key declared after a parenthesised type
// (same fix as actor-binding-check.mjs).
const fnHeadRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi;

/** From the index of an opening ' or ", return the index just past the closing
 * quote, or -1 if unterminated. Handles doubled quotes ('' / "") as literal
 * characters INSIDE the string, and backslash escapes in E'...' strings —
 * including the mix E'it''s \'x' where a doubled quote must not clear escape
 * mode (Codex P2 round 4). */
function scanQuoted(text, openIdx) {
  const strCh = text[openIdx];
  const isEStr = strCh === "'" &&
    /[eE]/.test(text[openIdx - 1] || "") && !/[\w$]/.test(text[openIdx - 2] || "");
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (isEStr && ch === "\\") { i++; continue; }
    if (ch === strCh) {
      if (text[i + 1] === strCh) { i++; continue; } // doubled quote: stay inside
      return i + 1;
    }
  }
  return -1;
}

/** Match a dollar-quote opener ($tag$) at index i, or return null. No length
 * cap — a bounded slice window silently missed long tags and skipped the body
 * (fail-open). Requires a token boundary before the '$': in an identifier like
 * foo$bar$, the '$' is part of the name, not a delimiter (Codex P2 round 5). */
const DOLLAR_TAG_RE = /\$\w*\$/y;
function dollarTagAt(text, i) {
  if (/[\w$]/.test(text[i - 1] || "")) return null;
  DOLLAR_TAG_RE.lastIndex = i;
  const m = DOLLAR_TAG_RE.exec(text);
  return m ? m[0] : null;
}

/** Replace SQL comments (-- to end of line, NESTED block comments) AND the
 * CONTENTS of quoted strings with spaces, recursing into dollar-quoted blocks
 * (delimiters kept) so their inner comments and strings are masked the same
 * way. LENGTH-PRESERVING: every index into the masked text is a valid index
 * into the original, so callers scan structure here and slice real content
 * (parameter lists, function bodies) from the original by index.
 * Returns null when a string, block comment, or dollar-quote never terminates
 * (caller fails CLOSED).
 * This is the structural fix for four review findings on PR #335:
 *  - a commented-out "CREATE FUNCTION foo(" header must not be scanned as live
 *    DDL (its unmatched paren tripped the fail-closed deny — Codex P2 round 4);
 *  - a comment containing "AS $fake$...$fake$" must not be mistaken for a
 *    function body, which could skip a later REAL function (CodeRabbit Major);
 *  - "CREATE FUNCTION foo(" inside a string literal — top-level or in a
 *    RAISE NOTICE within a DO block — must not be scanned as live DDL either
 *    (Codex P2 round 6); masking string contents kills the whole class. */
function maskSqlNoise(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "-" && text[i + 1] === "-") {
      let nl = text.indexOf("\n", i + 2);
      if (nl === -1) nl = text.length; // comment to EOF is valid SQL
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
        const inner = maskSqlNoise(text.slice(i + tag.length, close));
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
      out += ch + " ".repeat(end - i - 2) + ch;
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** From the index of a '(' , return {params, end} where end is just past its match.
 * Skips SQL comments (-- to end of line, block comments) so an unmatched paren
 * inside a parameter comment cannot desync the depth count (Codex P2, PR #335). */
function readBalancedParens(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i + 2);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // PostgreSQL block comments NEST — track depth, don't stop at the first */.
      let cdepth = 1;
      let j = i + 2;
      while (j < text.length && cdepth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { cdepth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { cdepth--; j += 2; continue; }
        j++;
      }
      if (cdepth > 0) return null;
      i = j - 1;
      continue;
    }
    if (ch === "$") {
      // Dollar-quoted literal ($tag$...$tag$) in a DEFAULT expression — skip it
      // whole so a '(' inside the literal isn't counted as syntax.
      const tag = dollarTagAt(text, i);
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        i = close + tag.length - 1;
        continue;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(text, i); // doubled-quote + E-string aware (Codex P2 rounds 3–4)
      if (end === -1) return null;
      i = end - 1;
      continue;
    }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth === 0) return { params: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** From just past the parameter list, return {bodyStart, bodyEnd, end} for the
 * AS $tag$...$tag$ block. Walks the MASKED text skipping quoted strings and
 * non-body dollar-quoted literals, and only accepts a $tag$ directly preceded by
 * the AS keyword — so "AS $fake$" text inside a quoted option value can never be
 * mistaken for the body (CodeRabbit Major, PR #335). */
function readDollarQuotedBody(text, fromIdx) {
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
          // Return INDEXES, not a slice: the caller slices the body from the
          // ORIGINAL content so string literals (operation names) survive masking.
          return { bodyStart, bodyEnd, end: bodyEnd + tag.length };
        }
        // A dollar-quoted literal that is NOT the body (e.g. a SET option value):
        // skip it whole.
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        i = close + tag.length;
        continue;
      }
      i++;
      continue;
    }
    // Stop at the next CREATE so one function's missing body can never swallow
    // the next function's real body.
    if ((ch === "c" || ch === "C") && /^CREATE\s/i.test(text.slice(i, i + 7)) && !/[\w$]/.test(text[i - 1] || "")) {
      return null;
    }
    i++;
  }
  return null;
}

const violations = [];
try {
// Strip comments first so commented-out DDL is invisible to every scan below.
// Mask comments and string contents so neither can masquerade as DDL; scan
// structure on the mask, slice real content from `content` by index.
const masked = maskSqlNoise(content);
if (masked === null) {
  violations.push(
    "This migration could not parse (unterminated string, block comment, or dollar-quote) — " +
    "the idempotency guard cannot inspect it. Fix the unterminated construct, or if it is " +
    "genuinely valid SQL the lexer mishandles, add the exempt marker and get a manual review."
  );
}
let head;
while (masked !== null && (head = fnHeadRe.exec(masked)) !== null) {
  const fnName = head[1];
  const parsed = readBalancedParens(masked, fnHeadRe.lastIndex - 1);
  if (!parsed) {
    // FAIL CLOSED: a parameter list this lexer cannot close is exactly where a
    // hidden p_idempotency_key could live (Codex PR #335 found three such lexer
    // holes in a row). Blocking with an explanation beats silently skipping the
    // function; the file-level exempt marker remains the escape hatch.
    violations.push(
      `Function ${fnName}: could not parse its parameter list (unbalanced parentheses, ` +
      `unterminated string/comment/dollar-quote?) — the idempotency guard cannot inspect it. ` +
      `Simplify the signature, or if it is genuinely valid SQL the lexer mishandles, add the ` +
      `exempt marker and get a manual review.`
    );
    break;
  }
  const params = parsed.params;
  const rest = readDollarQuotedBody(masked, parsed.end);
  if (!rest) continue;
  // Slice the body from the ORIGINAL content (indexes align — masking is
  // length-preserving) so operation-name string literals survive for the
  // wiring and FIX 6 scoping checks below.
  const body = content.slice(rest.bodyStart, rest.bodyEnd);
  // Resume scanning after this function so a nested CREATE FUNCTION inside a
  // body (DO-block style migrations) isn't parsed twice.
  fnHeadRe.lastIndex = rest.end;

  if (!/p_idempotency_key\s+text/i.test(params)) continue;

  const hasMutation = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(body);
  if (!hasMutation) continue;

  // Pattern 1: direct idempotency_keys access (check + record).
  const readsKey = /FROM\s+idempotency_keys\s+WHERE\s+idempotency_key\s*=\s*p_idempotency_key/i.test(body);
  const writesKey = /INSERT\s+INTO\s+idempotency_keys/i.test(body);
  const directWired = readsKey && writesKey;

  // Pattern 2: canonical helper calls. BOTH are required — half-wired fails.
  const callsCheckHelper = /\bcheck_idempotency\s*\(/i.test(body);
  const callsSaveHelper = /\bsave_idempotency\s*\(/i.test(body);
  const helperWired = callsCheckHelper && callsSaveHelper;

  if (directWired || helperWired) {
    // FIX 6: wired is not the same as SCOPED. Check the lookup itself for an
    // operation reference before accepting this function as correctly guarded.
    if (directWired) {
      const stmtRe = /FROM\s+idempotency_keys\s+WHERE\s+idempotency_key\s*=\s*p_idempotency_key([\s\S]*?);/i;
      const stmtMatch = stmtRe.exec(body);
      const clause = stmtMatch ? stmtMatch[1] : "";
      if (!/\boperation\b/i.test(clause)) {
        violations.push(
          `Function ${fnName}: the idempotency_keys lookup filters ONLY on idempotency_key with no operation scoping — ` +
          `this is the restore_quote_version bug class (Codex 2026-06-08, fixed at scale by migration 20260611211058): ` +
          `a key collision across two DIFFERENT operations will silently short-circuit the wrong one. ` +
          `Add "AND operation = '${fnName}'" (or an operation-bearing parameter) to the lookup's WHERE clause.`
        );
      }
    }
    if (helperWired) {
      const checkCalls = [...body.matchAll(/\bcheck_idempotency\s*\(([^)]*)\)/gi)];
      const unscopedCheckCall = checkCalls.some((call) => splitTopLevelArgs(call[1]).length < 2);
      if (unscopedCheckCall) {
        violations.push(
          `Function ${fnName}: check_idempotency() is called with no operation argument — ` +
          `this is the restore_quote_version bug class (Codex 2026-06-08, fixed at scale by migration 20260611211058): ` +
          `a key collision across two DIFFERENT operations will silently short-circuit the wrong one. ` +
          `Call check_idempotency(p_idempotency_key, '${fnName}') (or an operation-bearing parameter).`
        );
      }
      // Codex P1 2026-07-13: two args isn't enough — a check under one operation
      // string with a save under a DIFFERENT one means every retry misses the
      // cached result and replays the mutation. Compare the two operation
      // literals when both are plain string literals (conservative: any
      // non-literal/parameterized operation is left to the reviewers).
      const literalOp = (args) => {
        const parts = splitTopLevelArgs(args);
        if (parts.length < 2) return null;
        const m = /^\s*'((?:[^']|'')*)'\s*$/.exec(parts[1]);
        return m ? m[1] : null;
      };
      const saveCalls = [...body.matchAll(/\bsave_idempotency\s*\(([^)]*)\)/gi)];
      const checkOps = checkCalls.map((c) => literalOp(c[1])).filter((v) => v !== null);
      const saveOps = saveCalls.map((c) => literalOp(c[1])).filter((v) => v !== null);
      // Every pairing must close, not just one (Codex P2 round 3): a check op
      // with no matching save replays that branch; a save op with no matching
      // check is never consulted. Only literal ops are judged — parameterized
      // ones stay with the reviewers.
      if (checkOps.length > 0 && saveOps.length > 0) {
        const unsavedChecks = checkOps.filter((op) => !saveOps.includes(op));
        const uncheckedSaves = saveOps.filter((op) => !checkOps.includes(op));
        if (unsavedChecks.length > 0 || uncheckedSaves.length > 0) {
          const parts = [];
          if (unsavedChecks.length) parts.push(`check_idempotency() operation(s) [${unsavedChecks.map((o) => `'${o}'`).join(", ")}] have no matching save_idempotency() — those branches replay on every retry`);
          if (uncheckedSaves.length) parts.push(`save_idempotency() operation(s) [${uncheckedSaves.map((o) => `'${o}'`).join(", ")}] are never checked — their saved results are dead`);
          violations.push(
            `Function ${fnName}: mismatched idempotency operation keys — ${parts.join("; ")} ` +
            `(the exact duplicate-execution class this guard exists for). Every operation literal must appear in BOTH calls.`
          );
        }
      }
    }
    continue;
  }

  const missing = [];
  if (callsCheckHelper !== callsSaveHelper) {
    missing.push(callsCheckHelper
      ? "calls check_idempotency() but never save_idempotency() — half-wired, the result is never recorded so retries replay the mutation"
      : "calls save_idempotency() but never check_idempotency() — half-wired, existing keys are never checked so retries replay the mutation");
  } else {
    if (!readsKey) missing.push("does not check idempotency before mutating (no direct idempotency_keys lookup, no check_idempotency() call)");
    if (!writesKey) missing.push("does not record the key after mutating (no INSERT INTO idempotency_keys, no save_idempotency() call)");
  }
  violations.push(`Function ${fnName}: ${missing.join("; ")}.`);
}
} catch (err) {
  // FAIL-OPEN, but loud: a broken hook must never brick the session.
  process.stderr.write(`idempotency-body-check.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

if (violations.length > 0) {
  out("block",
    "IDEMPOTENCY VIOLATION: " + violations.join(" | ") +
    " A function that declares p_idempotency_key MUST both check existing keys before mutating " +
    "and record the new key after — either via the canonical helpers (check_idempotency() at top " +
    "AND save_idempotency() at end — both, same pattern, no mixing) or via direct idempotency_keys " +
    "access. See .claude/skills/new-rpc/SKILL.md for the canonical pattern. " +
    "If this is intentional (e.g., a wrapper that delegates idempotency), add the marker " +
    "-- idempotency-body-check: exempt near the top of the migration file.");
}

out("allow");
