# Handoff: close out the push-guard review loop (PR #289)

**Status:** COMPLETE. All round-23 HIGH findings are closed, the exact-head Codex proof returned
CLEAN, and commit `5e022b64` was pushed to PR #289. GitHub review follow-ups are recorded in later
commits on the same PR.

**Worktree:** `C:\Users\mason\.claude\worktrees\secdef-pricing-guard\CRX_Manager`
**Branch:** `claude/claude-memory-ignore-and-offsite-20260729`
**PR:** https://github.com/masonwells1/CRX_Manager_V1.0/pull/289

## Closeout

Rounds 16–23 hardened the push guard and off-site memory backup without touching CRX application
code, SQL, migrations, money, RLS, or lifecycle behavior. Every security predicate was regression-
and mutation-tested, and the real hook and backup paths were exercised before the exact-head proof.

## The three round-23 findings — closed

1. **CLOSED — backup destination transport.** `backupUrlUsesApprovedGitHubTransport()` now requires
   explicit GitHub HTTPS for the backup path. Local, `file:`, `git:`, plain HTTP, SSH-rewritten, and
   unknown transports remain unavailable to the backup even where the general push guard permits a
   local repository.

2. **CLOSED — shell-spliced push spellings.** `pushHiddenByShellComposition()` now unwraps PowerShell
   backticks, POSIX backslashes and line splices, and Windows Command Prompt carets before deciding
   whether the shell will execute a hidden `git push`. Each spelling is denied by the actual hook.

3. **CLOSED — executable transports.** `remote.<name>.vcs` is classified as executable transport
   configuration. Inherited `GIT_EXEC_PATH` is allowed only when it exactly matches a fresh
   `git --exec-path` lookup performed with a clean environment; planted or unverifiable values fail
   closed. The lookup is time-bounded so the hook cannot hang indefinitely.

The documented SSH keepalive and its allowlist now agree.

## Working agreements this loop established — keep them

- **Mutation-test every guard.** Neuter the predicate and disable each call site separately; if a
  suite stays green the guard is decoration. Rounds 17–22 all did this; scratchpad harnesses
  `mut21.mjs`/`mut22.mjs` show the pattern.
- **Prove on a real path, not only in the harness.** Drive the actual hook over stdin, and run the
  actual backup script against the real private clone. Prefer a *discriminating* proof: round 22's
  scheme fix was proven by showing two ordinary destinations pass and only `relay://` denies.
- Reading `.claude/session-state/` from a shell is blocked by design — read the capture with the
  file-reading tool at an absolute path; the verdict is the last line.
- Proof command: `node scripts/write-codex-push-proof.mjs --timeout 1500` (no `--base`). It writes a
  proof only on a terminal `CODEX_PROOF_VERDICT: CLEAN`, binds it to HEAD *and* the `origin/main`
  base, and expires it in 30 minutes.
- Commit with `git commit --only <paths>`. Never `git add -A`, never `--no-verify`.

## Definition of done

`node scripts/write-codex-push-proof.mjs --timeout 1500` writes a proof, the branch pushes, PR #289's
checks are green, CodeRabbit's review is read and answered, and the PR merges.

## Also outstanding, independent of the above

The private `CRX_Backups` snapshot remains a separate operation. After any push there, run
`--verify-remote`: it requires the remote `manifest.json` to be byte-identical to the local one,
requires the remote listing to contain exactly the manifest plus its recorded notes, and downloads
and SHA-256 hashes every note. Do not treat a successful `git push` message alone as landing proof.
