#!/usr/bin/env node
// Bash safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version that overreached.
//
// Behavior:
//   - Block known dangerous patterns (force push, hard reset, --no-verify, rm -rf src, etc.)
//   - Block MODIFY of EXISTING files in supabase/migrations/ ONLY when target exists
//     (creating new files is allowed)
//   - Do NOT block writes to docs/

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const cmd = payload?.tool_input?.command || "";
if (!cmd) out("allow");

const checks = [
  [/git\s+push\s+(--force\b|-f\b|--force-with-lease\b)/, "Blocked force push. Force pushing rewrites remote history. Push to a new branch instead."],
  [/git\s+reset\s+--hard\b/, "Blocked `git reset --hard`. Permanently destroys uncommitted work. Use `git stash` or `git restore <file>`."],
  [/git\s+checkout\s+\.\s*(?:$|;|&|\|)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  [/git\s+restore\s+\.\s*(?:$|;|&|\|)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  [/git\s+clean\s+-[A-Za-z]*[fdx][A-Za-z]*\b/, "Blocked `git clean -f`. Permanently deletes untracked files. Review with `git clean -n` first."],
  [/--no-verify\b/, "Blocked `--no-verify`. Pre-commit hooks prevent bugs — fix the underlying issue."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+(?:\.\.?\s*(?:$|;|&|\|)|\.\.?\/(?:src|supabase|docs)(?:\b|\/)|\/?(?:src|supabase|docs)(?:\b|\/))/, "Blocked recursive deletion of project source/migrations/docs."],
  [/\bnpm\s+uninstall\s+(?:react|@supabase\/supabase-js|vite|typescript)\b/, "Blocked uninstall of a core dependency."],
  [/git\s+add\s+[^&|;]*\.env(?:\b|$)/, "Blocked staging of .env. Secrets must never be committed."],
  [/npx\s+supabase\s+db\s+push\b/, "Blocked `supabase db push`. Test migrations locally first."],
  [/npx\s+supabase\s+migration\s+repair\b/, "Blocked `supabase migration repair`. Causes migration history drift."],
  [/(?:npx\s+)?supabase\s+db\s+reset\b/, "Blocked `supabase db reset`. This wipes the entire local Supabase DB and re-runs all 356 migrations from scratch — minutes of work plus loss of any local test data. If you really need to reset, run it manually in a terminal where you can see the warnings."],
  [/\b(?:dropdb|createdb)\b/, "Blocked `dropdb`/`createdb`. Destructive at the database level — if you need a fresh DB, do it via Supabase dashboard with explicit confirmation."],
  [/\bgit\s+branch\s+(?:-D|--delete\s+--force)\s+(?:main|master|production)\b/, "Blocked force-delete of main/master/production branch. Almost never the right move."],
  [/\bgit\s+push\s+(?:--mirror|--prune)\b/, "Blocked `git push --mirror`/`--prune`. These can wipe remote branches in one shot."],
  [/\bgit\s+filter-(branch|repo)\b/, "Blocked `git filter-branch`/`filter-repo`. Rewrites entire repo history — destructive and slow."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+\/(?!tmp|var\/tmp|c\/CRX_Manager\/\.playwright-mcp|c\/CRX_Manager\/\.claude\/worktrees)/, "Blocked `rm -rf /<path>` outside known-safe scratch areas. Use a more specific path."],
  [/\bnpm\s+run\s+(?:reset|nuke|wipe)\b/, "Blocked suspicious `npm run reset/nuke/wipe`. Verify what this script does first."],
];

for (const [re, reason] of checks) {
  if (re.test(cmd)) out("block", reason);
}

if (/\b(?:DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i.test(cmd) && /(psql|supabase\s+sql|--?c\s)/i.test(cmd)) {
  out("block", "Blocked destructive SQL via psql/supabase. Add a migration instead.");
}

// Block MODIFY of EXISTING migration files only.
const cwd = process.cwd();
const migrationModifyRes = [
  /(?:>>?|2>&1\s*>>?)\s*['"]?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
  /(?:sed|perl|awk)\s+-[A-Za-z]*i[A-Za-z]*\b[^|;&]*?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
];

for (const re of migrationModifyRes) {
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const target = m[1].replace(/^['"]|['"]$/g, "");
    const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    try {
      if (existsSync(abs)) {
        out("block", `Blocked modification of existing migration file: ${target}. Existing migrations must never be edited — create a NEW migration that supersedes it.`);
      }
    } catch { /* ignore */ }
  }
}

out("allow");
