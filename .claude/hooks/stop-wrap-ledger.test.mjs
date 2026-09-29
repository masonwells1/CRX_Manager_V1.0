#!/usr/bin/env node
// stop-wrap.mjs "Commits exist this session but no ledger file was touched".
//
// 2026-09-26 regression: a session whose only commit was a merge of main into
// the feature branch was warned in a loop. `git log --name-status` lists no
// files for a merge commit, so the branch's changelog entry (committed before
// the session-start snapshot) was invisible. Session work is what this
// checkout created (HEAD's reflog): commits fetched from elsewhere, and the
// clean part of a merge, are not; a real commit without a ledger — on this
// branch, on a side branch merged in, or already landed on main — still warns.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const stopWrapPath = path.join(hooksDir, "stop-wrap.mjs");

// Never spawn git (directly or via a hook under test) with an inherited GIT_DIR
// — see applied-source-containment.test.mjs for the incident this prevents.
const cleanEnv = { ...process.env };
for (const name of [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
]) delete cleanEnv[name];

// Commits made "before the session" are backdated so `git log --since=<snapshot
// mtime>` cannot pick them up regardless of clock granularity.
const PAST = "2020-01-01T00:00:00Z";
function git(args, cwd, { past = false } = {}) {
  const env = past ? { ...cleanEnv, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } : cleanEnv;
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function runStopWrap(sessionId, projectDir) {
  return spawnSync(process.execPath, [stopWrapPath], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: sessionId }),
    env: { ...cleanEnv, CLAUDE_PROJECT_DIR: projectDir },
  });
}
const snapDir = path.join(os.tmpdir(), "crx-claude-hooks");
function startSession(sessionId) {
  // git's --since has one-second granularity: wait past the previous session's
  // last commit so it cannot fall inside this session's window.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  mkdirSync(snapDir, { recursive: true });
  const p = path.join(snapDir, `session-${sessionId}.snapshot`);
  writeFileSync(p, "", "utf8"); // clean tree at session start; mtime = now
  return p;
}
const LEDGER_WARNING = /no ledger file was touched/;

