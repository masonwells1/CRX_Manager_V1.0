#!/usr/bin/env node
// PreToolUse(*) guard: closes the "Desktop Commander blind spot" (2026-07-13
// audit, Critical). bash-safety.mjs only gates the Bash|PowerShell tool
// matcher — but Desktop Commander's start_process/interact_with_process can
// run the exact same dangerous shell commands, and its
// write_file/edit_block/move_file/create_directory can touch the exact same
// protected paths (.env*, an EXISTING migration, .claude/settings.json,
// .claude/hooks/*.mjs) without ever going through the Write/Edit tool matcher
// those other hooks are wired to. Both blind spots let a session route around
// the entire guard net just by picking a different tool for the same action.
//
// Behavior:
//   - start_process / interact_with_process: extract the command/input text and
//     run it through the SAME dangerous-command + migration-modify checks
//     bash-safety.mjs enforces (shared via bash-safety-lib.mjs — one pattern
//     table, no duplication, no drift).
//   - write_file / edit_block / move_file / create_directory: deny if the
//     target path is a .env* file, an EXISTING file under supabase/migrations/,
//     .claude/settings.json, or any .claude/hooks/*.mjs file.
//   - kill_process / set_config_value: not gated here (no command/path text to
//     check against these patterns; set_config_value was "ask"-gated in
//     settings.json until 2026-09-05 and now sits in `deny` there, alongside
//     the other Desktop Commander mutators - PR #605).
//   - Supabase MCP leaves (any server name containing `supabase`, or the UUID
//     connector): FAIL CLOSED on anything that is not on the exact read-only
//     allowlist and is not one of the three leaves another gate already owns
//     (execute_sql -> live-testdata/live-db guards; apply_migration ->
//     migration-apply-guard; deploy_edge_function -> the `ask` tier, Mason's
//     deploy gate - passed ONLY when that exact tool name has a settings entry,
//     since the ask entries are per server name/UUID). Added 2026-09-05 (GitHub Codex P1 on PR #605): once the repo
//     inherits Auto mode an UNLISTED tool goes to the classifier instead of
//     being refused, so a new or renamed Supabase mutation absent from the finite
//     settings.json deny list could be accepted. Mirrors the fail-closed rule in
//     .codex/hooks/production-action-guard.mjs (SUPABASE_READ_ONLY_TOOLS).
//   - Other connector UUIDs: a UUID whose settings entries name a leaf only
//     Supabase has gets the complete Supabase policy; otherwise each tool
//     needs its own exact settings entry (or a read-shaped name) or it is
//     denied - the reinstalled-Supabase case (Codex P1 x3, PR #605).
//
// FAIL-OPEN, LOUD: any internal error here → allow, with a stderr warning. A
// broken guard must never brick a session.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommandDeep, checkMigrationModify } from "./bash-safety-lib.mjs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
function nothing() { process.exit(0); } // silent passthrough — normal flow, nothing to say

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  nothing();
}

const toolName = String(payload?.tool_name || "");

// SERVER-AGNOSTIC (Codex P1 2026-07-13): the same tool names exist on OTHER
// MCP servers too — settings.json allow-lists mcp__filesystem__write_file/
// edit_file/move_file — so matching only Desktop_Commander left an identical
// blind spot one server over. Match the tool NAME on any mcp__<server>__
// prefix; the checks below only act on command/path fields, so an unrelated
// server's same-named tool is still handled correctly (or passes through).
// kill_process/set_config_value are matched for completeness/future extension
// but carry no specific check below (see header).
const DC_TOOL_RE = /^mcp__[\w-]+__(start_process|interact_with_process|write_file|edit_file|edit_block|move_file|create_file|create_directory|delete_file|kill_process|set_config_value)$/;
const DC_RUN_RE = /^mcp__[\w-]+__(start_process|interact_with_process)$/;
const DC_WRITE_RE = /^mcp__[\w-]+__(write_file|edit_file|edit_block|move_file|create_file|create_directory|delete_file)$/;

