#!/usr/bin/env node
// SessionStart staleness checks. Surfaces things that have drifted while the
// laptop was closed:
//   - schema-registry.json BEHIND the migrations on disk (content-based, C3 v2:
//     compares registry _meta.migrations_high_water against the highest
//     supabase/migrations/*.sql filename stamp; falls back to the old 7-day
//     mtime check for a v1-shaped registry without a high-water mark)
//   - CLAUDE.md "Current State" counts that don't match reality (pages, migrations)
//   - Uncommitted files from a prior session
//
// Returns a "prompt" hookSpecificOutput.additionalContext so Claude sees the
// warnings at session start and can mention them to Mason proactively.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

// ─── CHECK 1 — schema registry staleness (content-based, not mtime) ──────
const registryPath = path.join(projectDir, ".claude", "schema-registry.json");
try {
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const highWater = registry?._meta?.migrations_high_water;

    if (highWater && /^\d{14}$/.test(String(highWater))) {
      // v2: compare the registry's applied-migration high water against the
      // highest migration filename stamp on disk. mtime lies (a git checkout
      // refreshes it); content doesn't.
      const migDir = path.join(projectDir, "supabase", "migrations");
      const newer = [];
      if (existsSync(migDir)) {
        for (const f of readdirSync(migDir)) {
          const m = f.match(/^(\d{14})_.+\.sql$/);
          if (m && m[1] > String(highWater)) newer.push(f);
        }
      }
      if (newer.length > 0) {
        newer.sort();
        const sample = newer.slice(0, 5).map(f => "      " + f).join("\n");
        warnings.push(
          `📅 Schema registry is BEHIND the migrations on disk: registry high-water is ${highWater}, ` +
          `but ${newer.length} migration file(s) carry a newer stamp:\n` + sample +
          (newer.length > 5 ? `\n      ... and ${newer.length - 5} more` : "") +
          `\n   If these were applied live, the 4 schema-aware hooks are validating against a stale schema —\n` +
          `   invoke /regen-schema-registry. If they are written-but-unapplied, apply (or park) them first.`
        );
      }
    } else {
      // v1-shaped registry (no high-water mark): fall back to the mtime check.
      const stat = statSync(registryPath);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        warnings.push(
          `📅 Schema registry is ${Math.round(ageDays)} days old (last regenerated ${stat.mtime.toISOString().slice(0, 10)}) ` +
          `and has no _meta.migrations_high_water (v1 shape).\n` +
          `   This is the source of truth for 4 PreToolUse hooks and the review subagents.\n` +
          `   Recommend: invoke /regen-schema-registry to refresh from live Supabase (also upgrades it to v2).`
        );
      }
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
