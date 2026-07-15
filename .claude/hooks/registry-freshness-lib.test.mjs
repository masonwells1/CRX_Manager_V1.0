#!/usr/bin/env node
// Tests for registry-freshness-lib.mjs (FIX 4, 2026-07-13) — the REGISTRY-STALE.flag
// cross-worktree sharing helpers. Uses REAL `git init` / `git worktree add` in a
// scratch temp dir tree so the git-common-dir resolution is exercised for real,
// not mocked. Run: node .claude/hooks/registry-freshness-lib.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMainCheckoutRoot,
  flagCandidatePaths,
  writeStaleFlag,
  readStaleFlag,
  clearStaleFlag,
} from "./registry-freshness-lib.mjs";
import { scratchHookEnvironment } from "./git-test-env.mjs";

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: scratchHookEnvironment(cwd, process.env),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "registry-freshness-lib-test-"));

try {
  // ── non-git directory: git resolution fails cleanly, no throw ───────────
  const plainDir = path.join(tmpRoot, "plain");
  mkdirSync(plainDir, { recursive: true });
  eq(resolveMainCheckoutRoot(plainDir), null, "non-git dir: resolveMainCheckoutRoot returns null");
  const plainPaths = flagCandidatePaths(plainDir);
  eq(plainPaths.commonPath, null, "non-git dir: commonPath is null");
  ok(plainPaths.localPath.endsWith(path.join(".claude", "session-state", "REGISTRY-STALE.flag")), "non-git dir: localPath still resolved");

  // writeStaleFlag falls back to local-only in a non-git dir.
  const { written: plainWritten } = writeStaleFlag(plainDir, { created: "x", migration_hint: "y" });
  eq(plainWritten.length, 1, "non-git dir: writes exactly 1 location (local only)");
  ok(existsSync(plainPaths.localPath), "non-git dir: local flag file exists after write");

  // readStaleFlag finds it via the local-only path.
  const plainRead = readStaleFlag(plainDir);
  ok(plainRead.stale, "non-git dir: readStaleFlag reports stale after local write");
  eq(plainRead.path, plainPaths.localPath, "non-git dir: readStaleFlag path is the local path");

  // no flag anywhere -> not stale.
  const emptyDir = path.join(tmpRoot, "empty");
  mkdirSync(emptyDir, { recursive: true });
  ok(!readStaleFlag(emptyDir).stale, "empty non-git dir: not stale");

  // ── real git repo (no worktree): common == local ─────────────────────────
  const soloRepo = path.join(tmpRoot, "solo");
  mkdirSync(soloRepo, { recursive: true });
  git(["init", "-q"], soloRepo);
  git(["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"], soloRepo);
  const soloRoot = resolveMainCheckoutRoot(soloRepo);
  ok(soloRoot !== null, "solo repo: resolveMainCheckoutRoot resolves (not null)");
  // Compare normalized (case/slash-insensitive on Windows) since git may return 8.3 short paths.
  const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  eq(norm(soloRoot), norm(soloRepo), "solo repo: resolves to its own root (no worktree involved)");

  // ── real git worktree: writes land at the MAIN checkout, not the worktree ──
  const mainRepo = path.join(tmpRoot, "main-repo");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q"], mainRepo);
  git(["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);
  const worktreeDir = path.join(tmpRoot, "wt1");
  git(["worktree", "add", "-q", "-b", "test-wt-branch", worktreeDir], mainRepo);

  const wtRoot = resolveMainCheckoutRoot(worktreeDir);
  ok(wtRoot !== null, "worktree: resolveMainCheckoutRoot resolves (not null)");
  eq(norm(wtRoot), norm(mainRepo), "worktree: resolves to the MAIN checkout root, not the worktree's own dir");
  ok(norm(wtRoot) !== norm(worktreeDir), "worktree: main checkout root differs from the worktree dir itself");

  const wtPaths = flagCandidatePaths(worktreeDir);
  ok(wtPaths.commonPath !== null, "worktree: commonPath resolved");
  ok(norm(wtPaths.commonPath).includes(norm(mainRepo)), "worktree: commonPath lives under the main checkout");
  ok(norm(wtPaths.localPath).includes(norm(worktreeDir)), "worktree: localPath lives under the worktree checkout");
  ok(norm(wtPaths.commonPath) !== norm(wtPaths.localPath), "worktree: common and local paths differ");

  // writeStaleFlag from the worktree writes to BOTH locations.
  const { written: wtWritten } = writeStaleFlag(worktreeDir, { created: "2026-07-13T00:00:00.000Z", migration_hint: "test_mig" });
  eq(wtWritten.length, 2, "worktree: writes to both common + local locations");
  ok(existsSync(wtPaths.commonPath), "worktree: flag exists at the MAIN checkout's session-state dir");
  ok(existsSync(wtPaths.localPath), "worktree: flag ALSO exists at the worktree's own session-state dir (transition safety)");
  const commonFlag = JSON.parse(readFileSync(wtPaths.commonPath, "utf8"));
  eq(commonFlag.migration_hint, "test_mig", "worktree: main-checkout flag content is correct");

  // A session in the MAIN checkout (or a SIBLING worktree) must see the flag too —
  // simulate a sibling worktree that never wrote the flag itself.
  const siblingDir = path.join(tmpRoot, "wt2");
  git(["worktree", "add", "-q", "-b", "test-wt-branch-2", siblingDir], mainRepo);
  const siblingRead = readStaleFlag(siblingDir);
  ok(siblingRead.stale, "sibling worktree (never wrote the flag itself) still sees it as stale");
  // Since the round-3 mixed-version fix, writeStaleFlag fans out to EVERY
  // checkout's local path (not just common+own), so the sibling may detect the
  // flag at its own local path OR the common path — either proves propagation.
  ok(
    [norm(wtPaths.commonPath), norm(path.join(siblingDir, ".claude", "session-state", "REGISTRY-STALE.flag"))].includes(norm(siblingRead.path)),
    "sibling worktree: flag detected at a propagated location (common or its own local)"
  );

  // The main checkout itself must also see a flag written from a worktree.
  const mainRead = readStaleFlag(mainRepo);
  ok(mainRead.stale, "main checkout sees a flag written from a worktree");

  // ── read detects flag present in EITHER location individually ───────────
  // Fresh main repo (no prior flag writes) so this case isn't contaminated by
  // the shared-common-path flag already written above via mainRepo/wt1/wt2.
  const mainRepo2 = path.join(tmpRoot, "main-repo-2");
  mkdirSync(mainRepo2, { recursive: true });
  git(["init", "-q"], mainRepo2);
  git(["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo2);
  const wt3 = path.join(tmpRoot, "wt3");
  git(["worktree", "add", "-q", "-b", "test-wt-branch-3", wt3], mainRepo2);
  const wt3Paths = flagCandidatePaths(wt3);

  // Only the LOCAL (worktree-own) location has a flag — common does not.
  mkdirSync(path.dirname(wt3Paths.localPath), { recursive: true });
  writeFileSync(wt3Paths.localPath, JSON.stringify({ created: "x", migration_hint: "local-only" }) + "\n");
  const localOnlyRead = readStaleFlag(wt3);
  ok(localOnlyRead.stale, "flag present ONLY at the local (worktree) path is still detected as stale");
  eq(norm(localOnlyRead.path), norm(wt3Paths.localPath), "local-only case: detected path is the local path");

  // ── clearStaleFlag removes BOTH locations (Codex P1 2026-07-13) ──────────
  // Write from the worktree (dual-location write), then clear from the SAME
  // worktree — both the common and local copies must be gone afterward, and
  // every checkout must read not-stale.
  writeStaleFlag(wt3, { created: "y", migration_hint: "dual-write-for-clear" });
  ok(readStaleFlag(wt3).stale, "precondition: dual-written flag reads stale before clear");
  const cleared = clearStaleFlag(wt3);
  ok(cleared.removed.length >= 1, "clearStaleFlag reports at least one removed path");
  ok(!existsSync(wt3Paths.localPath), "clearStaleFlag removed the local (worktree) copy");
  if (wt3Paths.commonPath && wt3Paths.commonPath !== wt3Paths.localPath) {
    ok(!existsSync(wt3Paths.commonPath), "clearStaleFlag removed the common (main-checkout) copy");
  }
  ok(!readStaleFlag(wt3).stale, "worktree reads not-stale after clearStaleFlag");
  ok(!readStaleFlag(mainRepo2).stale, "main checkout reads not-stale after clearStaleFlag from the worktree");

  // ── Codex P2 round 2: clearing from a DIFFERENT checkout must also sweep the
  //    originating worktree's local flag (via git worktree enumeration) ───────
  writeStaleFlag(wt3, { created: "2026-01-01T00:00:00Z", migration_hint: "applied-in-wt3" });
  ok(readStaleFlag(wt3).stale, "precondition: wt3 flag present");
  const clearedFromMain = clearStaleFlag(mainRepo2);
  ok(!existsSync(wt3Paths.localPath), "clearing from MAIN also removed wt3's local flag (worktree sweep)");
  ok(clearedFromMain.removed.length >= 1, "main-side clear reports removals");
  ok(!readStaleFlag(wt3).stale, "wt3 reads not-stale after a clear run from main");

  // ── Codex P2 round 2: a flag NEWER than the refresh cutoff must be KEPT ─────
  writeStaleFlag(wt3, { created: "2026-07-13T12:00:00Z", migration_hint: "newer-apply" });
  const clearedOld = clearStaleFlag(wt3, { cutoffIso: "2026-07-13T09:00:00Z" });
  eq(clearedOld.removed.length, 0, "cutoff clear removes nothing when the flag is newer than the cutoff");
  ok(clearedOld.kept.length >= 1, "cutoff clear reports the newer flag as kept");
  ok(readStaleFlag(wt3).stale, "newer flag survives a cutoff-bounded clear (still stale)");
  const clearedAll = clearStaleFlag(wt3, { cutoffIso: "2026-07-13T13:00:00Z" });
  ok(clearedAll.removed.length >= 1, "later cutoff clears the flag");
  ok(!readStaleFlag(wt3).stale, "flag gone after cutoff-covered clear");

  console.log(`registry-freshness-lib: ${pass} assertions passed`);
} finally {
  // Best-effort cleanup — worktrees must be removed via git before rmSync,
  // otherwise the main repo's .git/worktrees metadata gets orphaned (harmless
  // for a throwaway tmp repo, but keep it tidy).
  try {
    const mainRepo = path.join(tmpRoot, "main-repo");
    if (existsSync(mainRepo)) {
      for (const wt of ["wt1", "wt2"]) {
        try { git(["worktree", "remove", "--force", path.join(tmpRoot, wt)], mainRepo); } catch { /* ignore */ }
      }
    }
    const mainRepo2 = path.join(tmpRoot, "main-repo-2");
    if (existsSync(mainRepo2)) {
      try { git(["worktree", "remove", "--force", path.join(tmpRoot, "wt3")], mainRepo2); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
}