// ── Supabase: exact read-only allowlist, fail closed on everything else ──────
// Server names seen on the Claude side: supabase, Supabase, claude_ai_Supabase,
// and the UUID connector. Leaves are matched case-insensitively.
// Leaf syntax is the full MCP leaf alphabet incl. hyphens: a kebab-case
// mutation (`future-write-tool`) must hit the same fail-closed branch
// (GitHub Codex P1 on PR #605 head 68c1c32f0).
const SUPABASE_TOOL_RE = /^mcp__([\w-]*supabase[\w-]*|50e15046-cf2c-49da-b8df-ceef27768f63)__([\w-]+)$/i;
const SUPABASE_READ_ONLY_TOOLS = new Set([
  "generate_typescript_types", "get_advisors", "get_cost", "get_edge_function",
  "get_logs", "get_organization", "get_project", "get_project_url",
  "get_publishable_keys", "list_branches", "list_edge_functions",
  "list_extensions", "list_migrations", "list_organizations", "list_projects",
  "list_tables", "query_logs", "search_docs",
]);
// Owned by another gate; this guard stays silent so THAT gate decides.
const SUPABASE_GATED_ELSEWHERE = new Set(["execute_sql", "apply_migration", "deploy_edge_function"]);
// ── Connector UUID servers: derive identity from settings, else fail closed ──
// The Supabase connector UUID is per-install and changes on reinstall
// (.claude/skills/deploy-edge-function/SKILL.md), so a reinstalled connector
// arrives under a UUID that neither settings.json nor SUPABASE_TOOL_RE knows,
// and under Auto mode its mutations would reach the classifier (GitHub Codex
// P1 x3 on PR #605, 2026-09-05). The hook payload carries only the tool name,
// so the connector's identity cannot be read at call time; the Claude settings
// files (repo .claude/settings.json, .claude/settings.local.json,
// ~/.claude/settings.json) are the closest source of truth. For a UUID server
// that SUPABASE_TOOL_RE does not already know:
//   1. IDENTIFIED AS SUPABASE: if any allow/ask/deny entry for that UUID names
//      a leaf that only Supabase's connector has (list_tables, execute_sql,
//      apply_migration, get_advisors, ... - NOT the generic *_project leaves
//      Vercel shares), the UUID is the Supabase connector and the COMPLETE
//      Supabase policy applies: exact read-only allowlist passes, the three
//      leaves other gates own pass to those gates, everything else is denied.
//   2. OTHERWISE, PER-TOOL: a leaf passes only if the exact
//      `mcp__<uuid>__<leaf>` ask/deny entry exists in a settings file, or it is on the
//      Supabase read-only allowlist, or it is read-shaped by verb (get_/list_/
//      search_/read_/find_/query_/...). EVERYTHING ELSE is denied: a single
//      registered leaf never settles the other tools on that server, so a
//      reinstalled Supabase connector with only `list_projects` listed still
//      has `delete_project`, `future_write_tool`, `deploy_edge_function`
//      denied (Codex probe on 68c1c32f0). The denial says how to register.
// Registering is a settings.json edit requiring approval under PR #605's final
// policy; a reinstalled Supabase connector must ALSO be added to
// SUPABASE_TOOL_RE. Residual: a mutation deliberately named with a read verb
// on an unidentified connector passes; no known connector does that. A
// malformed settings file yields fewer registered entries, i.e. MORE denials.
const UUID_SERVER_TOOL_RE = /^mcp__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__([\w-]+)$/i;
const SUPABASE_SENSITIVE_LEAVES = new Set([
  "apply_migration", "deploy_edge_function", "execute_sql",
  "delete_branch", "merge_branch", "reset_branch", "rebase_branch", "create_branch",
  "create_project", "pause_project", "restore_project", "confirm_cost",
]);
// Leaves shared with other connectors prove nothing about identity and are
// excluded here: Vercel has list_projects/get_project/pause_project, and the
// GitHub connector has list_branches/create_branch (GitHub Codex P2 on PR #605
// head 3612eb3a1: a UUID-installed GitHub connector registered for those was
// misidentified as Supabase and had its ordinary tools denied).
const SUPABASE_SHARED_LEAVES = new Set([
  "list_projects", "get_project", "create_project", "pause_project", "restore_project",
  "list_branches", "create_branch",
]);
const SUPABASE_DISTINCTIVE_LEAVES = new Set(
  [...SUPABASE_READ_ONLY_TOOLS, ...SUPABASE_GATED_ELSEWHERE, ...SUPABASE_SENSITIVE_LEAVES]
    .filter((leaf) => !SUPABASE_SHARED_LEAVES.has(leaf)),
);
const READ_SHAPED_LEAF_RE = /^(?:get|list|search|read|find|query|describe|fetch|show|view|check|inspect|compare|validate|render|extract|convert|download|suggest|analy[sz]e|display|lookup|count|preview)(?:_|$)/i;
// GitHub spells some reads with the verb LAST (pull_request_read, issue_read,
// actions_get, actions_list); accept that shape too (GitHub Codex P2 on 3612eb3a1).
const READ_SHAPED_SUFFIX_RE = /_(?:read|get|list)$/i;
const isReadShaped = (leaf) => READ_SHAPED_LEAF_RE.test(leaf) || READ_SHAPED_SUFFIX_RE.test(leaf);
const SETTINGS_UUID_LEAF_RE = /^mcp__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__([\w-]+)$/i;

