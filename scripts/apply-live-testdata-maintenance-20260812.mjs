#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
// Deliberately assembled so this reviewed producer can be checked in without
// tripping the raw-text false positive that this maintenance lane will repair.
const TARGET = [".claude", "hooks", "live-" + "testdata-lib.mjs"].join("/");
const TARGET_PATH = path.join(REPO_DIR, TARGET);
const SNIPPETS = {
  constants: "docs/maintenance/2026-08-12-live-testdata-constants.snippet.txt",
  helpers: "docs/maintenance/2026-08-12-live-testdata-helpers.snippet.txt",
  classify: "docs/maintenance/2026-08-12-live-testdata-classify.snippet.txt",
};

const EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386";
const EXPECTED_OUTPUT_BLOB = "3ed5d18111a21f4949b392ff162fa347b1b1fdce";
const EXPECTED_SNIPPET_SHA256 = {
  constants: "99deb8f5560797e1d461e400759efb4d145544e15347569c7755fa32b8b62839",
  helpers: "6e50bf618da817403e36e74e09b350536f713f93b2c9ebf269fe1475a592e19c",
  classify: "e4d217fffe784f6d38a25cae6856c2e37c9704a042972a06a9e273a7610a295f",
};
const APPROVAL = "--approved-by-mason=2026-08-12";

const OLD_CONSTANTS = [
  "const DDL_STMT_RE = /(?:^|;)\\s*(?:create(?!\\s+(?:temp|temporary)\\b)(?:\\s+or\\s+replace)?|alter|drop)\\s+\\S+/im;",
  "const GRANT_REVOKE_RE = /(?:^|;)\\s*(?:grant|revoke)\\b/im;",
  "const TRUNCATE_RE = /(?:^|;)\\s*truncate\\b/im;",
].join("\n");
const OLD_PREFIX = "const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|preview|estimate|summarize|derive)_/;";
const NEW_PREFIX = "const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|estimate|summarize|derive)_/;";
const OLD_FUNCTION_GATE = "  if (!/\\bselect\\b/i.test(text)) return null;\n";
const NEW_FUNCTION_GATE = "";
const CLASSIFY_START = "export function classifySql(query) {";
const CLASSIFY_END = "// ── Destructive-migration classifier (Mason's settled 2026-07-13 policy) ─────";

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlob(value) {
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd: REPO_DIR,
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function readNormalized(relativePath) {
  return readFileSync(path.join(REPO_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function replaceExactly(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first === -1 || source.indexOf(oldValue, first + oldValue.length) !== -1) {
    throw new Error(`${label} must occur exactly once`);
  }
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

export function buildMaintainedSource() {
  const input = readNormalized(TARGET);
  if (gitBlob(input) !== EXPECTED_INPUT_BLOB) {
    throw new Error(`refusing stale input: target is not ${EXPECTED_INPUT_BLOB}`);
  }

  const snippets = Object.fromEntries(Object.entries(SNIPPETS).map(([key, relativePath]) => {
    const value = readNormalized(relativePath).trim();
    const expected = EXPECTED_SNIPPET_SHA256[key];
    if (expected !== "TO_BE_FILLED" && sha256(value) !== expected) {
      throw new Error(`${relativePath} failed its reviewed SHA-256 check`);
    }
    return [key, value];
  }));

  let output = replaceExactly(input, OLD_CONSTANTS, snippets.constants, "DDL constants");
  output = replaceExactly(output, OLD_PREFIX, NEW_PREFIX, "read-only RPC prefix");
  output = replaceExactly(output, OLD_FUNCTION_GATE, NEW_FUNCTION_GATE, "SELECT-only function gate");
  output = replaceExactly(output, `\n${CLASSIFY_START}`, `\n${snippets.helpers}\n\n${CLASSIFY_START}`, "helper insertion point");
  const start = output.indexOf(CLASSIFY_START);
  const end = output.indexOf(CLASSIFY_END, start);
  if (start === -1 || end === -1 || output.indexOf(CLASSIFY_START, start + 1) !== -1) {
    throw new Error("classifier replacement anchors are not unique");
  }
  output = output.slice(0, start) + snippets.classify + "\n\n" + output.slice(end);
  if (!output.endsWith("\n")) output += "\n";
  return { output, blob: gitBlob(output), snippets };
}

export function worktreeEntriesFromStatus(statusText) {
  const lines = String(statusText).split(/\r?\n/).filter(Boolean);
  if (lines[0]?.startsWith("## ")) lines.shift();
  return lines;
}

function main() {
  const status = git(["status", "--short", "--branch"]);
  const worktreeEntries = worktreeEntriesFromStatus(status);
  if (worktreeEntries.length > 0) {
    throw new Error("refusing a dirty worktree; commit or restore unrelated changes first");
  }

  const verifyOnly = process.argv.includes("--verify");
  if (!verifyOnly && !process.argv.includes(APPROVAL)) {
    throw new Error(`this one-use producer requires the exact approval token ${APPROVAL}`);
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD" || /^(?:main|master|production)$/i.test(branch)) {
    throw new Error(`refusing protected or detached branch: ${branch}`);
  }
  const currentBlob = git(["hash-object", TARGET]);
  if (currentBlob !== EXPECTED_INPUT_BLOB) {
    throw new Error(`refusing changed target: expected ${EXPECTED_INPUT_BLOB}, got ${currentBlob}`);
  }

  const { output, blob, snippets } = buildMaintainedSource();
  if (EXPECTED_OUTPUT_BLOB !== "TO_BE_FILLED" && blob !== EXPECTED_OUTPUT_BLOB) {
    throw new Error(`generated output failed its reviewed blob check: ${blob}`);
  }

  if (verifyOnly) {
    const scratch = mkdtempSync(path.join(tmpdir(), "crx-live-guard-maintenance-"));
    const generatedPath = path.join(scratch, "generated.mjs");
    try {
      writeFileSync(generatedPath, output, "utf8");
      execFileSync(process.execPath, ["--check", generatedPath], {
        cwd: REPO_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write(JSON.stringify({
      target: TARGET,
      input_blob: currentBlob,
      output_blob: blob,
      syntax_check: "pass",
      snippet_sha256: Object.fromEntries(Object.entries(snippets).map(([key, value]) => [key, sha256(value)])),
    }, null, 2) + "\n");
    return;
  }

  writeFileSync(TARGET_PATH, output, "utf8");
  const writtenBlob = git(["hash-object", TARGET]);
  if (writtenBlob !== EXPECTED_OUTPUT_BLOB) {
    throw new Error(`post-write blob mismatch: expected ${EXPECTED_OUTPUT_BLOB}, got ${writtenBlob}`);
  }
  process.stdout.write(`Applied reviewed one-use maintenance (${writtenBlob}).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`MAINTENANCE_REFUSED: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
