## 2026-09-23 - the push guard reads a bundled `-o` by SHAPE, so `-ou <url> HEAD:main` no longer slips the gate

An independent Opus review of PR #630 found a measured hole in the push guard's
option parsing. It was **not** a regression from that PR — the identical code was
live on `origin/main`, and the fix therefore lands on its own branch.

### The bug

`.claude/hooks/codex-push-lib.mjs` decided whether a bundled short-option cluster
consumes the NEXT argv word with `bare.includes("o")`, at three call sites
(`unknownPushOptions`, `pushDestinationToken`, `pushNamesRefspec`). That is true no
matter where the `o` sits. Git's parse-options treats `-o<value>` as an **attached**
value, so `-ou` is push-option `u` and consumes nothing further.

For `git push -ou https://github.com/masonwells1/CRX_Manager_V1.0.git HEAD:main`:

- **git** reads the repository as the CRX Manager URL and the refspec as `HEAD:main` —
  the push lands on production `main`.
- **the guard** read the destination as `HEAD:main`, so all three app-repo classifiers
  in `.claude/hooks/codex-push-guard.mjs` said "not the app repo", the loop `continue`d,
  and the risky-diff / exact-SHA Codex proof gate never ran.

`-no`, `-uo`, `-o ci.skip` and `-o=ci.skip` all parsed correctly; only an `o` followed
by more letters was wrong. `-fou` was already caught separately by `pushIsForced`.

### The fix

One shape-based walker, `pushShortCluster`, modelled on the `ghMergeShortCluster` /
`ghApiShortCluster` pair that already sit in the same file — not a fourth hand-rolled
walk. It reports where the value-taking letter sat, its value, and whether that value
was ATTACHED; only a detached value reaches into the next word. A non-alphanumeric ends
the cluster, so a boolean short carrying `=` (which git refuses — measured below) cannot
be walked past into a trailing `o` that would swallow the destination. All three call sites now share it, and
`unknownPushOptions` scans only the letters BEFORE the value-taking one, since
everything after it is `-o`'s value rather than more flags.

### Proof 1 — git's own parse, measured (git 2.x, throwaway local bare repo, `--dry-run`)

The premise was measured rather than reasoned from the manual:

| command | what git did | what it proves |
|---|---|---|
| `push --dry-run -ou <bare repo> HEAD:main` | reached the receiving end at `<bare repo>`: `fatal: the receiving end does not support push options` | `u` **attached** as the push-option; the next word was the REPOSITORY |
| `push --dry-run -uo <bare repo> HEAD:main` | `ssh: Could not resolve hostname head` | `<bare repo>` was eaten as `-o`'s **detached** value, and `HEAD:main` became the repository |
| `push --dry-run -o=ci.skip <bare repo> HEAD:main` | reached the receiving end at `<bare repo>` | the `=` form attaches too |
| `push --dry-run -q=o <bare repo> HEAD:main` | ``error: unknown switch `='`` | a BOOLEAN short carrying `=` is not a bundle — git refuses the whole command, so ending the cluster at a non-alphanumeric matches git |

### Proof 2 — the real hook process, base vs candidate

A scratchpad probe spawned `.claude/hooks/codex-push-guard.mjs` from two hook trees —
`HEAD` (base) and the working tree (candidate) — over identical stdin payloads, against
a scratch repo whose own remotes are **not** the app repo, so only the command-line
destination can classify the push. 17 cases, every verdict as expected, exactly two
changed:

| case | base | candidate |
|---|---|---|
| `-ou <CRX URL> HEAD:main` | **ALLOWED** | **DENIED** |
| `-oci.skip origin HEAD:feature` (in the app repo) | DENIED (over-refusal) | ALLOWED |

Unchanged and still correct: `-o ci.skip`, `-o=ci.skip`, `-no ci.skip`, `-uo ci.skip`
and a bare `<CRX URL> HEAD:main` all still DENY when aimed at production main; the same
forms aimed at an unrelated repo, and ordinary `origin HEAD:feature` pushes inside the
app repo, are still allowed.

### Also in this change

- `.codex/hooks/production-action-guard.mjs`: an orphaned `--disable-auto` comment had
  drifted above the unrelated `unsupportedGraphql` check. Moved to the `if (ghRequest)`
  gating point, which is what it describes (and where its twin sits in
  `.claude/hooks/pr-merge-guard.mjs`).
- `.claude/hooks/pr-merge-guard.mjs`: the red-pipeline denial told a caller carrying
  `--disable-auto` to "use `gh pr merge --auto`" — the opposite of the intent, since
  that flag CANCELS a queued auto-merge and lands nothing. `ghMergeRequest` now records
  `disableAuto` (positionally, ParseBool semantics, last value wins, value positions are
  data) and the denial branches its remedy sentence. **The gate itself is unchanged**:
  the stand-down Mason removed on 2026-09-21 is not restored, `auto` stays false, and a
  cancellation is still checked like any other merge. The field is wording only.

### Verified

`node .claude/hooks/codex-push-lib.test.mjs`, `node .claude/hooks/pr-merge-guard.test.mjs`,
`node .codex/hooks/production-action-guard.test.mjs`, `npm run test:correction-guards`,
`npm run test:agent-workflows`, `npm run check-doc-drift` — all green.

### Not verified

Nothing was pushed to any real remote: proof 1 ran `--dry-run` against a throwaway local
bare repository, and proof 2 drives the guard's decision rather than git's transport.

The "boolean short carrying `=`" row of proof 1 was measured on `-q=o`, not on the `-f=o`
spelling the code comment used to name: the force-push guard denies any `-f` spelling before
git can run, which is itself the stronger gate on that form. `-q` and `-f` are both boolean
shorts and take the same parse-options path, so the measurement covers the shape — but it is
a generalization from one spelling, not a direct measurement of `-f=o`. Raised by CodeRabbit
on PR #784 against the original wording, which asserted the rejection as measured fact while
this section said it was unmeasured; the claim is now grounded and the inconsistency is gone.
