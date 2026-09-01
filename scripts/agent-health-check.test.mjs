#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeEol } from "./normalize-eol.mjs";
// Every `git` and guard child process below MUST get this scrubbed environment.
// A git hook exports the repository-local GIT_* variables (GIT_DIR, GIT_INDEX_FILE,
// GIT_CONFIG_*, ...) pointing at the REAL repository, and GIT_DIR outranks both cwd
// and `-C <dir>`. Unscrubbed, this file's fixture setup lands on C:/CRX_Manager
// itself: `git init` marks the shared checkout core.bare=true (breaking every linked
// worktree with "must be run in a work tree"), `git config core.hooksPath` writes the
// real repo so the fixture read below returns FAIL instead of PASS, and the
// installRepo block's `git config user.email/user.name` silently overwrites the
// repository's commit identity. It passes standalone AND in CI because neither sets
// GIT_DIR — only the pre-commit path is destructive, so a green CI proves nothing here.
// Reproduce with: GIT_DIR=$(git rev-parse --absolute-git-dir) node <this file>
// (a relative GIT_DIR=.git re-resolves against the child's cwd and falsely passes).
import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";

import {
  checkClaudeAuth,
  checkCodexAuth,
  checkBranchStaleness,
  checkCodexHookPortability,
  checkFilesPresent,
  checkGitHooksInstalled,
  compareSyncedFiles,
  summarizeChecks,
} from "./agent-health-check.mjs";
import { clearWorktreeOverride } from "./install-git-hooks.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "crx-agent-health-"));

