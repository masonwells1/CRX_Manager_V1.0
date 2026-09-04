#!/usr/bin/env node
// Best-effort forgeable-actor binding guard for CRX Manager. This is a cheap
// write-time speed bump for ordinary Write/Edit paths, not a security boundary;
// exact-SHA review and CodeRabbit remain the load-bearing pre-merge controls.
// See the 2026-09-01 capped-guard decision in docs/manual/DECISION_LOG.md.
//
// THE GAP THIS CLOSES
//   Two sweep predicates (predicates/actor-forgery.sql and
//   predicates/actor-forgery-fin-audit.sql) find SECURITY DEFINER functions that
//   trust a caller-supplied actor parameter — but they only run against the LIVE
//   catalog, i.e. AFTER the migration has been applied. This hook performs a
//   narrower form of that check while supported Write/Edit tools author SQL.
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
//     in the body — it does not attempt to verify the guard is correct. Exact-SHA
//     review and CodeRabbit provide the deeper pre-merge review; the live sweeps
//     add partial post-apply coverage for the limited sink shapes they recognize.

import { existsSync, readFileSync } from "node:fs";
import { applyEditsForAnalysis, toLF } from "./edit-splice-lib.mjs";

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

// Write carries the full file, while Edit/MultiEdit carries only fragments.
// Reconstruct the full post-edit migration with the shared CRLF-safe helper so
// the existing function header, parameters, and SECURITY DEFINER attribute stay
// visible. If reconstruction is unavailable, retain the prior best-effort
// fragment behavior; this capped hook deliberately remains fail-open.
const input = payload?.tool_input || {};
let content = input.content || input.new_string || "";
const isFragmentEdit = typeof input.content !== "string" &&
  (typeof input.old_string === "string" || Array.isArray(input.edits));
if (isFragmentEdit) {
  try {
    if (existsSync(filePath)) {
      content = applyEditsForAnalysis(readFileSync(filePath, "utf8"), input);
    } else if (Array.isArray(input.edits)) {
      content = input.edits.map((edit) => edit?.new_string || "").join("\n");
    }
  } catch {
    // Keep the fragment. The hook is a best-effort speed bump, not a boundary.
  }
}
content = toLF(content);
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

/** From the index of a '(' , return {params, end} where end is just past its match. */
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
    if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth === 0) return { params: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** From just past the parameter list, return {attrs, body} for the AS $tag$...$tag$ block. */
function readAttrsAndBody(text, fromIdx) {
  const tagMatch = /\bAS\s+(\$\w*\$)/i.exec(text.slice(fromIdx));
  if (!tagMatch) return null;
  const attrs = text.slice(fromIdx, fromIdx + tagMatch.index);
  const tag = tagMatch[1];
  const bodyStart = fromIdx + tagMatch.index + tagMatch[0].length;
  const bodyEnd = text.indexOf(tag, bodyStart);
  if (bodyEnd === -1) return null;
  return { attrs, body: text.slice(bodyStart, bodyEnd), end: bodyEnd + tag.length };
}

const violations = [];
try {
  let head;
  while ((head = fnHeadRe.exec(content)) !== null) {
    const fnName = head[1];
    const parsed = readBalancedParens(content, fnHeadRe.lastIndex - 1);
    if (!parsed) continue;
    const rest = readAttrsAndBody(content, parsed.end);
    if (!rest) continue;
    const params = parsed.params;
    const attrs = rest.attrs;
    const body = rest.body;
    // Resume scanning after this function so a nested CREATE FUNCTION inside a
    // body (DO-block style migrations) isn't parsed twice.
    fnHeadRe.lastIndex = rest.end;

    // Only SECURITY DEFINER functions can forge an actor with the owner's rights.
    if (!/SECURITY\s+DEFINER/i.test(attrs)) continue;

    // Only mutating bodies attribute anything worth forging.
    if (!/\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(body)) continue;

    const actorParams = splitTopLevelArgs(params)
      .map(paramName)
      .filter((n) => ACTOR_PARAM_RE.test(n));
    if (actorParams.length === 0) continue;

    if (/ACTOR_MISMATCH/i.test(body)) continue;

    violations.push(
      `Function ${fnName}: SECURITY DEFINER, mutates, and declares the forgeable actor parameter(s) ` +
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
