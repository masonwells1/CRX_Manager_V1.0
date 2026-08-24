#!/usr/bin/env node
// Patrol entry point: scan -> classify -> render, in one process.
//
// Running all three stages here is deliberate. The snapshot never round-trips through a
// path another process could swap between validation and rendering, and the exit code
// the renderer chooses is the exit code the caller sees.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildSnapshot, writeSnapshot } from "./patrol-scan.mjs";
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
if (!repo) {
  const url = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? "";
}

// A unique run id per invocation: the renderer refuses any snapshot that is not the one
// this run asked for, so a stale successful snapshot can never stand in for a failed scan.
const runId = randomUUID();

let snapshot = null;
let failure = null;
try {
  snapshot = buildSnapshot({ repo, repoRoot, runId });
  writeSnapshot(snapshot); // the report cites this path; it must actually exist
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

process.stdout.write(`${result.text}\n`);
if (failure) process.stdout.write(`\nCollector threw: ${failure}\n`);
process.exit(result.exitCode);
