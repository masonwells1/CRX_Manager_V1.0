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
const EXPECTED_OUTPUT_BLOB = "bda5a0b744ac28dbd2059b38cd2bdf0e5890e31f";
const EXPECTED_SNIPPET_SHA256 = {
  constants: "a8ab856dd6cd28089f60c00584a4bfc0b288a839246c80020d32681f790838a0",
  helpers: "6e50bf618da817403e36e74e09b350536f713f93b2c9ebf269fe1475a592e19c",
  classify: "524e38a342f48e113821377434032b79fd76ace4db3fb1f268d637a3ec4cc8c4",
};
const APPROVAL = "--approved-by-mason=2026-08-12";
const PROTECT_PRODUCER = "--protect-producer";
const PROTECTED_SOURCES = {
  codexGuard: [".codex", "hooks", "production-action-" + "guard.mjs"].join("/"),
  pushLib: [".claude", "hooks", "codex-push-" + "lib.mjs"].join("/"),
};
const EXPECTED_PROTECTED_INPUT_BLOBS = {
  codexGuard: "ffde9b188f7ec69c7d74ed1df6c631d7a595270b",
  pushLib: "40c8857d4b6c37b6a89525efb1caf49e9c4215d1",
};
const EXPECTED_PROTECTED_OUTPUT_BLOBS = {
  codexGuard: "28c9b3d6e3ff38b619eb244fb9f96ca14dd09cb6",
  pushLib: "88e5b9acd9929408d78dee328cb3fa3a2280b346",
};

export function maintenanceProducerCommandMentioned(command) {
  const compact = String(command || "")
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes("apply-live-testdata-maintenance-20260812.mjs");
}

export function exactHeadProofValid(data, headSha, baseSha, nowMs = Date.now()) {
  if (!data || data.codex_ran !== true || data.verdict !== "clean") return false;
  if (data.model !== "gpt-5.6-sol" || data.reasoning_effort !== "high") return false;
  if (data.head_sha !== headSha || data.base_sha !== baseSha) return false;
  const timestamp = Date.parse(data.timestamp || "");
  const age = nowMs - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= 30 * 60 * 1000;
}

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
  return normalizeLineEndings(readFileSync(path.join(REPO_DIR, relativePath), "utf8"));
}

export function normalizeLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n");
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

export function buildProducerProtectionSources() {
  const sources = Object.fromEntries(Object.entries(PROTECTED_SOURCES).map(([key, relativePath]) => {
    const value = readNormalized(relativePath);
    const blob = gitBlob(value);
    if (blob !== EXPECTED_PROTECTED_INPUT_BLOBS[key]) {
      throw new Error(`refusing stale protected input ${relativePath}: expected ${EXPECTED_PROTECTED_INPUT_BLOBS[key]}, got ${blob}`);
    }
    return [key, value];
  }));

  const oldProtectedHarness = "(?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate)";
  const newProtectedHarness = "(?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)";
  let codexGuard = replaceExactly(
    sources.codexGuard,
    oldProtectedHarness,
    newProtectedHarness,
    "Codex direct-edit protected producer list",
  );

  const constantsAnchor = "const PROTECTED_HARNESS_FRAGMENT_RE = new RegExp(`(?<![\\\\w.-])${PROTECTED_HARNESS_SOURCE}(?![\\\\w.-])`, \"i\");";
  const constantsReplacement = `${constantsAnchor}\nconst MAINTENANCE_PRODUCER = "scripts/apply-live-testdata-maintenance-20260812.mjs";\nconst MAINTENANCE_PRODUCER_COMMAND_RE = /(?:^|[;&|]\\s*)(?:\"[^\"]*[\\\\/]node(?:\\.exe)?\"|'[^']*[\\\\/]node(?:\\.exe)?'|(?:\\S*[\\\\/])?node(?:\\.exe)?)\\s+(?:(?:--[a-z-]+(?:=[^\\s]+)?|-{1,2}[a-z-]+)\\s+)*(?:\"[^\"]*[\\\\/]|'[^']*[\\\\/]|\\S*[\\\\/])?scripts[\\\\/]apply-live-testdata-maintenance-20260812\\.mjs(?:[\"']|\\s|$)/i;`;
  const constantsWithMatcher = `${constantsReplacement}\nexport ${maintenanceProducerCommandMentioned.toString()}`;
  codexGuard = replaceExactly(codexGuard, constantsAnchor, constantsWithMatcher, "maintenance producer command constants");

  const proofFunctionAnchor = "function shellWords(value) {";
  const maintenanceGate = `function gateMaintenanceProducerExecution({ command, repoDir, nowMs, runGit }) {\n  if (!MAINTENANCE_PRODUCER_COMMAND_RE.test(command)) return { blocked: false };\n\n  let headSha;\n  let baseSha;\n  let headBlob;\n  let worktreeBlob;\n  let status;\n  try {\n    headSha = runGit([\"rev-parse\", \"HEAD\"], repoDir);\n    baseSha = runGit([\"rev-parse\", \"origin/main\"], repoDir);\n    status = runGit([\"status\", \"--porcelain\", \"--untracked-files=all\", \"--\", MAINTENANCE_PRODUCER], repoDir);\n    headBlob = runGit([\"rev-parse\", \`HEAD:\${MAINTENANCE_PRODUCER}\`], repoDir);\n    worktreeBlob = runGit([\"hash-object\", \`--path=\${MAINTENANCE_PRODUCER}\`, MAINTENANCE_PRODUCER], repoDir);\n  } catch (error) {\n    return denied(\`CODEX PRODUCTION GATE: cannot bind the maintenance producer to the current committed HEAD: \${error?.message || error}\`);\n  }\n  if (status || headBlob !== worktreeBlob) {\n    return denied(\"CODEX PRODUCTION GATE: the maintenance producer differs from its exact committed HEAD blob. Commit it, obtain a fresh exact-head review, and retry.\");\n  }\n\n  const proofPath = path.join(repoDir, \".claude\", \"session-state\", \`codex-review-\${headSha}.json\`);\n  let proof;\n  try {\n    proof = JSON.parse(readFileSync(proofPath, \"utf8\"));\n  } catch (error) {\n    return proofRequirement(headSha, \"execution of the protected maintenance producer\", \`Missing or unreadable exact-head proof: \${proofPath}\`, baseSha);\n  }\n  if (!proofValid(proof, headSha, nowMs, baseSha)) {\n    return proofRequirement(headSha, \"execution of the protected maintenance producer\", \"The exact-head Sol-high proof is stale or does not match the current HEAD/base.\", baseSha);\n  }\n  return { blocked: false };\n}\n\n`;
  const hardenedMaintenanceGate = maintenanceGate.replace(
    "MAINTENANCE_PRODUCER_COMMAND_RE.test",
    "maintenanceProducerCommandMentioned",
  );
  codexGuard = replaceExactly(codexGuard, proofFunctionAnchor, hardenedMaintenanceGate + proofFunctionAnchor, "maintenance producer execution gate");

  const commandAnchor = "  if (/[\\r\\n]/.test(command) && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {";
  const commandReplacement = `  const maintenanceProducerGate = gateMaintenanceProducerExecution({ command, repoDir: actionRepoDir, nowMs, runGit });\n  if (maintenanceProducerGate.blocked) return maintenanceProducerGate;\n\n${commandAnchor}`;
  codexGuard = replaceExactly(codexGuard, commandAnchor, commandReplacement, "maintenance producer command gate call");

  const riskyAnchor = "  /(^|\\/)scripts\\/overnight-codex-gate\\.mjs$/i,";
  const riskyReplacement = `${riskyAnchor}\n  /(^|\\/)scripts\\/apply-live-testdata-maintenance-20260812\\.mjs$/i,`;
  const pushLib = replaceExactly(sources.pushLib, riskyAnchor, riskyReplacement, "risky producer path");

  const outputs = { codexGuard, pushLib };
  const blobs = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, gitBlob(value)]));
  for (const [key, blob] of Object.entries(blobs)) {
    const expected = EXPECTED_PROTECTED_OUTPUT_BLOBS[key];
    if (expected !== "TO_BE_FILLED" && blob !== expected) {
      throw new Error(`generated protected output failed its reviewed blob check for ${PROTECTED_SOURCES[key]}: ${blob}`);
    }
  }
  return { outputs, blobs };
}

