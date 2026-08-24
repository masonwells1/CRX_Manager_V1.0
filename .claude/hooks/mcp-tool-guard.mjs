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
//   - process-signal tools: denied while the protected maintenance producer is
//     tracked at HEAD, because a signal trap can execute shell state assembled
//     across earlier persistent-process interactions.
//   - set_config_value: not gated here; it already requires explicit "ask"
//     approval in settings.json.
//
// FAIL-OPEN, LOUD: any internal error here → allow, with a stderr warning. A
// broken guard must never brick a session.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  checkCommandDeep,
  checkAskDeep,
  checkMigrationModify,
} from "./bash-safety-lib.mjs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : decision === "ask"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }
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
const DC_TOOL_RE = /^mcp__[\w-]+__(start_process|interact_with_process|write_file|write_text_file|append_file|edit_file|edit_block|replace_in_file|move_file|copy_file|rename_file|create_file|create_directory|move_directory|copy_directory|delete_file|delete_directory|kill_process|send_signal|signal_process|terminate_process|stop_process|set_config_value)$/;
const DC_RUN_RE = /^mcp__[\w-]+__(start_process|interact_with_process)$/;
const DC_INTERACT_RE = /^mcp__[\w-]+__interact_with_process$/;
const DC_SIGNAL_RE = /^mcp__[\w-]+__(kill_process|send_signal|signal_process|terminate_process|stop_process)$/;
const DC_WRITE_RE = /^mcp__[\w-]+__(write_file|write_text_file|append_file|edit_file|edit_block|replace_in_file|move_file|copy_file|rename_file|create_file|create_directory|move_directory|copy_directory|delete_file|delete_directory)$/;

if (!DC_TOOL_RE.test(toolName)) nothing();

const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const protectedProducerName = ["apply-live-testdata-maintenance-", "20260812.mjs"].join("");
const protectedProducerRepoPath = `scripts/${protectedProducerName}`;
// LATCHED safety boundary. Retirement requires an explicit reviewed change to
// this guard and its regressions; producer tracking state cannot reopen the
// persistent-process or signal routes by itself.
const protectedProducerRetired = false;

// A hard link is NOT a link at the path level: it is a second directory entry
// pointing at the same file data, so `realpath` returns the alias's own
// pathname and every name-shaped check above sees an unprotected spelling.
// `mklink /H alias .claude\hooks\bash-safety-lib.mjs` followed by a write to
// `alias` would therefore edit a protected hook (Codex CRX-SEC-01, 2026-08-23).
// Identity — device + inode/file-ID — is the property a hard link cannot
// disguise, so compare that too whenever the target already exists.
function fileIdentity(target) {
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return "";
    // A filesystem that cannot report a real inode/file-ID (reported as 0)
    // gives no identity signal; never let that read as "matches nothing".
    if (!stat.ino) return "";
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "";
  }
}

function protectedFileIdentities(root) {
  const identities = new Set();
  const add = (candidate) => {
    const identity = fileIdentity(candidate);
    if (identity) identities.add(identity);
  };
  const addDirectory = (directory, matches) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !matches(entry.name)) continue;
      add(path.join(directory, entry.name));
    }
  };
  addDirectory(path.join(root, ".claude", "hooks"), (name) => /\.mjs$/i.test(name));
  addDirectory(path.join(root, "supabase", "migrations"), (name) => /\.sql$/i.test(name));
  addDirectory(root, (name) => /^\.env(\.[\w-]+)?$/i.test(name));
  add(path.join(root, ".claude", "settings.json"));
  add(path.join(root, "scripts", protectedProducerName));
  add(path.join(root, ".gitignore"));
  return identities;
}

// Only consulted when no name-shaped pattern matched, so the ordinary deny path
// costs nothing extra. Unreadable protected files simply contribute no identity;
// the name patterns above remain the primary boundary.
function aliasesProtectedFile(absTarget, root) {
  const identity = fileIdentity(absTarget);
  if (!identity) return false;
  return protectedFileIdentities(root).has(identity);
}

