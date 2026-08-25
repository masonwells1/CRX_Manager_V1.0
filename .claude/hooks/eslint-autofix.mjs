#!/usr/bin/env node
// Auto-eslint --fix on TypeScript/TSX edits in src/.
// PostToolUse hook — runs AFTER a successful Write/Edit. Cannot block (the file is already written).
// Purpose: catch import-order, semi, prefer-const, and the local-rules warnings (assertRpcResult, etc.)
// at edit time instead of waiting for explicit preflight or CI, so the model sees the lint output immediately.
//
// Behavior:
//   - Only acts on .ts / .tsx files in src/
//   - Skips test files (.test.tsx?, .spec.tsx?) — those have looser conventions
//   - Skips files in supabase/migrations/, supabase/functions/, node_modules/, scripts/, eslint-local-rules/
//   - Runs the project's local eslint with `--fix --no-warn-ignored --cache` and a 15s timeout;
//     skips silently if the local eslint install is missing (no shell fallback)
//   - If eslint fails (errors remain after fix), emits a `hookSpecificOutput.additionalContext`
//     so the model is told what's still wrong without crashing the turn.
//   - If eslint succeeds, exits silently.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
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
// edit and was the single slowest hook in the 2026-08-18 audit (p90 ~15.5s).
// --cache is passed but can't actually hit: this hook only ever runs right after
// the file it checks was just edited, and --cache-strategy defaults to "metadata"
// (size + mtime), so the just-written file never matches its cache entry.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const eslintBin = path.join(projectDir, "node_modules", "eslint", "bin", "eslint.js");

// No local eslint (deps not installed yet) — skip silently; explicit preflight
// and CI lint are the durable gates. Deliberately no npx fallback: interpolating the edited file's
// path into a shell string is a command-injection surface (CodeRabbit, PR #413).
if (!existsSync(eslintBin)) emit();

// Redundant: flat-cache (4.0.1) creates this directory itself in writeJSON, with
// { recursive: true }, so the first run is covered too. Kept as a cheap defensive
// call; nothing downstream depends on it.
const cacheLocation = path.join(projectDir, "node_modules", ".cache", "eslint-autofix");
try { mkdirSync(path.dirname(cacheLocation), { recursive: true }); } catch { /* best effort */ }

const result = spawnSync(
  process.execPath,
  [eslintBin, "--fix", "--no-warn-ignored", "--cache", "--cache-location", cacheLocation, rawPath],
  { timeout: 15000, encoding: "utf8", cwd: projectDir }
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