// { exact: Set<lower-cased entry>, byUuid: Map<uuid, Set<leaf>> } of every exact
// per-tool `mcp__<server>__<leaf>` entry across the settings files.
let settingsCache = null;
function settingsMcpEntries() {
  if (settingsCache) return settingsCache;
  const exact = new Set();
  const tiers = new Map(); // lower-cased entry -> Set of tiers it appears in
  const found = new Map();
  const hookDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(hookDir, "..", "..");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const candidates = [
    path.join(repoRoot, ".claude", "settings.json"),
    path.join(repoRoot, ".claude", "settings.local.json"),
    path.join(projectDir, ".claude", "settings.json"),
    path.join(projectDir, ".claude", "settings.local.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const perms = parsed?.permissions && typeof parsed.permissions === "object" ? parsed.permissions : {};
      for (const tier of ["allow", "ask", "deny"]) {
        for (const entry of Array.isArray(perms[tier]) ? perms[tier] : []) {
          const text = String(entry).trim();
          if (/^mcp__[\w-]+__[\w-]+$/i.test(text)) {
            const lower = text.toLowerCase();
            exact.add(lower);
            if (!tiers.has(lower)) tiers.set(lower, new Set());
            tiers.get(lower).add(tier);
          }
          const m = SETTINGS_UUID_LEAF_RE.exec(text);
          if (!m) continue;
          const uuid = m[1].toLowerCase();
          if (!found.has(uuid)) found.set(uuid, new Set());
          found.get(uuid).add(m[2].toLowerCase());
        }
      }
    } catch (err) {
      process.stderr.write(`[mcp-tool-guard] could not read ${file}: ${err?.message || err}\n`);
    }
  }
  settingsCache = { exact, tiers, byUuid: found };
  return settingsCache;
}

// deploy_edge_function is "gated elsewhere" ONLY by its exact `ask` entry in
// settings.json - there is no deploy hook. Those entries name specific servers
// (supabase, Supabase, claude_ai_Supabase, the registered UUID), so on any other
// Supabase-looking server the leaf would reach the classifier instead of Mason's
// deploy prompt (GitHub Codex P1 on PR #605 head af30d4c17). Pass it only when
// THIS exact tool name has a settings entry; otherwise deny and say how.
// A live action (deploy, lifecycle mutation) counts as registered only when its
// exact entry sits in `ask` or `deny`. An `allow` line would let the tool run
// with no prompt at all - the very bypass the tier exists to prevent (GitHub
// Codex P1 on PR #605 head 6de456ac5) - so it does NOT count.
function gatedTierRegistered(name) {
  const tiers = settingsMcpEntries().tiers.get(name.toLowerCase());
  return Boolean(tiers && (tiers.has("ask") || tiers.has("deny")));
}

