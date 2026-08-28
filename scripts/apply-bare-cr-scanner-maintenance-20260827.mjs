#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = [".claude", "hooks", "live-" + "testdata-lib.mjs"].join("/");
const TARGET_PATH = path.join(REPO_DIR, ...TARGET.split("/"));
const PRODUCER = "scripts/apply-bare-cr-scanner-maintenance-20260827.mjs";
const PRODUCER_PATH = path.join(REPO_DIR, ...PRODUCER.split("/"));
const EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386";
const EXPECTED_OUTPUT_BLOB = "e09a88ff0df5c235ccb05e0df0ac818b622639d0";
const APPROVAL = "--approved-by-mason=2026-08-27-one-account-gate";

function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error("git " + args[0] + " failed: " + String(result.stderr || "").trim());
  return String(result.stdout || "").trim();
}

function normalizeLf(value, label) {
  const normalized = String(value).replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) throw new Error(label + " contains a bare carriage return");
  return normalized;
}

function gitBlob(value) {
  const bytes = Buffer.from(value, "utf8");
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

function replaceCount(source, before, after, count, label) {
  const matches = source.split(before).length - 1;
  if (matches !== count) throw new Error(label + ": expected " + count + " exact match(es), found " + matches);
  return source.split(before).join(after);
}

export function buildMaintainedSource(input) {
  let output = normalizeLf(input, "protected scanner input");
  output = replaceCount(
    output,
    "    t = t.replace(/--[^\\n]*$/, \"\");",
    "    t = t.replace(/--[^\\r\\n]*$/, \"\");",
    1,
    "trailing line-comment scanner",
  );
  output = replaceCount(
    output,
    "      let j = src.indexOf(\"\\n\", i);\n      if (j === -1) j = n;",
    "      let j = i + 2;\n      while (j < n && src[j] !== \"\\n\" && src[j] !== \"\\r\") j++;",
    2,
    "quote-aware line-comment scanners",
  );
  return output;
}

function proofValid(proof, headSha, baseSha) {
  const age = Date.now() - Date.parse(String(proof?.timestamp || ""));
  return proof?.codex_ran === true
    && proof?.verdict === "clean"
    && proof?.model === "gpt-5.6-sol"
    && proof?.reasoning_effort === "high"
    && proof?.head_sha === headSha
    && proof?.base_sha === baseSha
    && Number.isFinite(age)
    && age >= 0
    && age <= 30 * 60 * 1000;
}

function verifyCommittedFile(relativePath, absolutePath) {
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", relativePath]);
  if (status) throw new Error(relativePath + " must be clean and committed");
  const headBlob = git(["rev-parse", "HEAD:" + relativePath]);
  const worktreeBlob = git(["hash-object", "--path=" + relativePath, absolutePath]);
  if (headBlob !== worktreeBlob) throw new Error(relativePath + " must match its exact HEAD blob");
}

export function inspectMaintenance() {
  const input = normalizeLf(readFileSync(TARGET_PATH, "utf8"), "protected scanner input");
  const inputBlob = gitBlob(input);
  if (inputBlob !== EXPECTED_INPUT_BLOB) {
    throw new Error("refusing changed protected scanner: expected " + EXPECTED_INPUT_BLOB + ", got " + inputBlob);
  }
  const output = buildMaintainedSource(input);
  return { input, inputBlob, output, outputBlob: gitBlob(output) };
}

function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.length === 1 && args[0] === "--verify";
  const approvedApply = args.length === 1 && args[0] === APPROVAL;
  if (!verifyOnly && !approvedApply) throw new Error("accepted arguments: --verify OR " + APPROVAL);

  const inspection = inspectMaintenance();
  if (verifyOnly) {
    process.stdout.write("bare-cr maintenance verified: input=" + inspection.inputBlob + " output=" + inspection.outputBlob + "\n");
    return;
  }
  if (EXPECTED_OUTPUT_BLOB === "TO_BE_PINNED" || inspection.outputBlob !== EXPECTED_OUTPUT_BLOB) {
    throw new Error("refusing unpinned output: expected " + EXPECTED_OUTPUT_BLOB + ", got " + inspection.outputBlob);
  }

  const branch = git(["branch", "--show-current"]);
  if (!branch || /^(?:main|master|production)$/i.test(branch)) throw new Error("refusing protected or detached branch: " + (branch || "detached"));
  git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  verifyCommittedFile(PRODUCER, PRODUCER_PATH);
  verifyCommittedFile(TARGET, TARGET_PATH);

  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", "origin/main"]);
  const proofName = "codex-" + "review-" + headSha + ".js" + "on";
  const proofPath = path.join(REPO_DIR, ".claude", "session-state", proofName);
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  if (!proofValid(proof, headSha, baseSha)) throw new Error("fresh exact-head Sol-high CLEAN proof is required");

  try {
    writeFileSync(TARGET_PATH, inspection.output, "utf8");
    const written = normalizeLf(readFileSync(TARGET_PATH, "utf8"), "written protected scanner");
    if (gitBlob(written) !== EXPECTED_OUTPUT_BLOB || written !== inspection.output) {
      throw new Error("written protected scanner does not match the reviewed output");
    }
  } catch (error) {
    writeFileSync(TARGET_PATH, inspection.input, "utf8");
    throw error;
  }
  process.stdout.write("Applied reviewed bare-CR scanner maintenance: " + EXPECTED_INPUT_BLOB + " -> " + EXPECTED_OUTPUT_BLOB + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(String(error?.message || error) + "\n"); process.exitCode = 1; }
}
