#!/usr/bin/env node
// grant-change-guard.mjs — C5 control (docs/audits/2026-06-10-error-prevention-review.md §4)
// PreToolUse guard for Write/Edit of supabase/migrations/*.sql that touch
// GRANT/REVOKE on functions.
//
// THE B10 RULE: a REVOKE migration broke production because caller analysis
// covered 2 of 6 functions. This hook makes per-function caller analysis
// MANDATORY for EVERY function a grant-change migration touches:
//
//   - It extracts every function named in GRANT/REVOKE ... ON FUNCTION ... statements.
//   - For each function REVOKEd from authenticated/anon/PUBLIC, it looks the name up
//     in .claude/caller-graph.json (rpc_callers + edge_callers incl. ?action= branches
//     + cron_callers — regenerate with: node scripts/generate-caller-graph.mjs).
//   - If the function HAS callers and the migration does NOT contain a justification
//     marker line for it, the write is DENIED and the message lists every caller
//     (file:line) so the analysis cannot be skipped or done partially.
//
// Justification marker (one line per function, anywhere in the migration):
//   -- caller-analysis: <function_name> :: <disposition>
// e.g.
//   -- caller-analysis: mark_overdue_invoices :: cron-only caller runs as postgres owner; REVOKE authenticated is safe
//
// Blanket statements (GRANT/REVOKE ... ON ALL FUNCTIONS IN SCHEMA x) cannot be
// caller-analyzed per function, so they require the special marker:
//   -- caller-analysis: all-functions :: <why a blanket change is safe>
//
// Allowed without markers: GRANT-only migrations (additive), REVOKEs from roles
// other than authenticated/anon/PUBLIC (e.g. service_role tightening), REVOKEs on
// functions with zero callers, and non-migration files.
//
// Stale-graph guard: if caller-graph.json _meta.generated_at is older than 7 days,
// the hook still allows but emits a systemMessage warning to regenerate first.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { toLF, applyEditsForAnalysis } from "./edit-splice-lib.mjs";

const STALE_DAYS = 7;

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
function allow(systemMessage) {
  const payload = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  emit(payload);
}
function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  allow();
}

const toolName = (payload?.tool_name || "").toLowerCase();
if (!["write", "edit", "multiedit"].includes(toolName)) allow();

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath.endsWith(".sql") || !filePath.includes("supabase/migrations/")) allow();

// Content being written: Write -> content; Edit -> new_string; MultiEdit -> all new_strings.
const input = payload?.tool_input || {};
let newContent = "";
if (typeof input.content === "string") newContent = input.content;
else if (typeof input.new_string === "string") newContent = input.new_string;
else if (Array.isArray(input.edits)) newContent = input.edits.map((e) => e?.new_string || "").join("\n");
// The emptiness early-exit moved BELOW the disk reconstruction: a pure-deletion
// Edit has an empty new_string, and exiting here let it bypass the guard
// entirely — deleting a caller-analysis marker line left a risky REVOKE
// unjustified yet allowed (CodeRabbit PR #489).

// For Edit/MultiEdit, new_string is only a FRAGMENT — a role-token-only change
// inside an existing REVOKE (e.g. `service_role` -> `authenticated`) carries no
// grant/revoke word and would slip past the fast path + parser below. Apply the
// edit against the on-disk file so both see the FULL post-edit statements (Codex
// 2026-06-13). The splice is line-ending-safe (edit-splice-lib): an exact-match
// splice silently no-oped on CRLF worktrees, so the guard judged the UNEDITED
// file and denied the very Edit that added its required marker (2026-08-26).
// Falls back to the fragment if the file can't be read/applied.
let reconstructed = toolName === "write"; // Write content IS the full file
if (toolName !== "write" && existsSync(filePath)) {
  try {
    newContent = applyEditsForAnalysis(readFileSync(filePath, "utf8"), input);
    reconstructed = true;
  } catch {
    /* keep the fragment */
  }
}
newContent = toLF(newContent);
if (!newContent) {
  // Empty content is only trustworthy when it IS the real post-edit file
  // (a Write of empty content, or a reconstruction that emptied the file).
  // A deletion Edit whose reconstruction FAILED (readFileSync threw after
  // existsSync passed) leaves no signal at all — allowing it would let a
  // marker-deleting edit through unanalyzed (CodeRabbit PR #489). Fail closed.
  if (reconstructed) allow();
  deny(
    "GRANT-CHANGE GUARD: this Edit deletes content from a migration file, but the on-disk file " +
      "could not be read to analyze the post-edit result, so the deletion cannot be checked for " +
      "grant/revoke impact. Retry, or use a single full-file Write so the guard sees complete content."
  );
}