function canonicalizeThroughExistingAncestor(target) {
  const original = path.resolve(target);
  let current = original;
  const missing = [];
  while (true) {
    try {
      const canonical = realpathSync.native(current);
      return path.resolve(canonical, ...missing.reverse());
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) return original;
      const parent = path.dirname(current);
      if (parent === current) return original;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

try {
  const producerProtectionActive = !protectedProducerRetired;

  if (DC_SIGNAL_RE.test(toolName) && producerProtectionActive) {
    out(
      "block",
      `MCP TOOL GUARD (${toolName}): process signaling is disabled while the protected maintenance producer is tracked; a signal trap can execute persistent shell state outside single-call inspection.`
    );
  }

  if (DC_RUN_RE.test(toolName)) {
    // Desktop Commander's fields vary by tool/version — gather every plausible
    // command/text field rather than guessing one exact name.
    const text = [input.command, input.input, input.text, input.script]
      .filter((v) => typeof v === "string" && v.length > 0)
      .join("\n");

    if (DC_INTERACT_RE.test(toolName) && producerProtectionActive) {
      out(
        "block",
        `MCP TOOL GUARD (${toolName}): interaction with an existing process is disabled while the protected maintenance producer exists; cross-call shell continuations cannot be inspected safely. Launch the complete command in a fresh process instead.`
      );
    }

    if (text) {
      const reason = checkCommandDeep(text, cwd);
      if (reason) out("block", `MCP TOOL GUARD (${toolName}): ${reason}`);

      const migReason = checkMigrationModify(text, cwd);
      if (migReason) out("block", `MCP TOOL GUARD (${toolName}): ${migReason}`);

      const askReason = checkAskDeep(text, cwd);
      if (askReason) out("ask", `MCP TOOL GUARD (${toolName}): ${askReason}`);
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
      // Windows 8.3 aliases (for example APPLY-~1.MJS) and junction/symlink
      // aliases must not turn one protected file into an unrecognized spelling.
      // Canonicalize the deepest existing ancestor so this also protects a new
      // destination nested below a short-name or linked directory.
      const canonical = canonicalizeThroughExistingAncestor(abs);
      const surfaces = [targetRaw, abs, canonical].map((value) => value.replace(/\\/g, "/"));

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
      const isProtectedProducer = surfaces.some((s) => s.toLowerCase().endsWith(`/${protectedProducerRepoPath.toLowerCase()}`));
      const isGitExclusionControl = surfaces.some((s) =>
        /(^|\/)\.gitignore$/i.test(s)
        || /(^|\/)\.git(?:\/[^/]+)*\/info\/exclude$/i.test(s)
        || /(^|\/)\.git(?:\/[^/]+)*\/config(?:\.worktree)?$/i.test(s)
        || /(^|\/)\.gitconfig$/i.test(s)
        || /(^|\/)\.config\/git\/(?:config|ignore)$/i.test(s)
      );

      // Whole-directory targets (Codex P1 2026-07-13 round 3): moving/renaming
      // `supabase/migrations`, `supabase`, `.claude`, or `.claude/hooks` as a
      // DIRECTORY relocates every protected file inside it in one call — the
      // per-file patterns above never match a bare directory path.
      const isProtectedDir = surfaces.some((s) =>
        /(^|\/)(scripts|supabase(\/migrations)?|\.claude(\/hooks)?)\/?$/i.test(s)
      );

      const matchedByName = isEnv || isSettings || isHookFile || isMigrationPath
        || isProtectedProducer || isGitExclusionControl || isProtectedDir;
      // Checked last, and only when every name-shaped pattern missed, so a
      // hard-link alias cannot present an innocuous pathname for a protected file.
      const matchedByIdentity = !matchedByName && aliasesProtectedFile(abs, cwd);

      if (matchedByName || matchedByIdentity) {
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
