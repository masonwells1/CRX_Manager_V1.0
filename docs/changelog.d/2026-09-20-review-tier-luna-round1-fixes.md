## 2026-09-20 — Round 1 of the new reviewer found 11 real defects in this change
 — all fixed

Step 3A was run against this branch's own diff and returned `LUNA_REVIEW: FINDINGS 11`
(202,875 tokens). Every finding was verified against the files before acting; none were false
positives. The two that mattered most:

- **The advisory path was not actually isolated.** `--skip-git-repo-check` only disables repo
  detection. The first Step 3A run's own header read `sandbox: danger-full-access` with user config
  loaded — meaning a live Supabase/Vercel connector — while reading a diff, which is
  attacker-influenceable text. It now uses the same flag set `overnight-codex-gate.mjs` uses:
  `--ephemeral --ignore-user-config --sandbox read-only`. **These three do not come apart:**
  `--sandbox read-only` *without* `--ignore-user-config` reproduces the 2026-09-08 deadlock, where
  the repo's Stop hook cannot write `stop-wrap-ack.json`, the hook blocks the stop, and Codex
  retries for ~50 minutes at low CPU — indistinguishable from a hung network call.
- **Step 3A reviewed the wrong scope.** It hard-coded `origin/main...HEAD` while Step 1 offers
  `--uncommitted` and `--commit`. With `SCOPE=--uncommitted` the diff comes back **empty** and the
  reviewer reports clean having read nothing. It now honors the selected scope and hard-fails on an
  empty diff.

The rest: the overnight and codex-driven loops still called a now-Luna gate "Sol/high"; the gauntlet
still ran the Sol proof *before* any Luna round; `review-workflow` had silently dropped auth,
permissions and Edge Functions from the Sol-gated set; Luna's `LUNA_REVIEW` terminator had no
mapping to the SHIP/NEEDS-WORK vocabulary its callers consume; `tee | tail` masked launch failures
(now `set -o pipefail` + `PIPESTATUS`); and the new "never `-C <repo>`" rule contradicted
`overnight-codex-gate.mjs`, which does pass `-C repoRoot` — scoped precisely rather than left as a
silent disagreement, and recorded as a pre-existing residual owned by that wrapper.

**One wording fix worth calling out on its own:** "run Sol once" was ambiguous and dangerous. The
proof binds to the HEAD it reviewed, so any later commit — including a one-line fix for a late
finding — voids it. `AGENTS.md`, `ship.md`, the gauntlet and the skill now all say once **per
candidate SHA**, with Sol sequenced **last**: Luna clean → freeze → Sol → push with no further
commits.

**Also found by running it, before Luna ever saw the diff:** the first Step 3A recipe passed the
prompt as an *argument*, so `codex exec` blocked forever on `Reading additional input from
stdin...` — no error, no timeout, exit code unset, a 39-byte capture. The prompt now goes in on
stdin, and `-C` gets a `cygpath -m` path, because `codex.exe` cannot resolve a Git Bash `/tmp/…`.
