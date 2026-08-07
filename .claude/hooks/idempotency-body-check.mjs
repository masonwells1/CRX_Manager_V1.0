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

/** From the index of a '(' , return {params, end} where end is just past its match.
 * Skips SQL comments (-- to end of line, block comments) so an unmatched paren
 * inside a parameter comment cannot desync the depth count (Codex P2, PR #335). */
function readBalancedParens(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === strCh) inStr = false;
      continue;
    }
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
      const dq = /^\$\w*\$/.exec(text.slice(i));
      if (dq) {
        const close = text.indexOf(dq[0], i + dq[0].length);
        if (close === -1) return null;
        i = close + dq[0].length - 1;
        continue;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth === 0) return { params: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** From just past the parameter list, return {body, end} for the AS $tag$...$tag$ block. */
function readDollarQuotedBody(text, fromIdx) {
  const tagMatch = /\bAS\s+(\$\w*\$)/i.exec(text.slice(fromIdx));
  if (!tagMatch) return null;
  const tag = tagMatch[1];
  const bodyStart = fromIdx + tagMatch.index + tagMatch[0].length;
  const bodyEnd = text.indexOf(tag, bodyStart);
  if (bodyEnd === -1) return null;
  return { body: text.slice(bodyStart, bodyEnd), end: bodyEnd + tag.length };
}

const violations = [];
try {
let head;
while ((head = fnHeadRe.exec(content)) !== null) {
  const fnName = head[1];
  const parsed = readBalancedParens(content, fnHeadRe.lastIndex - 1);
  if (!parsed) continue;
  const params = parsed.params;
  const rest = readDollarQuotedBody(content, parsed.end);
  if (!rest) continue;
  const body = rest.body;
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