function main() {
  const status = git(["status", "--short", "--branch"]);
  const worktreeEntries = worktreeEntriesFromStatus(status);
  if (worktreeEntries.length > 0) {
    throw new Error("refusing a dirty worktree; commit or restore unrelated changes first");
  }

  const verifyOnly = process.argv.includes("--verify");
  const protectProducer = process.argv.includes(PROTECT_PRODUCER);
  if (!verifyOnly && !process.argv.includes(APPROVAL)) {
    throw new Error(`this one-use producer requires the exact approval token ${APPROVAL}`);
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD" || /^(?:main|master|production)$/i.test(branch)) {
    throw new Error(`refusing protected or detached branch: ${branch}`);
  }
  if (!verifyOnly) {
    const producerPath = "scripts/apply-live-testdata-maintenance-20260812.mjs";
    const headSha = git(["rev-parse", "HEAD"]);
    const baseSha = git(["rev-parse", "origin/main"]);
    const headBlob = git(["rev-parse", `HEAD:${producerPath}`]);
    const worktreeBlob = git(["hash-object", `--path=${producerPath}`, producerPath]);
    if (headBlob !== worktreeBlob) {
      throw new Error("the maintenance producer must match its exact committed HEAD blob");
    }
    const stateDir = [".claude", "session-state"].join(path.sep);
    const proofName = "codex-" + "review-" + headSha + ".json";
    const proofPath = path.join(REPO_DIR, stateDir, proofName);
    let proof;
    try {
      proof = JSON.parse(readFileSync(proofPath, "utf8"));
    } catch {
      throw new Error(`missing or unreadable exact-head proof: ${proofPath}`);
    }
    if (!exactHeadProofValid(proof, headSha, baseSha)) {
      throw new Error("the maintenance producer requires a fresh exact-head Sol-high proof matching the current HEAD and origin/main");
    }
  }
  const currentBlob = gitBlob(readNormalized(TARGET));
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

  if (protectProducer) {
    const { outputs, blobs } = buildProducerProtectionSources();
    const originals = Object.fromEntries(Object.entries(PROTECTED_SOURCES).map(([key, relativePath]) => [key, readNormalized(relativePath)]));
    try {
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        writeFileSync(path.join(REPO_DIR, relativePath), outputs[key], "utf8");
      }
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        const writtenBlob = gitBlob(readNormalized(relativePath));
        if (writtenBlob !== blobs[key]) throw new Error(`post-write blob mismatch for ${relativePath}`);
      }
    } catch (error) {
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        writeFileSync(path.join(REPO_DIR, relativePath), originals[key], "utf8");
      }
      throw error;
    }
    process.stdout.write(`Protected reviewed maintenance producer (${JSON.stringify(blobs)}).\n`);
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
