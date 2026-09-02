## 2026-09-02 — git can be told to run a program, and a read-only subcommand does not stop it

Two more P1s from the Codex connector on PR #530, each **reproduced by the reviewer as a real
deletion of `.husky/pre-push`**:

```
git -c diff.external=rm diff --ext-diff -- .husky/pre-push
git grep --open-files-in-pager=rm pattern -- .husky/pre-push
```

Both passed the guard because `diff` and `grep` are on the read-only git subcommand allowlist. The
subcommand was never the problem: git executes whatever a config override or a pager/diff helper
names, so a read-only verb runs an arbitrary writer. This is the same shape as `rg --pre` fixed
earlier — an allowlisted reader with an exec escape hatch — and `gitSubcommandOf()` made it invisible,
because it deliberately skips `-c` **and its value** while hunting for the real subcommand. Correct
for that job; blind to this.

**Fixed by refusing the whole channel, not the two spellings.** When a segment names a guarded
surface, `git` may not carry `-c` or `--config-env` at all, nor `--ext-diff` / `-O` /
`--open-files-in-pager`. Listing the config keys that execute — `diff.external`, `core.pager`,
`sequence.editor`, `core.editor`, `pager.*`, `alias.*`, and whatever git adds next — is the blocklist
mistake this file has already made twice. Reading a guarded file never needs `-c`.

This **deliberately flips a former ALLOW case**: `git -c core.pager=cat log <guarded>` is now denied.
That test was vouching for the exact vulnerable shape; keeping it would have kept the hole. Ordinary
reads are untouched, and verified live: `git diff --stat -- .husky/pre-push` and
`git log --oneline -1 -- .husky/pre-push` both still run, while both bypass probes are refused by
REVIEW PROOF GUARD specifically.

**Also corrected: a decision-log entry that could have caused a real process failure.** The
2026-09-01 entry described "the repo's automatic PR reviewer", which reads as CodeRabbit.
`.coderabbit.yaml` sets `reviews.auto_review.enabled: false`, so CodeRabbit reviews **only** on an
explicit `@coderabbitai review` after the candidate is frozen. An agent reading the old wording would
wait for a review that never comes and skip the required trigger. Now named explicitly as the Codex
connector, with the CodeRabbit contrast spelled out.

Two remaining ratchet gaps — multiline template literals, and the audit's two-directory scan scope —
are recorded in `KNOWN_ISSUES.md` and deliberately left open under the adversarial-iteration cap.
Neither is a production-safety issue: the ratchet governs whether guard comments overclaim.