// The established SQL/migration routes retain their existing downstream guards. A new
// connector identity must not inherit that authority from a read-tool entry.
function gateReplacementData(server, leaf) {
  if (leaf !== "execute_sql" && leaf !== "apply_migration") return;
  const established = new Set(["supabase", "claude_ai_supabase", "50e15046-cf2c-49da-b8df-ceef27768f63"]);
  if (established.has(server.toLowerCase()) || gatedTierRegistered(toolName)) return;
  out("block", `MCP TOOL GUARD (${toolName}): ${leaf} on a replacement or renamed Supabase connector requires an exact ask/deny entry. Read-tool registration or an allow entry does not authorize data changes on this connector.`);
}

function denyUnlessDeployRegistered(server) {
  if (gatedTierRegistered(toolName)) nothing();
  out("block",
    `MCP TOOL GUARD (${toolName}): deploy_edge_function on Supabase server "${server}" has no exact ask/deny entry in any Claude settings file ` +
    "(an `allow` line does not count), so it would skip Mason's deploy prompt and reach the permission classifier. Edge Function deploys " +
    "need his approval in the current conversation: add `" + toolName + "` to the `ask` list in .claude/settings.json (fail closed).");
}

const supabaseLeaf = SUPABASE_TOOL_RE.exec(toolName);
if (!supabaseLeaf) {
  const uuidMatch = UUID_SERVER_TOOL_RE.exec(toolName);
  if (uuidMatch) {
    const uuid = uuidMatch[1].toLowerCase();
    const leaf = uuidMatch[2];
    const leafLower = leaf.toLowerCase();
    const registered = settingsMcpEntries().byUuid.get(uuid) || new Set();
    const identifiedAsSupabase = [...registered].some((l) => SUPABASE_DISTINCTIVE_LEAVES.has(l));
    if (identifiedAsSupabase) {
      gateReplacementData(uuid, leafLower);
      if (leafLower === "deploy_edge_function") denyUnlessDeployRegistered(uuid);
      if (SUPABASE_READ_ONLY_TOOLS.has(leafLower) || SUPABASE_GATED_ELSEWHERE.has(leafLower)) nothing();
      out("block",
        `MCP TOOL GUARD (${toolName}): connector UUID ${uuid} is identified as the Supabase connector by its settings entries, ` +
        `and "${leaf}" is not on the exact read-only allowlist, so it is denied (fail closed). Add this UUID to ` +
        ".claude/hooks/mcp-tool-guard.mjs SUPABASE_TOOL_RE and to the Supabase ask/deny entries in .claude/settings.json; " +
        "live schema, data, branch and project changes travel only through the reviewed migration path or a Mason-approved gate.");
    }
    const liveAction = SUPABASE_SENSITIVE_LEAVES.has(leafLower);
    const settled = gatedTierRegistered(toolName);
    if (!settled && !SUPABASE_READ_ONLY_TOOLS.has(leafLower) && !isReadShaped(leaf)) {
      const kind = liveAction ? "a Supabase live-action leaf (only an `ask` or `deny` entry settles it; an `allow` line does not count)" : "not a read-shaped tool";
      out("block",
        `MCP TOOL GUARD (${toolName}): "${leaf}" is ${kind} and has no qualifying exact entry for connector UUID ${uuid} in any Claude settings file ` +
        "(repo .claude/settings.json, .claude/settings.local.json, ~/.claude/settings.json), so it is denied rather than left to the " +
        "permission classifier. The connector UUID changes on reinstall. Register the exact tool in ask/deny (an allow entry does not count) to settle it; " +
        "if this is the reinstalled Supabase connector, add the UUID to .claude/hooks/mcp-tool-guard.mjs SUPABASE_TOOL_RE instead so the " +
        "exact read-only allowlist applies (fail closed).");
    }
  }
}
if (supabaseLeaf) {
  const leaf = supabaseLeaf[2].toLowerCase();
  gateReplacementData(supabaseLeaf[1], leaf);
  if (leaf === "deploy_edge_function") denyUnlessDeployRegistered(supabaseLeaf[1]);
  if (SUPABASE_READ_ONLY_TOOLS.has(leaf) || SUPABASE_GATED_ELSEWHERE.has(leaf)) nothing();
  out("block",
    `MCP TOOL GUARD (${toolName}): Supabase tool "${leaf}" is not on the exact read-only allowlist and is denied (fail closed). ` +
    "Live schema, data, branch and project changes travel only through the reviewed migration path or an explicit Mason-approved gate; " +
    "an unrecognized Supabase leaf is never left to the permission classifier.");
}

