#!/usr/bin/env node
// Tests for the applied-migration source-containment loop (mistake class C3:
// a migration runs on live with no source file in the repo).
//
//   recorder: applied-snapshot-invalidate.mjs appends every apply_migration to
//             .claude/session-state/applied-source-ledger.json
//   checker:  stop-wrap.mjs blocks session end while a recorded apply has no
//             git-tracked supabase/migrations/*.sql match, and prunes entries
//             once the file is tracked.
//
// Run: node .claude/hooks/applied-source-containment.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const recorderPath = path.join(hooksDir, "applied-snapshot-invalidate.mjs");
const stopWrapPath = path.join(hooksDir, "stop-wrap.mjs");

// The scrubbed environment is NOT optional (same lesson as
// backup-claude-memory.test.mjs): git exports GIT_DIR/GIT_INDEX_FILE into every
// hook it runs, and `git init` under an inherited GIT_DIR re-initialises THAT
// repository instead of the temp dir — the first run of this suite inside the
// pre-commit hook flipped the real CRX repo to core.bare=true and broke every
// worktree until it was set back. Never spawn git (directly or via a hook
// under test) without clearing these.
const cleanEnv = { ...process.env };
for (const name of [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
]) delete cleanEnv[name];

function runHook(hookPath, payload, projectDir) {
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...cleanEnv, CLAUDE_PROJECT_DIR: projectDir },
  });
}
function git(args, cwd) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: cleanEnv });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-c3-test-"));
try {
  // ── Fresh git repo standing in for a session's worktree ──
  git(["init", "-q"], tmp);
  // Refuse to continue if init landed anywhere but the temp dir (the guard
  // against ever touching another repository, per the env note above).
  const topLevel = git(["rev-parse", "--show-toplevel"], tmp).trim();
  assert.equal(path.resolve(topLevel), path.resolve(tmp), "git init must land in the temp dir, never another repo");
  git(["config", "user.email", "test@test"], tmp);
  git(["config", "user.name", "test"], tmp);
  mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(tmp, "README.md"), "x\n");
  git(["add", "."], tmp);
  git(["commit", "-qm", "init"], tmp);

  const ledgerPath = path.join(tmp, ".claude", "session-state", "applied-source-ledger.json");

  // ── Recorder ──
  // A non-apply tool records nothing.
  runHook(recorderPath, { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select 1" } }, tmp);
  assert.ok(!existsSync(ledgerPath), "non-apply tools must not create the ledger");

  // apply_migration records name+session; a second apply APPENDS.
  runHook(recorderPath, { tool_name: "mcp__supabase__apply_migration", tool_input: { name: "add_widget_flag" }, session_id: "s1" }, tmp);
  runHook(recorderPath, { tool_name: "mcp__supabase__apply_migration", tool_input: { name: "20260818120000_fix_totals" }, session_id: "s1" }, tmp);
  let entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 2, "both applies recorded");
  assert.equal(entries[0].name, "add_widget_flag");
  assert.equal(entries[1].name, "20260818120000_fix_totals");

  // A corrupt ledger never breaks an apply — the recorder starts fresh.
  writeFileSync(ledgerPath, "{not json");
  const rec = runHook(recorderPath, { tool_name: "mcp__supabase__apply_migration", tool_input: { name: "after_corruption" } }, tmp);
  assert.equal(rec.status, 0, "recorder is fail-open on a corrupt ledger");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "corrupt ledger restarted with the new entry");

  // CONCURRENT recorders must not lose entries (CodeRabbit PR #423): the
  // read-modify-write is serialized by a cross-process lock, so parallel
  // apply_migration hooks in one message all land in the ledger.
  rmSync(ledgerPath, { force: true });
  const CONCURRENT = 12;
  await Promise.all(Array.from({ length: CONCURRENT }, (_, k) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recorderPath], {
      env: { ...cleanEnv, CLAUDE_PROJECT_DIR: tmp },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", () => resolve());
    child.stdin.end(JSON.stringify({
      tool_name: "mcp__supabase__apply_migration",
      tool_input: { name: `concurrent_apply_${k}` },
      session_id: "s-parallel",
    }));
  })));
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, CONCURRENT, `all ${CONCURRENT} concurrent applies recorded, none lost`);
  assert.equal(new Set(entries.map(e => e.name)).size, CONCURRENT, "every concurrent entry is distinct");

  // ── Checker: applied with NO tracked source → stop-wrap BLOCKS ──
  writeFileSync(ledgerPath, JSON.stringify([{ name: "add_widget_flag", ts: "2026-08-18T00:00:00Z", session: "s1" }]) + "\n");
  let out = runHook(stopWrapPath, { session_id: "c3-test-none" }, tmp).stdout;
  assert.match(out, /"decision":"block"/, "uncontained apply must block session end");
  assert.match(out, /APPLIED TO LIVE with no committed source/, "block reason names the failure");
  assert.match(out, /add_widget_flag/, "block reason names the migration");

  // A stale ack (recorded when the tree was clean and no applies were pending)
  // must NOT bypass the new issue — the apply folds into the signature.
  mkdirSync(path.join(tmp, ".claude", "session-state"), { recursive: true });
  writeFileSync(path.join(tmp, ".claude", "session-state", "stop-wrap-ack.json"), JSON.stringify({ signature: "" }));
  out = runHook(stopWrapPath, { session_id: "c3-test-ack" }, tmp).stdout;
  assert.match(out, /"decision":"block"/, "an empty-set ack cannot mask an uncontained apply");
  rmSync(path.join(tmp, ".claude", "session-state", "stop-wrap-ack.json"));

  // ── Checker: tracked source satisfies by SLUG (stamp may differ) and prunes ──
  writeFileSync(path.join(tmp, "supabase", "migrations", "20260818999999_add_widget_flag.sql"), "select 1;\n");
  git(["add", "supabase/migrations/20260818999999_add_widget_flag.sql"], tmp);
  git(["commit", "-qm", "migration"], tmp);
  out = runHook(stopWrapPath, { session_id: "c3-test-ok" }, tmp).stdout;
  assert.ok(!/APPLIED TO LIVE/.test(out), "tracked source file resolves the issue");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 0, "satisfied entry is pruned from the ledger");

  // Full-stamped recorded name also matches the same file by slug.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "20260818999999_add_widget_flag.sql", ts: "t", session: "s" }]) + "\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-stamp" }, tmp).stdout;
  assert.ok(!/APPLIED TO LIVE/.test(out), "stamped name + .sql suffix matches the tracked file");

  // A merely UNTRACKED file on disk is not containment — still blocks.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "orphan_change", ts: "t", session: "s" }]) + "\n");
  writeFileSync(path.join(tmp, "supabase", "migrations", "20260818999998_orphan_change.sql"), "select 2;\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-untracked" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "untracked-on-disk is not committed — still blocks");

  // `git add -N` (intent-to-add: the FILENAME is registered but no content is
  // committed or even staged) is not containment either (CodeRabbit PR #423) —
  // the checker reads HEAD, so it still blocks and must NOT prune the entry.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "ita_change", ts: "t", session: "s" }]) + "\n");
  writeFileSync(path.join(tmp, "supabase", "migrations", "20260818999997_ita_change.sql"), "select 3;\n");
  git(["add", "-N", "supabase/migrations/20260818999997_ita_change.sql"], tmp);
  out = runHook(stopWrapPath, { session_id: "c3-test-ita" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "intent-to-add is not committed — still blocks");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "intent-to-add must not prune the ledger entry");

  // A BROKEN git call (binary missing / timeout) must not masquerade as
  // "nothing committed" and phantom-block (CodeRabbit PR #423 round 2): the
  // checker skips containment when git itself is unavailable. Simulated by a
  // PATH with no git in it; the entry must survive unpruned for the next
  // session where git works again.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "git_broken_probe", ts: "t", session: "s" }]) + "\n");
  const noGitEnv = { ...cleanEnv, CLAUDE_PROJECT_DIR: tmp };
  for (const k of Object.keys(noGitEnv)) if (/^path$/i.test(k)) delete noGitEnv[k];
  noGitEnv.PATH = tmp; // a directory that contains no git executable
  const noGit = spawnSync(process.execPath, [stopWrapPath], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: "c3-test-nogit" }),
    env: noGitEnv,
  });
  assert.equal(noGit.status, 0, "checker exits cleanly when git is unavailable");
  assert.ok(!/APPLIED TO LIVE/.test(noGit.stdout), "a failed git call skips containment instead of phantom-blocking");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "skipped check must not prune the entry");

  // An UNBORN HEAD (fresh repo, nothing ever committed) must still BLOCK —
  // nothing committed is exactly the uncontained case. Guards against a
  // "skip when HEAD doesn't resolve" regression (CodeRabbit PR #423 round 3):
  // only a transient git failure may skip, never a genuinely empty history.
  const tmp2 = mkdtempSync(path.join(os.tmpdir(), "crx-c3-unborn-"));
  try {
    git(["init", "-q"], tmp2);
    const top2 = git(["rev-parse", "--show-toplevel"], tmp2).trim();
    assert.equal(path.resolve(top2), path.resolve(tmp2), "second git init must land in its temp dir");
    mkdirSync(path.join(tmp2, ".claude", "session-state"), { recursive: true });
    writeFileSync(path.join(tmp2, ".claude", "session-state", "applied-source-ledger.json"),
      JSON.stringify([{ name: "unborn_probe", ts: "t", session: "s" }]) + "\n");
    const unborn = runHook(stopWrapPath, { session_id: "c3-test-unborn" }, tmp2);
    assert.match(unborn.stdout, /APPLIED TO LIVE with no committed source/, "unborn HEAD still blocks — nothing is committed");
  } finally {
    try { rmSync(tmp2, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // A corrupt ledger never bricks session end (fail-open).
  writeFileSync(ledgerPath, "{not json");
  const wrap = runHook(stopWrapPath, { session_id: "c3-test-corrupt" }, tmp);
  assert.equal(wrap.status, 0, "checker is fail-open on a corrupt ledger");
  assert.ok(!/APPLIED TO LIVE/.test(wrap.stdout), "corrupt ledger adds no phantom issue");

  console.log("OK - applied-source-containment checks passed.");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
