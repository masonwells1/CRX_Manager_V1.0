#!/usr/bin/env node
// PreToolUse guard on the native Write|Edit matcher.
//
// The MCP tool guard already denies file tools whose target is a second pathname
// for a protected file. The native Write/Edit tools were the remaining write
// route: an alias created by any means — `cp -l`, `link`, a junction hop, a
// language runtime's link() — could be edited here under an innocent pathname,
// changing a protected hook, migration, settings file, or `.env` without ever
// naming it (Codex, 2026-08-24).
//
// Pathname-shaped protection for these tools lives in settings.json's permission
// rules and the sibling content hooks; this adds the one property a second
// pathname cannot fake. It is checked in addition to those, never instead.
import { aliasesProtectedFile } from "./protected-identity-lib.mjs";
import path from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

function out(decision, reason) {
  if (decision === "allow") {
    process.stdout.write("");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

try {
  const payload = raw.trim() ? JSON.parse(raw) : null;
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  // Write uses file_path; Edit uses file_path too. Accept the common spellings
  // so a future tool shape cannot slip past by naming the field differently.
  const target = input.file_path || input.path || input.filePath || "";
  if (!target) out("allow");

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);

  if (aliasesProtectedFile(abs, cwd)) {
    out(
      "deny",
      `PROTECTED IDENTITY GUARD: ${target} is a second pathname for a protected file (same device and inode). Edit the real path so the guard hooks can inspect the change.`,
    );
  }
} catch (err) {
  // FAIL-OPEN, but loud: a broken guard must never brick the session. The
  // pathname-shaped protections still apply on this route.
  process.stderr.write(`protected-identity-guard.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

out("allow");