if (!DC_TOOL_RE.test(toolName)) nothing();

const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try {
  if (DC_RUN_RE.test(toolName)) {
    // Desktop Commander's fields vary by tool/version — gather every plausible
    // command/text field rather than guessing one exact name.
    const text = [input.command, input.input, input.text, input.script]
      .filter((v) => typeof v === "string" && v.length > 0)
      .join("\n");

    if (text) {
      const reason = checkCommandDeep(text, cwd);
      if (reason) out("block", `MCP TOOL GUARD (${toolName}): ${reason}`);

      const migReason = checkMigrationModify(text, cwd);
      if (migReason) out("block", `MCP TOOL GUARD (${toolName}): ${migReason}`);
    }
    nothing();
  }

  if (DC_WRITE_RE.test(toolName)) {
    // Check EVERY path-like field — for move_file that means the SOURCE as well
    // as the destination (Codex P1 2026-07-13: checking only the destination
    // let a protected migration be moved/renamed AWAY to an unprotected path).
    const candidates = [input.path, input.file_path, input.source, input.old_path, input.destination, input.new_path]
      .filter((v) => typeof v === "string" && v.length > 0);
    if (candidates.length === 0) nothing();

    for (const targetRaw of candidates) {
      // Test patterns against the RESOLVED path, not the raw string — a raw
      // ".claude/sub/../settings.json" resolves to the protected settings file
      // but the raw text never matches the pattern (Codex P2 2026-07-13).
      // The raw normalized form is also tested so a relative path that escapes
      // cwd upward (resolving OUTSIDE the repo) still matches on its raw shape.
      const abs = path.isAbsolute(targetRaw) ? path.resolve(targetRaw) : path.resolve(cwd, targetRaw);
      const surfaces = [targetRaw.replace(/\\/g, "/"), abs.replace(/\\/g, "/")];

      const isEnv = surfaces.some((s) => /(^|\/)\.env(\.[\w-]+)?$/i.test(s));
      const isSettings = surfaces.some((s) => /(^|\/)\.claude\/settings\.json$/i.test(s));
      const isHookFile = surfaces.some((s) => /(^|\/)\.claude\/hooks\/[\w.-]+\.mjs$/i.test(s));
      // ANY migration-file write via MCP is denied — new files too, not just
      // existing ones. The content guards (sql-safety, rls-on-new-tables,
      // status-enum-check, generated-column-check, idempotency-body-check) are
      // wired to the native Write/Edit matchers only, so CREATING a migration
      // through an MCP write tool would skip every one of them (Codex P1
      // 2026-07-13 round 5). The native Write path is the only guarded path.
      const isMigrationPath = surfaces.some((s) => /(^|\/)supabase\/migrations\/[\w.-]+\.sql$/i.test(s));

      // Whole-directory targets (Codex P1 2026-07-13 round 3): moving/renaming
      // `supabase/migrations`, `supabase`, `.claude`, or `.claude/hooks` as a
      // DIRECTORY relocates every protected file inside it in one call — the
      // per-file patterns above never match a bare directory path.
      const isProtectedDir = surfaces.some((s) =>
        /(^|\/)(supabase(\/migrations)?|\.claude(\/hooks)?)\/?$/i.test(s)
      );

      if (isEnv || isSettings || isHookFile || isMigrationPath || isProtectedDir) {
        out(
          "block",
          `MCP TOOL GUARD (${toolName}): use the native Edit/Write tools so the guard hooks can inspect this change (protected path: ${targetRaw}).`
        );
      }
    }
  }
} catch (err) {
  process.stderr.write(`mcp-tool-guard.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  nothing();
}

nothing();