let pass = 0;
const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-stopwrap-ledger-"));
const snapshots = [];
try {
  git(["init", "-q", "-b", "main"], tmp);
  git(["config", "user.email", "test@test"], tmp);
  git(["config", "user.name", "test"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "base\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "init"], tmp, { past: true });

  // Feature branch: real work plus its changelog entry, committed BEFORE the session.
  git(["checkout", "-qb", "feat"], tmp);
  mkdirSync(path.join(tmp, "docs", "changelog.d"), { recursive: true });
  writeFileSync(path.join(tmp, "feature.txt"), "feature\n");
  writeFileSync(path.join(tmp, "docs", "changelog.d", "2020-01-01-feature.md"),
    "## 2020-01-01 — feature\n\nAdded the feature.\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "feature with ledger"], tmp, { past: true });

  // main moves on.
  git(["checkout", "-q", "main"], tmp);
  writeFileSync(path.join(tmp, "other.txt"), "other\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "unrelated main work"], tmp, { past: true });
  git(["checkout", "-q", "feat"], tmp);

  // ── Session 1: the ONLY commit this session is a merge of main → no warning ──
  const s1 = "ledger-test-merge-only";
  snapshots.push(startSession(s1));
  git(["merge", "--no-ff", "--no-edit", "main"], tmp);
  const mergeOnly = runStopWrap(s1, tmp);
  assert.equal(mergeOnly.status, 0, `stop-wrap exits 0: ${mergeOnly.stderr}`);
  assert.ok(!LEDGER_WARNING.test(mergeOnly.stdout),
    `a merge-only session must not get the "no ledger" warning; got: ${mergeOnly.stdout}`);
  pass++;

  // ── Session 1b: a merge that needed a hand-written conflict resolution is
  //    real work (Codex P2, PR #824) → still warns when nothing was recorded ──
  git(["checkout", "-q", "main"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "main side\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "main edits base"], tmp, { past: true });
  git(["checkout", "-q", "feat"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "feat side\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "feat edits base"], tmp, { past: true });
  const s1b = "ledger-test-conflicted-merge";
  snapshots.push(startSession(s1b));
  const conflicted = spawnSync("git", ["-C", tmp, "merge", "--no-edit", "main"], { encoding: "utf8", env: cleanEnv });
  assert.notEqual(conflicted.status, 0, "setup: the merge must conflict");
  writeFileSync(path.join(tmp, "base.txt"), "hand-resolved: both sides combined\n");
  git(["add", "base.txt"], tmp);
  git(["commit", "--no-edit", "-q"], tmp);
  const resolvedMerge = runStopWrap(s1b, tmp);
  assert.match(resolvedMerge.stdout, LEDGER_WARNING,
    "a merge carrying an authored conflict resolution with no ledger must still warn");
  pass++;

  // ── Session 1c: the merge resolution itself ADDS this session's changelog
  //    entry (Codex P2, PR #827) → that counts as the ledger, no warning ──
  git(["checkout", "-q", "main"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "main side 2\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "main edits base again"], tmp, { past: true });
  git(["checkout", "-q", "feat"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "feat side 2\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "feat edits base again"], tmp, { past: true });
  const s1c = "ledger-test-merge-adds-entry";
  snapshots.push(startSession(s1c));
  const conflicted2 = spawnSync("git", ["-C", tmp, "merge", "--no-edit", "main"], { encoding: "utf8", env: cleanEnv });
  assert.notEqual(conflicted2.status, 0, "setup: the second merge must conflict");
  writeFileSync(path.join(tmp, "base.txt"), "hand-resolved again\n");
  writeFileSync(path.join(tmp, "docs", "changelog.d", "2026-09-27-merge-resolution.md"),
    "## 2026-09-27 — merge resolution\n\nCombined both sides of base.txt by hand.\n");
  git(["add", "base.txt", "docs/changelog.d/2026-09-27-merge-resolution.md"], tmp);
  git(["commit", "--no-edit", "-q"], tmp);
  const mergeWithEntry = runStopWrap(s1c, tmp);
  assert.ok(!LEDGER_WARNING.test(mergeWithEntry.stdout),
    `a merge whose resolution adds a changelog entry must count as recorded; got: ${mergeWithEntry.stdout}`);
  pass++;

  // ── Session 1d (Codex P2, PR #827): main gains an unrecorded commit AFTER the
  //    snapshot and is merged cleanly — main's commit is not this session's
  //    work (first-parent scan), and a clean merge of separate hunks in the
  //    SAME file is not authored work either → no warning ──
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "src", "shared.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "shared file on feat"], tmp, { past: true });
  git(["checkout", "-q", "main"], tmp);
  git(["merge", "-q", "--no-edit", "feat"], tmp, { past: true });
  git(["checkout", "-q", "feat"], tmp);
  writeFileSync(path.join(tmp, "src", "shared.txt"), "ONE feat\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "feat edits top of shared"], tmp, { past: true });
  const s1d = "ledger-test-upstream-after-snapshot";
  snapshots.push(startSession(s1d));
  // Someone else's commit reaches main the real way: made in another clone,
  // then fetched — it never passes through this checkout's HEAD.
  const other = mkdtempSync(path.join(os.tmpdir(), "crx-stopwrap-other-"));
  try {
    git(["clone", "-q", "-b", "main", tmp, other], os.tmpdir());
    git(["config", "user.email", "other@test"], other);
    git(["config", "user.name", "other"], other);
    writeFileSync(path.join(other, "src", "shared.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN main\n");
    git(["add", "."], other);
    git(["commit", "-qm", "main edits bottom of shared, no ledger"], other);
    git(["fetch", "-q", other, "main:main"], tmp);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
  git(["merge", "--no-ff", "--no-edit", "main"], tmp);
  const upstreamMerge = runStopWrap(s1d, tmp);
  assert.ok(!LEDGER_WARNING.test(upstreamMerge.stdout),
    `merging main's post-snapshot commit (clean, same-file hunks) must not warn; got: ${upstreamMerge.stdout}`);
  pass++;

  // ── Session 1e (Codex P2, PR #827): a conflict resolved by taking one side
  //    ("ours") equals a parent, but it is still a hand-made resolution → warns ──
  git(["checkout", "-q", "main"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "main side 3\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "main edits base a third time"], tmp, { past: true });
  git(["checkout", "-q", "feat"], tmp);
  writeFileSync(path.join(tmp, "base.txt"), "feat side 3\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "feat edits base a third time"], tmp, { past: true });
  const s1e = "ledger-test-take-ours";
  snapshots.push(startSession(s1e));
  const conflicted3 = spawnSync("git", ["-C", tmp, "merge", "--no-edit", "main"], { encoding: "utf8", env: cleanEnv });
  assert.notEqual(conflicted3.status, 0, "setup: the third merge must conflict");
  git(["checkout", "--ours", "base.txt"], tmp);
  git(["add", "base.txt"], tmp);
  git(["commit", "--no-edit", "-q"], tmp);
  const tookOurs = runStopWrap(s1e, tmp);
  assert.match(tookOurs.stdout, LEDGER_WARNING,
    "a conflict resolved by taking one side is authored work and must still warn without a ledger");
  pass++;

  // ── Session 1f (Codex P2, PR #827 round 4): an unrecorded commit made THIS
  //    session on a local topic branch, then merged cleanly into feat, is
  //    session work — it is not on main, so it must still warn ──
  const s1f = "ledger-test-topic-branch";
  snapshots.push(startSession(s1f));
  git(["checkout", "-qb", "topic"], tmp);
  writeFileSync(path.join(tmp, "topic.txt"), "topic work\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "unrecorded topic work"], tmp);
  git(["checkout", "-q", "feat"], tmp);
  git(["merge", "--no-ff", "--no-edit", "topic"], tmp);
  const topicMerge = runStopWrap(s1f, tmp);
  assert.match(topicMerge.stdout, LEDGER_WARNING,
    "an unrecorded commit authored this session on a side branch and merged in must still warn");
  pass++;

  // ── Session 1g (Codex P2, PR #827 round 5): an unrecorded session commit
  //    that has already LANDED on main before the stop hook runs is still
  //    this session's work → still warns ──
  const s1g = "ledger-test-landed-on-main";
  snapshots.push(startSession(s1g));
  writeFileSync(path.join(tmp, "landed.txt"), "landed work\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "unrecorded work that lands on main"], tmp);
  git(["branch", "-f", "main", "feat"], tmp);
  const landed = runStopWrap(s1g, tmp);
  assert.match(landed.stdout, LEDGER_WARNING,
    "a session commit that already reached main must still warn without a ledger");
  pass++;

  // ── Session 1h (Codex P2, PR #827 round 6): a ledger edit that was amended
  //    OUT of the session's commit no longer records anything — the superseded
  //    commit stays in the reflog but is unreachable → still warns ──
  const s1h = "ledger-test-amended-out";
  snapshots.push(startSession(s1h));
  mkdirSync(path.join(tmp, "docs", "manual"), { recursive: true });
  writeFileSync(path.join(tmp, "src", "amended.txt"), "real work\n");
  writeFileSync(path.join(tmp, "docs", "manual", "NOTES.md"), "# Notes\n\nRecorded the work.\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "work plus ledger"], tmp);
  git(["rm", "-q", "docs/manual/NOTES.md"], tmp);
  git(["commit", "-q", "--amend", "-m", "work only"], tmp);
  const amendedOut = runStopWrap(s1h, tmp);
  assert.match(amendedOut.stdout, LEDGER_WARNING,
    "a ledger edit amended out of the session's commit must not count as the record");
  pass++;

  // ── Session 2: a real commit without any ledger → still warns ──
  const s2 = "ledger-test-real-commit";
  snapshots.push(startSession(s2));
  writeFileSync(path.join(tmp, "feature.txt"), "feature v2\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "unrecorded change"], tmp);
  const realCommit = runStopWrap(s2, tmp);
  assert.match(realCommit.stdout, LEDGER_WARNING,
    "a real commit with no ledger entry must still get the warning");
  pass++;
} finally {
  rmSync(tmp, { recursive: true, force: true });
  for (const p of snapshots) rmSync(p, { force: true });
}

console.log(`stop-wrap-ledger: ${pass} assertions passed`);
