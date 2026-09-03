## 2026-09-02 - Record the gate's trigger decision and its four open follow-ups in the manual layer

#516 shipped the CodeRabbit label gate (`f2307fbf9`) with a settled security decision and four
knowingly-open items. Both were captured in changelog entries and a pull-request comment, neither of
which is where an agent looks before re-opening a design question or before treating a bug as new.
`docs/manual/` is the synthesis layer; this moves them there.

## `DECISION_LOG.md` — the gate is `pull_request_target`-only

Records Mason's 2026-09-02 approval to remove the `pull_request_review` trigger, why the trigger was
unsafe (it sources the workflow YAML from the pull request's own ref, not the default branch, so a PR
editing the file could run its own steps with the job's `issues: write` token), and — the part worth
keeping — the live Actions run that proved it rather than argued it, including the one-line
`gh api` command to re-check the same thing on any run.

It also records that two automated reviewers disagreed, and which one was right and why: the GitHub
Codex connector rated it P1 while the CLI push-proof review returned CLEAN, having verified the
`pull_request_target` path and generalised to the whole workflow.

Without this entry the trigger reads as a missing feature, and the obvious "fix" is to add it back.

## `KNOWN_ISSUES.md` — the four tracked follow-ups

Two Codex P2s in the gate's reset/dedupe semantics, the mutable action-tag pinning, and the
pre-existing gap where both merge guards accept a generic `APPROVED` without reading the gate marker
or reviewer identity. Each entry states the fix shape and why it was deferred, and the fourth is
explicitly marked as pre-dating #516 and belonging with #556 — so nobody bills it to the gate.

The section closes with why the chase stopped: eight exact-head Codex reviews, a fresh P2 of the same
class on essentially every commit, the two worst instances fixed and mutation-tested, and a CLEAN
verdict from the hard gate `AGENTS.md` actually defines.

## Not changed

`KNOWN_ISSUES.md`'s "Last verified" stamp still reads 2026-09-01, because it scopes migration-ledger
facts that this change did not re-verify. Bumping it would assert a live check that did not happen.
`npm run check:docs` passes.
