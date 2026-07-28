#!/usr/bin/env node
// Regression fixtures for the 2026-07-28 Windows hook fail-open. Every one of
// these "broken" forms is expanded by the PowerShell parent that launches the
// hook, which is what silently disabled all 30 Codex Windows guards. A test that
// only proves the fixed file passes proves nothing, so each broken form is
// asserted to FAIL and each safe form to PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasWindowsShellVariable, findWindowsShellVariableHooks } from "./windows-hook-command.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── rejected: every PowerShell expansion form ────────────────────────────────
// The exact command that shipped broken, verbatim from the pre-fix hooks.json.
ok(hasWindowsShellVariable("$root = git rev-parse --show-toplevel; node (Join-Path $root '.claude/hooks/sql-safety.mjs')"), "rejects the original bare $root command");
ok(hasWindowsShellVariable("node (Join-Path ${root} '.claude/hooks/sql-safety.mjs')"), "rejects braced ${root}");
ok(hasWindowsShellVariable("node (Join-Path $env:REPO_ROOT '.claude/hooks/sql-safety.mjs')"), "rejects $env: scope access");
ok(hasWindowsShellVariable("node (Join-Path $(git rev-parse --show-toplevel) '.claude/hooks/sql-safety.mjs')"), "rejects $(...) subexpression");
ok(hasWindowsShellVariable("node $_"), "rejects the $_ pipeline variable");

// ── accepted: the fixed form and other expansion-free commands ───────────────
ok(!hasWindowsShellVariable("node (Join-Path (git rev-parse --show-toplevel) '.claude/hooks/sql-safety.mjs')"), "accepts the fixed inline command group");
ok(!hasWindowsShellVariable(""), "empty command has nothing to expand");
ok(!hasWindowsShellVariable(undefined), "missing command has nothing to expand");

// ── live check against the real manifest ─────────────────────────────────────
const codexHooks = JSON.parse(readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8"));
const allHooks = Object.values(codexHooks.hooks || {})
  .flatMap((entries) => entries)
  .flatMap((entry) => entry.hooks || [])
  .filter((hook) => hook.type === "command");
ok(allHooks.length > 0, "real manifest has command hooks to check");
ok(findWindowsShellVariableHooks(allHooks).length === 0, `all ${allHooks.length} real Windows hook commands are expansion-free`);

// The detector must actually be able to fail — feed it a poisoned copy.
const poisoned = allHooks.map((hook, i) => (i === 0 ? { ...hook, commandWindows: `node (Join-Path \${root} 'x.mjs')` } : hook));
ok(findWindowsShellVariableHooks(poisoned).length === 1, "detector catches a single reintroduced ${root} among real hooks");

console.log(`PASS - windows-hook-command (${pass} assertions)`);
