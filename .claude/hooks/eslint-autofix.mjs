#!/usr/bin/env node
// Auto-eslint --fix on TypeScript/TSX edits in src/.
// PostToolUse hook — runs AFTER a successful Write/Edit. Cannot block (the file is already written).
// Purpose: catch import-order, semi, prefer-const, and the local-rules warnings (assertRpcResult, etc.)
// at edit time instead of at pre-commit time, so the model sees the lint output immediately.
//
// Behavior:
//   - Only acts on .ts / .tsx files in src/
//   - Skips test files (.test.tsx?, .spec.tsx?) — those have looser conventions
//   - Skips files in supabase/migrations/, supabase/functions/, node_modules/, scripts/, eslint-local-rules/
//   - Runs `npx eslint --fix --no-warn-ignored <file>` with a 15s timeout
//   - If eslint fails (errors remain after fix), emits a `hookSpecificOutput.additionalContext`
//     so the model is told what's still wrong without crashing the turn.
//   - If eslint succeeds, exits silently.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: extra }
    }));
  }
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}

const rawPath = payload?.tool_input?.file_path || "";
const filePath = rawPath.replace(/\\/g, "/");
if (!filePath) emit();

const isTs = /\.tsx?$/.test(filePath);
const isTest = /\.(test|spec)\.tsx?$/.test(filePath);
const inSrc = filePath.includes("/src/");
const excluded = /node_modules\/|supabase\/(migrations|functions)\/|\/scripts\/|\/eslint-local-rules\//.test(filePath);

if (!isTs || isTest || !inSrc || excluded) emit();

// Run eslint --fix on the single file. Invoke the project's own eslint through
// the current node binary — `npx` via a shell re-resolves the package on every
// edit and was the single slowest hook in the 2026-08-18 audit (p90 ~15s).
// --cache skips files eslint has already seen unchanged. Fall back to the old
// npx path only if the local install is missing (e.g. deps not installed yet).
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const eslintBin = path.join(projectDir, "node_modules", "eslint", "bin", "eslint.js");
const cacheLocation = path.join(projectDir, "node_modules", ".cache", "eslint-autofix");
const result = existsSync(eslintBin)
  ? spawnSync(
      process.execPath,
      [eslintBin, "--fix", "--no-warn-ignored", "--cache", "--cache-location", cacheLocation, rawPath],
      { timeout: 15000, encoding: "utf8", cwd: projectDir }
    )
  : spawnSync(
      `npx eslint --fix --no-warn-ignored "${rawPath}"`,
      { shell: true, timeout: 15000, encoding: "utf8", cwd: projectDir }
    );

// status 0 = clean (or fixed); status 1 = remaining errors; status > 1 = config/crash
if (result.status === 0) emit();

// Killed by the 15s timeout (cold start / slow disk) — NOT a lint failure. Stay
// silent rather than reporting a misleading "could not fix" message; pre-commit
// lint remains the real gate.
if (result.signal || result.error) emit();

// Report what's still wrong so the model can address it.
const stderr = (result.stderr || "").trim();
const stdout = (result.stdout || "").trim();
const summary = (stdout || stderr || "(eslint exited non-zero with no output)").slice(0, 1500);

emit(
  `eslint-autofix ran on ${filePath} and could not fix all issues. Remaining lint output below — ` +
  `please address before continuing:\n\n${summary}`
);
