# Handoff: close out the push-guard review loop (PR #289)

**Status:** PARKED at round 23. Three HIGH findings open. No Codex proof exists, so the merge gate
correctly refuses PR #289.

**Worktree:** `C:\Users\mason\.claude\worktrees\secdef-pricing-guard\CRX_Manager`
**Branch:** `claude/claude-memory-ignore-and-offsite-20260729` — 26 commits ahead of its own remote,
unpushed. Working tree clean.
**PR:** https://github.com/masonwells1/CRX_Manager_V1.0/pull/289

## Why this is parked rather than fixed

Rounds 16–23 are eight consecutive review rounds on the *review tooling itself* — the push guard and
the off-site memory backup. Every round's findings are real and every round's fixes are proven and
mutation-tested, but each fix adds surface for the next review, so the loop has not converged. It
was stopped deliberately, not because a fix failed. Nothing here touches the CRX Manager app: the
branch contains no SQL, migration, `src/`, money, RLS, or lifecycle changes (Codex confirmed this in
rounds 22 and 23).

## The three open findings (Codex round 23, verbatim substance)

1. **HIGH — backup destination verification accepts non-GitHub transports.**
   `BUILTIN_TRANSPORT_SCHEMES` in `.claude/hooks/codex-push-lib.mjs` trusts `file`, `http` and `git`.
   `file://github.com/masonwells1/CRX_Backups.git` therefore canonicalizes to the approved private
   backup repo and passes `destinationIsPublishable()` in `scripts/backup-claude-memory.mjs`, while
   actually naming a filesystem/UNC path. Fix direction Codex gave: the *backup* path should require
   an explicit GitHub HTTPS/SSH form rather than reuse the push guard's broader scheme list. Note the
   two callers want different strictness — a local bare repo is a legitimate push destination, but
   never a legitimate backup destination.

2. **HIGH — PowerShell/bash backslash-splicing bypasses the whole guard.**
   ``git pu`sh …`` executes as `git push` in PowerShell, but both `isGitPush()` and
   `pushHiddenByShellComposition()` return false, so `codex-push-guard.mjs` exits before every check.
   `pushHiddenByShellComposition` already strips quotes and substitution punctuation; it does not
   strip backtick-escapes or bash `\` line-splices. Same shape as round 19 — extend that unwrapping,
   do not add a new detector.

3. **HIGH — `remote.<name>.vcs` is an unchecked executable transport.**
   `EXECUTABLE_TRANSPORT_KEYS` (round 21) does not list it; git invokes `git-remote-<vcs>` for it.
   Add `/^remote\..+\.vcs$/`. Codex also flags the deliberate inherited-`GIT_EXEC_PATH` exemption as
   a related open route — that exemption is documented in the file with its reason (git exports the
   variable into every hook it runs, so denying on it denied every ordinary push); do not remove it
   without a replacement that distinguishes git's own export from a planted one.

**Non-blocking:** the documented SSH keepalive includes `TCPKeepAlive=yes`, which the allowlist at
`transportValueIsAllowed` rejects.

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

The private `CRX_Backups` snapshot has **not** been pushed. A clone sits at
`<scratchpad>/CRX_Backups` with local commit `db3f352` (185 notes) unpushed, plus fresh staging
output for 190 files. `git@github.com:masonwells1/CRX_Backups.git` still has no `claude-memory/`
folder. Verify a landing by comparing `completed_at` / `file_count` / `total_bytes` character for
character — a push there has silently failed before.