try {
  for (const dir of [
    ".claude/commands",
    ".claude/skills/claude-review",
    ".agents/skills/claude-review",
    ".codex",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  writeFileSync(path.join(root, ".claude/commands/claude-review.md"), "review command");
  writeFileSync(path.join(root, ".claude/skills/claude-review/SKILL.md"), "same");
  writeFileSync(path.join(root, ".agents/skills/claude-review/SKILL.md"), "same");

  const present = checkFilesPresent(root, [
    ".claude/commands/claude-review.md",
    ".claude/skills/claude-review/SKILL.md",
    ".agents/skills/claude-review/SKILL.md",
  ]);
  assert.equal(present.every((check) => check.status === "PASS"), true);

  const synced = compareSyncedFiles(root, [
    [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"],
  ]);
  assert.equal(synced[0].status, "PASS");

  // A CRLF-vs-LF difference is NOT drift. sync-agent-workflows.mjs has normalized line
  // endings before comparing since 2026-07-16; this check still compared raw bytes, so
  // one commit could FAIL here while the generator reported everything in sync. Both
  // now share scripts/normalize-eol.mjs.
  const syncedPair = [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"];
  writeFileSync(path.join(root, syncedPair[0]), "line one\r\nline two\r\n");
  writeFileSync(path.join(root, syncedPair[1]), "line one\nline two\n");
  assert.equal(compareSyncedFiles(root, [syncedPair])[0].status, "PASS");

  // ...but a real content difference must still FAIL, EOL style notwithstanding.
  writeFileSync(path.join(root, syncedPair[1]), "line one\nline two CHANGED\n");
  assert.equal(compareSyncedFiles(root, [syncedPair])[0].status, "FAIL");

  writeFileSync(path.join(root, syncedPair[0]), "same");
  writeFileSync(path.join(root, syncedPair[1]), "same");

  // The shared normalizer is deliberately narrow, and that narrowness is the
  // safety argument: it can only turn a real difference into a false alarm,
  // never a real difference into a false pass.
  assert.equal(normalizeEol("a\r\nb"), "a\nb");
  assert.equal(normalizeEol("a\rb"), "a\rb", "a lone CR is left alone, so it still reads as drift");
  assert.throws(() => normalizeEol(undefined), TypeError, "non-string input must throw, not coerce");

  // HARD guard on the single definition. Both mirror comparisons must import
  // normalizeEol from the one module: a local copy in either script is exactly
  // how the two checks diverged between 2026-07-16 and 2026-08-19, and nothing
  // else in this suite would notice it happening again.
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  for (const caller of ["agent-health-check.mjs", "sync-agent-workflows.mjs"]) {
    const source = readFileSync(path.join(scriptsDir, caller), "utf8");
    assert.match(
      source,
      /import \{ normalizeEol \} from "\.\/normalize-eol\.mjs";/,
      `${caller} must import the shared normalizeEol`,
    );
    assert.equal(
      /(?:const|let|function)\s+normalizeEol\b/.test(source),
      false,
      `${caller} must not define its own normalizeEol`,
    );
  }

  const staleHooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "node C:\\CRX_Manager\\.codex\\hooks\\copied-hook.mjs",
            },
          ],
        },
      ],
    },
  };
  const freshHooks = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/codex-hook-adapter.mjs\" \".claude/hooks/sql-safety.mjs\"",
              commandWindows: "powershell -Command shared-hook",
            },
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/production-action-guard.mjs\"",
              commandWindows: "powershell -Command production-action-guard.mjs",
            },
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/codex-hook-adapter.mjs\" \".claude/hooks/review-proof-guard.mjs\"",
              commandWindows: "powershell -Command review-proof-guard.mjs",
            },
          ],
        },
      ],
    },
  };

  assert.equal(checkCodexHookPortability(staleHooks).status, "FAIL");
  assert.equal(checkCodexHookPortability(freshHooks).status, "PASS");
  assert.equal(checkBranchStaleness(() => "0 2").status, "PASS");
  assert.equal(checkBranchStaleness(() => "3 1").status, "WARN");
  assert.equal(checkBranchStaleness(() => "bad output").status, "WARN");

  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "WARN" },
    ]).exitCode,
    0,
  );
  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "FAIL" },
    ]).exitCode,
    1,
  );

  // ── CLI auth smokes (delegate to the CLI's own authoritative status command) ──
  // The checks shell out to `codex login status` / `claude auth status`; tests inject a
  // fake runner so every outcome (logged in / out / malformed / CLI-missing) is deterministic.

  // Codex: PASS on exit 0 (codex prints "Logged in" to STDERR and signals success via the
  // exit code — so the check must not depend on stdout content); everything else FAILs.
  assert.equal(checkCodexAuth(() => ({ ok: true, stdout: "", stderr: "Logged in using ChatGPT" })).status, "PASS");
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "Not logged in", stderr: "" })).status, "FAIL");
  // Malformed/expired tokens — codex exits non-zero with "missing field id_token" → FAIL (the
  // exact case a JSON-shape smoke would have falsely PASSed).
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "", stderr: "Error checking login status: missing field `id_token`" })).status, "FAIL");
  // Binary not found → FAIL.
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "", stderr: "newest OpenAI Codex binary not found" })).status, "FAIL");

  // Claude: PASS only on loggedIn:true; logged-out/unparseable/CLI-missing → WARN (env or
  // apiKeyHelper auth may still work for non-interactive `claude -p`).
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" })).status, "PASS");
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: false }), stderr: "" })).status, "WARN");
  // Empty/malformed claudeAiOauth would make a shape-check PASS, but `claude auth status` reports
  // loggedIn:false → WARN (the round-2 P3 case).
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: false, claudeAiOauth: {} }), stderr: "" })).status, "WARN");
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: "not json", stderr: "" })).status, "WARN");
  assert.equal(checkClaudeAuth(() => ({ ok: false, stdout: "", stderr: "unknown command 'auth'" })).status, "WARN");

  // checkGitHooksInstalled — exercised against a real throwaway repo, because the
  // whole failure mode is that git silently runs nothing when core.hooksPath
  // resolves to a directory that is not there. Each FAIL branch is asserted, not
  // just the happy path: on 2026-08-31 fourteen live worktrees were in one of
  // these states, all reporting perfectly normal `git commit` output.
  const hooksRepo = mkdtempSync(path.join(os.tmpdir(), "crx-hooks-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", hooksRepo, ...args], {
        stdio: "ignore",
        env: scratchHookEnvironment(hooksRepo),
      });
    git("init");
    // Unset → git falls back to .git/hooks, where this repo installs nothing.
    assert.equal(checkGitHooksInstalled(hooksRepo).status, "FAIL");

    // The exact regression: husky's generated, gitignored .husky/_ is absent in
    // any worktree that never ran `npm install`.
    // writeFileSync creates 0644, which is itself a FAIL on POSIX — the hooks have
    // to be made executable or every assertion below would be measuring the wrong
    // branch on Linux CI while passing on Windows.
    const writeHook = (dir, name) => {
      const file = path.join(dir, name);
      writeFileSync(file, "#!/usr/bin/env sh\n");
      chmodSync(file, 0o755);
    };
    mkdirSync(path.join(hooksRepo, ".husky"), { recursive: true });
    writeHook(path.join(hooksRepo, ".husky"), "pre-commit");
    writeHook(path.join(hooksRepo, ".husky"), "pre-push");
    git("config", "core.hooksPath", ".husky/_");
    const missingUnderscore = checkGitHooksInstalled(hooksRepo);
    assert.equal(missingUnderscore.status, "FAIL");
    // Rejected as "not the tracked .husky" before the missing-hooks branch is even
    // reached — .husky/_ fails the allowlist on its own. The missing-hooks message is
    // covered by the partial-install case below, where the path IS .husky.
    assert.match(missingUnderscore.note, /tracked \.husky/);

    // The tracked directory is the correct target and needs no husky runtime.
    git("config", "core.hooksPath", ".husky");
    assert.equal(checkGitHooksInstalled(hooksRepo).status, "PASS");

    // Partial installs still FAIL — pre-push carries typecheck/build.
    rmSync(path.join(hooksRepo, ".husky/pre-push"));
    const partial = checkGitHooksInstalled(hooksRepo);
    assert.equal(partial.status, "FAIL");
    assert.match(partial.note, /pre-push/);
    writeHook(path.join(hooksRepo, ".husky"), "pre-push");

    // Present but not executable is skipped by git just as silently on POSIX.
    // Windows has no executable bit, so that platform must never report it.
    assert.equal(checkGitHooksInstalled(hooksRepo, "win32").status, "PASS", "win32 does not inspect the executable bit");
    if (process.platform !== "win32") {
      chmodSync(path.join(hooksRepo, ".husky/pre-commit"), 0o644);
      const notExecutable = checkGitHooksInstalled(hooksRepo, "linux");
      assert.equal(notExecutable.status, "FAIL");
      assert.match(notExecutable.note, /non-executable/);
      chmodSync(path.join(hooksRepo, ".husky/pre-commit"), 0o755);
    }

    // An absolute path into another checkout resolves to real hook files, so an
    // existence-only check would PASS it while the guards that ran belonged to a
    // different branch. Six live worktrees pointed at an abandoned Codex checkout.
    git("config", "core.hooksPath", path.join(hooksRepo, ".husky"));
    assert.equal(checkGitHooksInstalled(hooksRepo).status, "PASS", "own worktree by absolute path is still this worktree");
    const foreign = mkdtempSync(path.join(os.tmpdir(), "crx-foreign-hooks-"));
    try {
      mkdirSync(path.join(foreign, ".husky"), { recursive: true });
      writeHook(path.join(foreign, ".husky"), "pre-commit");
      writeHook(path.join(foreign, ".husky"), "pre-push");
      git("config", "core.hooksPath", path.join(foreign, ".husky"));
      const outside = checkGitHooksInstalled(hooksRepo);
      assert.equal(outside.status, "FAIL");
      assert.match(outside.note, /tracked \.husky/);

      // Any other in-worktree directory holding two executable hooks would pass a
      // containment test while git bypassed the tracked .husky entirely.
      mkdirSync(path.join(hooksRepo, ".other-hooks"), { recursive: true });
      writeHook(path.join(hooksRepo, ".other-hooks"), "pre-commit");
      writeHook(path.join(hooksRepo, ".other-hooks"), "pre-push");
      git("config", "core.hooksPath", ".other-hooks");
      const otherDir = checkGitHooksInstalled(hooksRepo);
      assert.equal(otherDir.status, "FAIL", "only the tracked .husky is accepted");
      assert.match(otherDir.note, /tracked \.husky/);

      // `.husky` itself replaced by a link into another checkout. Canonicalizing BOTH
      // sides would make this compare equal, so it pins the asymmetry in the check:
      // the expected path keeps `.husky` literal, the configured one is resolved.
      // Junctions need no privilege on Windows; if the link cannot be made, skip
      // rather than assert a false pass.
      const linkedRepo = mkdtempSync(path.join(os.tmpdir(), "crx-linked-husky-"));
      try {
        const linkedEnv = scratchHookEnvironment(linkedRepo);
        execFileSync("git", ["-C", linkedRepo, "init"], { stdio: "ignore", env: linkedEnv });
        let linked = true;
        try {
          symlinkSync(path.join(foreign, ".husky"), path.join(linkedRepo, ".husky"), "junction");
        } catch {
          linked = false;
        }
        if (linked) {
          execFileSync("git", ["-C", linkedRepo, "config", "core.hooksPath", ".husky"], {
            stdio: "ignore",
            env: linkedEnv,
          });
          const viaLink = checkGitHooksInstalled(linkedRepo);
          assert.equal(viaLink.status, "FAIL", "a .husky linked into another checkout is not this worktree's .husky");
          assert.match(viaLink.note, /tracked \.husky/);
        }
      } finally {
        rmSync(linkedRepo, { recursive: true, force: true });
      }
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  } finally {
    rmSync(hooksRepo, { recursive: true, force: true });
  }

  // Regression check against THIS repository's own tracked hooks, not a fixture.
  // The fixtures above chmod their hooks to 0755, which is exactly what masked the
  // real condition: .husky/pre-commit and .husky/pre-push were committed 100644
  // while .husky/commit-msg was 100755, so pointing core.hooksPath at the tracked
  // directory would have made POSIX skip both silently — the bug this work exists
  // to remove, reintroduced. Windows cannot observe it; the index mode can, on any
  // platform, which is why this asserts the mode git records rather than the mode
  // the filesystem reports.
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const trackedHooks = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--stage", ".husky/pre-commit", ".husky/pre-push", ".husky/commit-msg"],
    // Read-only, and repoRoot IS the real repository — but scrub anyway so `-C repoRoot`
    // decides which index is read. Under a hook, an inherited GIT_DIR/GIT_INDEX_FILE
    // points at the *calling worktree*, so this would silently assert against that
    // worktree's index instead of the one it names.
    { encoding: "utf8", env: scratchHookEnvironment(repoRoot) },
  ).trim();
  const trackedLines = trackedHooks.split(/\r?\n/).filter(Boolean);
  assert.equal(trackedLines.length, 3, `expected three tracked hooks, got: ${trackedHooks}`);
  for (const line of trackedLines) {
    assert.match(line, /^100755 /, `tracked hook is not executable in the index — git skips it on POSIX: ${line}`);
  }

  // scripts/install-git-hooks.mjs — the `prepare` script. A per-worktree
  // core.hooksPath OUTRANKS the shared local value, so writing the shared value
  // alone leaves a stale foreign override effective and `npm install` reports
  // success while repairing nothing. Exercised against a real repository with a
  // real linked worktree, because that precedence is the whole point.
  const installRepo = mkdtempSync(path.join(os.tmpdir(), "crx-install-hooks-"));
  const installWorktree = mkdtempSync(path.join(os.tmpdir(), "crx-install-wt-"));
  try {
    // Scrubbed per-call, keyed to the directory being acted on: this block spans two
    // fixture repositories, and the `git config user.email/user.name` calls just below
    // are the ones that silently rewrote the real repository's commit identity on
    // 2026-08-26 when GIT_DIR leaked in.
    const g = (dir, ...args) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: scratchHookEnvironment(dir) });
    const effective = (dir) =>
      execFileSync("git", ["-C", dir, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
        env: scratchHookEnvironment(dir),
      }).trim();

    g(installRepo, "init");
    g(installRepo, "config", "user.email", "hooks-test@example.invalid");
    g(installRepo, "config", "user.name", "Hooks Test");
    mkdirSync(path.join(installRepo, ".husky"), { recursive: true });
    for (const hook of ["pre-commit", "pre-push"]) {
      const file = path.join(installRepo, ".husky", hook);
      writeFileSync(file, "#!/usr/bin/env sh\n");
      chmodSync(file, 0o755);
    }
    g(installRepo, "add", "-A");
    g(installRepo, "commit", "-m", "init");
    // rmdir first: git worktree add refuses an existing non-empty path, and mkdtemp
    // has already created it.
    rmSync(installWorktree, { recursive: true, force: true });
    g(installRepo, "worktree", "add", "--detach", installWorktree);

    // The exact state CodeRabbit reproduced: worktree-scoped override winning.
    g(installWorktree, "config", "extensions.worktreeConfig", "true");
    g(installWorktree, "config", "--worktree", "core.hooksPath", path.join(installRepo, "..", "elsewhere"));
    assert.notEqual(effective(installWorktree), ".husky", "precondition: the override is in effect");

    // The guard UNDER TEST, and the scrub that is easiest to omit. The git helpers
    // above fail loudly when GIT_DIR leaks; this one fails *silently* — the spawned
    // script would inspect and repair the real repository, and the assertion below
    // could then pass for entirely the wrong reason. scratchHookEnvironment also sets
    // CLAUDE_PROJECT_DIR, which is what points install-git-hooks.mjs at the fixture.
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "install-git-hooks.mjs")], {
      cwd: installWorktree,
      stdio: "ignore",
      env: scratchHookEnvironment(installWorktree),
    });
    assert.equal(effective(installWorktree), ".husky", "prepare must clear the worktree override, not just set the shared value");
    assert.equal(checkGitHooksInstalled(installWorktree).status, "PASS");

    // Linked worktrees live UNDER the main checkout in this repository
    // (.claude/worktrees/<name>), so an absolute path into one is CONTAINED by the
    // root. A containment test passes it while git runs that other branch's guards.
    const nested = path.join(installRepo, "nested-worktree");
    g(installRepo, "worktree", "add", "--detach", nested);
    try {
      g(installRepo, "config", "core.hooksPath", path.join(nested, ".husky"));
      const viaNested = checkGitHooksInstalled(installRepo);
      assert.equal(viaNested.status, "FAIL", "a nested worktree's .husky is another checkout's hooks");
      assert.match(viaNested.note, /tracked \.husky/);
    } finally {
      execFileSync("git", ["-C", installRepo, "worktree", "remove", "--force", nested], {
        stdio: "ignore",
        env: scratchHookEnvironment(installRepo),
      });
      g(installRepo, "config", "core.hooksPath", ".husky");
    }
  } finally {
    try {
      execFileSync("git", ["-C", installRepo, "worktree", "remove", "--force", installWorktree], {
        stdio: "ignore",
        env: scratchHookEnvironment(installRepo),
      });
    } catch {
      /* best effort — the directory removal below is what matters */
    }
    rmSync(installWorktree, { recursive: true, force: true });
    rmSync(installRepo, { recursive: true, force: true });
  }

  // clearWorktreeOverride must distinguish "there was nothing to clear" from a real
  // failure. Swallowing the second leaves a foreign override winning over the shared
  // value while the install reports success — the silent state this work removes.
  assert.equal(clearWorktreeOverride(() => ({ status: 0, stderr: "" })).cleared, true);
  // 5 = the key is not set in this scope. Normal.
  assert.equal(clearWorktreeOverride(() => ({ status: 5, stderr: "" })).cleared, true);
  // No per-worktree scope exists at all. Also normal.
  assert.equal(
    clearWorktreeOverride(() => ({ status: 128, stderr: "fatal: --worktree can only be used with extensions.worktreeConfig" })).cleared,
    true,
  );
  const lockFailure = clearWorktreeOverride(() => ({ status: 255, stderr: "error: could not lock config file" }));
  assert.equal(lockFailure.cleared, false, "a real git failure must not be swallowed");
  assert.match(lockFailure.reason, /could not lock config file/);
  const spawnFailure = clearWorktreeOverride(() => ({ error: new Error("spawn git ENOENT") }));
  assert.equal(spawnFailure.cleared, false);
  assert.match(spawnFailure.reason, /ENOENT/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("OK - agent-health-check helpers passed.");
