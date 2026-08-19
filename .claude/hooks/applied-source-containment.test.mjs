#!/usr/bin/env node
// Tests for the applied-migration source-containment loop (mistake class C3:
// a migration runs on live with no source file in the repo).
//
//   recorder: applied-snapshot-invalidate.mjs appends every apply_migration to
//             .claude/session-state/applied-source-ledger.json
//   checker:  stop-wrap.mjs blocks session end while a recorded apply has no
//             committed supabase/migrations/*.sql match (exact basename, or a
//             slug whose committed stamp is near the recorded apply time), and
//             prunes entries once the file is committed.
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

  // A retried apply of the SAME name refreshes its entry instead of stacking
  // duplicates (each duplicate would need separate clearing).
  runHook(recorderPath, { tool_name: "mcp__supabase__apply_migration", tool_input: { name: "after_corruption" }, session_id: "s2" }, tmp);
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "same-name retry dedups to one entry");
  assert.equal(entries[0].session, "s2", "the retry refreshed the entry in place");

  // An EXPLICITLY failed apply (tool_response.isError) must not mint an entry:
  // the block message asserts the SQL is live, and a syntax-error retry loop
  // would stack phantom blocks that committing a file can never clear.
  runHook(recorderPath, {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { name: "failed_apply_probe" },
    tool_response: { isError: true, content: [{ type: "text", text: "syntax error at or near" }] },
  }, tmp);
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.ok(!entries.some(e => e.name === "failed_apply_probe"), "an isError apply is not recorded");
  // ...but error-ish TEXT without the explicit marker still records — only the
  // unambiguous flag skips; everything else fails toward the alarm.
  runHook(recorderPath, {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { name: "texty_error_probe" },
    tool_response: { content: [{ type: "text", text: "ERROR: relation does not exist" }] },
  }, tmp);
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.ok(entries.some(e => e.name === "texty_error_probe"), "error text alone still records — only the explicit isError marker skips");

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

  // ── Slug matching is TIME-GATED (Opus review 2026-08-19) ──
  // The real repo holds duplicate slugs years apart; an unrelated OLD file
  // with the same slug must not satisfy — and then silently prune — a fresh
  // apply. Only a file stamped near (or after) the recorded apply time counts.
  writeFileSync(path.join(tmp, "supabase", "migrations", "20240101000000_legacy_slug.sql"), "select 4;\n");
  git(["add", "supabase/migrations/20240101000000_legacy_slug.sql"], tmp);
  git(["commit", "-qm", "old migration"], tmp);
  writeFileSync(ledgerPath, JSON.stringify([{ name: "legacy_slug", ts: "2026-08-18T00:00:00Z", session: "s" }]) + "\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-slug-old" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "an old-stamped same-slug file cannot contain a fresh apply");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "the old-slug mismatch must not prune the entry");
  // A same-slug file stamped within the window DOES contain and prune it.
  writeFileSync(path.join(tmp, "supabase", "migrations", "20260817000000_legacy_slug.sql"), "select 5;\n");
  git(["add", "supabase/migrations/20260817000000_legacy_slug.sql"], tmp);
  git(["commit", "-qm", "fresh migration"], tmp);
  out = runHook(stopWrapPath, { session_id: "c3-test-slug-fresh" }, tmp).stdout;
  assert.ok(!/APPLIED TO LIVE/.test(out), "a near-time same-slug file contains the apply");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 0, "a time-valid slug match prunes");

  // An entry whose ts cannot be parsed is cleared only by an EXACT basename
  // match — a slug alone fails toward blocking.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "add_widget_flag", ts: "t", session: "s" }]) + "\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-undatable" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "an undatable entry is not cleared by a slug-only match");

  // A full-stamped recorded name matches the committed file EXACTLY — no
  // timestamp needed, because the stamp itself pins identity.
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

  // One malformed ledger row must not disable the whole check (Opus review
  // 2026-08-19): the real uncontained entry still blocks, and junk rows are
  // dropped by the same locked rewrite that prunes satisfied entries.
  writeFileSync(ledgerPath, JSON.stringify([
    { name: 12345, ts: "x" },
    { bogus: true },
    { name: "real_orphan_probe", ts: "2026-08-18T00:00:00Z", session: "s" },
  ]) + "\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-junk" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "junk rows must not mask a real uncontained apply");
  assert.match(out, /real_orphan_probe/, "the real entry is still named");
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 1, "junk rows are pruned by the rewrite");
  assert.equal(entries[0].name, "real_orphan_probe");

  // Entry names are attacker-influenced tool input: control characters are
  // stripped and long names truncated before the block message interpolates
  // them.
  writeFileSync(ledgerPath, JSON.stringify([
    { name: "badname_" + "x".repeat(200), ts: "2026-08-18T00:00:00Z", session: "s" },
  ]) + "\n");
  out = runHook(stopWrapPath, { session_id: "c3-test-sanitize" }, tmp).stdout;
  assert.match(out, /APPLIED TO LIVE with no committed source/, "the sanitized entry still blocks");
  assert.ok(!out.includes("") && !out.includes("\\u0007"), "control characters are stripped from the block message");
  assert.ok(!out.includes("x".repeat(120)), "over-long names are truncated in the block message");

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

  // ls-tree FAILING while HEAD is valid must SKIP (no block, no prune) —
  // the transient-failure branch of the round-3 fix (CodeRabbit PR #423).
  // Simulated by deleting the commit's root tree object from the loose object
  // store: rev-parse --verify HEAD still succeeds (the commit object exists),
  // but ls-tree cannot read the tree and exits non-zero.
  const tmp3 = mkdtempSync(path.join(os.tmpdir(), "crx-c3-lstree-"));
  try {
    git(["init", "-q"], tmp3);
    const top3 = git(["rev-parse", "--show-toplevel"], tmp3).trim();
    assert.equal(path.resolve(top3), path.resolve(tmp3), "third git init must land in its temp dir");
    git(["config", "user.email", "test@test"], tmp3);
    git(["config", "user.name", "test"], tmp3);
    writeFileSync(path.join(tmp3, "README.md"), "x\n");
    git(["add", "."], tmp3);
    git(["commit", "-qm", "init"], tmp3);
    const treeHash = git(["rev-parse", "HEAD^{tree}"], tmp3).trim();
    rmSync(path.join(tmp3, ".git", "objects", treeHash.slice(0, 2), treeHash.slice(2)));
    // Sanity: the simulation really is "valid HEAD, broken ls-tree".
    assert.ok(git(["rev-parse", "--verify", "HEAD"], tmp3).trim(), "HEAD must still verify after tree deletion");
    const brokenLs = spawnSync("git", ["-C", tmp3, "ls-tree", "-r", "HEAD", "--name-only"], { encoding: "utf8", env: cleanEnv });
    assert.notEqual(brokenLs.status, 0, "ls-tree must fail once the tree object is gone");
    const ledger3 = path.join(tmp3, ".claude", "session-state", "applied-source-ledger.json");
    mkdirSync(path.dirname(ledger3), { recursive: true });
    writeFileSync(ledger3, JSON.stringify([{ name: "lstree_fail_probe", ts: "t", session: "s" }]) + "\n");
    const lsFail = runHook(stopWrapPath, { session_id: "c3-test-lstree-fail" }, tmp3);
    assert.equal(lsFail.status, 0, "checker exits cleanly on an ls-tree failure with a valid HEAD");
    assert.ok(!/APPLIED TO LIVE/.test(lsFail.stdout), "ls-tree failure with a valid HEAD skips instead of phantom-blocking");
    const entries3 = JSON.parse(readFileSync(ledger3, "utf8"));
    assert.equal(entries3.length, 1, "skipped ls-tree check must not prune the entry");
  } finally {
    try { rmSync(tmp3, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Lock-timeout semantics (CodeRabbit PR #423 round 4): while another
  // process HOLDS the ledger lock, the checker still evaluates (read-only,
  // fail-open) but must NOT prune — an unlocked rewrite could erase a
  // concurrent recorder's append. Once the lock is free, the prune resumes.
  // "add_widget_flag" is satisfied by the migration committed above (slug
  // match with a valid apply time), so a prune WOULD fire here if it ignored
  // the lock.
  writeFileSync(ledgerPath, JSON.stringify([{ name: "add_widget_flag", ts: "2026-08-18T00:00:00Z", session: "s" }]) + "\n");
  const lockDir = ledgerPath + ".lock";
  mkdirSync(lockDir, { recursive: true });
  try {
    const held = runHook(stopWrapPath, { session_id: "c3-test-lockheld" }, tmp);
    assert.equal(held.status, 0, "checker exits cleanly while the ledger lock is held");
    assert.ok(!/APPLIED TO LIVE/.test(held.stdout), "satisfied entry does not block while the lock is held");
    entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(entries.length, 1, "a held lock must prevent the prune — no unlocked rewrite");
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  runHook(stopWrapPath, { session_id: "c3-test-lockfree" }, tmp);
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entries.length, 0, "prune resumes once the lock is released");

  // ── Ack valve NEVER masks an uncontained apply (Opus review 2026-08-19) ──
  // The earlier stale-ack test ran in a tree with untracked files, so the ack
  // signature could never match and the scenario was untested. Here the tree
  // is genuinely CLEAN (.claude/ is gitignored), the signature reduces to just
  // the APPLIED-NO-SOURCE component, and an EXACTLY matching ack is planted —
  // the session must still refuse to end.
  const tmp4 = mkdtempSync(path.join(os.tmpdir(), "crx-c3-ackgate-"));
  try {
    git(["init", "-q"], tmp4);
    const top4 = git(["rev-parse", "--show-toplevel"], tmp4).trim();
    assert.equal(path.resolve(top4), path.resolve(tmp4), "fourth git init must land in its temp dir");
    git(["config", "user.email", "test@test"], tmp4);
    git(["config", "user.name", "test"], tmp4);
    writeFileSync(path.join(tmp4, ".gitignore"), ".claude/\n");
    git(["add", "."], tmp4);
    git(["commit", "-qm", "init"], tmp4);
    const state4 = path.join(tmp4, ".claude", "session-state");
    mkdirSync(state4, { recursive: true });
    writeFileSync(path.join(state4, "applied-source-ledger.json"),
      JSON.stringify([{ name: "ack_mask_probe", ts: "2026-08-18T00:00:00Z", session: "s" }]) + "\n");
    // Sanity: the tree really is clean, or this scenario silently degrades
    // into the untestable one above.
    const dirt4 = git(["status", "--porcelain"], tmp4).split("\n").filter(l => l.trim());
    assert.equal(dirt4.length, 0, "tmp4 tree must be clean for the ack-gate scenario to be real");
    writeFileSync(path.join(state4, "stop-wrap-ack.json"),
      JSON.stringify({ signature: "APPLIED-NO-SOURCE\tack_mask_probe" }));
    const ackGate = runHook(stopWrapPath, { session_id: "c3-test-ackgate" }, tmp4);
    assert.match(ackGate.stdout, /"decision":"block"/, "a signature-matching ack must NOT end the session while an apply is uncontained");
    assert.match(ackGate.stdout, /ack_mask_probe/, "the block names the uncontained apply, not some other issue");
  } finally {
    try { rmSync(tmp4, { recursive: true, force: true }); } catch { /* best-effort */ }
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
