#!/usr/bin/env node
// Patrol entry point: scan -> classify -> render, in one process.
//
// Running all three stages here is deliberate. The snapshot never round-trips through a
// path another process could swap between validation and rendering, and the exit code
// the renderer chooses is the exit code the caller sees.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, writeSnapshot, writeHeartbeat } from "./patrol-scan.mjs";
import { git as trustedGit } from "./trusted-exec.mjs";
import { classifySnapshot } from "./patrol-classify.mjs";
import { renderReport } from "./patrol-render.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const repoRoot = argOf("--repo-root", path.resolve(SCRIPT_DIR, "..", ".."));
let repo = argOf("--repo", null);
// Inside a try, because this is the FIRST thing the documented command does and it can
// throw: no trusted git executable, no `origin` remote, or a timeout. Uncaught, the
// process died before the emergency block could print — the one path in this file that
// would have failed WITHOUT saying "this is not an all-clear".
let resolveFailure = null;
if (!repo) {
  try {
    // Trusted Git, not a PATH lookup: a `git` shim earlier on PATH would otherwise execute
    // here, straight past the fixed-executable layer used everywhere else.
    const url = trustedGit(["-C", repoRoot, "remote", "get-url", "origin"], { cwd: repoRoot }).trim();
    repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? "";
  } catch (e) {
    resolveFailure = `could not resolve the repository from ${repoRoot}: ${String(e?.message ?? e)}`;
  }
  if (!repo && !resolveFailure) resolveFailure = `no GitHub remote found at ${repoRoot}`;
}

// A unique run id per invocation: the renderer refuses any snapshot that is not the one
// this run asked for, so a stale successful snapshot can never stand in for a failed scan.
const runId = randomUUID();

let snapshot = null;
let snapshotPath = null;
let failure = null;
try {
  if (resolveFailure) throw new Error(resolveFailure);
  snapshot = buildSnapshot({ repo, repoRoot, runId });
  snapshotPath = writeSnapshot(snapshot); // the report cites this path; it must actually exist
} catch (e) {
  failure = String(e?.message ?? e);
  // Discard the in-memory snapshot on ANY failure, including a persistence failure that
  // left a perfectly good snapshot in hand. Keeping it would render normally — possibly
  // printing the reserved all-clear — and exit 0, while the run had actually errored and
  // the "full queue" path it cites does not exist.
  snapshot = null;
}

const nowMs = Date.now();
const items = snapshot ? classifySnapshot(snapshot, nowMs) : [];
const result = renderReport(snapshot, items, { nowMs, expectedRunId: runId, expectedRepoId: repo });

// Stamp the heartbeat only once a report has actually been produced. Anything that goes
// wrong between collection and here — classification, rendering, an expired snapshot —
// leaves the previous heartbeat in place and lets the dead-man monitor go overdue, which
// is the honest outcome.
if (result.exitCode === 0 && snapshot) {
  try { writeHeartbeat(snapshot, snapshotPath); } catch { /* an unstampable heartbeat must not fail the report */ }
}

process.stdout.write(`${result.text}\n`);
if (failure) process.stdout.write(`\nCollector threw: ${failure}\n`);
process.exit(result.exitCode);
