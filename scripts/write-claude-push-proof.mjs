#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage: node scripts/write-claude-push-proof.mjs --verdict clean|blockers-fixed\n");
  process.exit(1);
}

const verdictIndex = process.argv.indexOf("--verdict");
if (verdictIndex === -1 || !process.argv[verdictIndex + 1]) usage("Missing --verdict.");
const verdict = process.argv[verdictIndex + 1];
if (verdict !== "clean" && verdict !== "blockers-fixed") {
  usage(`Invalid verdict: ${verdict}`);
}

let repoRoot;
let headSha;
try {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch (error) {
  usage(`Could not resolve the repository HEAD: ${error?.message || error}`);
}

const stateDir = path.join(repoRoot, ".claude", "session-state");
const proofPath = path.join(stateDir, "claude-review-push.json");
mkdirSync(stateDir, { recursive: true });
writeFileSync(proofPath, `${JSON.stringify({
  claude_ran: true,
  verdict,
  head_sha: headSha,
  timestamp: new Date().toISOString(),
}, null, 2)}\n`, "utf8");

process.stdout.write(`${proofPath}\n`);
