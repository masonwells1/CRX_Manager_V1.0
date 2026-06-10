#!/usr/bin/env node
// C7 — dependency integrity verifier
// (docs/audits/2026-06-10-error-prevention-review.md §4)
//
// WHY: PR #66 bumped vitest to 4.x but left vite at 5.x — `npm ci` tolerated
// the broken peer range so CI stayed green, while a plain `npm install` on
// main hit ERESOLVE. "Green" validation that didn't test what it claimed.
//
// WHAT IT DOES:
//   1. Always: compares INSTALLED vitest/vite versions (node_modules) against
//      the LOCKFILE versions (package-lock.json `packages` map) and prints them.
//      Mismatch or missing install = problem.
//   2. If package-lock.json changed vs HEAD (`git diff --name-only HEAD`),
//      or --force is passed: runs `npm ci --dry-run` and `npm ls`, scanning
//      both for ERESOLVE / peer-dependency / invalid / missing problems.
//
// Usage:   node scripts/verify-deps.mjs [--force]
// Exit:    0 = clean, 1 = problems found.
// Deps:    none (node builtins only — zero new packages, by design).

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const force = process.argv.includes("--force");

// Packages whose installed-vs-locked versions we always surface (the pair
// that bit us in PR #66; vitest 4 peers on vite ^6||^7||^8).
const WATCHED = ["vitest", "vite", "@vitejs/plugin-react"];

// Patterns that mark npm output as a real problem. Documented because they
// are heuristics over human-readable npm output:
//   /ERESOLVE/                     — npm's unresolvable-tree error code
//   /peer dep(endency)? (missing|conflict)/i, /Conflicting peer dependency/i
//   /UNMET DEPENDENCY/             — npm ls marker for a missing package
//   /^.*\binvalid:/m               — npm ls marker for a version that violates a range
//   /missing:/                     — npm ls marker for a lockfile entry not on disk
const PROBLEM_PATTERNS = [
  /ERESOLVE/,
  /Conflicting peer dependency/i,
  /peer dep(endency)?s? (missing|conflict)/i,
  /UNMET DEPENDENCY/,
  /\binvalid:/,
  /\bmissing:/,
];

const problems = [];

function run(cmd) {
  // shell:true so `npm` resolves to npm.cmd on Windows.
  const res = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    out: `${res.stdout || ""}\n${res.stderr || ""}`,
    error: res.error,
  };
}

function excerpt(out, max = 20) {
  const interesting = out
    .split("\n")
    .filter(l => PROBLEM_PATTERNS.some(re => re.test(l)) || /^npm e?rr/i.test(l.trim()))
    .slice(0, max);
  return (interesting.length ? interesting : out.split("\n").slice(0, max))
    .map(l => "    " + l)
    .join("\n");
}

// ─── 1. Installed vs lockfile versions ────────────────────────────────────
let lock = null;
try {
  lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
} catch (e) {
  problems.push(`Cannot read/parse package-lock.json: ${e.message}`);
}

console.log("── verify-deps: installed vs lockfile ──────────────────────────");
for (const name of WATCHED) {
  const locked = lock?.packages?.[`node_modules/${name}`]?.version ?? "(not in lockfile)";
  let installed = "(not installed)";
  const pkgJson = path.join(root, "node_modules", ...name.split("/"), "package.json");
  if (existsSync(pkgJson)) {
    try { installed = JSON.parse(readFileSync(pkgJson, "utf8")).version; } catch { /* keep default */ }
  }
  const ok = installed === locked;
  console.log(`  ${name.padEnd(24)} lockfile=${String(locked).padEnd(12)} installed=${String(installed).padEnd(12)} ${ok ? "OK" : "** MISMATCH **"}`);
  if (!ok) {
    problems.push(`${name}: installed (${installed}) != lockfile (${locked}) — run \`npm ci\` (or the lockfile is wrong).`);
  }
}

// ─── 2. Did the lockfile change vs HEAD? ──────────────────────────────────
const diff = run("git diff --name-only HEAD");
const lockChanged = diff.status === 0 && /(^|\n)package-lock\.json(\n|$)/.test(diff.out);
console.log(`\n  package-lock.json changed vs HEAD: ${lockChanged ? "YES" : "no"}${force ? " (--force: running full checks anyway)" : ""}`);

if (lockChanged || force) {
  // ─── npm ci --dry-run: does the lockfile actually install cleanly? ──────
  console.log("\n── npm ci --dry-run ─────────────────────────────────────────────");
  const ci = run("npm ci --dry-run");
  const ciBad = ci.status !== 0 || PROBLEM_PATTERNS.some(re => re.test(ci.out));
  if (ci.error) problems.push(`npm ci --dry-run failed to spawn: ${ci.error.message}`);
  if (ciBad) {
    problems.push("`npm ci --dry-run` reported problems (ERESOLVE / peer conflicts / non-zero exit):");
    console.log(excerpt(ci.out));
  } else {
    console.log("  clean (exit 0, no ERESOLVE/peer markers)");
  }

  // ─── npm ls: is the installed tree valid against package.json ranges? ───
  console.log("\n── npm ls ───────────────────────────────────────────────────────");
  const ls = run("npm ls");
  const lsBad = ls.status !== 0 || PROBLEM_PATTERNS.some(re => re.test(ls.out));
  if (ls.error) problems.push(`npm ls failed to spawn: ${ls.error.message}`);
  if (lsBad) {
    problems.push("`npm ls` reported problems (invalid/missing/peer — ELSPROBLEMS):");
    console.log(excerpt(ls.out));
  } else {
    console.log("  clean (exit 0, tree valid)");
  }
} else {
  console.log("  Skipping `npm ci --dry-run` + `npm ls` (lockfile unchanged; pass --force to run them anyway).");
}

// ─── Verdict ──────────────────────────────────────────────────────────────
console.log("\n── verdict ──────────────────────────────────────────────────────");
if (problems.length === 0) {
  console.log("  PASS — dependency tree consistent with lockfile.");
  process.exit(0);
}
console.log(`  FAIL — ${problems.length} problem(s):`);
for (const p of problems) console.log(`   • ${p}`);
console.log("\n  A green `npm ci` is NOT proof the lockfile is healthy — `npm install` may still ERESOLVE. Fix peer ranges before merging.");
process.exit(1);
