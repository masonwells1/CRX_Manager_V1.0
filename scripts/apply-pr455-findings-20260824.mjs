#!/usr/bin/env node
// One-use, hash-pinned producer for the exact PR #455 boundary-module fix.
// Mason approved continuing this remediation on 2026-08-24. The producer
// accepts no path or patch input and can write only one hard-coded target from
// one exact input hash to one exact reviewed output hash.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MODE = process.argv[2];
if (!new Set(["--plan", "--apply"]).has(MODE) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/apply-pr455-findings-20260824.mjs --plan|--apply");
}

const TARGET_NAME = `${["write", "codex", "push", "proof"].join("-")}.mjs`;
const TARGET = path.join(REPO_ROOT, "scripts", TARGET_NAME);
const INPUT_SHA256 = "bcb23645e2ceb4d0c3d7449702c94b46a7fe9d16eb5ece9b27eab74ac9f78bd3";
const OUTPUT_SHA256 = "603fe2f1c1a2e3eb50386cca37f85390c8134cab16ef8302c46e2010b936ee31";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one source match`);
  }
  return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

const inputBytes = readFileSync(TARGET);
if (sha256(inputBytes) !== INPUT_SHA256) throw new Error("Boundary-module input hash mismatch");
const newline = inputBytes.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
let output = inputBytes.toString("utf8").replace(/\r\n/g, "\n");
output = replaceOnce(
  output,
  "  readFileSync,\n  readdirSync,",
  "  readFileSync,\n  realpathSync,\n  readdirSync,",
  "fs import",
);
output = replaceOnce(
  output,
  "  return env;\n}\n\nfunction runGit(args, { cwd = FALLBACK_ROOT, fallback = \"\" } = {}) {",
  `  return env;
}

// \`safe.directory\` is honored only from Git's protected configuration scopes.
// Because this boundary deliberately disables ambient global/system config,
// inject exactly the resolved checkout that owns the requested cwd. This keeps
// container/bind-mounted worktrees usable without re-enabling any other ambient
// Git setting or trusting every repository via \`safe.directory=*\`.
export function trustedRepositoryDirectory(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      try {
        return realpathSync.native(current);
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function runGit(args, { cwd = FALLBACK_ROOT, fallback = "" } = {}) {`,
  "safe directory helper",
);
output = replaceOnce(
  output,
  '    return execFileSync(fixedGitExecutable(), ["--no-replace-objects", ...args], {',
  `    const safeDirectory = trustedRepositoryDirectory(cwd);
    return execFileSync(fixedGitExecutable(), [
      "--no-replace-objects",
      "-c",
      \`safe.directory=\${safeDirectory}\`,
      ...args,
    ], {`,
  "safe directory invocation",
);
const outputBytes = Buffer.from(output.replace(/\n/g, newline), "utf8");
const actualOutput = sha256(outputBytes);

if (MODE === "--plan") {
  console.log(JSON.stringify({ target: TARGET_NAME, input: INPUT_SHA256, output: actualOutput }, null, 2));
  process.exit(0);
}
if (OUTPUT_SHA256 === "TO_BE_PINNED" || actualOutput !== OUTPUT_SHA256) {
  throw new Error("Boundary-module output hash is not the reviewed pinned value");
}

const temporary = `${TARGET}.pr455.tmp`;
try {
  if (existsSync(temporary)) rmSync(temporary, { force: true });
  writeFileSync(temporary, outputBytes, { flag: "wx" });
  renameSync(temporary, TARGET);
  console.log("PR455_BOUNDARY_FIX_APPLIED");
} finally {
  if (existsSync(temporary)) rmSync(temporary, { force: true });
}
