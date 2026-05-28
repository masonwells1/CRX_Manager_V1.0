#!/usr/bin/env node
// SessionStart staleness checks. Surfaces things that have drifted while the
// laptop was closed:
//   - schema-registry.json older than 7 days
//   - CLAUDE.md "Current State" counts that don't match reality (pages, migrations)
//   - Uncommitted files from a prior session
//
// Returns a "prompt" hookSpecificOutput.additionalContext so Claude sees the
// warnings at session start and can mention them to Mason proactively.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extra }
    }));
  }
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const warnings = [];

// ─── CHECK 1 — schema registry staleness ─────────────────────────────────
const registryPath = path.join(projectDir, ".claude", "schema-registry.json");
try {
  if (existsSync(registryPath)) {
    const stat = statSync(registryPath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      warnings.push(
        `📅 Schema registry is ${Math.round(ageDays)} days old (last regenerated ${stat.mtime.toISOString().slice(0, 10)}).\n` +
        `   This is the source of truth for 4 PreToolUse hooks and the review subagents.\n` +
        `   Recommend: invoke /regen-schema-registry to refresh from live Supabase.`
      );
    }
  }
} catch { /* ignore */ }

// ─── CHECK 2 — CLAUDE.md count drift ─────────────────────────────────────
const claudeMdPath = path.join(projectDir, "CLAUDE.md");
try {
  if (existsSync(claudeMdPath)) {
    const md = readFileSync(claudeMdPath, "utf8");

    // Page count: count `lazy(` in src/App.tsx
    let actualPages = 0;
    try {
      const app = readFileSync(path.join(projectDir, "src", "App.tsx"), "utf8");
      actualPages = (app.match(/lazy\(/g) || []).length;
    } catch { /* ignore */ }

    // Migrations: count .sql files
    let actualMigrations = 0;
    try {
      const out = execFileSync("git", ["ls-files", "supabase/migrations/*.sql"], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        cwd: projectDir,
      });
      actualMigrations = out.split("\n").filter(l => l.trim()).length;
    } catch { /* ignore */ }

    // Pull claimed counts from the "Current State" section.
    // Patterns: "66 pages", "356 migrations"
    const claimedPagesMatch = md.match(/(\d+)\s+pages\b/);
    const claimedMigrationsMatch = md.match(/(\d+)\s+migrations\b/);
    const claimedPages = claimedPagesMatch ? Number(claimedPagesMatch[1]) : null;
    const claimedMigrations = claimedMigrationsMatch ? Number(claimedMigrationsMatch[1]) : null;

    if (claimedPages !== null && actualPages > 0 && claimedPages !== actualPages) {
      warnings.push(
        `📄 CLAUDE.md claims ${claimedPages} pages but src/App.tsx has ${actualPages} lazy() imports.\n` +
        `   Recommend: invoke /update-docs to sync.`
      );
    }
    if (claimedMigrations !== null && actualMigrations > 0 && claimedMigrations !== actualMigrations) {
      warnings.push(
        `🗄️  CLAUDE.md claims ${claimedMigrations} migrations but supabase/migrations/ has ${actualMigrations} files.\n` +
        `   Recommend: invoke /update-docs to sync.`
      );
    }
  }
} catch { /* ignore */ }

// ─── CHECK 3 — uncommitted files from prior session ──────────────────────
try {
  const porcelain = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    cwd: projectDir,
  });
  const lines = porcelain.split("\n").filter(l => l.trim());
  // Filter out the well-known untracked dirs from CLAUDE.md SessionStart context.
  const meaningfulLines = lines.filter(l => {
    const p = l.slice(3);
    return !p.startsWith(".claude/worktrees/")
      && !p.startsWith(".playwright-mcp/")
      && !p.startsWith("docs/audits/")  // audit-prompt scratch
      ;
  });
  if (meaningfulLines.length > 0) {
    const sample = meaningfulLines.slice(0, 6).map(l => "      " + l).join("\n");
    warnings.push(
      `📝 You have ${meaningfulLines.length} uncommitted file(s) from before this session:\n` +
      sample +
      (meaningfulLines.length > 6 ? `\n      ... and ${meaningfulLines.length - 6} more` : "") +
      `\n   Recommend: run /preflight before continuing — these might be in-progress work or forgotten changes.`
    );
  }
} catch { /* ignore */ }

if (warnings.length === 0) emit();

emit(
  `═══ SESSION STALENESS CHECK ═══\n\n` +
  warnings.join("\n\n") +
  `\n\n   (These warnings come from .claude/hooks/session-staleness.mjs.\n` +
  `    Mention them to Mason if relevant to the task he asks about.)`
);