// Fast path: nothing grant-shaped in the post-edit content.
if (!/\b(grant|revoke)\b/i.test(newContent)) allow();

// Marker scan source: when the full post-edit file was reconstructed, scan
// ONLY it — markers that already live elsewhere in the file are inside it, and
// including the pre-edit disk content would retain a marker the edit REMOVES,
// silently allowing a still-risky REVOKE (CodeRabbit PR #489). The disk+fragment
// union survives solely for the fragment fallback (file unreadable/unapplied),
// where markers elsewhere in the file must still count.
let markerSource = newContent;
if (!reconstructed && existsSync(filePath)) {
  try {
    markerSource = toLF(readFileSync(filePath, "utf8")) + "\n" + newContent;
  } catch {
    /* fall back to new content only */
  }
}

// ---------------------------------------------------------------------------
// Parse GRANT/REVOKE ... ON FUNCTION statements from the comment-stripped SQL.
// ---------------------------------------------------------------------------
const sqlNoComments = newContent.replace(/--[^\n]*/g, "");
const statements = sqlNoComments.split(";");

const RISKY_ROLES = new Set(["authenticated", "anon", "public"]);

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function fnNameOf(piece) {
  // `public.fn_name(uuid, text)` | `"fn name"(...)` | `fn_name` -> fn_name
  const m = piece
    .trim()
    .match(/(?:"?[A-Za-z_][\w$]*"?\.)?"?([A-Za-z_][\w$]*)"?\s*(?:\([^)]*\))?\s*$/);
  return m ? m[1].toLowerCase() : null;
}

const revokesRisky = new Map(); // fn name -> true (REVOKEd from authenticated/anon/PUBLIC)
let blanketRiskyRevoke = null; // statement text if REVOKE ... ALL FUNCTIONS IN SCHEMA from risky role
let touchesFunctionGrants = false;

