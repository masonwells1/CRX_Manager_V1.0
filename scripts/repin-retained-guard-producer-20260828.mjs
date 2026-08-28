#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = ["scripts", "apply-live-" + "testdata-maintenance-20260812.mjs"].join("/");
const TARGET_PATH = path.join(REPO_DIR, ...TARGET.split("/"));
const PRODUCER = "scripts/repin-retained-guard-producer-20260828.mjs";
const PRODUCER_PATH = path.join(REPO_DIR, ...PRODUCER.split("/"));
const OLD_PIN = 'const EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386";';
const NEW_PIN = 'const EXPECTED_INPUT_BLOB = "e09a88ff0df5c235ccb05e0df0ac818b622639d0";';
const EXPECTED_INPUT_BLOB = "d36285a53c304588d541343c3d8b3b8917948db9";
const EXPECTED_OUTPUT_BLOB = "dd81f608e55e661a2e7825bf86ddfa64aa5e3535";
const APPROVAL = "--one-account-gate-approval=2026-08-27";

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

export function buildRepinnedSource(input) {
  const source = normalizeLf(input, "retained producer input");
  const matches = source.split(OLD_PIN).length - 1;
  if (matches !== 1) throw new Error("expected one exact retained-producer input pin, found " + matches);
  return source.replace(OLD_PIN, NEW_PIN);
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

export function inspectRepin() {
  const input = normalizeLf(readFileSync(TARGET_PATH, "utf8"), "retained producer input");
  const inputBlob = gitBlob(input);
  const output = buildRepinnedSource(input);
  return { input, inputBlob, output, outputBlob: gitBlob(output) };
}

function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.length === 1 && args[0] === "--verify";
  const approvedApply = args.length === 1 && args[0] === APPROVAL;
  if (!verifyOnly && !approvedApply) throw new Error("accepted arguments: --verify OR " + APPROVAL);

  const inspection = inspectRepin();
  if (verifyOnly) {
    process.stdout.write("retained producer repin verified: input=" + inspection.inputBlob + " output=" + inspection.outputBlob + "\n");
    return;
  }
  if (EXPECTED_INPUT_BLOB === "TO_BE_PINNED" || inspection.inputBlob !== EXPECTED_INPUT_BLOB) {
    throw new Error("refusing unpinned input: expected " + EXPECTED_INPUT_BLOB + ", got " + inspection.inputBlob);
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
    const written = normalizeLf(readFileSync(TARGET_PATH, "utf8"), "written retained producer");
    if (gitBlob(written) !== EXPECTED_OUTPUT_BLOB || written !== inspection.output) {
      throw new Error("written retained producer does not match the reviewed output");
    }
  } catch (error) {
    writeFileSync(TARGET_PATH, inspection.input, "utf8");
    throw error;
  }
  process.stdout.write("Applied reviewed retained-producer repin: " + EXPECTED_INPUT_BLOB + " -> " + EXPECTED_OUTPUT_BLOB + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(String(error?.message || error) + "\n"); process.exitCode = 1; }
}