for (const stmt of statements) {
  const m = stmt.match(
    /\b(grant|revoke)\b[\s\S]*?\bon\s+(all\s+functions\s+in\s+schema\s+[\w".]+|(?:function|procedure|routine)\s+([\s\S]*?))\s+(to|from)\s+([\s\S]+)$/i
  );
  if (!m) continue;
  touchesFunctionGrants = true;
  const verb = m[1].toLowerCase();
  const target = m[2];
  const fnList = m[3];
  const roleText = m[5]
    .replace(/\b(granted\s+by[\s\S]*|cascade|restrict|with\s+grant\s+option)\b/gi, "");
  const roles = roleText
    .split(",")
    .map((r) => r.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter(Boolean);
  const hitsRisky = roles.some((r) => RISKY_ROLES.has(r));

  if (verb !== "revoke" || !hitsRisky) continue; // GRANTs and non-risky REVOKEs are additive/safe

  if (/^all\s+functions\s+in\s+schema/i.test(target.trim())) {
    blanketRiskyRevoke = stmt.trim().replace(/\s+/g, " ").slice(0, 160);
    continue;
  }
  for (const piece of splitTopLevelCommas(fnList)) {
    const name = fnNameOf(piece);
    if (name) revokesRisky.set(name, true);
  }
}

if (!touchesFunctionGrants) allow();

// ---------------------------------------------------------------------------
// Justification markers: `-- caller-analysis: <fn> :: <disposition>`
// ---------------------------------------------------------------------------
const markers = new Map(); // fn (lowercase, schema stripped) -> disposition
const markerRe = /^\s*--\s*caller-analysis:\s*([\w.$*-]+)\s*::\s*(.+?)\s*$/gim;
let mm;
while ((mm = markerRe.exec(markerSource)) !== null) {
  const token = mm[1].toLowerCase();
  const bare = token.includes(".") ? token.split(".").pop() : token;
  markers.set(bare, mm[2]);
}

// ---------------------------------------------------------------------------
// Caller graph lookup
// ---------------------------------------------------------------------------
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const graphPath = path.join(projectDir, ".claude", "caller-graph.json");
let graph = null;
try {
  graph = JSON.parse(readFileSync(graphPath, "utf8"));
} catch {
  graph = null;
}

const needsGraph = revokesRisky.size > 0 || blanketRiskyRevoke !== null;
if (!graph && needsGraph) {
  deny(
    "GRANT-CHANGE GUARD: this migration REVOKEs function EXECUTE from authenticated/anon/PUBLIC, " +
      "but .claude/caller-graph.json is missing or unreadable, so per-function caller analysis is impossible.\n\n" +
      "Regenerate it first:\n" +
      "  node scripts/generate-caller-graph.mjs --live-json <file>   (see --print-sql for the read-only live queries,\n" +
      "  or ask Claude Code to regenerate the caller graph via Supabase MCP)\n\n" +
      "This guard exists because of B10 (2026-06-10 review §4 C5): a REVOKE migration broke production " +
      "when caller analysis covered 2 of 6 functions."
  );
}

let staleNote = "";
if (graph) {
  const genAt = Date.parse(graph?._meta?.generated_at || "");
  if (Number.isNaN(genAt) || Date.now() - genAt > STALE_DAYS * 24 * 60 * 60 * 1000) {
    staleNote =
      `caller-graph.json is STALE (generated_at: ${graph?._meta?.generated_at || "unknown"}; ` +
      `older than ${STALE_DAYS} days). Callsites may have changed — regenerate with ` +
      `\`node scripts/generate-caller-graph.mjs\` before trusting this analysis.`;
  }
}

function callersOf(name) {
  if (!graph) return [];
  const found = [];
  for (const loc of graph.rpc_callers?.[name] || []) found.push(`rpc  ${loc}`);
  for (const loc of graph.cron_callers?.[name] || []) found.push(`cron ${loc}`);
  for (const [key, locs] of Object.entries(graph.edge_callers || {})) {
    if (key === name || key.startsWith(name + "?")) {
      for (const loc of locs) found.push(`edge [${key}] ${loc}`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------
const violations = [];

if (blanketRiskyRevoke && !markers.has("all-functions")) {
  violations.push(
    `BLANKET revoke detected: "${blanketRiskyRevoke}" — ALL FUNCTIONS IN SCHEMA cannot be caller-analyzed ` +
      `per function. Either enumerate the functions explicitly (preferred), or add:\n` +
      `    -- caller-analysis: all-functions :: <why a blanket change is safe>`
  );
}

for (const name of revokesRisky.keys()) {
  const callers = callersOf(name);
  if (callers.length === 0) continue; // zero-caller fn — REVOKE is what the C5 control wants to enable
  if (markers.has(name)) continue; // justified — per-function analysis was done and recorded
  violations.push(
    `REVOKE on "${name}" — this function HAS live callers and no justification marker:\n` +
      callers.map((c) => `      ${c}`).join("\n") +
      `\n    Required: analyze each caller above, then add the marker line to the migration:\n` +
      `    -- caller-analysis: ${name} :: <disposition — e.g. "cron runs as postgres owner, unaffected" or "UI callsite removed in this branch">`
  );
}

if (violations.length > 0) {
  deny(
    "GRANT-CHANGE GUARD (B10 rule — per-function caller analysis is mandatory for EVERY function in a " +
      "REVOKE-from-authenticated/anon migration):\n\n" +
      violations.join("\n\n") +
      "\n\nCaller data: .claude/caller-graph.json (regenerate: node scripts/generate-caller-graph.mjs). " +
      "Edge keys include ?action= branches — guard the branch the UI actually calls (B8)." +
      (staleNote ? "\n\nWARNING: " + staleNote : "")
  );
}

allow(staleNote ? "GRANT-CHANGE GUARD warning: " + staleNote : undefined);
